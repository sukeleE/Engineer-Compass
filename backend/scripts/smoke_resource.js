// 个人资源库冒烟测试（node 内联 fetch + FormData/Blob，Node ≥22 原生支持 multipart 上传）
// 覆盖：鉴权 401 / 1MB 上传+列表+配额+审计 / 空文件 400 / 非 multipart 400 / 128MB 边界 201 / 超限 413
//      配额 413 / 越权 403 ×2 / ?token= 直连下载 / 404 ×2 / 本人删除磁盘清理 / admin 搜索+删除+审计 / 普通用户访问 admin 403
// 运行前提：后端已启动在 :3000（npm start）
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, rmSync } from 'node:fs';
import { hashPassword } from '../routes/middleware.js';
import { QUOTA, RESOURCE_DIR } from '../routes/resource.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB = join(__dirname, '..', 'data', 'compass.db');
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

// multipart 上传（显式带 Authorization；不设 Content-Type 由 fetch 补 boundary）
async function upload(blob, name, token) {
  const fd = new FormData();
  fd.append('file', blob, name);
  const res = await fetch(BASE + '/resource/upload', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ---- 准备：直插测试用户（A 普通 / B 普通 / 管理员），并清掉测试目录残留 ----
const db = new DatabaseSync(DB);
const A_MAIL = 'smoke_res_a@x.com', B_MAIL = 'smoke_res_b@x.com', ADM_MAIL = 'smoke_res_adm@x.com';
db.prepare('DELETE FROM user WHERE email IN (?,?,?)').run(A_MAIL, B_MAIL, ADM_MAIL);
const aId = Number(db.prepare("INSERT INTO user (username, nickname, password_hash, email) VALUES (?,?,?,?)")
  .run('smoke_res_a', '资源A', hashPassword('test123456'), A_MAIL).lastInsertRowid);
const bId = Number(db.prepare("INSERT INTO user (username, nickname, password_hash, email) VALUES (?,?,?,?)")
  .run('smoke_res_b', '资源B', hashPassword('test123456'), B_MAIL).lastInsertRowid);
const admId = Number(db.prepare("INSERT INTO user (username, nickname, password_hash, email, is_admin) VALUES (?,?,?,?,1)")
  .run('smoke_res_adm', '资源管理员', hashPassword('test123456'), ADM_MAIL).lastInsertRowid);
for (const id of [aId, bId, admId]) rmSync(join(RESOURCE_DIR, String(id)), { recursive: true, force: true });
console.log(`— 测试账号 A=${aId} B=${bId} admin=${admId}（配额 ${(QUOTA / 1024 / 1024).toFixed(0)}MB）`);

const auditCount = (action, uid) => db.prepare(
  'SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ? AND action = ?').get(uid, action).n;

const aLogin = await req('/auth/login', { method: 'POST', body: JSON.stringify({ email: A_MAIL, password: 'test123456' }) });
const bLogin = await req('/auth/login', { method: 'POST', body: JSON.stringify({ email: B_MAIL, password: 'test123456' }) });
const admLogin = await req('/auth/login', { method: 'POST', body: JSON.stringify({ email: ADM_MAIL, password: 'test123456' }) });
const aTok = aLogin.data.token, bTok = bLogin.data.token, admTok = admLogin.data.token;
ok('三账号登录 → 200', [aLogin, bLogin, admLogin].every((r) => r.status === 200));

// ---- 1) 鉴权 ----
console.log('— 鉴权');
let r = await req('/resource');
ok('无 token 列表 → 401', r.status === 401, `got ${r.status}`);
r = await upload(new Blob(['x']), 'x.bin');
ok('无 token 上传 → 401', r.status === 401, `got ${r.status}`);

// ---- 2) A 上传 1MB ----
console.log('— 上传与列表');
const mb1 = new Uint8Array(1024 * 1024); for (let i = 0; i < mb1.length; i++) mb1[i] = i & 0xff;
r = await upload(new Blob([mb1]), 'a-1mb.bin', aTok);
ok('A 上传 1MB → 201', r.status === 201 && r.data.file_size === 1024 * 1024, `got ${r.status} ${JSON.stringify(r.data).slice(0, 80)}`);
const f1 = r.data.id;
r = await req('/resource', { token: aTok });
ok('列表含该文件 + used/quota 正确', r.status === 200 && r.data.total === 1 && r.data.used === 1024 * 1024
  && r.data.quota === QUOTA && r.data.list[0].file_name === 'a-1mb.bin', JSON.stringify(r.data).slice(0, 120));
ok('resource-upload 审计埋点', auditCount('resource-upload', aId) === 1, auditCount('resource-upload', aId));

// ---- 3) 空文件 / 非 multipart ----
console.log('— 非法请求');
r = await upload(new Blob([]), 'empty.bin', aTok);
ok('空文件 → 400', r.status === 400 && r.data.error.includes('空'), `got ${r.status} ${r.data.error}`);
r = await req('/resource/upload', { token: aTok, method: 'POST', body: JSON.stringify({ file: 'x' }) });
ok('非 multipart → 400', r.status === 400 && r.data.error.includes('未收到文件'), `got ${r.status} ${r.data.error}`);

// ---- 4) 128MB 边界与超限 ----
console.log('— 128MB 边界');
const mb128 = new Uint8Array(128 * 1024 * 1024); // 内容随机即可，占位内存 ~128MB
r = await upload(new Blob([mb128]), 'a-128mb.bin', aTok);
ok('128MB 边界 → 201', r.status === 201 && r.data.file_size === 128 * 1024 * 1024, `got ${r.status} ${JSON.stringify(r.data).slice(0, 80)}`);
r = await req('/resource', { token: aTok });
ok('列表 total=2（1MB + 128MB）', r.status === 200 && r.data.total === 2, `total=${r.data.total}`);
const mb128p1 = new Uint8Array(128 * 1024 * 1024 + 1);
r = await upload(new Blob([mb128p1]), 'over.bin', aTok);
ok('128MB+1 字节 → 413', r.status === 413 && r.data.error.includes('128MB'), `got ${r.status} ${r.data.error}`);
r = await req('/resource', { token: aTok });
ok('超限文件未入库（total 仍 2）', r.data.total === 2, `total=${r.data.total}`);
ok('resource-upload 审计共 2 条', auditCount('resource-upload', aId) === 2, auditCount('resource-upload', aId));

// ---- 5) 配额（直插占位行到 QUOTA-512KB，再传 1MB → 413）----
console.log('— 配额');
db.prepare('INSERT INTO user_resource (user_id, file_name, file_size, store_path) VALUES (?,?,?,?)')
  .run(aId, '占位', QUOTA - 512 * 1024, 'placeholder.bin');
r = await upload(new Blob([mb1]), 'quota-over.bin', aTok);
ok('已用 QUOTA-512KB 时传 1MB → 413', r.status === 413 && r.data.error.includes('配额'), `got ${r.status} ${r.data.error}`);
db.prepare('DELETE FROM user_resource WHERE id = (SELECT id FROM user_resource WHERE user_id = ? AND file_name = ?)')
  .run(aId, '占位');
r = await req('/resource', { token: aTok });
ok('占位行清理后配额回落', r.data.used === 129 * 1024 * 1024, `used=${r.data.used}`);

// ---- 6) 越权 ----
console.log('— 越权拦截');
r = await req(`/resource/${f1}/download`, { token: bTok });
ok('B 下载 A 的资源 → 403', r.status === 403, `got ${r.status}`);
r = await req(`/resource/${f1}`, { token: bTok, method: 'DELETE' });
ok('B 删除 A 的资源 → 403', r.status === 403, `got ${r.status}`);

// ---- 7) ?token= 直连下载（无 Authorization 头）----
console.log('— 下载');
const dl = await fetch(`${BASE}/resource/${f1}/download?token=${aTok}`);
const buf = Buffer.from(await dl.arrayBuffer());
ok('?token= 下载 → 200 且字节数一致', dl.status === 200 && buf.length === 1024 * 1024
  && buf[0] === 0 && buf[1023] === 0xff, `status=${dl.status} len=${buf.length}`);
r = await req('/resource/999999/download', { token: aTok });
ok('下载不存在 id → 404', r.status === 404, `got ${r.status}`);
r = await req('/resource/999999', { token: aTok, method: 'DELETE' });
ok('删除不存在 id → 404', r.status === 404, `got ${r.status}`);

// ---- 8) 本人删除（128MB 文件）+ 磁盘清理 ----
console.log('— 本人删除');
const f2row = db.prepare('SELECT id, store_path FROM user_resource WHERE user_id = ? AND file_name = ?')
  .get(aId, 'a-128mb.bin');
r = await req(`/resource/${f2row.id}`, { token: aTok, method: 'DELETE' });
ok('A 删除自己的 128MB 文件 → 200', r.status === 200, `got ${r.status}`);
ok('磁盘文件已删除', !existsSync(join(RESOURCE_DIR, String(aId), f2row.store_path)));
ok('resource-delete 审计埋点', auditCount('resource-delete', aId) === 1, auditCount('resource-delete', aId));

// ---- 9) admin 管理 ----
console.log('— 管理员资源管理');
r = await req('/admin/resources?q=1mb', { token: admTok });
ok('admin 按文件名搜到资源（含上传者用户名）', r.status === 200 && r.data.total === 1
  && r.data.list[0].username === 'smoke_res_a' && r.data.list[0].file_size === 1024 * 1024,
  JSON.stringify(r.data).slice(0, 120));
r = await req('/admin/resources', { token: bTok });
ok('普通用户访问 /admin/resources → 403', r.status === 403, `got ${r.status}`);
const f1row = db.prepare('SELECT store_path FROM user_resource WHERE id = ?').get(f1);
r = await req(`/admin/resources/${f1}`, { token: admTok, method: 'DELETE' });
ok('admin 删除任意资源 → 200', r.status === 200, `got ${r.status}`);
ok('磁盘文件随 admin 删除清理', !existsSync(join(RESOURCE_DIR, String(aId), f1row.store_path)));
ok('resource-admin-delete 审计埋点', auditCount('resource-admin-delete', admId) === 1, auditCount('resource-admin-delete', admId));

// ---- 清理 ----
console.log('— 清理测试数据');
db.prepare('DELETE FROM user_resource WHERE user_id IN (?,?,?)').run(aId, bId, admId);
for (const id of [aId, bId, admId]) rmSync(join(RESOURCE_DIR, String(id)), { recursive: true, force: true });
db.prepare('DELETE FROM audit_log WHERE user_id IN (?,?,?)').run(aId, bId, admId);
db.prepare('DELETE FROM session WHERE user_id IN (?,?,?)').run(aId, bId, admId);
db.prepare('DELETE FROM user WHERE id IN (?,?,?)').run(aId, bId, admId);
db.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
