// 考勤冒烟：自起临时后端(:3112)+临时库，覆盖
//   非成员/组员权限 / 规则默认值·保存校验 / 多时段 / 请假审批与仅登记 /
//   代签 / 签到码生成·核销·重复·停用 / 日看板 / 月统计
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = 3112;
const BASE = `http://127.0.0.1:${PORT}/api`;
const work = mkdtempSync(join(tmpdir(), 'smk-att-'));
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
const api = async (p, o = {}) => { const { res, data } = await jreq(p, o); if (!res.ok) throw new Error(`${o.method || 'GET'} ${p} → ${res.status} ${JSON.stringify(data)}`); return data; };
const exp = async (p, st, o = {}) => { const { res, data } = await jreq(p, o); return { ok: res.status === st, got: res.status, data }; };

const tz = { timeZone: 'Asia/Shanghai' };
const cn = new Intl.DateTimeFormat('en-CA', { ...tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format;
const today = cn(new Date());
const monthLast = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
const hmFmt = new Intl.DateTimeFormat('en-GB', { ...tz, hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23' });
const hm = (d) => {
  const p = Object.fromEntries(hmFmt.formatToParts(d).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute}`;
};
const dowMap = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const dow = dowMap[new Intl.DateTimeFormat('en-US', { ...tz, weekday: 'short' }).format(new Date())];
const addDays = (dstr, n) => {
  const [Y, M, D] = dstr.split('-').map(Number);
  return cn(new Date(Date.UTC(Y, M - 1, D) + n * 864e5));
};

let server;
try {
  server = spawn(process.execPath, [
    '--import', pathToFileURL(join(process.cwd(), 'scripts', 'polyfill_dom.mjs')).href,
    join(process.cwd(), 'backend', 'server.js'),
  ], { cwd: work, env, stdio: 'ignore', shell: false });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!(await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.ok).catch(() => false))) throw new Error('后端未就绪');
  console.log('后端就绪，临时库:', env.DB_PATH);

  // ---------- 0. 注册 + 建组 ----------
  const stamp = Date.now().toString().slice(-8);
  const reg = async (k, nick) => api('/auth/register', { method: 'POST', body: { email: `at_${k}_${stamp}@test.dev`, password: 'pass123456', nickname: nick } });
  const rO = await reg('o', '考勤组长');
  const rA = await reg('a', '考勤组员');
  const rC = await reg('c', '考勤路人');
  const tO = rO.token, tA = rA.token, tC = rC.token;
  const tg = await api('/team', { method: 'POST', token: tO, body: { name: `考勤冒烟组${stamp}` } });
  const TID = tg.team?.id || tg.id;
  await api(`/team/${TID}/member/add`, { method: 'POST', token: tO, body: { user_ids: [rA.user.id] } });

  // ---------- 1. 权限 ----------
  let g = await exp(`/team/${TID}/attendance/settings`, 403, { token: tC });
  ok('非成员看考勤设置 403', g.ok);
  await api(`/team/${TID}/member/add`, { method: 'POST', token: tO, body: { user_ids: [rC.user.id] } });
  const st0 = await api(`/team/${TID}/attendance/settings`, { token: tA });
  ok('组员可看默认考勤设置且非负责人', st0.settings.workdays.length >= 1 && st0.settings.slots.length >= 1 && st0.is_manager === false, st0);
  g = await exp(`/team/${TID}/attendance/settings`, 403, { method: 'PUT', token: tC, body: { workdays: [dow] } });
  ok('组员不能保存考勤规则 403', g.ok);
  g = await exp(`/team/${TID}/attendance/settings`, 400, { method: 'PUT', token: tO, body: { workdays: [], slots: [{ name: 'x', start: '08:00', late: '09:00', end: '10:00' }] } });
  ok('无工作日保存 400', g.ok);
  g = await exp(`/team/${TID}/attendance/settings`, 400, { method: 'PUT', token: tO, body: { workdays: [dow], slots: [] } });
  ok('无时段保存 400', g.ok);

  // ---------- 2. 多时段规则 + 仅登记请假 ----------
  const s1 = { id: 's1', name: '全天', start: '00:00', late: '23:59', end: '23:59' };
  const s2 = {
    id: 's2', name: '签到码时段',
    start: hm(new Date(Date.now() - 3 * 60000)),
    late: hm(new Date(Date.now() + 2 * 60000)),
    end: hm(new Date(Date.now() + 5 * 60000)),
  };
  await api(`/team/${TID}/attendance/settings`, { method: 'PUT', token: tO, body: {
    name: '竞赛考勤', active: 1, workdays: [dow], slots: [s1, s2],
    scope_type: 'all', scope_json: [], managers: [rA.user.id],
    leave_mode: 'register', start_date: '', end_date: '', exceptions: [],
  } });
  const st1 = await api(`/team/${TID}/attendance/settings`, { token: tA });
  ok('多时段规则保存并生效', st1.settings.slots.length === 2 && st1.settings.workdays[0] === dow, st1.settings.slots);
  ok('显式负责人 is_manager=true', st1.is_manager === true, st1.is_manager);
  const mine = await api(`/team/${TID}/attendance/my`, { token: tC });
  ok('普通成员可看自己的今日考勤', mine.today_working === true && mine.today.length === 2 && mine.is_manager === false && mine.recent.length === 14, {
    w: mine.today_working, cells: mine.today.length, mgr: mine.is_manager, recent: mine.recent.length,
  });
  const mineMonth = await api(`/team/${TID}/attendance/my?month=${today.slice(0, 7)}`, { token: tC });
  const todayMine = mineMonth.month_days?.find((x) => x.date === today);
  ok('自然月接口返回当月每日明细', mineMonth.month === today.slice(0, 7) && mineMonth.month_days.length === monthLast && mineMonth.recent.length === 14, {
    month: mineMonth.month, days: mineMonth.month_days?.length, recent: mineMonth.recent?.length,
  });
  ok('自然月今日明细正确', todayMine?.working === true && todayMine.cells.length === 2 && todayMine.cells.every((c) => c.status === 'can_checkin'), todayMine);

  g = await exp(`/team/${TID}/attendance/leaves`, 400, { method: 'POST', token: tA, body: { end_date: today, slot_id: 's2', reason: '有事' } });
  ok('请假缺开始日期 400', g.ok, g);
  const lv = await api(`/team/${TID}/attendance/leaves`, { method: 'POST', token: tA, body: {
    start_date: today, end_date: today, slot_id: 's2', leave_type: '事假', reason: '临时有事',
  } });
  ok('仅登记模式请假直接批准', lv.status === 'approved', lv);

  // ---------- 3. 代签 + 签到码 ----------
  const proxy = await api(`/team/${TID}/attendance/checkin/proxy`, { method: 'POST', token: tO, body: {
    user_id: rA.user.id, date: today, slot_id: 's1', time: '00:00', note: '现场确认',
  } });
  ok('负责人代签正常', proxy.status === 'normal' && proxy.message === '已代签', proxy);
  g = await exp(`/team/${TID}/attendance/checkin/proxy`, 403, { method: 'POST', token: tC, body: { user_id: rO.user.id, date: today, slot_id: 's1' } });
  ok('组员不能代签 403', g.ok);
  g = await exp(`/team/${TID}/attendance/checkin/proxy`, 400, { method: 'POST', token: tO, body: { user_id: rA.user.id, date: addDays(today, 1), slot_id: 's1' } });
  ok('不能代签未来日期 400', g.ok);

  const code = await api(`/team/${TID}/attendance/codes`, { method: 'POST', token: tO, body: { date: today, slot_id: 's2', max_uses: 3 } });
  ok('负责人发布签到码', code.code.length === 6 && code.slot_id === 's2', code);
  g = await exp(`/team/${TID}/attendance/codes`, 403, { method: 'POST', token: tC, body: { date: today, slot_id: 's2' } });
  ok('组员不能发布签到码 403', g.ok);
  const redeem = await api(`/team/${TID}/attendance/codes/${code.code}/redeem`, { method: 'POST', token: tA });
  ok('组员凭码打卡', redeem.status === 'normal', redeem);
  g = await exp(`/team/${TID}/attendance/codes/${code.code}/redeem`, 409, { method: 'POST', token: tA });
  ok('同一时段重复核销 409', g.ok);
  g = await exp(`/team/${TID}/attendance/checkin`, 409, { method: 'POST', token: tA, body: { slot_id: 's2' } });
  ok('本人重复打卡 409', g.ok);

  // ---------- 4. 看板 + 统计 ----------
  const board = await api(`/team/${TID}/attendance/board?date=${today}`, { token: tO });
  const aRow = board.rows.find((x) => x.id === rA.user.id);
  const c1 = aRow.cells.find((c) => c.slot_id === 's1');
  const c2 = aRow.cells.find((c) => c.slot_id === 's2');
  ok('看板：全天正常 + 签到码时段被请假覆盖', c1.status === 'normal' && c2.status === 'leave', { c1: c1?.status, c2: c2?.status });
  g = await exp(`/team/${TID}/attendance/board?date=${today}`, 403, { token: tC });
  ok('组员不能看全员看板 403', g.ok);
  const stats = await api(`/team/${TID}/attendance/stats?month=${today.slice(0, 7)}`, { token: tO });
  const sRow = stats.rows.find((x) => x.user_id === rA.user.id);
  ok('月统计：正常1 迟到0 请假1', sRow.normal === 1 && sRow.late === 0 && sRow.leave === 1 && sRow.total >= 2, sRow);
  const todayStats = stats.days?.find((x) => x.date === today);
  const aDay = todayStats?.rows?.find((x) => x.user_id === rA.user.id);
  ok('月统计带每日成员明细', stats.days.length === monthLast && todayStats?.rows?.length === 3, {
    days: stats.days?.length, todayRows: todayStats?.rows?.length,
  });
  ok('自然月日明细状态正确', aDay?.cells.map((c) => c.status).join(',') === 'normal,leave', aDay?.cells);

  // ---------- 5. 需审批模式 ----------
  await api(`/team/${TID}/attendance/settings`, { method: 'PUT', token: tO, body: {
    name: '竞赛考勤', active: 1, workdays: [dow], slots: [s1, s2],
    scope_type: 'all', scope_json: [], managers: [rA.user.id],
    leave_mode: 'approval', start_date: '', end_date: '', exceptions: [],
  } });
  const tomorrow = addDays(today, 1);
  const lv2 = await api(`/team/${TID}/attendance/leaves`, { method: 'POST', token: tA, body: {
    start_date: tomorrow, end_date: tomorrow, slot_id: '', leave_type: '病假', reason: '身体不适',
  } });
  ok('需审批模式请假为待审批', lv2.status === 'pending', lv2);
  const appr = await api(`/team/${TID}/attendance/leaves/${lv2.id}/status`, { method: 'PUT', token: tO, body: { status: 'approved', review_note: '注意休息' } });
  ok('负责人批准请假', /批准/.test(appr.message), appr);
  const lvList = await api(`/team/${TID}/attendance/leaves`, { token: tO });
  ok('请假列表含两条且状态正确', lvList.leaves.length >= 2
    && lvList.leaves.find((x) => x.id === lv2.id).status === 'approved', lvList.leaves.map((x) => x.status));

  // ---------- 6. 停用签到码 ----------
  await api(`/team/${TID}/attendance/codes/${code.id}`, { method: 'DELETE', token: tO });
  g = await exp(`/team/${TID}/attendance/codes/${code.code}/redeem`, 400, { method: 'POST', token: tA });
  ok('停用后签到码不可用', g.ok && g.got === 400, g.data);
} catch (e) {
  console.error('冒烟异常:', e);
  fail++;
} finally {
  if (server) server.kill();
}

console.log(`\n考勤冒烟结果: 通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
