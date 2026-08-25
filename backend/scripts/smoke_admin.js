// 后台管理接口冒烟测试（node 内联 fetch；覆盖：adminRequired 权限 / 用户管理 / 封禁禁言拦截 / 审计埋点 / 公告 CRUD / 服务器状态）
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

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ---- 准备：直插测试用户（管理员 + 普通用户）----
const db = new DatabaseSync(DB);
const ADMIN_MAIL = 'smoke_admin@x.com', USER_MAIL = 'smoke_user@x.com';
db.prepare('DELETE FROM user WHERE email IN (?,?)').run(ADMIN_MAIL, USER_MAIL);
const adminId = Number(db.prepare(
  "INSERT INTO user (username, nickname, password_hash, email, is_admin) VALUES (?,?,?,?,1)"
).run('smoke_admin', '冒烟管理员', hashPassword('test123456'), ADMIN_MAIL).lastInsertRowid);
const userId = Number(db.prepare(
  "INSERT INTO user (username, nickname, password_hash, email) VALUES (?,?,?,?)"
).run('smoke_user', '冒烟用户', hashPassword('test123456'), USER_MAIL).lastInsertRowid);
console.log(`— 测试账号 admin=${adminId} user=${userId}`);

const auditCount = (action) => db.prepare(
  'SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ? AND action = ?').get(adminId, action).n + db.prepare(
  'SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ? AND action = ?').get(userId, action).n;

// ---- 1) 权限 ----
console.log('— adminRequired 权限');
let r = await req('/admin/users');
ok('无 token 访问 /admin/users → 401', r.status === 401, `got ${r.status}`);
const adminLogin = await req('/auth/login', { method: 'POST', body: JSON.stringify({ email: ADMIN_MAIL, password: 'test123456' }) });
ok('管理员登录 → 200', adminLogin.status === 200, `got ${adminLogin.status}`);
const adminTok = adminLogin.data.token;
const userLogin = await req('/auth/login', { method: 'POST', body: JSON.stringify({ email: USER_MAIL, password: 'test123456' }) });
ok('普通用户登录 → 200', userLogin.status === 200, `got ${userLogin.status}`);
const userTok = userLogin.data.token;
r = await req('/admin/users', { token: userTok });
ok('普通用户访问 → 403', r.status === 403 && r.data.error === '需要管理员权限', `got ${r.status} ${r.data.error}`);

// ---- 2) 用户列表 ----
r = await req('/admin/users?size=5&q=冒烟', { token: adminTok });
ok('GET /admin/users 分页+搜索', r.status === 200 && r.data.total >= 2 && r.data.list.length >= 2
  && r.data.list.every((u) => u.nickname && !('password_hash' in u)), `total=${r.data.total}`);

// ---- 3) 操作日志 ----
r = await req('/admin/logs?action=login', { token: adminTok });
ok('GET /admin/logs 按 action=login 过滤', r.status === 200 && r.data.list.length >= 2
  && r.data.list.every((l) => l.action === 'login'), `count=${r.data.list.length}`);

// ---- 4) 计划/好友/评论/私信埋点 ----
console.log('— 审计埋点（普通用户动作）');
r = await req('/schedule/manual', { token: userTok, method: 'POST', body: JSON.stringify({
  title: '冒烟自编计划', phases: [{ phase: '学习', tasks: [{ text: '看文档' }] }],
}) });
ok('自编计划 → 201', r.status === 201, `got ${r.status}`);
ok('audit_log 有 plan-manual', auditCount('plan-manual') === 1, auditCount('plan-manual'));
r = await req('/share/posts', { token: userTok, method: 'POST', body: JSON.stringify({ title: '冒烟帖', content: '冒烟内容' }) });
const postId = r.data.id;
ok('发帖 → 200', r.status === 200, `got ${r.status}`);
r = await req(`/share/posts/${postId}/comments`, { token: userTok, method: 'POST', body: JSON.stringify({ content: '冒烟评论' }) });
ok('评论 → 200', r.status === 200, `got ${r.status}`);
ok('audit_log 有 comment-share', auditCount('comment-share') === 1, auditCount('comment-share'));
r = await req('/friends/request', { token: userTok, method: 'POST', body: JSON.stringify({ to_id: adminId }) });
ok('好友申请 → 200', r.status === 200, `got ${r.status}`);
ok('audit_log 有 friend-request', auditCount('friend-request') >= 1, auditCount('friend-request'));
r = await req(`/friends/dm/${adminId}`, { token: userTok, method: 'POST', body: JSON.stringify({ content: '冒烟私信' }) });
ok('私信 → 200', r.status === 200, `got ${r.status}`);
ok('audit_log 有 dm-send', auditCount('dm-send') >= 1, auditCount('dm-send'));

// ---- 5) 公告 CRUD + 前台 latest ----
console.log('— 公告');
r = await req('/admin/announcements', { token: adminTok, method: 'POST', body: JSON.stringify({ title: '冒烟公告', content: '冒烟公告内容', pinned: 1 }) });
ok('发布公告 → 201', r.status === 201, `got ${r.status}`);
const annId = r.data.id;
r = await req('/announcements/latest');
ok('前台 latest 返回置顶公告', r.status === 200 && r.data?.id === annId && r.data.pinned === 1, JSON.stringify(r.data));
r = await req(`/admin/announcements/${annId}`, { token: adminTok, method: 'PUT', body: JSON.stringify({ title: '冒烟公告改', pinned: 0 }) });
ok('编辑公告 → 200', r.status === 200, `got ${r.status}`);
r = await req('/announcements/latest');
ok('取消置顶后 latest 不再返回它', r.data?.id !== annId || !r.data.pinned, JSON.stringify(r.data));
ok('audit_log 有 announce-create/update', auditCount('announce-create') === 1 && auditCount('announce-update') === 1);

// ---- 6) 禁言拦截 ----
console.log('— 禁言拦截');
r = await req(`/admin/users/${userId}/status`, { token: adminTok, method: 'PUT', body: JSON.stringify({ status: 2 }) });
ok('禁言 → 200', r.status === 200, `got ${r.status}`);
ok('audit_log 有 user-status', auditCount('user-status') === 1, auditCount('user-status'));
r = await req('/share/posts', { token: userTok, method: 'POST', body: JSON.stringify({ title: 'x', content: 'x' }) });
ok('禁言用户发帖 → 403', r.status === 403 && r.data.error.includes('禁言'), `got ${r.status}`);
r = await req(`/friends/dm/${adminId}`, { token: userTok, method: 'POST', body: JSON.stringify({ content: 'x' }) });
ok('禁言用户私信 → 403', r.status === 403, `got ${r.status}`);
r = await req(`/admin/users/${userId}/status`, { token: adminTok, method: 'PUT', body: JSON.stringify({ status: 0 }) });
ok('解禁 → 200', r.status === 200, `got ${r.status}`);

// ---- 7) 封禁拦截 ----
console.log('— 封禁拦截');
r = await req(`/admin/users/${userId}/status`, { token: adminTok, method: 'PUT', body: JSON.stringify({ status: 1 }) });
ok('封禁 → 200', r.status === 200, `got ${r.status}`);
r = await req('/friends', { token: userTok });
ok('封禁用户 token 访问 → 403', r.status === 403 && r.data.error.includes('封禁'), `got ${r.status}`);
r = await req('/auth/login', { method: 'POST', body: JSON.stringify({ email: USER_MAIL, password: 'test123456' }) });
ok('封禁用户登录 → 403', r.status === 403 && r.data.error.includes('封禁'), `got ${r.status}`);
r = await req(`/admin/users/${userId}/status`, { token: adminTok, method: 'PUT', body: JSON.stringify({ status: 0 }) });
ok('解封 → 200', r.status === 200, `got ${r.status}`);

// ---- 8) 服务器状态 ----
r = await req('/admin/server-status', { token: adminTok });
ok('server-status 字段完整', r.status === 200 && r.data.counts && typeof r.data.uptime === 'number'
  && typeof r.data.totalmem === 'number' && typeof r.data.dbSize === 'number'
  && r.data.counts.users >= 2 && r.data.counts.todayLogins >= 2, JSON.stringify(r.data).slice(0, 120));

// ---- 9) 内容管理：帖子/评论列表与删除级联 ----
console.log('— 内容管理（帖子/评论）');
// 直插：帖子 + 2 评论 + 1 通知
const tPostId = Number(db.prepare(
  "INSERT INTO share_post (user_id, title, content) VALUES (?, '冒烟测试帖', '内容')"
).run(userId).lastInsertRowid);
db.prepare("INSERT INTO share_comment (post_id, user_id, content) VALUES (?,?, '评论A')").run(tPostId, userId);
db.prepare("INSERT INTO share_comment (post_id, user_id, content) VALUES (?,?, '评论B')").run(tPostId, userId);
db.prepare("INSERT INTO notification (user_id, actor_id, type, post_id) VALUES (?,?, 'like', ?)").run(adminId, userId, tPostId);
r = await req('/admin/posts', { token: userTok });
ok('普通用户访问 /admin/posts → 403', r.status === 403, `got ${r.status}`);
r = await req('/admin/posts?q=冒烟测试帖', { token: adminTok });
ok('帖子列表搜到测试帖（含评论数）', r.status === 200 && r.data.list.some((p) => p.id === tPostId && p.comment_count === 2), JSON.stringify(r.data).slice(0, 100));
r = await req(`/admin/comments?postId=${tPostId}`, { token: adminTok });
ok('评论按帖子筛选 → 2 条', r.status === 200 && r.data.total === 2 && r.data.list[0].post_title, JSON.stringify(r.data).slice(0, 100));
r = await req(`/admin/posts/${tPostId}`, { token: adminTok, method: 'DELETE' });
ok('删除帖子 → 200', r.status === 200, `got ${r.status}`);
const cc = db.prepare('SELECT COUNT(*) AS n FROM share_comment WHERE post_id = ?').get(tPostId).n;
const nc = db.prepare('SELECT COUNT(*) AS n FROM notification WHERE post_id = ?').get(tPostId).n;
ok('评论随帖子级联删除', cc === 0, `剩 ${cc}`);
ok('通知随帖子级联删除', nc === 0, `剩 ${nc}`);
ok('post-delete 审计埋点', auditCount('post-delete') >= 1);
const tPostId2 = Number(db.prepare(
  "INSERT INTO share_post (user_id, title) VALUES (?, '冒烟测试帖2')"
).run(userId).lastInsertRowid);
const tCommentId = Number(db.prepare(
  "INSERT INTO share_comment (post_id, user_id, content) VALUES (?,?, '待删评论')"
).run(tPostId2, userId).lastInsertRowid);
db.prepare("INSERT INTO notification (user_id, actor_id, type, post_id, comment_id) VALUES (?,?, 'comment', ?, ?)").run(adminId, userId, tPostId2, tCommentId);
r = await req(`/admin/comments/${tCommentId}`, { token: adminTok, method: 'DELETE' });
ok('删除评论 → 200', r.status === 200, `got ${r.status}`);
const notifLeft = db.prepare('SELECT COUNT(*) AS n FROM notification WHERE comment_id = ?').get(tCommentId).n;
ok('评论通知同步清理', notifLeft === 0, `剩 ${notifLeft}`);
ok('comment-delete 审计埋点', auditCount('comment-delete') >= 1);
db.prepare('DELETE FROM share_post WHERE id = ?').run(tPostId2);

// ---- 10) 用户详情 ----
console.log('— 用户详情');
r = await req(`/admin/users/${userId}/detail`, { token: adminTok });
ok('用户详情字段完整', r.status === 200 && r.data.user && typeof r.data.stats === 'object'
  && r.data.stats.teams >= 0 && Array.isArray(r.data.logs), JSON.stringify(r.data).slice(0, 100));
ok('详情含操作日志（登录埋点）', r.data.logs.some((l) => l.action === 'login'), '无 login 日志');

// ---- 11) 角色管理 ----
console.log('— 角色管理');
r = await req(`/admin/users/${userId}/role`, { token: adminTok, method: 'PUT', body: JSON.stringify({ is_admin: 1 }) });
ok('设为管理员 → 200', r.status === 200, `got ${r.status}`);
const nowAdmin = db.prepare('SELECT is_admin FROM user WHERE id = ?').get(userId).is_admin;
ok('数据库 is_admin 已置 1', nowAdmin === 1, `got ${nowAdmin}`);
r = await req(`/admin/users/${userId}/role`, { token: adminTok, method: 'PUT', body: JSON.stringify({ is_admin: 0 }) });
ok('取消管理员 → 200', r.status === 200, `got ${r.status}`);
ok('user-role 审计埋点', auditCount('user-role') >= 2);
r = await req(`/admin/users/${adminId}/role`, { token: adminTok, method: 'PUT', body: JSON.stringify({ is_admin: 0 }) });
ok('操作自己 → 400', r.status === 400, `got ${r.status}`);

// ---- 清理 ----
console.log('— 清理测试数据');
db.prepare('DELETE FROM audit_log WHERE user_id IN (?,?)').run(adminId, userId);
db.prepare('DELETE FROM announcement WHERE admin_id = ?').run(adminId);
db.prepare('DELETE FROM share_comment WHERE post_id = ?').run(postId);
db.prepare('DELETE FROM share_post WHERE id = ?').run(postId);
db.prepare('DELETE FROM friend_request WHERE from_id = ? OR to_id = ?').run(userId, userId);
db.prepare('DELETE FROM friend WHERE user_id = ? OR friend_id = ?').run(userId, userId);
db.prepare('DELETE FROM dm_message WHERE from_id = ? OR to_id = ?').run(userId, userId);
db.prepare('DELETE FROM user_schedule WHERE user_id = ?').run(userId);
db.prepare('DELETE FROM session WHERE user_id IN (?,?)').run(adminId, userId);
db.prepare('DELETE FROM user WHERE id IN (?,?)').run(adminId, userId);
db.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
