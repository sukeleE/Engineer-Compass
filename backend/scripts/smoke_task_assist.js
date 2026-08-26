// 任务面板冒烟测试（node 内联 fetch，依赖本地后端已启动 :3000）
// 覆盖：normalizePlan/finalizeTaskAssist 单测（免服务器）、task-assist 接口（形状断言，.env 有真实 key 会真调 AI）、
//      小组 toggle 只改评星不碰 done/done_by、非法 stars 400、links 存活、my-tasks 输出新字段、
//      组员 split 403 / 组长 split 原位替换、组长全量保存保留 stars/links、个人 edit 全量保存后 normalizePlan 输出保留
import db from '../db/database.js';
import { normalizePlan } from '../routes/schedule.js';
import { finalizeTaskAssist } from '../routes/taskAssist.js';

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

const Y = 'tsk_' + Date.now().toString().slice(-6);

// 0) 单测（不依赖服务器/AI，确定性）
console.log('— 单测：normalizePlan / finalizeTaskAssist');
const np = normalizePlan({ phases: [{ phase: 'p', tasks: [{ text: 't', stars: 3, links: [{ title: '教程', url: 'https://a.com' }] }] }] });
ok('normalizePlan 保留 stars/links', np.phases[0].tasks[0].stars === 3 && np.phases[0].tasks[0].links[0]?.url === 'https://a.com', JSON.stringify(np.phases[0].tasks[0]));
const npBad = normalizePlan({ phases: [{ phase: 'p', tasks: [{ text: 't', stars: 9, links: [{ url: 'javascript:x' }, { url: 'ftp://x' }, { url: 'https://ok.com' }] }] }] });
ok('normalizePlan 清洗非法 stars/非http链接', npBad.phases[0].tasks[0].stars === null && npBad.phases[0].tasks[0].links.length === 1, JSON.stringify(npBad.phases[0].tasks[0]));
const d1 = finalizeTaskAssist('任务X', null);
ok('finalizeTaskAssist 降级：subtasks=[原任务] + 8 平台资源', d1.subtasks.length === 1 && d1.subtasks[0] === '任务X' && d1.degraded === true && d1.resources.length === 8, `sub=${JSON.stringify(d1.subtasks)} res=${d1.resources.length}`);
const d2 = finalizeTaskAssist('任务X', { subtasks: ['子1', '子2', ''], keywords: ['k1', 'k2', 'k3', 'k4', 'k5'] });
ok('finalizeTaskAssist 正常：过滤空子任务 + 关键词限4 + 资源 8+4×3', d2.subtasks.length === 2 && d2.keywords.length === 4 && d2.resources.length === 8 + 4 * 3 && !d2.degraded, `sub=${d2.subtasks.length} kw=${d2.keywords.length} res=${d2.resources.length}`);
const d3 = finalizeTaskAssist('任务X', { subtasks: [], keywords: [] });
ok('finalizeTaskAssist 空子任务 → 降级保留原任务', d3.subtasks.length === 1 && d3.subtasks[0] === '任务X', JSON.stringify(d3.subtasks));
const d4 = finalizeTaskAssist('任务X', { subtasks: ['子1'], keywords: [] });
ok('finalizeTaskAssist 无关键词 → 仅主主题 8 条', d4.resources.length === 8, `res=${d4.resources.length}`);

// 1) task-assist 接口（形状断言：有 key 真调 AI，无 key/失败也走 200 降级）
console.log('— HTTP /ai/task-assist');
let r = await req('/ai/task-assist', { method: 'POST', body: JSON.stringify({ task_text: '' }) });
ok('空 task_text → 400', r.status === 400, `got ${r.status}`);
r = await req('/ai/task-assist', { method: 'POST', body: JSON.stringify({ task_text: '学习STM32 GPIO配置' }) }, 120000);
ok('task-assist → 200 且 subtasks 非空字符串数组', r.status === 200 && Array.isArray(r.data.subtasks) && r.data.subtasks.length >= 1 && r.data.subtasks.every((s) => typeof s === 'string' && s.trim()), `got ${r.status} ${r.data.error || ''}`);
ok('task-assist → resources ≥ 8 且每条含 url', Array.isArray(r.data.resources) && r.data.resources.length >= 8 && r.data.resources.every((x) => x.url?.startsWith('http')), `res=${r.data.resources?.length}`);
if (r.data.degraded) console.log('  ℹ️ 降级模式（AI 不可用）：' + (r.data.hint || ''));

// 2) 准备：注册组长 A / 组员 B
console.log('— 准备账号');
r = await req('/auth/register', { method: 'POST', body: JSON.stringify({ username: Y + '_a', password: 'test123456', email: Y + '_a@test.dev' }) });
ok('注册组长 A', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const tokA = r.data.token;
r = await req('/auth/register', { method: 'POST', body: JSON.stringify({ username: Y + '_b', password: 'test123456', email: Y + '_b@test.dev' }) });
ok('注册组员 B', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const tokB = r.data.token;

r = await req('/team', { method: 'POST', token: tokA, body: JSON.stringify({ name: Y + '_组' }) });
ok('建组', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const teamId = r.data.id;
r = await req('/team/join', { method: 'POST', token: tokB, body: JSON.stringify({ invite_code: r.data.invite_code }) });
ok('B 邀请码加入', r.status === 201, `got ${r.status} ${r.data.error || ''}`);

// 3) 小组计划：组长全量建确定性计划（含 stars/links，验证 normTeamPlan 保留）
console.log('— 小组计划保存与勾选');
const planBody = { phases: [{ phase: '阶段1', tasks: [{ text: '任务甲', dept: '通用', stars: 4, links: [{ title: '教程', url: 'https://a.com' }] }, { text: '任务乙' }] }] };
r = await req(`/team/${teamId}/plan`, { method: 'POST', token: tokA, body: JSON.stringify({ title: Y + '_计划', plan_json: planBody }) });
ok('组长建计划 → 201', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const pid = r.data.id;
let planRow = db.prepare('SELECT plan_json FROM team_plan WHERE id = ?').get(pid);
ok('normTeamPlan 保留 stars/links', JSON.parse(planRow.plan_json).phases[0].tasks[0].stars === 4 && JSON.parse(planRow.plan_json).phases[0].tasks[0].links[0]?.url === 'https://a.com', JSON.stringify(JSON.parse(planRow.plan_json).phases[0].tasks[0]));

// B 勾选任务甲（通用任务全员可勾）
r = await req(`/team/${teamId}/plan/${pid}/task`, { method: 'POST', token: tokB, body: JSON.stringify({ phase_idx: 0, task_idx: 0, done: true }) });
ok('B 勾选 → 200 + done_by', r.status === 200 && r.data.done === true && !!r.data.done_by, `got ${r.status} ${r.data.error || ''} done_by=${r.data.done_by}`);
const doneByB = r.data.done_by;

// A 只传 stars（不传 done）→ done/done_by 不得被改动（undefined 守卫）
r = await req(`/team/${teamId}/plan/${pid}/task`, { method: 'POST', token: tokA, body: JSON.stringify({ phase_idx: 0, task_idx: 0, stars: 2 }) });
ok('只传 stars → 200 且 done 保持 true', r.status === 200 && r.data.done === true && r.data.stars === 2, `got ${r.status} done=${r.data.done} stars=${r.data.stars}`);
ok('只传 stars → done_by 仍是 B（未覆盖完成人）', r.data.done_by === doneByB, `got ${r.data.done_by} want ${doneByB}`);

// 非法 stars → 400
r = await req(`/team/${teamId}/plan/${pid}/task`, { method: 'POST', token: tokA, body: JSON.stringify({ phase_idx: 0, task_idx: 0, stars: 9 }) });
ok('stars=9 → 400', r.status === 400, `got ${r.status}`);

// links 全量替换
r = await req(`/team/${teamId}/plan/${pid}/task`, { method: 'POST', token: tokA, body: JSON.stringify({ phase_idx: 0, task_idx: 0, links: [{ url: 'https://b.com' }, { url: 'javascript:x' }] }) });
ok('links 更新 → 200 且清洗非法项', r.status === 200 && r.data.links.length === 1 && r.data.links[0].url === 'https://b.com', `got ${r.status} ${JSON.stringify(r.data.links)}`);
planRow = db.prepare('SELECT plan_json FROM team_plan WHERE id = ?').get(pid);
ok('links 落库存活', JSON.parse(planRow.plan_json).phases[0].tasks[0].links?.[0]?.url === 'https://b.com', '');

// my-tasks 输出含 stars/links
r = await req('/team/my-tasks', { method: 'GET', token: tokA });
const myT = r.data.find((t) => t.team_id === teamId)?.plans?.find((p) => p.id === pid);
ok('my-tasks 输出含 stars/links 与原始下标', !!myT && myT.phases[0].tasks[0].stars === 2 && myT.phases[0].tasks[0].links?.[0]?.url === 'https://b.com' && myT.phases[0].tasks[0].task_idx === 0 && myT.phases[0].tasks[0].done === true, JSON.stringify(myT?.phases?.[0]?.tasks?.[0]));

// 4) split：组员 403 / 组长 200 原位替换
console.log('— 拆分任务');
r = await req(`/team/${teamId}/plan/${pid}/task/split`, { method: 'POST', token: tokB, body: JSON.stringify({ phase_idx: 0, task_idx: 0, subtasks: ['子1', '子2'] }) });
ok('组员 split → 403', r.status === 403, `got ${r.status}`);
r = await req(`/team/${teamId}/plan/${pid}/task/split`, { method: 'POST', token: tokA, body: JSON.stringify({ phase_idx: 0, task_idx: 0, subtasks: ['子1', '子2', '子3', ''] }) });
ok('组长 split → 200 count=3（空串过滤）', r.status === 200 && r.data.count === 3, `got ${r.status} ${r.data.error || ''} count=${r.data.count}`);
planRow = db.prepare('SELECT plan_json FROM team_plan WHERE id = ?').get(pid);
const ph0 = JSON.parse(planRow.plan_json).phases[0].tasks;
ok('split 原位替换（3子任务 + 原任务乙）', ph0.length === 4 && ph0[0].text === '子1' && ph0[1].text === '子2' && ph0[2].text === '子3' && ph0[3].text === '任务乙', JSON.stringify(ph0.map((t) => t.text)));
ok('子任务继承 dept=通用 且 done 重置', ph0[0].dept === '通用' && ph0[0].done === false, JSON.stringify(ph0[0]));
r = await req(`/team/${teamId}/plan/${pid}/task/split`, { method: 'POST', token: tokA, body: JSON.stringify({ phase_idx: 0, task_idx: 9, subtasks: ['x'] }) });
ok('split 越界任务 → 400', r.status === 400, `got ${r.status}`);
r = await req(`/team/${teamId}/plan/${pid}/task/split`, { method: 'POST', token: tokA, body: JSON.stringify({ phase_idx: 0, task_idx: 0, subtasks: [] }) });
ok('split 空 subtasks → 400', r.status === 400, `got ${r.status}`);

// 5) 组长全量保存（覆盖保存）→ stars/links 保留（normTeamPlan）
console.log('— 组长全量保存');
r = await req(`/team/${teamId}/plan`, { method: 'POST', token: tokA, body: JSON.stringify({ id: pid, title: Y + '_计划', plan_json: { phases: [{ phase: '阶段1', tasks: [{ text: '任务丙', dept: '通用', stars: 5, links: [{ url: 'https://c.com', title: '资料' }] }] }] } }) });
ok('组长全量保存 → 200', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
planRow = db.prepare('SELECT plan_json FROM team_plan WHERE id = ?').get(pid);
ok('全量保存后 stars/links 保留', JSON.parse(planRow.plan_json).phases[0].tasks[0].stars === 5 && JSON.parse(planRow.plan_json).phases[0].tasks[0].links[0]?.url === 'https://c.com', JSON.stringify(JSON.parse(planRow.plan_json).phases[0].tasks[0]));

// 6) 个人链路：edit 全量保存带新字段 → list（normalizePlan 输出）保留
console.log('— 个人计划');
r = await req('/schedule/manual', { method: 'POST', token: tokA, body: JSON.stringify({ title: Y + '_自编', phases: [{ phase: 'P', tasks: ['任务X'] }] }) });
ok('manual 创建 → 201', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const sid = r.data.id;
r = await req(`/schedule/${sid}/edit`, { method: 'POST', token: tokA, body: JSON.stringify({ plan_json: { phases: [{ phase: 'P', tasks: [{ text: '任务X', stars: 4, links: [{ url: 'https://x.com' }] }] }] } }) });
ok('edit 保存 → 200', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
r = await req('/schedule/list', { method: 'GET', token: tokA });
const sRow = r.data.find((s) => s.id === sid);
ok('list（normalizePlan 输出）保留 stars/links', sRow?.plan?.phases[0].tasks[0].stars === 4 && sRow?.plan?.phases[0].tasks[0].links[0]?.url === 'https://x.com', JSON.stringify(sRow?.plan?.phases[0].tasks[0]));

// 7) 清理
console.log('— 清理');
r = await req(`/team/${teamId}`, { method: 'DELETE', token: tokA });
ok('解散小组', r.status === 200, `got ${r.status}`);
db.prepare('DELETE FROM user_schedule WHERE id = ?').run(sid);
db.prepare('DELETE FROM user WHERE username IN (?, ?)').run(Y + '_a', Y + '_b');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
