// 小组 AI 备赛计划接口冒烟测试（node 内联 fetch，中文无 GBK 问题）
// 覆盖：建组/入组/角色、组长生成计划、确定性计划替换、部门勾选限权（403 负例）、
//      done_by 完成人（勾选/取消/编辑保留）、组长例外、my-tasks 个人聚合过滤、无编辑权限、删除
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

const Y = 'tp_' + Date.now().toString().slice(-6);
let teamId = null, planId = null, phaseCount = 0;

// 0) 找一个 active 竞赛
console.log('— 准备');
let r = await req('/competition?status=active');
ok('有 active 竞赛数据', Array.isArray(r.data) && r.data.length > 0, `got ${r.status}`);
const comp = r.data[0];

// 1) 注册组长 + 组员
r = await req('/auth/register', { method: 'POST', body: JSON.stringify({ username: Y + '_a', password: 'test123456' }) });
ok('注册组长', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const tokA = r.data.token;
const unameA = r.data.user.username;
r = await req('/auth/register', { method: 'POST', body: JSON.stringify({ username: Y + '_b', password: 'test123456' }) });
ok('注册组员', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const tokB = r.data.token;
const uidB = r.data.user.id;
const unameB = r.data.user.username;

// 2) 建组 + 邀请码加入
r = await req('/team', { method: 'POST', token: tokA, body: JSON.stringify({ name: Y, desc: '冒烟小组' }) });
ok('组长建组', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
teamId = r.data.id;
const invite = r.data.invite_code;
r = await req('/team/join', { method: 'POST', token: tokB, body: JSON.stringify({ invite_code: invite }) });
ok('组员邀请码加入', r.status === 201, `got ${r.status} ${r.data.error || ''}`);

// 3) 建部门角色「机械组」（B 归入）+「电控组」（权限负例用）
r = await req(`/team/${teamId}/role`, { method: 'POST', token: tokA, body: JSON.stringify({ name: '机械组', level: 5, permissions: ['progress'] }) });
ok('建角色「机械组」', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const mechRoleId = r.data.id;
r = await req(`/team/${teamId}/role`, { method: 'POST', token: tokA, body: JSON.stringify({ name: '电控组', level: 4, permissions: ['progress'] }) });
ok('建角色「电控组」', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
r = await req(`/team/${teamId}/member`, { method: 'POST', token: tokA, body: JSON.stringify({ user_id: uidB, role_id: mechRoleId }) });
ok('B 设为机械组', r.status === 200, `got ${r.status} ${r.data.error || ''}`);

// 4) 组长 AI 生成小组计划（无 DeepSeek key 时走子赛项模板兜底）
console.log('— 计划生成');
r = await req(`/team/${teamId}/plan/generate`, { method: 'POST', token: tokA, body: JSON.stringify({ comp_id: comp.id }) }, 100000);
ok('组长生成计划 → 201', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
planId = r.data.id;
const plan0 = r.data.plan;
phaseCount = (plan0.phases || []).length;
ok('计划含阶段', phaseCount > 0);
const tasks0 = (plan0.phases || []).flatMap((p) => p.tasks || []);
ok('任务均带 dept 部门字段', tasks0.length > 0 && tasks0.every((t) => t.dept && String(t.dept).trim() !== ''), JSON.stringify(tasks0.slice(0, 2)));

// 4.5) 组长用编辑接口替换为确定性计划（任务下标固定 0/1/2，后续断言不依赖 AI 输出）
//      phases[0].tasks = [机械组, 通用, 电控组]
console.log('— 确定性计划');
const fixedPlan = {
  phases: [{
    phase: '阶段1', date: '2026-08-01 ~ 08-31', check_standard: '达标', week_hours: 10,
    tasks: [
      { text: '机械组任务', dept: '机械组' },
      { text: '通用任务', dept: '通用' },
      { text: '电控组任务', dept: '电控组' },
    ],
  }],
};
r = await req(`/team/${teamId}/plan`, { method: 'POST', token: tokA,
  body: JSON.stringify({ id: planId, title: '冒烟计划', plan_json: fixedPlan }) });
ok('替换为确定性计划 → 200', r.status === 200, `got ${r.status} ${r.data.error || ''}`);

// 5) 部门勾选限权 + 完成人
console.log('— 成员跟进（部门限权）');
// 5a) B 勾本部门（机械组）任务 → 成功 + 完成人为 B
r = await req(`/team/${teamId}/plan/${planId}/task`, { method: 'POST', token: tokB,
  body: JSON.stringify({ phase_idx: 0, task_idx: 0, done: true }) });
ok('B 勾机械组任务（本部门）→ 200', r.status === 200 && r.data.done === true, `got ${r.status} ${r.data.error || ''}`);
ok('响应带完成人 done_by=B', r.data.done_by === unameB, `got ${r.data.done_by}`);
r = await req(`/team/${teamId}/plan`, { token: tokA });
const list1 = r.data.find((p) => p.id === planId);
ok('列表反映勾选 + 完成人', list1?.plan?.phases?.[0]?.tasks?.[0]?.done === true && list1?.plan?.phases?.[0]?.tasks?.[0]?.done_by === unameB);

// 5b) B 勾电控组任务（非本部门）→ 403
r = await req(`/team/${teamId}/plan/${planId}/task`, { method: 'POST', token: tokB,
  body: JSON.stringify({ phase_idx: 0, task_idx: 2, done: true }) });
ok('B 勾电控组任务（非本部门）→ 403', r.status === 403 && String(r.data.error || '').includes('电控组'), `got ${r.status} ${r.data.error || ''}`);

// 5c) B 取消勾选 → done=false 且完成人清空
r = await req(`/team/${teamId}/plan/${planId}/task`, { method: 'POST', token: tokB,
  body: JSON.stringify({ phase_idx: 0, task_idx: 0, done: false }) });
ok('B 取消勾选 → 200 且完成人清空', r.status === 200 && r.data.done === false && r.data.done_by === null, `got ${r.status} ${r.data.error || ''} done_by=${r.data.done_by}`);

// 5d) B 重新勾选机械组 + 勾通用任务（全员可勾）
r = await req(`/team/${teamId}/plan/${planId}/task`, { method: 'POST', token: tokB,
  body: JSON.stringify({ phase_idx: 0, task_idx: 0, done: true }) });
ok('B 再勾机械组 → 200', r.status === 200 && r.data.done === true, `got ${r.status}`);
r = await req(`/team/${teamId}/plan/${planId}/task`, { method: 'POST', token: tokB,
  body: JSON.stringify({ phase_idx: 0, task_idx: 1, done: true }) });
ok('B 勾通用任务（全员）→ 200', r.status === 200 && r.data.done === true, `got ${r.status} ${r.data.error || ''}`);

// 5e) 组长例外：A（无部门）可勾电控组任务
r = await req(`/team/${teamId}/plan/${planId}/task`, { method: 'POST', token: tokA,
  body: JSON.stringify({ phase_idx: 0, task_idx: 2, done: true }) });
ok('组长 A 勾电控组任务（例外）→ 200', r.status === 200 && r.data.done === true && r.data.done_by === unameA, `got ${r.status} ${r.data.error || ''}`);

// 6) 成员无编辑权限
console.log('— 权限');
r = await req(`/team/${teamId}/plan`, { method: 'POST', token: tokB,
  body: JSON.stringify({ id: planId, title: 'hack', plan_json: { phases: [{ phase: 'x', tasks: [{ text: 'y', dept: '机械组' }] }] } }) });
ok('B 保存计划 → 403', r.status === 403, `got ${r.status}`);
r = await req(`/team/${teamId}/plan/generate`, { method: 'POST', token: tokB, body: JSON.stringify({ comp_id: comp.id }) });
ok('B 生成计划 → 403', r.status === 403, `got ${r.status}`);
r = await req(`/team/${teamId}/plan/${planId}`, { method: 'DELETE', token: tokB });
ok('B 删除计划 → 403', r.status === 403, `got ${r.status}`);

// 7) 组长编辑（基于最新列表快照改任务文字；完成人 done_by 必须保留——normTeamPlan 保留验证）
console.log('— 组长编辑');
r = await req(`/team/${teamId}/plan`, { token: tokA });
const latest = r.data.find((p) => p.id === planId);
const editPlan = { phases: latest.plan.phases.map((p) => ({ ...p, tasks: p.tasks.map((t, i) => (i === 0 ? { ...t, text: t.text + '（修订）' } : t)) })) };
r = await req(`/team/${teamId}/plan`, { method: 'POST', token: tokA,
  body: JSON.stringify({ id: planId, title: '修订后计划', plan_json: editPlan }) });
ok('A 编辑保存 → 200', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
r = await req(`/team/${teamId}/plan`, { token: tokA });
const list2 = r.data.find((p) => p.id === planId);
ok('标题已改', list2?.title === '修订后计划');
ok('任务文字已改且进度保留', (list2?.plan?.phases?.[0]?.tasks?.[0]?.text || '').includes('修订') && list2?.plan?.phases?.[0]?.tasks?.[0]?.done === true);
ok('完成人编辑后保留', list2?.plan?.phases?.[0]?.tasks?.[0]?.done_by === unameB && list2?.plan?.phases?.[0]?.tasks?.[2]?.done_by === unameA);

// 7.5) 个人页聚合：GET /team/my-tasks（服务端按角色过滤 + 原始下标）
console.log('— 我的小组任务聚合');
r = await req('/team/my-tasks', { token: tokB });
const mtB = r.data.find((t) => t.team_id === teamId);
const mtBTasks = mtB?.plans?.[0]?.phases?.[0]?.tasks || [];
ok('B 聚合含小组', !!mtB, `got ${r.status}`);
ok('B 聚合看到全部部门任务', mtBTasks.length === 3 && mtBTasks.every((t) => ['机械组', '通用', '电控组'].includes(t.dept)), JSON.stringify(mtBTasks.map((t) => t.dept)));
ok('B 聚合任务带原始下标', mtBTasks[0]?.task_idx === 0 && mtBTasks[1]?.task_idx === 1 && mtBTasks[2]?.task_idx === 2, JSON.stringify(mtBTasks.map((t) => t.task_idx)));
ok('B 聚合任务带完成人', mtBTasks[0]?.done_by === unameB);
r = await req('/team/my-tasks', { token: tokA });
const mtA = r.data.find((t) => t.team_id === teamId);
const mtATasks = mtA?.plans?.[0]?.phases?.[0]?.tasks || [];
ok('组长 A 聚合看到全部部门任务', mtATasks.length === 3 && mtATasks.every((t) => ['机械组', '通用', '电控组'].includes(t.dept)), JSON.stringify(mtATasks.map((t) => t.dept)));

// 8) 删除
console.log('— 删除');
r = await req(`/team/${teamId}/plan/${planId}`, { method: 'DELETE', token: tokA });
ok('A 删除计划 → 200', r.status === 200, `got ${r.status}`);
r = await req(`/team/${teamId}/plan`, { token: tokA });
ok('列表已空', !r.data.some((p) => p.id === planId));

// 9) cleanup：解散小组（级联删除 team_plan）+ 删测试账号
r = await req(`/team/${teamId}`, { method: 'DELETE', token: tokA });
ok('解散小组', r.status === 200);
db.prepare('DELETE FROM user WHERE username LIKE ?').run(Y + '_%');

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
