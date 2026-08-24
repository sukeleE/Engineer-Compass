// 成员多角色冒烟测试（node 内联 fetch）
// 覆盖：join 默认组员角色入桥表、组长数组分配（≤3）、第三角色 400、
//      成员自选 self-role、组长多角色（自选 + 被分配）、权限并集（两角色任一权限可用）、旧单角色兼容、
//      角色删除清理桥表、转让组长保留角色、GET /:id members 聚合、my-tasks role_names
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

const Y = 'mr_' + Date.now().toString().slice(-6);

// 1) 注册组长 A + 组员 B + 组员 C（无角色操作权限）
console.log('— 准备');
let r = await req('/auth/register', { method: 'POST', body: JSON.stringify({ username: Y + '_a', password: 'test123456', email: Y + '_a@test.dev' }) });
ok('注册组长', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const tokA = r.data.token;
const uidA = r.data.user.id;
r = await req('/auth/register', { method: 'POST', body: JSON.stringify({ username: Y + '_b', password: 'test123456', email: Y + '_b@test.dev' }) });
ok('注册组员B', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const tokB = r.data.token;
const uidB = r.data.user.id;
r = await req('/auth/register', { method: 'POST', body: JSON.stringify({ username: Y + '_c', password: 'test123456', email: Y + '_c@test.dev' }) });
ok('注册组员C', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const tokC = r.data.token;
const uidC = r.data.user.id;

// 2) 建组 + 邀请码加入（B/C）
r = await req('/team', { method: 'POST', token: tokA, body: JSON.stringify({ name: Y, desc: '多角色冒烟' }) });
ok('组长建组', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const teamId = r.data.id;
const invite = r.data.invite_code;
r = await req('/team/join', { method: 'POST', token: tokB, body: JSON.stringify({ invite_code: invite }) });
ok('B 加入', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
r = await req('/team/join', { method: 'POST', token: tokC, body: JSON.stringify({ invite_code: invite }) });
ok('C 加入', r.status === 201, `got ${r.status} ${r.data.error || ''}`);

// 3) 角色：机械组(progress)、电控组(message)、软件组(task)、资料组(file_upload)
const roleIds = {};
for (const [name, perms] of [['机械组', ['progress']], ['电控组', ['message']], ['软件组', ['task']], ['资料组', ['file_upload']]]) {
  r = await req(`/team/${teamId}/role`, { method: 'POST', token: tokA, body: JSON.stringify({ name, level: 3, permissions: perms }) });
  ok(`建角色「${name}」`, r.status === 201, `got ${r.status} ${r.data.error || ''}`);
  roleIds[name] = r.data.id;
}
// 默认「组员」角色：建组时自动创建，重复建 → 409（证明已存在）
r = await req(`/team/${teamId}/role`, { method: 'POST', token: tokA, body: JSON.stringify({ name: '组员', level: 1, permissions: [] }) });
ok('「组员」角色已存在（建组自动创建，重复建 409）', r.status === 409, `got ${r.status} ${r.data.error || ''}`);

// 4) join 默认角色入桥表：B 应有「组员」
console.log('— join 默认角色');
r = await req(`/team/${teamId}`, { token: tokB });
const b0 = r.data.members.find((m) => m.id === uidB);
ok('B 加入即带「组员」角色（role_names）', Array.isArray(b0.role_names) && b0.role_names.includes('组员'), JSON.stringify(b0.role_names));
ok('B 兼容字段 role_name=组员', b0.role_name === '组员', `got ${b0.role_name}`);

// 5) 组长数组分配：B → [机械组, 电控组]
console.log('— 组长分配（数组 ≤3）');
r = await req(`/team/${teamId}/member`, { method: 'POST', token: tokA,
  body: JSON.stringify({ user_id: uidB, role_ids: [roleIds['机械组'], roleIds['电控组']] }) });
ok('B 分配两个角色 → 200', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
r = await req(`/team/${teamId}`, { token: tokB });
const b1 = r.data.members.find((m) => m.id === uidB);
ok('B 两个角色都在 role_names', Array.isArray(b1.role_names) && b1.role_names.includes('机械组') && b1.role_names.includes('电控组'), JSON.stringify(b1.role_names));
ok('B 兼容 role_name = 最高 level 角色（机械组）', b1.role_name === '机械组', `got ${b1.role_name}`);
ok('B me.roles 两角色且带权限', Array.isArray(r.data.me.roles) && r.data.me.roles.length === 2 && r.data.me.roles.some((x) => x.name === '机械组'), JSON.stringify(r.data.me.roles?.map((x) => x.name)));
ok('B me.role 兼容（第一个=机械组）', r.data.me.role?.name === '机械组', `got ${r.data.me.role?.name}`);

// 6) 第三角色：≤3 上限
r = await req(`/team/${teamId}/member`, { method: 'POST', token: tokA,
  body: JSON.stringify({ user_id: uidB, role_ids: [roleIds['机械组'], roleIds['电控组'], roleIds['软件组'], roleIds['资料组']] }) });
ok('B 分 4 个角色 → 400', r.status === 400 && String(r.data.error || '').includes('3 个'), `got ${r.status} ${r.data.error || ''}`);

// 7) 旧接口兼容：单 role_id 赋值会替换全部（B → 仅软件组）
r = await req(`/team/${teamId}/member`, { method: 'POST', token: tokA,
  body: JSON.stringify({ user_id: uidB, role_id: roleIds['软件组'] }) });
ok('旧 role_id 单值兼容 → 200', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
r = await req(`/team/${teamId}`, { token: tokB });
const b2 = r.data.members.find((m) => m.id === uidB);
ok('单值替换后仅剩软件组', Array.isArray(b2.role_names) && b2.role_names.length === 1 && b2.role_names[0] === '软件组', JSON.stringify(b2.role_names));
ok('兼容 role_id 字段同步', Number(b2.role_id) === Number(roleIds['软件组']), `got ${b2.role_id}`);

// 8) 成员自选：C → [机械组, 资料组]（自己选，无 member 权限）
console.log('— 成员自选');
r = await req(`/team/${teamId}/member/self-role`, { method: 'POST', token: tokC,
  body: JSON.stringify({ role_ids: [roleIds['机械组'], roleIds['资料组']] }) });
ok('C 自选两个角色 → 200', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
r = await req(`/team/${teamId}`, { token: tokC });
const c1 = r.data.members.find((m) => m.id === uidC);
ok('C 两个角色生效', Array.isArray(c1.role_names) && c1.role_names.includes('机械组') && c1.role_names.includes('资料组'), JSON.stringify(c1.role_names));
r = await req(`/team/${teamId}/member/self-role`, { method: 'POST', token: tokC,
  body: JSON.stringify({ role_ids: [roleIds['机械组'], roleIds['资料组'], roleIds['软件组'], roleIds['电控组']] }) });
ok('C 自选 4 个 → 400', r.status === 400, `got ${r.status} ${r.data.error || ''}`);
r = await req(`/team/${teamId}/member/self-role`, { method: 'POST', token: tokC,
  body: JSON.stringify({ role_ids: [99999] }) });
ok('自选不存在角色 → 404', r.status === 404, `got ${r.status} ${r.data.error || ''}`);

// 8b) 组长多角色：组长也可自选 + 被分配（新需求）
console.log('— 组长多角色');
r = await req(`/team/${teamId}/member/self-role`, { method: 'POST', token: tokA, body: JSON.stringify({ role_ids: [roleIds['机械组']] }) });
ok('组长 self-role → 200（组长多角色）', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
r = await req(`/team/${teamId}`, { token: tokA });
const a0 = r.data.members.find((m) => m.id === uidA);
ok('组长自选角色生效（role_names 含机械组）', Array.isArray(a0.role_names) && a0.role_names.includes('机械组'), JSON.stringify(a0.role_names));
ok('组长 is_owner 且带角色', a0.is_owner === true);
r = await req(`/team/${teamId}/member`, { method: 'POST', token: tokA,
  body: JSON.stringify({ user_id: uidA, role_ids: [roleIds['机械组'], roleIds['软件组']] }) });
ok('组长被分配两个角色 → 200（不再 400）', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
r = await req(`/team/${teamId}`, { token: tokA });
const a0b = r.data.members.find((m) => m.id === uidA);
ok('组长两个角色都在 role_names', Array.isArray(a0b.role_names) && a0b.role_names.includes('机械组') && a0b.role_names.includes('软件组'), JSON.stringify(a0b.role_names));
ok('组长 me.roles 两角色', Array.isArray(r.data.me.roles) && r.data.me.roles.length === 2, JSON.stringify(r.data.me.roles?.map((x) => x.name)));

// 9) 权限并集：B 现在只有软件组(task)；给 B 换成 [机械组(progress), 电控组(message)]
//    → B 无 task 权限但无权限管理，走 progress 相关接口验证并集
r = await req(`/team/${teamId}/member`, { method: 'POST', token: tokA,
  body: JSON.stringify({ user_id: uidB, role_ids: [roleIds['机械组'], roleIds['电控组']] }) });
ok('B 重置为双角色', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
// 机械组带 progress 权限 → B 可提交进度汇报
r = await req(`/team/${teamId}/log`, { method: 'POST', token: tokB,
  body: JSON.stringify({ content: '<p>双角色权限冒烟</p>', attachments: [] }) });
ok('B（机械组 progress 权限）提交汇报 → 201', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
// 电控组带 message 权限 → B 可发消息
r = await req(`/team/${teamId}/message`, { method: 'POST', token: tokB,
  body: JSON.stringify({ content: '双角色权限并集冒烟' }) });
ok('B（电控组 message 权限）发消息 → 201', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
// 无权限操作：B 无 member 权限 → 改成员 403
r = await req(`/team/${teamId}/member`, { method: 'POST', token: tokB, body: JSON.stringify({ user_id: uidC, role_ids: [] }) });
ok('B 无 member 权限改成员 → 403', r.status === 403, `got ${r.status} ${r.data.error || ''}`);

// 10) 删除角色清理桥表：删「电控组」（B 有）→ B 剩机械组
console.log('— 角色删除清理');
r = await req(`/team/${teamId}/role/${roleIds['电控组']}`, { method: 'DELETE', token: tokA });
ok('删除角色「电控组」→ 200', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
r = await req(`/team/${teamId}`, { token: tokB });
const b3 = r.data.members.find((m) => m.id === uidB);
ok('B 删除后仅剩机械组', Array.isArray(b3.role_names) && b3.role_names.length === 1 && b3.role_names[0] === '机械组', JSON.stringify(b3.role_names));

// 11) my-tasks role_names（B 有机械组；建计划后检查）
console.log('— my-tasks 聚合');
const comp = (await req('/competition?status=active')).data[0];
r = await req(`/team/${teamId}/plan/generate`, { method: 'POST', token: tokA, body: JSON.stringify({ comp_id: comp.id }) }, 100000);
ok('生成计划（供 my-tasks）', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
r = await req('/team/my-tasks', { token: tokB });
const mt = r.data.find((x) => Number(x.team_id) === Number(teamId));
ok('my-tasks role_names=[机械组]', Array.isArray(mt?.role_names) && mt.role_names.length === 1 && mt.role_names[0] === '机械组', JSON.stringify(mt?.role_names));
ok('my-tasks 兼容 role_name=机械组', mt?.role_name === '机械组', `got ${mt?.role_name}`);

// 12) 转让组长：角色保留（组长也可多角色，转让只换组长身份）
console.log('— 转让组长（角色保留）');
r = await req(`/team/${teamId}/transfer`, { method: 'POST', token: tokA, body: JSON.stringify({ user_id: uidC }) });
ok('A 转让给 C → 200', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
r = await req(`/team/${teamId}`, { token: tokC });
const c2 = r.data.members.find((m) => m.id === uidC);
ok('新组长 C 角色保留（机械组+资料组）', Array.isArray(c2.role_names) && c2.role_names.includes('机械组') && c2.role_names.includes('资料组'), JSON.stringify(c2.role_names));
ok('新组长 C is_owner=true', c2.is_owner === true);
const a1 = r.data.members.find((m) => m.username === Y + '_a');
ok('原组长 A 角色保留（机械组+软件组）', Array.isArray(a1.role_names) && a1.role_names.includes('机械组') && a1.role_names.includes('软件组'), JSON.stringify(a1.role_names));
ok('A 不再是组长', a1.is_owner === false);
// 转让后 C 是组长，仍可自选角色
r = await req(`/team/${teamId}/member/self-role`, { method: 'POST', token: tokC, body: JSON.stringify({ role_ids: [roleIds['机械组'], roleIds['资料组']] }) });
ok('转让后 C（组长）self-role → 200', r.status === 200, `got ${r.status} ${r.data.error || ''}`);

// 13) 清理：解散小组 + 删测试用户
console.log('— 清理');
r = await req(`/team/${teamId}`, { method: 'DELETE', token: tokC });
ok('解散小组 → 200', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
db.prepare("DELETE FROM user WHERE username IN (?, ?, ?)").run(Y + '_a', Y + '_b', Y + '_c');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
