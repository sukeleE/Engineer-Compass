// 月历聚合接口冒烟测试（node 内联 fetch）
// 覆盖：小组任务勾选写 done_at→calendar team 条目、取消→消失；
//      竞赛日程 plan_json 带 done_at→comp 条目；学习日程→study 条目；笔记→notes；
//      匿名用户只查 'local' 数据
import db from '../db/database.js';

const BASE = 'http://localhost:3000/api';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

async function req(path, opts = {}, timeoutMs = 0) {
  const ctrl = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  const res = await fetch(BASE + path, {
    signal: ctrl,
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// 本地时区今天
const d = new Date();
const pad2 = (n) => String(n).padStart(2, '0');
const TODAY = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const MONTH = TODAY.slice(0, 7);

const Y = 'cal_' + Date.now().toString().slice(-6);

// 1) 注册用户 A
console.log('— 准备');
let r = await req('/auth/register', { method: 'POST', body: JSON.stringify({ username: Y + '_a', password: 'test123456', email: Y + '_a@test.dev' }) });
ok('注册用户A', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const tokA = r.data.token;
const uidA = r.data.user.id;

// 2) 小组计划：勾任务 → calendar team 条目
console.log('— 小组计划（done_at）');
r = await req('/team', { method: 'POST', token: tokA, body: JSON.stringify({ name: Y, desc: '日历冒烟' }) });
ok('建组', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const teamId = r.data.id;
const comp = (await req('/competition?status=active')).data[0];
r = await req(`/team/${teamId}/plan/generate`, { method: 'POST', token: tokA, body: JSON.stringify({ comp_id: comp.id }) }, 100000);
ok('生成小组计划', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const planId = r.data.id;
// 确定性计划（1 个任务，方便验证）
r = await req(`/team/${teamId}/plan`, { method: 'POST', token: tokA,
  body: JSON.stringify({ id: planId, title: '日历冒烟计划', plan_json: { phases: [{ phase: '阶段1', date: '', tasks: [{ text: '小组任务X', dept: '通用' }] }] } }) });
ok('替换确定性计划', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
r = await req(`/team/${teamId}/plan/${planId}/task`, { method: 'POST', token: tokA,
  body: JSON.stringify({ phase_idx: 0, task_idx: 0, done: true }) });
ok('勾选小组任务 → 200 + done_at', r.status === 200 && r.data.done === true && r.data.done_at === TODAY, `got ${r.status} done_at=${r.data.done_at}`);

r = await req(`/schedule/calendar?month=${MONTH}`, { token: tokA });
ok('calendar 返回 team 条目', r.data.team.some((x) => x.task === '小组任务X' && x.plan_name === '日历冒烟计划' && x.date === TODAY), JSON.stringify(r.data.team));

// 取消勾选 → 消失
r = await req(`/team/${teamId}/plan/${planId}/task`, { method: 'POST', token: tokA,
  body: JSON.stringify({ phase_idx: 0, task_idx: 0, done: false }) });
ok('取消勾选 done_at 清空', r.data.done_at === null, `got ${r.data.done_at}`);
r = await req(`/schedule/calendar?month=${MONTH}`, { token: tokA });
ok('取消后 team 条目消失', !r.data.team.some((x) => x.task === '小组任务X'), JSON.stringify(r.data.team));

// 3) 竞赛日程：plan_json 带 done_at → comp 条目
console.log('— 竞赛日程（done_at 前端写入）');
r = await req('/schedule/manual', { method: 'POST', token: tokA, body: JSON.stringify({
  comp_id: comp.id, title: '日历竞赛', phases: [{ phase: '阶段1', date: '', tasks: ['任务A'] }],
}) });
ok('自编竞赛日程', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const schedId = r.data.id;
r = await req(`/schedule/${schedId}/edit`, { method: 'POST', token: tokA, body: JSON.stringify({
  plan_json: { phases: [{ phase: '阶段1', date: '', tasks: [{ text: '任务A', done: true, done_at: TODAY }] }] },
}) });
ok('写入带 done_at 的 plan_json', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
r = await req(`/schedule/calendar?month=${MONTH}`, { token: tokA });
ok('calendar comp 条目', r.data.comp.some((x) => x.task === '任务A' && x.plan_name === comp.name), JSON.stringify(r.data.comp));

// 4) 学习日程：plan_json 带 done_at → study 条目
console.log('— 学习日程（done_at 前端写入）');
r = await req('/study/manual', { method: 'POST', token: tokA, body: JSON.stringify({
  topic: '日历学习', phases: [{ phase: '阶段1', tasks: ['学习任务Y'] }],
}) });
ok('自编学习日程', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const studyId = r.data.id;
r = await req(`/study/${studyId}`, { method: 'POST', token: tokA, body: JSON.stringify({
  plan_json: { phases: [{ phase: '阶段1', tasks: [{ text: '学习任务Y', done: true, done_at: TODAY }] }] },
}) });
ok('学习日程写入 done_at', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
r = await req(`/schedule/calendar?month=${MONTH}`, { token: tokA });
ok('calendar study 条目', r.data.study.some((x) => x.task === '学习任务Y' && x.plan_name === '日历学习'), JSON.stringify(r.data.study));

// 5) 笔记同步
console.log('— 笔记');
r = await req('/notes', { method: 'POST', token: tokA, body: JSON.stringify({ note_date: TODAY, content: '<p>日历冒烟笔记</p>' }) });
ok('写笔记', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
r = await req(`/schedule/calendar?month=${MONTH}`, { token: tokA });
ok('calendar notes 含笔记', r.data.notes.some((n) => n.note_date === TODAY), JSON.stringify(r.data.notes));

// 6) 非法 month → 400
r = await req('/schedule/calendar?month=abc', { token: tokA });
ok('非法 month → 400', r.status === 400, `got ${r.status}`);

// 7) 匿名：只查 'local'
console.log('— 匿名隔离');
r = await req(`/schedule/calendar?month=${MONTH}`);
ok('匿名 team 为空', Array.isArray(r.data.team) && r.data.team.length === 0);
ok('匿名 comp 不含登录用户数据', !r.data.comp.some((x) => x.task === '任务A'));

// 清理
console.log('— 清理');
r = await req(`/team/${teamId}`, { method: 'DELETE', token: tokA });
ok('解散小组', r.status === 200, `got ${r.status}`);
db.prepare("DELETE FROM user_schedule WHERE id = ?").run(schedId);
db.prepare("DELETE FROM user_study WHERE id = ?").run(studyId);
db.prepare("DELETE FROM daily_note WHERE note_date = ? AND user_id = ?").run(TODAY, String(uidA));
db.prepare("DELETE FROM user WHERE username = ?").run(Y + '_a');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
