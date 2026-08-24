// AI 智能建组 + 智能分组接口冒烟测试（node 内联 fetch，中文无 GBK 问题）
// 覆盖：建组带竞赛（AI 拆部门或模板兜底，均须产出计划）、手动补部门后 AI 分组建议、成员无 member 权限被拒
import db from '../db/database.js';

const BASE = 'http://localhost:3000/api';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

async function req(path, opts = {}, timeoutMs = 0) {
  const res = await fetch(BASE + path, {
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const Y = 'tai_' + Date.now().toString().slice(-6);
let teamId = null;

// 0) 竞赛
let r = await req('/competition?status=active');
ok('有 active 竞赛', Array.isArray(r.data) && r.data.length > 0);
const comp = r.data[0];

// 1) 注册组长 + 组员
r = await req('/auth/register', { method: 'POST', body: JSON.stringify({ username: Y + '_a', password: 'test123456', email: Y + '_a@test.dev' }) });
ok('注册组长', r.status === 201, `got ${r.status}`);
const tokA = r.data.token;
r = await req('/auth/register', { method: 'POST', body: JSON.stringify({ username: Y + '_b', password: 'test123456', email: Y + '_b@test.dev' }) });
ok('注册组员', r.status === 201, `got ${r.status}`);
const tokB = r.data.token;
const uidB = r.data.user.id;

// 2) 建组 + 选择竞赛 → AI 智能拆解（有 key 走 AI 出部门；无 key/异常走模板，均须产出计划）
console.log('— AI 智能建组');
r = await req('/team', { method: 'POST', token: tokA,
  body: JSON.stringify({ name: Y, desc: 'AI建组冒烟', comp_id: comp.id }) }, 100000);
ok('建组带竞赛 → 201', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
teamId = r.data.id;
const createRes = r.data;
ok('返回邀请码与组长', !!createRes.invite_code && createRes.owner_id !== undefined);
ok('产出小组计划（plan_id）', !!createRes.plan_id, `plan_id=${createRes.plan_id}`);
if (createRes.ai_depts?.length) {
  console.log(`  ℹ️  AI 拆分部门：${createRes.ai_depts.join('、')}`);
  ok('AI 部门已建为角色', createRes.roles.some((x) => createRes.ai_depts.includes(x.name)));
  // 计划任务 dept 应匹配部门或通用
  r = await req(`/team/${teamId}/plan`, { token: tokA });
  const plan = r.data.find((p) => p.id === createRes.plan_id) || r.data[0];
  const tasks = (plan?.plan?.phases || []).flatMap((p) => p.tasks || []);
  ok('计划任务 dept 来自部门或通用', tasks.length > 0 && tasks.every((t) => createRes.ai_depts.includes(t.dept) || t.dept === '通用'),
    JSON.stringify([...new Set(tasks.map((t) => t.dept))]));
} else {
  console.log('  ℹ️  AI 服务不可用，走子赛项模板兜底（dept=通用）');
  ok('模板兜底标记', createRes.template === true);
}

// 3) 组员加入
r = await req('/team/join', { method: 'POST', token: tokB, body: JSON.stringify({ invite_code: createRes.invite_code }) });
ok('组员加入', r.status === 201, `got ${r.status}`);
// 手动补一个部门（保证分组接口有目标；AI 已拆部门时也无妨）
r = await req(`/team/${teamId}/role`, { method: 'POST', token: tokA, body: JSON.stringify({ name: '电控组', level: 5, permissions: ['progress'] }) });
ok('补建部门「电控组」', r.status === 201, `got ${r.status} ${r.data.error || ''}`);

// 4) AI 智能分组（组长，member 权限）
console.log('— AI 智能分组');
r = await req(`/team/${teamId}/ai-grouping`, { method: 'POST', token: tokA }, 100000);
ok('组长调分组 → 200', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
if (r.data.assignments?.length) {
  ok('建议均指向已有部门', r.data.assignments.every((a) => a.suggest_role_id && a.user_id === uidB),
    JSON.stringify(r.data.assignments));
  console.log(`  ℹ️  建议：${r.data.assignments.map((a) => `${a.nickname}→${a.suggest_role}`).join('，')}`);
} else {
  console.log(`  ℹ️  ${r.data.message || '无建议'}`);
  ok('无建议时消息提示', !!r.data.message);
}

// 5) 组员无 member 权限 → 403
r = await req(`/team/${teamId}/ai-grouping`, { method: 'POST', token: tokB });
ok('组员调分组 → 403', r.status === 403, `got ${r.status}`);

// 6) cleanup：解散小组（级联 team_role/team_plan）+ 删账号
r = await req(`/team/${teamId}`, { method: 'DELETE', token: tokA });
ok('解散小组', r.status === 200);
db.prepare('DELETE FROM user WHERE username LIKE ?').run(Y + '_%');

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
