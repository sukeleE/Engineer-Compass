// 小组 AI 备赛计划接口冒烟测试（node 内联 fetch，中文无 GBK 问题）
// 覆盖：建组/入组/角色、组长生成计划、成员勾选任务、成员无编辑权限、组长编辑、删除
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
let teamId = null, planId = null, phaseCount = 0, taskAIdx = null, taskBIdx = null;

// 0) 找一个 active 竞赛
console.log('— 准备');
let r = await req('/competition?status=active');
ok('有 active 竞赛数据', Array.isArray(r.data) && r.data.length > 0, `got ${r.status}`);
const comp = r.data[0];

// 1) 注册组长 + 组员
r = await req('/auth/register', { method: 'POST', body: JSON.stringify({ username: Y + '_a', password: 'test123456' }) });
ok('注册组长', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const tokA = r.data.token;
r = await req('/auth/register', { method: 'POST', body: JSON.stringify({ username: Y + '_b', password: 'test123456' }) });
ok('注册组员', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const tokB = r.data.token;
const uidB = r.data.user.id;

// 2) 建组 + 邀请码加入
r = await req('/team', { method: 'POST', token: tokA, body: JSON.stringify({ name: Y, desc: '冒烟小组' }) });
ok('组长建组', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
teamId = r.data.id;
const invite = r.data.invite_code;
r = await req('/team/join', { method: 'POST', token: tokB, body: JSON.stringify({ invite_code: invite }) });
ok('组员邀请码加入', r.status === 201, `got ${r.status} ${r.data.error || ''}`);

// 3) 组长建部门角色「机械组」+ 把 B 设为机械组
r = await req(`/team/${teamId}/role`, { method: 'POST', token: tokA, body: JSON.stringify({ name: '机械组', level: 5, permissions: ['progress'] }) });
ok('建角色「机械组」', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const mechRoleId = r.data.id;
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
ok('dept 来自部门或通用', tasks0.every((t) => t.dept === '机械组' || t.dept === '通用'), JSON.stringify([...new Set(tasks0.map((t) => t.dept))]));
taskAIdx = tasks0.findIndex((t) => t.dept === '机械组');
taskBIdx = tasks0.findIndex((t) => t.dept === '通用');

// 5) 成员 B 勾选任务（多部门跟进）
console.log('— 成员跟进');
const ph0 = plan0.phases[0];
r = await req(`/team/${teamId}/plan/${planId}/task`, { method: 'POST', token: tokB,
  body: JSON.stringify({ phase_idx: 0, task_idx: taskAIdx, done: true }) });
ok('B 勾选机械组任务', r.status === 200 && r.data.done === true, `got ${r.status} ${r.data.error || ''}`);
r = await req(`/team/${teamId}/plan`, { token: tokA });
const list1 = r.data.find((p) => p.id === planId);
ok('列表反映勾选进度', list1?.plan?.phases?.[0]?.tasks?.[taskAIdx]?.done === true);

// 6) 成员无编辑权限
r = await req(`/team/${teamId}/plan`, { method: 'POST', token: tokB,
  body: JSON.stringify({ id: planId, title: 'hack', plan_json: { phases: [{ phase: 'x', tasks: [{ text: 'y', dept: '机械组' }] }] } }) });
ok('B 保存计划 → 403', r.status === 403, `got ${r.status}`);
r = await req(`/team/${teamId}/plan/generate`, { method: 'POST', token: tokB, body: JSON.stringify({ comp_id: comp.id }) });
ok('B 生成计划 → 403', r.status === 403, `got ${r.status}`);
r = await req(`/team/${teamId}/plan/${planId}`, { method: 'DELETE', token: tokB });
ok('B 删除计划 → 403', r.status === 403, `got ${r.status}`);

// 7) 组长编辑（基于最新列表快照改任务文字 + 改标题；成员勾选进度须保留）
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
ok('任务文字已改且进度保留', (list2?.plan?.phases?.[0]?.tasks?.[0]?.text || '').includes('修订') && list2?.plan?.phases?.[0]?.tasks?.[taskAIdx]?.done === true);

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
