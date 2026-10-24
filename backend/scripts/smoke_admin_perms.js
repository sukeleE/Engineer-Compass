// 管理员分权冒烟测试：超管/受限管理员模块权限 / 任命接口保护 / 竞赛审核鉴权 / 越权收口
// 运行前提：后端已启动在 :3000（npm start）
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from '../routes/middleware.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB = join(__dirname, '..', 'data', 'compass.db');
const BASE = 'http://localhost:3000/api';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};
const lastResp = (r) => `[${r.status}] ${typeof r.data.error === 'string' ? r.data.error : JSON.stringify(r.data).slice(0, 120)}`;

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const db = new DatabaseSync(DB);
const SUPER_MAIL = 'smoke_super@x.com', LIMITED_MAIL = 'smoke_limited@x.com', PLAIN_MAIL = 'smoke_plain@x.com';
db.prepare('DELETE FROM user WHERE email IN (?,?,?)').run(SUPER_MAIL, LIMITED_MAIL, PLAIN_MAIL);
// 超管：is_admin=1 且 admin_perms 为空（与线上既有管理员同形态）
const superId = Number(db.prepare(
  "INSERT INTO user (username, nickname, password_hash, email, is_admin, admin_perms) VALUES (?,?,?,?,1,'')"
).run('smoke_super', '冒烟超管', hashPassword('test123456'), SUPER_MAIL).lastInsertRowid);
const limitedId = Number(db.prepare(
  'INSERT INTO user (username, nickname, password_hash, email) VALUES (?,?,?,?)'
).run('smoke_limited', '冒烟受限管理员', hashPassword('test123456'), LIMITED_MAIL).lastInsertRowid);
const plainId = Number(db.prepare(
  'INSERT INTO user (username, nickname, password_hash, email) VALUES (?,?,?,?)'
).run('smoke_plain', '冒烟普通用户', hashPassword('test123456'), PLAIN_MAIL).lastInsertRowid);
console.log(`— 测试账号 super=${superId} limited=${limitedId} plain=${plainId}`);

const superLogin = await req('/auth/login', { method: 'POST', body: JSON.stringify({ email: SUPER_MAIL, password: 'test123456' }) });
ok('超管登录 → 200', superLogin.status === 200, `got ${superLogin.status}`);
const superTok = superLogin.data.token;
ok('超管 /me perms=[]（全权标识）', Array.isArray(superLogin.data.user.perms) && superLogin.data.user.perms.length === 0,
  JSON.stringify(superLogin.data.user.perms));

const limitedLogin = await req('/auth/login', { method: 'POST', body: JSON.stringify({ email: LIMITED_MAIL, password: 'test123456' }) });
const limitedTok = limitedLogin.data.token;
const plainLogin = await req('/auth/login', { method: 'POST', body: JSON.stringify({ email: PLAIN_MAIL, password: 'test123456' }) });
const plainTok = plainLogin.data.token;

console.log('— 未登录 / 普通用户鉴权');
let r = await req('/competition/pending');
ok('未登录访问待审核列表 → 401', r.status === 401, `got ${r.status}`);
r = await req('/admin/users', { token: plainTok });
ok('普通用户访问用户管理 → 403', r.status === 403, `got ${r.status}`);
r = await req('/competition/pending', { token: plainTok });
ok('普通用户访问待审核列表 → 403', r.status === 403, `got ${r.status}`);

console.log('— 超管任命受限管理员（content + competition）');
r = await req(`/admin/users/${limitedId}/role`, {
  token: superTok, method: 'PUT', body: JSON.stringify({ is_admin: 1, perms: ['content', 'competition'] }),
});
ok('任命受限管理员 → 200', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
const row = db.prepare('SELECT is_admin, admin_perms FROM user WHERE id = ?').get(limitedId);
ok('DB 落库 perms=["content","competition"]', row.is_admin === 1 && row.admin_perms === JSON.stringify(['content', 'competition']), row.admin_perms);

// 受限管理员重新登录拿最新 perms
const limitedRelogin = await req('/auth/login', { method: 'POST', body: JSON.stringify({ email: LIMITED_MAIL, password: 'test123456' }) });
ok('受限管理员 /me 回传 perms', JSON.stringify(limitedRelogin.data.user.perms) === JSON.stringify(['content', 'competition']),
  JSON.stringify(limitedRelogin.data.user.perms));

console.log('— 受限管理员：有权限模块放行');
r = await req('/admin/posts', { token: limitedTok });
ok('content 权限：GET /admin/posts → 200', r.status === 200, `got ${r.status}`);
r = await req('/admin/comments', { token: limitedTok });
ok('content 权限：GET /admin/comments → 200', r.status === 200, `got ${r.status}`);
r = await req('/competition/pending', { token: limitedTok });
ok('competition 权限：GET /competition/pending → 200', r.status === 200, `got ${r.status}`);
r = await req('/competition/999999/verify', { token: limitedTok, method: 'POST' });
ok('competition 权限：verify 过权限关后 404（非 403）', r.status === 404, `got ${r.status}`);

console.log('— 受限管理员：无权限模块拦截');
r = await req('/admin/users', { token: limitedTok });
ok('无 user 权限：GET /admin/users → 403', r.status === 403, `got ${r.status}`);
r = await req('/admin/server-status', { token: limitedTok });
ok('无 server 权限：GET /admin/server-status → 403', r.status === 403, `got ${r.status}`);
r = await req('/admin/honors', { token: limitedTok });
ok('无 honor 权限：GET /admin/honors → 403', r.status === 403, `got ${r.status}`);
r = await req('/admin/announcements', { token: limitedTok });
ok('无 announce 权限：GET /admin/announcements → 403', r.status === 403, `got ${r.status}`);
r = await req('/admin/logs', { token: limitedTok });
ok('无 log 权限：GET /admin/logs → 403', r.status === 403, `got ${r.status}`);

console.log('— 敏感操作仅超管');
r = await req(`/admin/users/${plainId}/role`, { token: limitedTok, method: 'PUT', body: JSON.stringify({ is_admin: 1 }) });
ok('受限管理员任命他人 → 403', r.status === 403, `got ${r.status}`);
r = await req(`/admin/users/${superId}/status`, { token: limitedTok, method: 'PUT', body: JSON.stringify({ status: 1 }) });
ok('受限管理员封禁超管 → 403', r.status === 403, `got ${r.status}`);
r = await req(`/admin/users/${superId}/role`, { token: superTok, method: 'PUT', body: JSON.stringify({ is_admin: 0 }) });
ok('超管操作自己 → 400', r.status === 400, `got ${r.status}`);

console.log('— 升级为超管后全权');
r = await req(`/admin/users/${limitedId}/role`, { token: superTok, method: 'PUT', body: JSON.stringify({ is_admin: 1, perms: [] }) });
ok('升级超管 → 200', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
const limitedTok2 = (await req('/auth/login', { method: 'POST', body: JSON.stringify({ email: LIMITED_MAIL, password: 'test123456' }) })).data.token;
r = await req('/admin/server-status', { token: limitedTok2 });
ok('升级后访问 server-status → 200', r.status === 200, `got ${r.status}`);

console.log('— 超管计数与最后超管保护');
// limitedId 现为第二超管：两名超管在场时取消其中一名应放行（取消后还剩一名）
r = await req(`/admin/users/${limitedId}/role`, { token: superTok, method: 'PUT', body: JSON.stringify({ is_admin: 0 }) });
ok('取消第二超管 → 200', r.status === 200, lastResp(r));
// 直插临时超管，由其取消 superId：取消后 tmp 仍是超管 → 放行
const tmpId = Number(db.prepare(
  "INSERT INTO user (username, nickname, password_hash, email, is_admin, admin_perms) VALUES (?,?,?,?,1,'')"
).run('smoke_tmp_super', '临时超管', hashPassword('test123456'), 'smoke_tmp@x.com').lastInsertRowid);
const tmpTok = (await req('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'smoke_tmp@x.com', password: 'test123456' }) })).data.token;
r = await req(`/admin/users/${superId}/role`, { token: tmpTok, method: 'PUT', body: JSON.stringify({ is_admin: 0 }) });
ok('取消后仍剩一名超管：放行 → 200', r.status === 200, lastResp(r));
// tmp 成为唯一超管：操作自己一律 400（“禁止操作自己”同时是最后超管的 HTTP 层保险）
r = await req(`/admin/users/${tmpId}/role`, { token: tmpTok, method: 'PUT', body: JSON.stringify({ is_admin: 1, perms: ['content'] }) });
ok('唯一超管降级自己 → 400', r.status === 400, lastResp(r));
r = await req(`/admin/users/${tmpId}/role`, { token: tmpTok, method: 'PUT', body: JSON.stringify({ is_admin: 0 }) });
ok('唯一超管取消自己 → 400', r.status === 400, lastResp(r));
// 两名超管在场时可重新授权：恢复 superId（同时验证超管任命通道）
r = await req(`/admin/users/${superId}/role`, { token: tmpTok, method: 'PUT', body: JSON.stringify({ is_admin: 1, perms: [] }) });
ok('重新授予超管 → 200', r.status === 200, lastResp(r));

console.log('— 非法 perms 入参过滤');
r = await req(`/admin/users/${plainId}/role`, { token: superTok, method: 'PUT', body: JSON.stringify({ is_admin: 1, perms: ['content', 'hacker', 99] }) });
ok('非法 key 被过滤，其余生效 → 200', r.status === 200, `got ${r.status}`);
const filtered = JSON.parse(db.prepare('SELECT admin_perms FROM user WHERE id = ?').get(plainId).admin_perms || '[]');
ok('落库仅保留 content', JSON.stringify(filtered) === JSON.stringify(['content']), JSON.stringify(filtered));
await req(`/admin/users/${plainId}/role`, { token: superTok, method: 'PUT', body: JSON.stringify({ is_admin: 0 }) });

console.log('— 清理测试数据');
db.prepare('DELETE FROM audit_log WHERE user_id IN (?,?,?,?)').run(superId, limitedId, plainId, tmpId);
db.prepare('DELETE FROM session WHERE user_id IN (?,?,?,?)').run(superId, limitedId, plainId, tmpId);
db.prepare("DELETE FROM user WHERE email IN (?,?,?,'smoke_tmp@x.com')").run(SUPER_MAIL, LIMITED_MAIL, PLAIN_MAIL);
db.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
