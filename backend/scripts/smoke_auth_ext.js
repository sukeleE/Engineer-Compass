// 请求 O 冒烟：邮箱密码登录 / 资料(昵称+头像) / 邮箱绑定(验证码) / 反馈邮件
// 场景：register(邮箱自动用户名) → login 邮箱/用户名双通道 → PUT profile(昵称+头像+清除)
//       → send-code(bind) → PUT email 换绑(+409/400 负例) → POST feedback(存库+[DEV MAIL]) → 清理
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DB_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'compass.db');

const BASE = 'http://localhost:3000/api';
const rnd = randomUUID().slice(0, 8);
const mailA = `exta-${rnd}@test.dev`;   // 主测试账号邮箱
const mailB = `extb-${rnd}@test.dev`;   // 换绑目标邮箱
const mailC = `extc-${rnd}@test.dev`;   // 占用者邮箱（409 用）

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

// ---- 场景1：注册（邮箱 + 密码，username 自动生成） ----
console.log('\n【场景1】邮箱密码注册');
let r = await call('/auth/register', { method: 'POST', body: { email: 'not-an-email', password: 'abc12345' } });
check('非法邮箱 → 400', r.status === 400);
r = await call('/auth/register', { method: 'POST', body: { email: mailA, password: '123' } });
check('密码过短 → 400', r.status === 400);
r = await call('/auth/register', { method: 'POST', body: { email: mailA, password: 'abc12345', nickname: '小明' } });
check('注册成功（无 username 入参）', r.status === 201 && r.data.token, `status=${r.status}`);
const tokA = r.data.token;
const userA = r.data.user;
check('username 自动生成且匹配邮箱前缀', userA.username === `exta_${rnd}`, `username=${userA.username}`);
check('响应含 email + avatar', userA.email === mailA && userA.avatar === null);
r = await call('/auth/register', { method: 'POST', body: { email: mailA, password: 'abc12345' } });
check('重复邮箱注册 → 409', r.status === 409);

// ---- 场景2：登录双通道 ----
console.log('\n【场景2】邮箱/用户名 + 密码登录');
r = await call('/auth/login', { method: 'POST', body: { email: mailA, password: 'abc12345' } });
check('邮箱+密码登录 → 200', r.status === 200 && r.data.user.id === userA.id && r.data.user.email === mailA);
r = await call('/auth/login', { method: 'POST', body: { username: userA.username, password: 'abc12345' } });
check('username+密码登录（存量兼容）→ 200', r.status === 200 && r.data.user.id === userA.id);
r = await call('/auth/login', { method: 'POST', body: { email: mailA, password: 'wrong-pass' } });
check('错误密码 → 401', r.status === 401);
r = await call('/auth/login', { method: 'POST', body: { email: 'ghost@test.dev', password: 'abc12345' } });
check('未注册邮箱 → 401', r.status === 401);

// ---- 场景3：PUT /auth/profile（昵称 + 头像） ----
console.log('\n【场景3】资料更新');
r = await call('/auth/profile', { method: 'PUT', body: { nickname: '  新昵称  ' }, token: tokA });
check('改昵称（trim）→ 200', r.status === 200 && r.data.user.nickname === '新昵称');
r = await call('/auth/profile', { method: 'PUT', body: { nickname: 'x'.repeat(21) }, token: tokA });
check('昵称超长 → 400', r.status === 400);
r = await call('/auth/profile', { method: 'PUT', body: { nickname: '  ' }, token: tokA });
check('空昵称 → 400', r.status === 400);
const avaOK = `data:image/png;base64,${Buffer.from('fakepng').toString('base64')}`;
r = await call('/auth/profile', { method: 'PUT', body: { avatar: avaOK }, token: tokA });
check('上传合法头像 → 200 且 avatar 生效', r.status === 200 && r.data.user.avatar === avaOK);
r = await call('/auth/me', { token: tokA });
check('me 反映昵称 + 头像', r.data.user.nickname === '新昵称' && r.data.user.avatar === avaOK);
r = await call('/auth/profile', { method: 'PUT', body: { avatar: 'data:text/html;base64,xxx' }, token: tokA });
check('非法头像格式 → 400', r.status === 400);
r = await call('/auth/profile', { method: 'PUT', body: { avatar: `data:image/png;base64,${'A'.repeat(200000)}` }, token: tokA });
check('超大头像 → 400', r.status === 400);
r = await call('/auth/profile', { method: 'PUT', body: { avatar: '' }, token: tokA });
check('空 avatar 清除头像', r.status === 200 && r.data.user.avatar === null);
r = await call('/auth/profile', { method: 'PUT', body: {}, token: tokA });
check('空 body → 400', r.status === 400);
r = await call('/auth/profile', { method: 'PUT', body: { nickname: '新昵称' } });
check('未登录改资料 → 401', r.status === 401);

// ---- 场景4：邮箱绑定 / 更换（bind 验证码） ----
console.log('\n【场景4】邮箱绑定');
r = await call('/auth/send-code', { method: 'POST', body: { email: mailB, purpose: 'bind' } });
check('bind 验证码发送 → dev_code', r.status === 200 && /^\d{6}$/.test(r.data.dev_code || ''), `code=${r.data.dev_code}`);
const bindCode = r.data.dev_code;
r = await call('/auth/send-code', { method: 'POST', body: { email: mailB, purpose: 'hack' } });
check('非法 purpose → 400', r.status === 400);
r = await call('/auth/email', { method: 'PUT', body: { email: mailB, code: '000000' }, token: tokA });
check('错误验证码 → 400', r.status === 400);
// 占用者：注册 mailC，占住 email 唯一性（其邮箱单独发码，避免与 mailB 的码冲突）
r = await call('/auth/register', { method: 'POST', body: { email: mailC, password: 'abc12345' } });
check('占用者注册', r.status === 201);
const occId = r.data.user?.id;
r = await call('/auth/send-code', { method: 'POST', body: { email: mailC, purpose: 'bind' } });
const codeC = r.data.dev_code;
r = await call('/auth/email', { method: 'PUT', body: { email: mailC, code: codeC }, token: tokA });
check('换绑到已占用邮箱 → 409', r.status === 409, `status=${r.status}`);
r = await call('/auth/email', { method: 'PUT', body: { email: mailB, code: bindCode }, token: tokA });
check('正确 bind 验证码换绑 → 200 且 email 更新', r.status === 200 && r.data.user.email === mailB);
r = await call('/auth/email', { method: 'PUT', body: { email: mailB, code: bindCode }, token: tokA });
check('验证码一次性（重复用 → 400）', r.status === 400);
r = await call('/auth/login', { method: 'POST', body: { email: mailA, password: 'abc12345' } });
check('旧邮箱登录 → 401（已解绑）', r.status === 401);
r = await call('/auth/login', { method: 'POST', body: { email: mailB, password: 'abc12345' } });
check('新邮箱+密码登录 → 200', r.status === 200 && r.data.user.email === mailB);
r = await call('/auth/email', { method: 'PUT', body: { email: 'bad', code: bindCode }, token: tokA });
check('换绑非法邮箱 → 400', r.status === 400);

// ---- 场景5：反馈 ----
console.log('\n【场景5】反馈');
r = await call('/feedback', { method: 'POST', body: { content: '反馈测试：希望支持导出 PDF' } });
check('未登录提交 → 401', r.status === 401);
r = await call('/feedback', { method: 'POST', body: { content: '   ' }, token: tokA });
check('空内容 → 400', r.status === 400);
r = await call('/feedback', { method: 'POST', body: { content: '反馈测试：希望支持导出 PDF <b>加粗</b>' }, token: tokA });
check('提交反馈 → 200', r.status === 200);
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');
const fb = db.prepare('SELECT * FROM feedback WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userA.id);
check('反馈已存库（含联系邮箱快照）', !!fb && fb.content.includes('加粗') && fb.contact_email === mailB, `contact_email=${fb?.contact_email}`);

// ---- 清理 ----
console.log('\n【清理】');
db.prepare('DELETE FROM feedback WHERE user_id IN (?, ?)').run(userA.id, occId || 0);
db.prepare('DELETE FROM session WHERE user_id IN (?, ?)').run(userA.id, occId || 0);
db.prepare("DELETE FROM email_code WHERE email LIKE 'exta-%' OR email LIKE 'extb-%' OR email LIKE 'extc-%'").run();
db.prepare('DELETE FROM user WHERE id IN (?, ?)').run(userA.id, occId || 0);
db.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
