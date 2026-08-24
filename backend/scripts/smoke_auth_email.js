// 邮箱验证码注册/登录冒烟测试
// 场景：send-code（dev_code）→ 冷却 429 → email-login 自动注册 + 匿名数据迁移 → me 带 email
//       → 重复登录（不迁移）→ 验证码错误 → 密码注册带 email → 双通道登录 → 清理（归还数据）
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DB_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'compass.db');

const BASE = 'http://localhost:3000/api';
const rnd = randomUUID().slice(0, 8);
const mail = `smoke-${rnd}@test.dev`;
const mail2 = `smoke2-${rnd}@test.dev`;

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

// ---- 准备：匿名数据（local 备赛计划 + NULL 学习日程） ----
console.log('\n【准备】造匿名数据（用于验证登录后迁移）');
let r = await call('/schedule/manual', { method: 'POST', body: { title: '迁移测试计划', phases: [{ phase: '阶段1', tasks: ['任务A'] }] } });
check('匿名创建备赛计划', r.status === 201 && r.data.id);
const anonSched = r.data.id;
r = await call('/study/manual', { method: 'POST', body: { topic: '迁移测试主题', phases: [{ phase: '阶段1', tasks: ['任务A'] }] } });
check('匿名创建学习计划', r.status === 201 && r.data.id);
const anonStudy = r.data.id;

// ---- 场景1：send-code ----
console.log('\n【场景1】发送验证码');
r = await call('/auth/send-code', { method: 'POST', body: { email: mail } });
check('send-code 返回 dev_code（开发模式）', r.status === 200 && /^\d{6}$/.test(r.data.dev_code || ''), `code=${r.data.dev_code}`);
const code = r.data.dev_code;
r = await call('/auth/send-code', { method: 'POST', body: { email: mail } });
check('60s 冷却内重复发送 → 429', r.status === 429, `status=${r.status} ${r.data.error || ''}`);
r = await call('/auth/send-code', { method: 'POST', body: { email: 'not-an-email' } });
check('非法邮箱 → 400', r.status === 400);

// ---- 场景2：email-login 自动注册 + 迁移 ----
console.log('\n【场景2】邮箱验证码登录（自动注册 + 匿名数据迁移）');
r = await call('/auth/email-login', { method: 'POST', body: { email: mail, code: '000000' } });
check('错误验证码 → 400', r.status === 400);
r = await call('/auth/email-login', { method: 'POST', body: { email: mail, code } });
check('正确验证码 → 登录成功', r.status === 200 && r.data.token && r.data.user.email === mail, `migrated=${r.data.migrated}`);
check('自动注册且迁移匿名数据（≥ 我造的 2 条）', r.data.migrated >= 2, `migrated=${r.data.migrated}`);
const token = r.data.token;
const uid = r.data.user.id;
r = await call('/auth/me', { token });
check('me 返回 email', r.status === 200 && r.data.user.email === mail);
r = await call('/schedule/list', { token });
check('备赛计划已归账号（local → 账号）', (r.data || []).some((s) => s.id === anonSched));
r = await call('/study/list', { token });
check('学习计划已归账号（NULL → 账号）', (r.data || []).some((s) => s.id === anonStudy));

// ---- 场景3：再次登录（已有账号，不迁移） ----
console.log('\n【场景3】已注册邮箱再次登录');
r = await call('/auth/send-code', { method: 'POST', body: { email: mail2 } });
const code2 = r.data.dev_code;
r = await call('/auth/email-login', { method: 'POST', body: { email: mail2, code: code2 } });
check('第二个邮箱自动注册', r.status === 200 && r.data.user.id !== uid, `uid2=${r.data.user.id}`);
r = await call('/auth/send-code', { method: 'POST', body: { email: mail } });
const code3 = r.data.dev_code;
r = await call('/auth/email-login', { method: 'POST', body: { email: mail, code: code3 } });
check('已有账号登录不再迁移（migrated=0）', r.status === 200 && r.data.migrated === 0, `migrated=${r.data.migrated}`);
r = await call('/auth/email-login', { method: 'POST', body: { email: mail, code: code3 } });
check('验证码一次性使用（重复用 → 400）', r.status === 400);

// ---- 场景4：密码注册带 email，双通道登录 ----
console.log('\n【场景4】密码注册 + 邮箱双通道');
r = await call('/auth/register', { method: 'POST', body: { username: `pwuser${rnd.slice(0, 6)}`, password: 'abc12345', email: mail2 } });
check('邮箱已被占用 → 409', r.status === 409);
r = await call('/auth/register', { method: 'POST', body: { username: `pwuser${rnd.slice(0, 6)}`, password: 'abc12345', email: `pwmail-${rnd}@test.dev` } });
check('密码注册（带新邮箱）成功', r.status === 201 && r.data.token);
const pwUser = r.data.user;
r = await call('/auth/login', { method: 'POST', body: { username: pwUser.username, password: 'abc12345' } });
check('密码登录 OK', r.status === 200 && r.data.user.id === pwUser.id);

// ---- 清理 ----
console.log('\n【清理】删除测试账号并归还真实数据');
const u2 = await call('/auth/email-login', { method: 'POST', body: { email: mail2, code: (await call('/auth/send-code', { method: 'POST', body: { email: mail2 } })).data.dev_code } });
// 1) 删测试创建的计划（API 无权限校验）
await call(`/schedule/${anonSched}`, { method: 'DELETE' });
await call(`/study/${anonStudy}`, { method: 'DELETE' });
// 2) 直连数据库：账号下剩余数据（含测试迁移走的真实数据）归还 local/NULL → 删测试用户
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');
const ids = [uid, u2.data.user.id, pwUser.id];
const ph = ids.map(() => '?').join(',');
db.prepare(`UPDATE user_schedule SET user_id = 'local' WHERE user_id IN (${ph})`).run(...ids);
db.prepare(`UPDATE user_study SET user_id = NULL WHERE user_id IN (${ph})`).run(...ids);
db.prepare(`DELETE FROM session WHERE user_id IN (${ph})`).run(...ids);
db.prepare(`DELETE FROM user WHERE id IN (${ph})`).run(...ids);
db.prepare("DELETE FROM email_code WHERE email LIKE 'smoke%' OR email LIKE 'pwmail%'").run();
db.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
