// 周期打卡冒烟：自起临时后端(:3111)+临时库，覆盖
//   任务 CRUD 权限 / 每日·每周·定时 / 提交·重复提交=更新 / 必填自评 / 坏周期 400 / 不可补交 400·补交迟交 /
//   看板状态 / 评分自动优秀·手动取消 / 优秀墙 / 排行榜计数排序 / XSS 白名单净化 / 删任务保留历史 / 提醒去重
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runCheckinReminders } from '../backend/lib/checkin.js';

const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}/api`;
const work = mkdtempSync(join(tmpdir(), 'smk-checkin-'));
const env = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
  PORT: String(PORT), DB_PATH: join(work, 'compass.db'),
  SHARE_UPLOAD_DIR: join(work, 'share'), HONOR_UPLOAD_DIR: join(work, 'honor'),
  PURCHASE_UPLOAD_DIR: join(work, 'purchase'),
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log(`✅ ${n}`)) : (fail++, console.log(`❌ ${n}${x !== undefined ? ' → ' + JSON.stringify(x) : ''}`)); };

const jreq = async (p, o = {}) => {
  const h = { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) };
  const res = await fetch(BASE + p, { headers: h, method: o.method || 'GET', body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { res, data };
};
const api = async (p, o = {}) => { const { res, data } = await jreq(p, o); if (!res.ok) throw new Error(`${o.method||'GET'} ${p} → ${res.status} ${JSON.stringify(data)}`); return data; };
const exp = async (p, st, o = {}) => { const { res, data } = await jreq(p, o); return { ok: res.status === st, got: res.status, data }; };

// 东八区日期/星期
const tz = { timeZone: 'Asia/Shanghai' };
const cn = new Intl.DateTimeFormat('en-CA', { ...tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format;
const today = cn(new Date());
const dowMap = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const dow = dowMap[new Intl.DateTimeFormat('en-US', { ...tz, weekday: 'short' }).format(new Date())];
const hm = (d) => new Intl.DateTimeFormat('en-GB', { ...tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const tMinus = (min) => { const d = new Date(Date.now() - min * 60000); return hm(d); };

let server;
try {
  server = spawn(process.execPath, [join(process.cwd(), 'backend', 'server.js')], { cwd: work, env, stdio: 'ignore', shell: false });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!(await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.ok).catch(() => false))) throw new Error('后端未就绪');
  console.log('后端就绪，临时库:', env.DB_PATH);

  // ---------- 0. 注册 + 建组 + 拉人 ----------
  const stamp = Date.now().toString().slice(-8);
  const reg = async (k, nick) => api('/auth/register', { method: 'POST', body: { email: `ci_${k}_${stamp}@test.dev`, password: 'pass123456', nickname: nick } });
  const rO = await reg('o', '打卡组长');
  const rA = await reg('a', '打卡组员');
  const rC = await reg('c', '打卡路人');
  const tO = rO.token, tA = rA.token, tC = rC.token;
  const tg = await api('/team', { method: 'POST', token: tO, body: { name: `打卡冒烟组${stamp}` } });
  const TID = tg.team?.id || tg.id;
  await api(`/team/${TID}/member/add`, { method: 'POST', token: tO, body: { user_ids: [rA.user.id] } });

  // ---------- 1. 打卡任务 CRUD 权限 ----------
  let g = await exp(`/team/${TID}/checkin/schedules`, 403, { method: 'POST', token: tA, body: { title: 'x', kind: 'recurring', freq: 'daily', due_time: '21:00', start_date: today } });
  ok('组员无 task 权限不能建打卡任务 403', g.ok);

  const dailyBody = {
    title: '每日训练打卡', kind: 'recurring', freq: 'daily', due_time: '23:59', start_date: today,
    allow_late: 1, need_self_progress: 1, need_self_rating: 1, auto_feature: 5,
  };
  const cd = await api(`/team/${TID}/checkin/schedules`, { method: 'POST', token: tO, body: dailyBody });
  const SID_DAILY = cd.id;
  ok('组长建每日打卡 201', !!SID_DAILY, cd);

  g = await exp(`/team/${TID}/checkin/schedules`, 400, { method: 'POST', token: tO, body: { title: '周', kind: 'recurring', freq: 'weekly', weekdays: [], due_time: '21:00', start_date: today } });
  ok('每周打卡未选星期 400', g.ok);
  const cw = await api(`/team/${TID}/checkin/schedules`, { method: 'POST', token: tO,
    body: { title: '每周周报', kind: 'recurring', freq: 'weekly', weekdays: [dow], due_time: '23:59', start_date: today, allow_late: 1 } });
  const SID_WEEK = cw.id;
  ok('建每周打卡（含今天）201', !!SID_WEEK, cw);

  g = await exp(`/team/${TID}/checkin/schedules`, 400, { method: 'POST', token: tO, body: { title: '定时', kind: 'once', once_at: '坏时间' } });
  ok('定时任务坏时间格式 400', g.ok);
  const futureOnce = `${today}T23:59`;
  const co = await api(`/team/${TID}/checkin/schedules`, { method: 'POST', token: tO,
    body: { title: '阶段汇报(未来)', kind: 'once', once_at: futureOnce, allow_late: 1 } });
  const SID_ONCE_FUT = co.id;
  ok('建定时任务 201', !!SID_ONCE_FUT, co);

  // 昨日 once：一个不可补交、一个可补交
  const y = new Date(Date.now() - 864e5);
  const yesterday = cn(y);
  const cnx = await api(`/team/${TID}/checkin/schedules`, { method: 'POST', token: tO,
    body: { title: '昨日截止不可补', kind: 'once', once_at: `${yesterday}T20:00`, allow_late: 0 } });
  const SID_NOLATE = cnx.id;
  const cy = await api(`/team/${TID}/checkin/schedules`, { method: 'POST', token: tO,
    body: { title: '昨日截止可补', kind: 'once', once_at: `${yesterday}T20:00`, allow_late: 1 } });
  const SID_LATE = cy.id;

  const sc = await api(`/team/${TID}/checkin/schedules`, { token: tA });
  ok('组员可见任务列表 can_manage=false', sc.schedules.length >= 5 && sc.can_manage === false, { n: sc.schedules.length, cm: sc.can_manage });
  const scO = await api(`/team/${TID}/checkin/schedules`, { token: tO });
  ok('组长 can_manage=true', scO.can_manage === true);
  g = await exp(`/team/${TID}/checkin/schedules/999999`, 403, { method: 'PUT', token: tC, body: { title: 'x' } });
  ok('非成员改任务 403', g.ok);

  // ---------- 2. 今日待办 ----------
  const mine = await api(`/team/${TID}/checkin/my`, { token: tA });
  const findDue = (id) => mine.dues.find((d) => d.schedule.id === id);
  ok('今日待办含每日/每周/可补交昨日项', !!findDue(SID_DAILY) && !!findDue(SID_WEEK) && !!findDue(SID_LATE),
    mine.dues.map((d) => d.schedule.id + ':' + d.status));
  ok('不可补交的过期项状态 missed', findDue(SID_NOLATE)?.status === 'missed', findDue(SID_NOLATE)?.status);

  // ---------- 3. 提交打卡 ----------
  const XSS = '<script>alert(1)</script><b>今天完成结构装配</b><img src=x onerror=alert(2)>';
  g = await exp(`/team/${TID}/checkin/submit`, 400, { method: 'POST', token: tA,
    body: { schedule_id: SID_DAILY, period_key: today, content: 'x' } });
  ok('必填自评进度缺失 400', g.ok, g.data);
  g = await exp(`/team/${TID}/checkin/submit`, 400, { method: 'POST', token: tA,
    body: { schedule_id: SID_DAILY, period_key: '2099-01-01', content: 'x', self_progress: 10, self_rating: 3 } });
  ok('未来/不存在周期 400', g.ok, g.data);
  const sub = await api(`/team/${TID}/checkin/submit`, { method: 'POST', token: tA,
    body: { schedule_id: SID_DAILY, period_key: today, content: XSS, self_progress: 80, self_rating: 4 } });
  const LID_DAILY = sub.id;
  ok('每日打卡提交 201', !!LID_DAILY && !sub.late, sub);
  const sub2 = await api(`/team/${TID}/checkin/submit`, { method: 'POST', token: tA,
    body: { schedule_id: SID_DAILY, period_key: today, content: '<b>更新后的内容</b>', self_progress: 90, self_rating: 5 } });
  ok('同周期重复提交=更新（id 不变）', sub2.id === LID_DAILY, sub2);

  // 不可补交 / 可补交
  g = await exp(`/team/${TID}/checkin/submit`, 400, { method: 'POST', token: tA,
    body: { schedule_id: SID_NOLATE, period_key: yesterday, content: '补' } });
  ok('不可补交任务过期提交 400', g.ok, g.data.error);
  const subLate = await api(`/team/${TID}/checkin/submit`, { method: 'POST', token: tA,
    body: { schedule_id: SID_LATE, period_key: yesterday, content: '补交汇报' } });
  ok('可补交任务过期提交成功并标记迟交', subLate.late === 1, subLate);
  const LID_LATE = subLate.id;

  g = await exp(`/team/${TID}/checkin/submit`, 403, { method: 'POST', token: tC,
    body: { schedule_id: SID_DAILY, period_key: today, content: 'x', self_progress: 1, self_rating: 1 } });
  ok('非成员提交 403', g.ok);

  // XSS 净化（走时间线读取）
  const logs = await api(`/team/${TID}/logs`, { token: tA });
  const dl = logs.logs || logs;
  const arr = Array.isArray(dl) ? dl : dl.logs;
  const dailyLog = arr.find((x) => x.id === LID_DAILY);
  ok('更新后内容落库 + 自评字段', dailyLog.self_progress === 90 && dailyLog.self_rating === 5, { sp: dailyLog.self_progress, sr: dailyLog.self_rating });
  // 先把 XSS 版本再写回一次，验证净化（更新接口同样过 sanitize）
  await api(`/team/${TID}/checkin/submit`, { method: 'POST', token: tA,
    body: { schedule_id: SID_DAILY, period_key: today, content: XSS, self_progress: 90, self_rating: 5 } });
  const logs2 = await api(`/team/${TID}/logs`, { token: tA });
  const arr2 = logs2.logs || logs2;
  const list2 = Array.isArray(arr2) ? arr2 : arr2.logs;
  const dl2 = list2.find((x) => x.id === LID_DAILY);
  ok('script/onerror 被净化，b 标签保留', !/<script/i.test(dl2.content) && !/onerror/i.test(dl2.content) && /<b>/.test(dl2.content), dl2.content);

  // ---------- 4. 看板 ----------
  const board = await api(`/team/${TID}/checkin/schedules/${SID_DAILY}/board`, { token: tO });
  ok('看板含周期列与成员行', board.periods.length >= 1 && board.members.length === 2, { p: board.periods.length, m: board.members.length });
  const aRow = board.members.find((m) => m.id === rA.user.id);
  const todayCell = aRow.cells.find((c) => c.key === today);
  ok('看板：A 今天已交（on 或 late）', todayCell && ['on', 'late'].includes(todayCell.state), todayCell);
  ok('看板返回角色列表与成员角色字段', Array.isArray(board.roles) && aRow.is_owner === false
    && Array.isArray(aRow.role_names) && board.role_filter === '', { roles: board.roles.length, rn: aRow.role_names });
  const ownerBoard = await api(`/team/${TID}/checkin/schedules/${SID_DAILY}/board?role_id=owner`, { token: tO });
  ok('看板 owner 筛选只剩组长', ownerBoard.members.length === 1 && ownerBoard.members[0].is_owner,
    ownerBoard.members.map((x) => `${x.id}:${x.is_owner}`));
  const testRole = await api(`/team/${TID}/role`, { method: 'POST', token: tO,
    body: { name: '看板测试角色', level: 5, permissions: ['progress'] } });
  await api(`/team/${TID}/member`, { method: 'POST', token: tO, body: { user_id: rA.user.id, role_ids: [testRole.id] } });
  const roleBoard = await api(`/team/${TID}/checkin/schedules/${SID_DAILY}/board?role_id=${testRole.id}`, { token: tO });
  ok('看板按角色 id 筛选只剩该角色成员', roleBoard.members.length === 1 && roleBoard.members[0].id === rA.user.id
    && roleBoard.members[0].role_names.includes('看板测试角色'), roleBoard.members.map((x) => x.id));
  ok('看板筛选返回 role_filter 与已交格数', String(roleBoard.role_filter) === String(testRole.id)
    && roleBoard.submitted_total >= 1, { rf: roleBoard.role_filter, n: roleBoard.submitted_total });

  // ---------- 4.5 邀请链接：peek 预览 / 未入组第三人凭码加入 / 重复加入 409 / 坏码 404 ----------
  const CODE = tg.invite_code || tg.team?.invite_code;
  const peek = await api(`/team/peek?code=${CODE}`, { token: tC });
  ok('peek：未入组者看到组名/人数且标记未入组', peek.id === TID && peek.is_member === false
    && peek.member_count === 2 && !!peek.owner_name, peek);
  const join1 = await api('/team/join', { method: 'POST', token: tC, body: { invite_code: CODE } });
  ok('第三人凭邀请码加入 201 且返回组 id', join1.id === TID && /加入/.test(join1.message), join1);
  const peek2 = await api(`/team/peek?code=${CODE}`, { token: tC });
  ok('peek：加入后 is_member=true 且人数+1', peek2.is_member === true && peek2.member_count === 3, peek2);
  const dup = await exp('/team/join', 409, { method: 'POST', token: tC, body: { invite_code: CODE } });
  ok('重复加入 409 且响应带组 id', dup.data.id === TID, dup.data);
  const badPeek = await exp('/team/peek?code=NOPE9999', 404, { token: tC });
  ok('坏邀请码 peek 404', badPeek.ok);
  const badJoin = await exp('/team/join', 404, { method: 'POST', token: tC, body: { invite_code: 'NOPE9999' } });
  ok('坏邀请码加入 404', badJoin.ok);

  // ---------- 5. 评分 / 优秀 ----------
  g = await exp(`/team/${TID}/checkin/logs/${LID_DAILY}/review`, 403, { method: 'POST', token: tA, body: { score: 5 } });
  ok('组员不能评分 403', g.ok);
  g = await exp(`/team/${TID}/checkin/logs/${LID_DAILY}/review`, 400, { method: 'POST', token: tO, body: { score: 6 } });
  ok('评分越界 400', g.ok);
  const rv = await api(`/team/${TID}/checkin/logs/${LID_DAILY}/review`, { method: 'POST', token: tO,
    body: { score: 5, review: '完成质量高' } });
  ok('评 5 星且 auto_feature=5 → 自动优秀', rv.score === 5 && rv.featured === 1, rv);
  let ft = await api(`/team/${TID}/checkin/featured`, { token: tA });
  ok('优秀墙含该汇报', ft.reports.some((x) => x.id === LID_DAILY), ft.reports.map((x) => x.id));
  const rv2 = await api(`/team/${TID}/checkin/logs/${LID_DAILY}/review`, { method: 'POST', token: tO, body: { featured: 0 } });
  ok('组长手动取消优秀', rv2.featured === 0, rv2);
  ft = await api(`/team/${TID}/checkin/featured`, { token: tA });
  ok('取消后优秀墙不含', !ft.reports.some((x) => x.id === LID_DAILY));
  await api(`/team/${TID}/checkin/logs/${LID_DAILY}/review`, { method: 'POST', token: tO, body: { featured: 1 } });
  const rvLate = await api(`/team/${TID}/checkin/logs/${LID_LATE}/review`, { method: 'POST', token: tO, body: { score: 4 } });
  ok('补交打卡同样可评分 200', rvLate.score === 4, rvLate);

  // ---------- 6. 排行榜 ----------
  const lb = await api(`/team/${TID}/checkin/leaderboard?range=month`, { token: tO });
  const aStat = lb.board.find((x) => x.id === rA.user.id);
  const oStat = lb.board.find((x) => x.id === rO.user.id);
  ok('排行榜：A 打卡 2 次（每日+补交）', aStat.cnt === 2, { a: aStat.cnt });
  ok('排行榜：A 优秀数 1', aStat.featured_cnt === 1, aStat.featured_cnt);
  ok('排行榜：组长 0 次且排在 A 之后', lb.board[0].id === rA.user.id && oStat.cnt === 0, lb.board.map((x) => x.id + ':' + x.cnt));

  // ---------- 7. 删除任务保留历史 ----------
  const del = await api(`/team/${TID}/checkin/schedules/${SID_DAILY}`, { method: 'DELETE', token: tO });
  ok('删除打卡任务 200', !!del.message, del);
  const logs3 = await api(`/team/${TID}/logs`, { token: tA });
  const arr3 = logs3.logs || logs3;
  const list3 = Array.isArray(arr3) ? arr3 : arr3.logs;
  ok('删任务后历史汇报仍在时间线（解除挂接）', list3.some((x) => x.id === LID_DAILY && !x.schedule_id), list3.map((x) => x.id + ':' + x.schedule_id));
  const lb2 = await api(`/team/${TID}/checkin/leaderboard?range=month`, { token: tO });
  const aStat2 = lb2.board.find((x) => x.id === rA.user.id);
  ok('排行榜剔除已删任务：A 剩 1 次', aStat2.cnt === 1, aStat2.cnt);

  // ---------- 8. 定时提醒扫描（直连临时库） ----------
  const lateDue = tMinus(30);
  const cr = await api(`/team/${TID}/checkin/schedules`, { method: 'POST', token: tO,
    body: { title: '提醒测试打卡', kind: 'recurring', freq: 'daily', due_time: lateDue, start_date: today, allow_late: 1 } });
  const SID_REM = cr.id;
  const db = new DatabaseSync(env.DB_PATH);
  db.exec('PRAGMA busy_timeout=5000');
  const sent1 = runCheckinReminders(db);
  const n1 = db.prepare("SELECT COUNT(*) AS n FROM personal_notice WHERE type='checkin_remind' AND link LIKE ?").get(`%ci=${SID_REM}%`).n;
  ok('提醒扫描给未交成员发通知（含 A 或 O 至少 1 条）', sent1 >= 1 && n1 >= 1, { sent1, n1 });
  const sent2 = runCheckinReminders(db);
  ok('重复扫描去重（不重复发）', sent2 === 0, sent2);
  // A 补交该期后不再提醒
  const myA = await api(`/team/${TID}/checkin/my`, { token: tA });
  const remDue = myA.dues.find((d) => d.schedule.id === SID_REM);
  await api(`/team/${TID}/checkin/submit`, { method: 'POST', token: tA,
    body: { schedule_id: SID_REM, period_key: remDue.period_key, content: '补交提醒测试' } });
  const sent3 = runCheckinReminders(db);
  const nA = db.prepare("SELECT COUNT(*) AS n FROM personal_notice WHERE user_id=? AND type='checkin_remind' AND link LIKE ?").get(rA.user.id, `%ci=${SID_REM}%`).n;
  ok('A 已交后不再新增（A 名下仍只 0 或 1 条旧通知）', nA <= 1, { sent3, nA });
  db.close();

  // ---------- 9. 清理：删组（级联） ----------
  await api(`/team/${TID}`, { method: 'DELETE', token: tO });
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
} catch (e) {
  fail++;
  console.log('❌ 异常中断:', e.stack || e.message);
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
} finally {
  try { server?.kill(); } catch {}
  process.exit(fail ? 1 : 0);
}
