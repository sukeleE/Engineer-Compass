// 用户公开主页冒烟测试（node 内联 fetch）
// 覆盖：B（任何登录用户）查 A 主页 → 200 含基本资料/竞赛计划/学习日程/参加小组；
//      未登录 401；不存在用户 404；非法 id 400；主页含已完成计划（成果展示不过滤）
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

const Y = 'pro_' + Date.now().toString().slice(-6);

// 1) 注册 A、B
console.log('— 准备');
let r = await req('/auth/register', { method: 'POST', body: JSON.stringify({ username: Y + '_a', password: 'test123456', email: Y + '_a@test.dev' }) });
ok('注册用户A', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const tokA = r.data.token;
const uidA = r.data.user.id;

r = await req('/auth/register', { method: 'POST', body: JSON.stringify({ username: Y + '_b', password: 'test123456', email: Y + '_b@test.dev' }) });
ok('注册用户B', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const tokB = r.data.token;

// 2) A 造数据：建组 + 自编竞赛日程（含已完成任务）+ 自编学习日程
console.log('— A 造数据');
r = await req('/team', { method: 'POST', token: tokA, body: JSON.stringify({ name: Y + '组', desc: '公开主页冒烟' }) });
ok('A 建组', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const teamId = r.data.id;
const comp = (await req('/competition?status=active')).data[0];

r = await req('/schedule/manual', { method: 'POST', token: tokA, body: JSON.stringify({
  comp_id: comp.id, title: '主页竞赛计划',
  phases: [{ phase: '阶段1', date: '', tasks: [{ text: '任务X', done: true }, { text: '任务Y', done: false }] }],
}) });
ok('A 自编竞赛日程', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const schedId = r.data.id;

r = await req('/study/manual', { method: 'POST', token: tokA, body: JSON.stringify({
  topic: '主页学习日程', phases: [{ phase: '阶段1', tasks: ['学习X'] }],
}) });
ok('A 自编学习日程', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const studyId = r.data.id;

// 3) B 查 A 主页
console.log('— 公开主页');
r = await req(`/users/${uidA}/public`, { token: tokB });
ok('B 查 A 主页 200', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
ok('主页含基本资料', r.data.user?.id === uidA && r.data.user?.nickname === Y + '_a', JSON.stringify(r.data.user));
ok('主页含参加小组', r.data.teams?.some((t) => t.id === teamId && t.is_owner && t.member_count === 1), JSON.stringify(r.data.teams));
ok('主页含竞赛计划进度', r.data.schedules?.some((s) => s.comp_name === comp.name && s.done === 1 && s.total === 2 && s.phases?.[0]?.phase === '阶段1'), JSON.stringify(r.data.schedules));
ok('主页含已完成任务（成果展示不过滤）', r.data.schedules?.[0]?.done === 1 && r.data.schedules?.[0]?.total === 2, JSON.stringify(r.data.schedules));
ok('主页含学习日程进度', r.data.studies?.some((s) => s.topic === '主页学习日程' && s.total === 1), JSON.stringify(r.data.studies));

// 4) A 自己查自己（isMe 场景数据等价）
r = await req(`/users/${uidA}/public`, { token: tokA });
ok('A 自己查主页 200', r.status === 200, `got ${r.status}`);

// 5) 未登录 → 401
r = await req(`/users/${uidA}/public`);
ok('未登录 401', r.status === 401, `got ${r.status}`);

// 6) 不存在用户 → 404；非法 id → 400
r = await req('/users/999999999/public', { token: tokB });
ok('不存在用户 404', r.status === 404, `got ${r.status}`);
r = await req('/users/abc/public', { token: tokB });
ok('非法 id 400', r.status === 400, `got ${r.status}`);

// 清理
console.log('— 清理');
r = await req(`/team/${teamId}`, { method: 'DELETE', token: tokA });
ok('解散小组', r.status === 200, `got ${r.status}`);
db.prepare('DELETE FROM user_schedule WHERE id = ?').run(schedId);
db.prepare('DELETE FROM user_study WHERE id = ?').run(studyId);
db.prepare('DELETE FROM user WHERE username IN (?, ?)').run(Y + '_a', Y + '_b');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
