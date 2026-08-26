// 多次任务冒烟测试（node 内联 fetch，依赖本地后端已启动 :3000）
// 覆盖：normalizePlan 派生校正/清洗（单测）、小组 complete 端点全链路（设定模式/目标次数、完成一次、
//      达标派生 done/done_by/done_at、撤销权限本人/组长、组员设定 403、multi toggle 400、非法 target 400、
//      my-tasks 新字段、月历聚合 multi 完成日、组长全量保存保留、once→multi 迁移、multi→once 清空）、
//      个人 edit 全量保存保留 mode/completions
import db from '../db/database.js';
import { normalizePlan } from '../routes/schedule.js';
import { sanitizeTarget, sanitizeCompletions } from '../routes/taskMeta.js';

const BASE = 'http://localhost:3000/api';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const Y = 'mta_' + Date.now().toString().slice(-6);
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const month = today.slice(0, 7);

// 0) 单测（不依赖服务器，确定性）
console.log('— 单测：normalizePlan / taskMeta');
ok('sanitizeTarget 1-100 整数', sanitizeTarget(3) === 3 && sanitizeTarget(100) === 100 && sanitizeTarget(0) === null && sanitizeTarget(101) === null && sanitizeTarget(3.5) === null, '');
ok('sanitizeCompletions 过滤坏记录', sanitizeCompletions([{ by: '甲', at: today, uid: 1 }, { by: '', at: today }, { by: '乙', at: 'x' }, { by: '丙', at: today }]).length === 2, '');
const np = normalizePlan({ phases: [{ phase: 'p', tasks: [{ text: 't', mode: 'multi', target: 2, completions: [{ by: '甲', at: today, uid: 1 }, { by: '乙', at: today, uid: 2 }] }] }] });
ok('normalizePlan 保留 mode/target/completions + 达标派生 done=true', np.phases[0].tasks[0].mode === 'multi' && np.phases[0].tasks[0].target === 2 && np.phases[0].tasks[0].completions.length === 2 && np.phases[0].tasks[0].done === true, JSON.stringify(np.phases[0].tasks[0]));
const np2 = normalizePlan({ phases: [{ phase: 'p', tasks: [{ text: 't', mode: 'multi', target: 5, completions: [{ by: '甲', at: today }] }] }] });
ok('normalizePlan 未达标 → done=false', np2.phases[0].tasks[0].done === false, '');
const np3 = normalizePlan({ phases: [{ phase: 'p', tasks: ['旧文本任务'] }] });
ok('normalizePlan 字符串任务补默认字段', np3.phases[0].tasks[0].mode === 'once' && np3.phases[0].tasks[0].target === null && Array.isArray(np3.phases[0].tasks[0].completions), JSON.stringify(np3.phases[0].tasks[0]));

// 1) 准备：注册组长 A / 成员 B / 成员 C
console.log('— 准备账号');
let r = await req('/auth/register', { method: 'POST', body: JSON.stringify({ username: Y + '_a', password: 'test123456', email: Y + '_a@test.dev' }) });
ok('注册组长 A', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const tokA = r.data.token;
r = await req('/auth/register', { method: 'POST', body: JSON.stringify({ username: Y + '_b', password: 'test123456', email: Y + '_b@test.dev' }) });
ok('注册成员 B', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const tokB = r.data.token;
r = await req('/auth/register', { method: 'POST', body: JSON.stringify({ username: Y + '_c', password: 'test123456', email: Y + '_c@test.dev' }) });
ok('注册成员 C', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const tokC = r.data.token;

r = await req('/team', { method: 'POST', token: tokA, body: JSON.stringify({ name: Y + '_组' }) });
ok('建组', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const teamId = r.data.id;
const inviteCode = r.data.invite_code;
for (const [tok, who] of [[tokB, 'B'], [tokC, 'C']]) {
  r = await req('/team/join', { method: 'POST', token: tok, body: JSON.stringify({ invite_code: inviteCode }) });
  ok(`${who} 邀请码加入`, r.status === 201, `got ${r.status} ${r.data.error || ''}`);
}

// 2) 小组计划：任务甲（通用）用于多次链路，任务乙（通用）用于 once→multi 迁移
console.log('— 多次任务 complete 端点');
r = await req(`/team/${teamId}/plan`, { method: 'POST', token: tokA, body: JSON.stringify({ title: Y + '_计划', plan_json: { phases: [{ phase: '阶段1', tasks: [{ text: '任务甲' }, { text: '任务乙' }] }] } }) });
ok('组长建计划 → 201', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const pid = r.data.id;

// 3) 组长设定 multi + target=2
r = await req(`/team/${teamId}/plan/${pid}/task/complete`, { method: 'POST', token: tokA, body: JSON.stringify({ phase_idx: 0, task_idx: 0, mode: 'multi', target: 2 }) });
ok('组长设 multi+target=2 → 200', r.status === 200 && r.data.mode === 'multi' && r.data.target === 2, `got ${r.status} ${r.data.error || ''} mode=${r.data.mode} target=${r.data.target}`);
r = await req(`/team/${teamId}/plan/${pid}/task/complete`, { method: 'POST', token: tokB, body: JSON.stringify({ phase_idx: 0, task_idx: 0, mode: 'once' }) });
ok('组员设定 mode → 403', r.status === 403, `got ${r.status}`);
r = await req(`/team/${teamId}/plan/${pid}/task/complete`, { method: 'POST', token: tokA, body: JSON.stringify({ phase_idx: 0, task_idx: 0, mode: 'multi', target: 500 }) });
ok('非法 target=500 → 400', r.status === 400, `got ${r.status}`);

// 4) 完成一次：B → count=1 未达标；C → count=2 达标派生
r = await req(`/team/${teamId}/plan/${pid}/task/complete`, { method: 'POST', token: tokB, body: JSON.stringify({ phase_idx: 0, task_idx: 0, complete: true }) });
ok('B 完成一次 → count=1 done=false（未达标）', r.status === 200 && r.data.count === 1 && r.data.done === false && r.data.completions[0].at === today, `got ${r.status} count=${r.data.count} done=${r.data.done}`);
r = await req(`/team/${teamId}/plan/${pid}/task/complete`, { method: 'POST', token: tokC, body: JSON.stringify({ phase_idx: 0, task_idx: 0, complete: true }) });
ok('C 完成一次 → count=2 done=true（达标派生）', r.status === 200 && r.data.count === 2 && r.data.done === true && r.data.done_by === Y + '_c' && r.data.done_at === today, `got ${r.status} count=${r.data.count} done=${r.data.done} by=${r.data.done_by}`);
ok('完成记录带 uid（撤销权限依据）', r.data.completions[0].uid && r.data.completions[1].uid && r.data.completions[0].uid !== r.data.completions[1].uid, JSON.stringify(r.data.completions));

// 5) 撤销权限：C 撤 B 的记录 403；组长可撤；C 可撤自己的
r = await req(`/team/${teamId}/plan/${pid}/task/complete`, { method: 'POST', token: tokC, body: JSON.stringify({ phase_idx: 0, task_idx: 0, undo: 0 }) });
ok('C 撤销 B 的记录 → 403', r.status === 403, `got ${r.status}`);
r = await req(`/team/${teamId}/plan/${pid}/task/complete`, { method: 'POST', token: tokA, body: JSON.stringify({ phase_idx: 0, task_idx: 0, undo: 0 }) });
ok('组长撤销 index0 → count=1 done=false', r.status === 200 && r.data.count === 1 && r.data.done === false, `got ${r.status} count=${r.data.count} done=${r.data.done}`);
r = await req(`/team/${teamId}/plan/${pid}/task/complete`, { method: 'POST', token: tokC, body: JSON.stringify({ phase_idx: 0, task_idx: 0, undo: 0 }) });
ok('C 撤销自己的记录 → count=0', r.status === 200 && r.data.count === 0 && r.data.done === false, `got ${r.status} count=${r.data.count}`);
r = await req(`/team/${teamId}/plan/${pid}/task/complete`, { method: 'POST', token: tokA, body: JSON.stringify({ phase_idx: 0, task_idx: 0, undo: 5 }) });
ok('撤销越界 → 400', r.status === 400, `got ${r.status}`);

// 6) B 完成两次重新达标 → toggle done 到 multi 任务 400
r = await req(`/team/${teamId}/plan/${pid}/task/complete`, { method: 'POST', token: tokB, body: JSON.stringify({ phase_idx: 0, task_idx: 0, complete: true }) });
r = await req(`/team/${teamId}/plan/${pid}/task/complete`, { method: 'POST', token: tokB, body: JSON.stringify({ phase_idx: 0, task_idx: 0, complete: true }) });
ok('B 完成两次 → count=2 达标 done=true', r.status === 200 && r.data.count === 2 && r.data.done === true, `got ${r.status} count=${r.data.count} done=${r.data.done}`);
r = await req(`/team/${teamId}/plan/${pid}/task`, { method: 'POST', token: tokB, body: JSON.stringify({ phase_idx: 0, task_idx: 0, done: true }) });
ok('toggle 传 done 到 multi 任务 → 400', r.status === 400, `got ${r.status}`);
r = await req(`/team/${teamId}/plan/${pid}/task`, { method: 'POST', token: tokB, body: JSON.stringify({ phase_idx: 0, task_idx: 0, stars: 4 }) });
ok('multi 任务仍可评星（toggle 不带 done）→ 200', r.status === 200 && r.data.stars === 4, `got ${r.status} ${r.data.error || ''}`);

// 7) my-tasks 输出新字段
r = await req('/team/my-tasks', { method: 'GET', token: tokB });
const myT = r.data.find((t) => t.team_id === teamId)?.plans?.find((p) => p.id === pid);
const mtTask = myT?.phases?.[0]?.tasks?.[0];
ok('my-tasks 含 mode/target/completions/count', mtTask?.mode === 'multi' && mtTask?.target === 2 && mtTask?.count === 2 && Array.isArray(mtTask?.completions), JSON.stringify(mtTask));

// 8) 月历聚合：multi 任务每条完成记录聚合一个完成日（B 今天完成 2 次 → team 数组 2 条）
r = await req(`/schedule/calendar?month=${month}`, { method: 'GET', token: tokB });
const calTeam = (r.data.team || []).filter((x) => x.task === '任务甲');
ok('月历聚合 multi 完成日（2 条，含 by）', calTeam.length === 2 && calTeam[0].by === Y + '_b', `got ${calTeam.length} ${JSON.stringify(calTeam[0] || {})}`);

// 9) 组长全量保存（normTeamPlan）保留 mode/target/completions
r = await req(`/team/${teamId}/plan`, { method: 'POST', token: tokA, body: JSON.stringify({ id: pid, title: Y + '_计划', plan_json: { phases: [{ phase: '阶段1', tasks: [{ text: '任务甲', mode: 'multi', target: 2, completions: [{ by: Y + '_b', at: today, uid: 2 }] }, { text: '任务乙' }] }] } }) });
ok('组长全量保存 → 200', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
const planRow = db.prepare('SELECT plan_json FROM team_plan WHERE id = ?').get(pid);
const savedTask = JSON.parse(planRow.plan_json).phases[0].tasks[0];
ok('全量保存后 mode/target/completions 保留', savedTask.mode === 'multi' && savedTask.target === 2 && savedTask.completions?.[0]?.by === Y + '_b', JSON.stringify(savedTask));

// 10) once→multi 迁移 + multi→once 清空（任务乙：先勾选完成再切 multi）
r = await req(`/team/${teamId}/plan/${pid}/task`, { method: 'POST', token: tokA, body: JSON.stringify({ phase_idx: 0, task_idx: 1, done: true }) });
ok('任务乙先勾选完成', r.status === 200 && r.data.done === true, `got ${r.status}`);
const doneAtB = r.data.done_at;
r = await req(`/team/${teamId}/plan/${pid}/task/complete`, { method: 'POST', token: tokA, body: JSON.stringify({ phase_idx: 0, task_idx: 1, mode: 'multi' }) });
ok('once→multi 迁移历史完成 → 1 条记录 target=3 未达标', r.status === 200 && r.data.count === 1 && r.data.target === 3 && r.data.done === false && r.data.completions[0].at === doneAtB, `got ${r.status} count=${r.data.count} done=${r.data.done} ${JSON.stringify(r.data.completions)}`);
r = await req(`/team/${teamId}/plan/${pid}/task/complete`, { method: 'POST', token: tokA, body: JSON.stringify({ phase_idx: 0, task_idx: 1, mode: 'once' }) });
ok('multi→once 清空记录与目标', r.status === 200 && r.data.mode === 'once' && r.data.target === null && r.data.count === 0, `got ${r.status} ${JSON.stringify(r.data)}`);

// 11) 个人链路：edit 全量保存带 mode/completions → list 保留（normalizePlan 输出）
console.log('— 个人计划');
r = await req('/schedule/manual', { method: 'POST', token: tokA, body: JSON.stringify({ title: Y + '_自编', phases: [{ phase: 'P', tasks: ['任务X'] }] }) });
ok('manual 创建 → 201', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const sid = r.data.id;
r = await req(`/schedule/${sid}/edit`, { method: 'POST', token: tokA, body: JSON.stringify({ plan_json: { phases: [{ phase: 'P', tasks: [{ text: '任务X', mode: 'multi', target: 3, completions: [{ by: '我', at: today, uid: null }] }] }] } }) });
ok('edit 保存 multi 任务 → 200', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
r = await req('/schedule/list', { method: 'GET', token: tokA });
const sRow = r.data.find((s) => s.id === sid);
const st = sRow?.plan?.phases?.[0]?.tasks?.[0];
ok('list 保留 mode/target/completions', st?.mode === 'multi' && st?.target === 3 && st?.completions?.[0]?.by === '我' && st?.completions?.[0]?.at === today, JSON.stringify(st));

// 12) 清理
console.log('— 清理');
r = await req(`/team/${teamId}`, { method: 'DELETE', token: tokA });
ok('解散小组', r.status === 200, `got ${r.status}`);
db.prepare('DELETE FROM user_schedule WHERE id = ?').run(sid);
db.prepare('DELETE FROM user WHERE username IN (?, ?, ?)').run(Y + '_a', Y + '_b', Y + '_c');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
