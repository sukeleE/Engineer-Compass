// 「我的资源引用」冒烟测试：公开分享链接（可撤销）+ 小组资料引用 + 帖子附件 url 形态
// 覆盖：分享鉴权/越权/404 / 生成幂等 / 无鉴权公开下载字节一致 / 撤销后 404 /
//      team_file 引用 201 + 列表 share_url + 组内下载 / 撤销后 410 + 列表失效 / 重新分享恢复 /
//      帖子附件 url 白名单放行与 evil url 清洗 / 审计
// 运行前提：后端已启动在 :3000（npm start）
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { hashPassword } from '../routes/middleware.js';
import { RESOURCE_DIR } from '../routes/resource.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB = join(__dirname, '..', 'data', 'compass.db');
const BASE = 'http://localhost:3000/api';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

async function jreq(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
// 无 Authorization 的原始 GET（公开下载语义核心：不登录也能拿文件）
async function rawGet(path) {
  const res = await fetch(BASE + path);
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}
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

// ---- 准备：A（资源所有者/组长）+ B（组员）----
const db = new DatabaseSync(DB);
const A_MAIL = 'smoke_ref_a@x.com', B_MAIL = 'smoke_ref_b@x.com';
db.prepare('DELETE FROM user WHERE email IN (?,?)').run(A_MAIL, B_MAIL);
const aId = Number(db.prepare("INSERT INTO user (username, nickname, password_hash, email) VALUES (?,?,?,?)")
  .run('smoke_ref_a', '引用A', hashPassword('test123456'), A_MAIL).lastInsertRowid);
const bId = Number(db.prepare("INSERT INTO user (username, nickname, password_hash, email) VALUES (?,?,?,?)")
  .run('smoke_ref_b', '引用B', hashPassword('test123456'), B_MAIL).lastInsertRowid);
for (const id of [aId, bId]) rmSync(join(RESOURCE_DIR, String(id)), { recursive: true, force: true });
console.log(`— 测试账号 A=${aId} B=${bId}`);

const auditCount = (action, uid) => db.prepare(
  'SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ? AND action = ?').get(uid, action).n;

const aLogin = await jreq('/auth/login', { method: 'POST', body: JSON.stringify({ email: A_MAIL, password: 'test123456' }) });
const bLogin = await jreq('/auth/login', { method: 'POST', body: JSON.stringify({ email: B_MAIL, password: 'test123456' }) });
const aTok = aLogin.data.token, bTok = bLogin.data.token;
ok('A/B 登录 → 200', aLogin.status === 200 && bLogin.status === 200);

// A 上传 2KB 内容文件（可预测字节，用于下载一致性比对）
const CONTENT = Buffer.alloc(2048); for (let i = 0; i < CONTENT.length; i++) CONTENT[i] = i & 0xff;
let r = await upload(new Blob([CONTENT]), 'ref-pic.png', aTok);
ok('A 上传资源 → 201', r.status === 201, `got ${r.status}`);
const rid = r.data.id;

// A 建组 + B 加入
r = await jreq('/team', { token: aTok, method: 'POST', body: JSON.stringify({ name: '引用冒烟组' }) });
ok('A 建组 → 201（含 invite_code）', r.status === 201 && r.data.id && r.data.invite_code, `got ${r.status} ${JSON.stringify(r.data).slice(0, 100)}`);
const tid = r.data.id;
r = await jreq('/team/join', { token: bTok, method: 'POST', body: JSON.stringify({ invite_code: r.data.invite_code }) });
ok('B 加入小组 → 200/201', r.status === 200 || r.status === 201, `got ${r.status} ${r.data.error || ''}`);

// ---- 1) 分享端点：鉴权与权限 ----
console.log('— 分享端点鉴权/权限');
r = await jreq(`/resource/${rid}/share`, { method: 'POST' });
ok('无 token 分享 → 401', r.status === 401, `got ${r.status}`);
r = await jreq(`/resource/${rid}/share`, { token: bTok, method: 'POST' });
ok('他人资源分享 → 403', r.status === 403 && r.data.error.includes('所有者'), `got ${r.status} ${r.data.error}`);
r = await jreq('/resource/99999/share', { token: aTok, method: 'POST' });
ok('不存在资源 → 404', r.status === 404, `got ${r.status}`);

// ---- 2) 生成（幂等） ----
console.log('— 分享生成');
r = await jreq(`/resource/${rid}/share`, { token: aTok, method: 'POST' });
const tok1 = r.data.token, url1 = r.data.url;
ok('A 分享 → 200 + token 32hex + url 格式', r.status === 200 && /^[0-9a-f]{32}$/.test(tok1)
  && url1 === `/api/resource/share/${tok1}`, JSON.stringify(r.data));
r = await jreq(`/resource/${rid}/share`, { token: aTok, method: 'POST' });
ok('重复分享幂等（同 token）', r.data.token === tok1, `tok1=${tok1} tok2=${r.data.token}`);
r = await jreq('/resource', { token: aTok });
ok('列表 shared=true', r.status === 200 && r.data.list.find((x) => x.id === rid)?.shared === 1, JSON.stringify(r.data.list));
ok('resource-share 审计 ≥1（生成+幂等复用各记一条）', auditCount('resource-share', aId) >= 1, auditCount('resource-share', aId));

// ---- 3) 公开下载（核心语义：无登录） ----
console.log('— 公开下载');
let g = await rawGet(`/resource/share/${tok1}`);
ok('无 Authorization 下载 → 200 且字节一致', g.status === 200 && g.buf.equals(CONTENT), `got ${g.status} len=${g.buf.length}`);
ok('Content-Disposition 带原始文件名', String(g.headers.get('content-disposition') || '').includes('ref-pic.png'), g.headers.get('content-disposition'));
g = await rawGet('/resource/share/00000000000000000000000000000000');
ok('乱 token → 404', g.status === 404, `got ${g.status}`);

// ---- 4) team_file 引用 ----
console.log('— 小组资料引用');
r = await jreq(`/team/${tid}/file/ref`, { token: aTok, method: 'POST', body: JSON.stringify({ resource_id: rid }) });
ok('引用 → 201 + share_url', r.status === 201 && r.data.share_url === url1, JSON.stringify(r.data));
const fid = r.data.id;
r = await jreq(`/team/${tid}/files`, { token: bTok });
const ff = r.data.find((f) => f.id === fid);
ok('列表含引用条目 + share_url + 快照信息', ff && ff.share_url === url1 && ff.resource_ref === rid && ff.file_name === 'ref-pic.png' && ff.file_size === CONTENT.length,
  JSON.stringify(ff));
r = await jreq('/team/file/99999/download', { token: bTok });
ok('不存在文件下载 → 404', r.status === 404, `got ${r.status}`);
// B 组内下载（带 token 走 team_file 端点，返回磁盘字节）
const bdl = await fetch(BASE + `/team/file/${fid}/download`, { headers: { Authorization: `Bearer ${bTok}` } });
const bbuf = Buffer.from(await bdl.arrayBuffer());
ok('B 组内下载 → 200 字节一致', bdl.status === 200 && bbuf.equals(CONTENT), `got ${bdl.status} len=${bbuf.length}`);

// ---- 5) 撤销与恢复 ----
console.log('— 撤销/恢复');
r = await jreq(`/resource/${rid}/share`, { token: aTok, method: 'DELETE' });
ok('撤销分享 → 200', r.status === 200 && auditCount('resource-unshare', aId) === 1, `got ${r.status}`);
g = await rawGet(`/resource/share/${tok1}`);
ok('撤销后公开 URL → 404', g.status === 404, `got ${g.status}`);
r = await jreq(`/team/${tid}/files`, { token: bTok });
ok('列表 share_url 变 null（失效标记）', r.data.find((f) => f.id === fid)?.share_url === null, JSON.stringify(r.data.find((f) => f.id === fid)));
const bdl2 = await fetch(BASE + `/team/file/${fid}/download`, { headers: { Authorization: `Bearer ${bTok}` } });
ok('撤销后组内下载 → 410 已失效', bdl2.status === 410, `got ${bdl2.status}`);
r = await jreq(`/resource/${rid}/share`, { token: aTok, method: 'POST' });
const tok2 = r.data.token;
ok('重新分享 → 新 token', r.status === 200 && tok2 !== tok1, JSON.stringify(r.data));
const bdl3 = await fetch(BASE + `/team/file/${fid}/download`, { headers: { Authorization: `Bearer ${bTok}` } });
const bbuf3 = Buffer.from(await bdl3.arrayBuffer());
ok('重新分享后组内下载恢复 → 200', bdl3.status === 200 && bbuf3.equals(CONTENT), `got ${bdl3.status}`);

// ---- 6) 帖子附件 url 形态 ----
console.log('— 帖子附件 url 白名单');
r = await jreq('/share/posts', { token: aTok, method: 'POST', body: JSON.stringify({
  title: '引用附件冒烟帖', content: '<p>测试</p>',
  attachments: [{ name: '引用的图.png', size: CONTENT.length, mime: 'image/png', url: `/api/resource/share/${tok2}` }],
  tags: [],
}) });
ok('发帖带引用型附件 → 200', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
const pid = r.data.id;
const row = db.prepare('SELECT attachments FROM share_post WHERE id = ?').get(pid);
const saved = JSON.parse(row.attachments)[0];
ok('存库条目 = {name,size,mime,url} 无 data', saved && saved.url === `/api/resource/share/${tok2}` && saved.data === undefined && saved.mime === 'image/png',
  JSON.stringify(saved));
// evil url：白名单外 → url 分支拒绝；同条目带 data → 退回 base64 条目
r = await jreq('/share/posts', { token: aTok, method: 'POST', body: JSON.stringify({
  title: 'evil 附件冒烟帖', content: '<p>x</p>',
  attachments: [
    { name: '外链.png', size: 1, mime: 'image/png', url: 'https://evil.com/x.png', data: 'aGVsbG8=' },
    { name: '纯外链.bin', size: 1, mime: 'application/octet-stream', url: 'https://evil.com/y.bin' },
  ],
  tags: [],
}) });
ok('evil url 帖 → 200（清洗不拒发）', r.status === 200, `got ${r.status} ${r.data.error || ''}`);
const row2 = db.prepare('SELECT attachments FROM share_post WHERE id = ?').get(r.data.id);
const saved2 = JSON.parse(row2.attachments);
ok('外链条目退回 base64（无 url）', saved2.length === 1 && saved2[0].name === '外链.png' && saved2[0].data === 'aGVsbG8=' && saved2[0].url === undefined,
  JSON.stringify(saved2));

// ---- 清理 ----
console.log('— 清理测试数据');
db.prepare('DELETE FROM share_post WHERE user_id = ?').run(aId);
db.prepare('DELETE FROM team WHERE id = ?').run(tid); // 级联 team_member/team_file/log/message
db.prepare('DELETE FROM user_resource WHERE user_id = ?').run(aId);
for (const id of [aId, bId]) rmSync(join(RESOURCE_DIR, String(id)), { recursive: true, force: true });
db.prepare('DELETE FROM audit_log WHERE user_id IN (?,?)').run(aId, bId);
db.prepare('DELETE FROM session WHERE user_id IN (?,?)').run(aId, bId);
db.prepare('DELETE FROM user WHERE id IN (?,?)').run(aId, bId);
db.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
