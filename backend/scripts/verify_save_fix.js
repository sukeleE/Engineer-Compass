// 端到端验证「AI计划保存」修复：登录态创建 → list 可见（模拟刷新）
// 场景1：匿名创建备赛计划 → list 可见
// 场景2：登录 zyltest 创建备赛计划 → list 可见（核心修复场景）
// 场景3：登录创建学习计划 → list 可见
import { randomUUID } from 'node:crypto';

const BASE = 'http://localhost:3000/api';
const rnd = randomUUID().slice(0, 8);

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

// ---- 场景1：匿名创建备赛计划 ----
console.log('\n【场景1】匿名创建备赛计划');
let r = await call('/schedule/add', { method: 'POST', body: { comp_id: 1 } });
check('匿名 add 返回 id', r.status === 201 && r.data.id, `status=${r.status}`);
const anonId = r.data.id;
r = await call('/schedule/list');
check('匿名 list 可见刚创建的计划', Array.isArray(r.data) && r.data.some((s) => s.id === anonId), `list 长度=${r.data.length}`);

// ---- 场景2：登录创建备赛计划（核心场景） ----
console.log('\n【场景2】登录 zyltest 创建备赛计划');
r = await call('/auth/login', { method: 'POST', body: { username: 'zyltest', password: 'zyltest123' } });
check('登录成功', r.status === 200 && r.data.token, `status=${r.status} ${r.data.error || ''}`);
const token = r.data.token;
r = await call('/schedule/add', { method: 'POST', body: { comp_id: 1 }, token });
check('登录 add 返回 id', r.status === 201 && r.data.id, `status=${r.status}`);
const uid = r.data.id;
r = await call('/schedule/list', { token });
const mine = (r.data || []).find((s) => s.id === uid);
check('登录 list 可见自己刚创建的计划（刷新后不丢）', !!mine, `list 长度=${r.data.length}`);

// 匿名遗留（local）也应可见
r = await call('/schedule/list', { token });
check('登录 list 仍可见匿名 local 计划', (r.data || []).some((s) => s.id === anonId));

// ---- 场景3：登录创建学习计划 ----
console.log('\n【场景3】登录创建学习计划');
r = await call('/study/plan', { method: 'POST', body: { topic: 'test-topic-' + rnd }, token });
check('study plan 创建成功', r.status === 201 && r.data.id, `status=${r.status} ${r.data.error || ''}`);
const suid = r.data.id;
r = await call('/study/list', { token });
check('登录 study list 可见自己创建的学习计划', Array.isArray(r.data) && r.data.some((s) => s.id === suid), `list 长度=${r.data.length}`);

// ---- 清理测试数据 ----
console.log('\n【清理】删除测试创建的计划');
await call(`/schedule/${anonId}`, { method: 'DELETE' });
await call(`/schedule/${uid}`, { method: 'DELETE' });
await call(`/study/${suid}`, { method: 'DELETE' });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
