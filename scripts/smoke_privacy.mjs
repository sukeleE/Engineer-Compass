// 隐私冒烟（2026-09-05）：学习/竞赛日程 + 月历收紧为「登录私有」后的权限矩阵
//   guest → 全部 401（不泄露资源存在性）；A/B 两个注册用户 → 列表隔离、跨人详情/改/删/导出/优化一律 404；
//   plan-chat 个人模式（schedule/study 及 edit）在登录与归属检查通过前不得触达 AI（404 先于 502/AI 调用）。
// 自建数据全部走 API 并即时清理；最后直接落库删除两个冒烟账号及其 session/审计行。
// 运行：node scripts/smoke_privacy.mjs（需后端 :3000 已启动）
import { DatabaseSync } from 'node:sqlite';

const API = 'http://localhost:3000/api';
const EMAILS = ['prv.smoke.a@ec.test', 'prv.smoke.b@ec.test'];
let fails = 0;
const line = (n, s, c, x = '') => { if (!c) fails++; console.log(`${c ? 'OK  ' : 'FAIL'} ${n}) ${s}${x ? ' | ' + x : ''}`); };

const japi = async (p, method = 'GET', body, tok) => {
  const res = await fetch(API + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
// 计划 body 工厂：minimal 阶段（manual 路由零 AI 依赖）
const planBody = (title) => ({ title, phases: [{ phase: '阶段1', date: '2026-09', tasks: [{ text: `任务-${title}`, done: false }], check_standard: '完成', week_hours: 10 }] });

let n = 0;
const ok = (s, c, x = '') => line(++n, s, c, x);

const db = new DatabaseSync('backend/data/compass.db');
const reg = async (email) => {
  const { status, data } = await japi('/auth/register', 'POST', { email, password: 'privacysmoke1' });
  if (status !== 201) throw new Error(`注册失败 ${email}: ${status} ${JSON.stringify(data)}`);
  return { ...data, token: data.token, id: data.user.id };
};

try {
  // ============ A/B 两个独立账号（互不知晓对方的私有日程） ============
  const A = await reg(EMAILS[0]);
  const B = await reg(EMAILS[1]);

  // ============ §1 guest（无 token）：所有个人端点一律 401，不泄露存在性 ============
  const guest401 = [
    ['GET /schedule/list', () => japi('/schedule/list')],
    ['GET /schedule/calendar?month=2026-09', () => japi('/schedule/calendar?month=2026-09')],
    ['DELETE /schedule/999999', () => japi('/schedule/999999', 'DELETE')],
    ['GET /schedule/999999/export', () => japi('/schedule/999999/export')],
    ['GET /study/list', () => japi('/study/list')],
    ['GET /study/999999', () => japi('/study/999999')],
    ['DELETE /study/999999', () => japi('/study/999999', 'DELETE')],
    ['POST /study/manual（越权建学习日程）', () => japi('/study/manual', 'POST', { topic: 'guest 冒烟', phases: [{ phase: 'p', tasks: ['t'] }] })],
    ['POST /study/plan（越权生成学习日程）', () => japi('/study/plan', 'POST', { topic: 'guest 冒烟' })],
    ['POST /schedule/manual（越权自编竞赛日程）', () => japi('/schedule/manual', 'POST', planBody('guest'))],
    ['POST /plan-chat mode=schedule（guest）', () => japi('/plan-chat', 'POST', { mode: 'schedule', comp_id: 1, messages: [{ role: 'user', content: 'hi' }] })],
    ['POST /plan-chat mode=study（guest）', () => japi('/plan-chat', 'POST', { mode: 'study', messages: [{ role: 'user', content: 'hi' }] })],
  ];
  for (const [name, fn] of guest401) {
    const r = await fn();
    ok(`guest ${name} → 401`, r.status === 401, `${r.status} ${r.data?.error || ''}`);
  }

  // ============ §2 A 自建日程（manual，零 AI）并确认本人可见可操作 ============
  const schedA = (await japi('/schedule/manual', 'POST', planBody('甲'), A.token)).data;
  ok('A POST /schedule/manual → 201 得 id', !!schedA?.id, JSON.stringify(schedA));
  const sA = schedA.id;
  const listA1 = await japi('/schedule/list', 'GET', undefined, A.token);
  ok('A GET /schedule/list 含自己新建项', listA1.status === 200 && listA1.data.some((x) => x.id === sA), `${listA1.status}`);
  const updA = await japi(`/schedule/${sA}/edit`, 'POST', { plan_json: { phases: [{ phase: '阶段1改', date: '', tasks: [{ text: '任务-甲', done: true }] }] } }, A.token);
  ok('A POST /:id/edit → 200', updA.status === 200, `${updA.status} ${updA.data?.error || ''}`);
  const expA = await japi(`/schedule/${sA}/export`, 'GET', undefined, A.token);
  ok('A GET /:id/export(md) → 200', expA.status === 200, `${expA.status}`);
  const expAx = await japi(`/schedule/${sA}/export?format=excel`, 'GET', undefined, A.token);
  ok('A GET /:id/export(excel) → 200', expAx.status === 200, `${expAx.status}`);
  const calA = await japi('/schedule/calendar?month=2026-09', 'GET', undefined, A.token);
  ok('A GET /schedule/calendar → 200（含 comp/study/team/notes 四数组）',
    calA.status === 200 && ['comp', 'study', 'team', 'notes'].every((k) => Array.isArray(calA.data[k])), `${calA.status}`);

  const studyA = (await japi('/study/manual', 'POST', { topic: '隐私冒烟主题', phases: [{ phase: 'p1', tasks: [{ text: 't1', done: false }] }] }, A.token)).data;
  ok('A POST /study/manual → 201 得 id', !!studyA?.id, JSON.stringify(studyA));
  const stA = studyA.id;
  const stListA = await japi('/study/list', 'GET', undefined, A.token);
  ok('A GET /study/list 含自己新建项', stListA.status === 200 && stListA.data.some((x) => x.id === stA), `${stListA.status}`);
  const stDetailA = await japi(`/study/${stA}`, 'GET', undefined, A.token);
  ok('A GET /study/:id → 200', stDetailA.status === 200 && stDetailA.data.topic === '隐私冒烟主题', `${stDetailA.status}`);
  const stUpdA = await japi(`/study/${stA}`, 'POST', { plan_json: { summary: 's', phases: [{ phase: 'p1', tasks: [{ text: 't1', done: true }] }] } }, A.token);
  ok('A POST /study/:id（勾选保存）→ 200', stUpdA.status === 200, `${stUpdA.status}`);

  // ============ §3 B 视角：列表隔离 + 对 A 的资源全部 404（改/删/导出/优化/AI 对话） ============
  const listB = await japi('/schedule/list', 'GET', undefined, B.token);
  ok('B GET /schedule/list 为空（看不见 A 的日程）', listB.status === 200 && !listB.data.some((x) => x.id === sA), `${listB.status} len=${listB.data.length}`);
  const listBst = await japi('/study/list', 'GET', undefined, B.token);
  ok('B GET /study/list 为空（看不见 A 的学习日程）', listBst.status === 200 && !listBst.data.some((x) => x.id === stA), `${listBst.status} len=${listBst.data.length}`);
  const bCross = [
    [`POST /schedule/${sA}/edit → 404`, () => japi(`/schedule/${sA}/edit`, 'POST', { plan_json: planBody('乙') }, B.token)],
    [`DELETE /schedule/${sA} → 404`, () => japi(`/schedule/${sA}`, 'DELETE', undefined, B.token)],
    [`GET /schedule/${sA}/export → 404`, () => japi(`/schedule/${sA}/export`, 'GET', undefined, B.token)],
    [`POST /schedule/${sA}/optimize → 404（归属门先于 AI 调用）`, () => japi(`/schedule/${sA}/optimize`, 'POST', {}, B.token)],
    [`POST /study/${stA} → 404`, () => japi(`/study/${stA}`, 'POST', { plan_json: {} }, B.token)],
    [`DELETE /study/${stA} → 404`, () => japi(`/study/${stA}`, 'DELETE', undefined, B.token)],
    [`POST /plan-chat schedule-edit（B 改 A 日程）→ 404 先于 AI`, () => japi('/plan-chat', 'POST', { mode: 'schedule-edit', schedule_id: sA, messages: [{ role: 'user', content: '把阶段1去掉' }] }, B.token)],
    [`POST /plan-chat study-edit（B 改 A 学习日程）→ 404 先于 AI`, () => japi('/plan-chat', 'POST', { mode: 'study-edit', study_id: stA, messages: [{ role: 'user', content: '改主题' }] }, B.token)],
  ];
  for (const [name, fn] of bCross) {
    const r = await fn();
    ok(`B 越权 ${name}`, r.status === 404, `${r.status} ${r.data?.error || ''}`);
  }
  const calB = await japi('/schedule/calendar?month=2026-09', 'GET', undefined, B.token);
  ok('B GET /schedule/calendar → 200 且 comp/study 均空（月历隔离）',
    calB.status === 200 && calB.data.comp.length === 0 && calB.data.study.length === 0, `${calB.status} comp=${calB.data.comp.length}`);

  // ============ §4 A 自清（恢复现场：只删自己建的） ============
  const delS = await japi(`/schedule/${sA}`, 'DELETE', undefined, A.token);
  ok('A DELETE /schedule/:id → 200', delS.status === 200, `${delS.status}`);
  const delSt = await japi(`/study/${stA}`, 'DELETE', undefined, A.token);
  ok('A DELETE /study/:id → 200', delSt.status === 200, `${delSt.status}`);
  const listA2 = await japi('/schedule/list', 'GET', undefined, A.token);
  const stListA2 = await japi('/study/list', 'GET', undefined, A.token);
  ok('A 删除后列表已清空（不留脏数据）', !listA2.data.some((x) => x.id === sA) && !stListA2.data.some((x) => x.id === stA));

  console.log(fails === 0 ? `✅ 隐私冒烟通过（${n}/${n}）` : `❌ 失败 ${fails}/${n}`);
} catch (e) {
  fails++;
  console.error('❌ 异常:', e.message);
} finally {
  // 落库清场：删两个冒烟账号 + session + 审计行（user_study/user_schedule 的行已由 A 在 §4 自删，未自删时一并兜底）
  const ids = [];
  for (const em of EMAILS) {
    const u = db.prepare('SELECT id FROM user WHERE email = ?').get(em);
    if (u) ids.push(u.id);
  }
  if (ids.length) {
    const q = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM session WHERE user_id IN (${q})`).run(...ids);
    db.prepare(`DELETE FROM user_study WHERE user_id IN (${q})`).run(...ids);
    db.prepare(`DELETE FROM user_schedule WHERE user_id IN (${q})`).run(...ids);
    db.prepare(`DELETE FROM audit_log WHERE user_id IN (${q})`).run(...ids);
    db.prepare(`DELETE FROM user WHERE id IN (${q})`).run(...ids);
    console.log(`🧹 清理冒烟账号 ${ids.length} 个及连带数据`);
  }
  db.close();
}
process.exit(fails ? 1 : 0);
