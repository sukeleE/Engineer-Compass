// 管理员细粒度分权冒烟（沙盒自起后端 3111：临时库 + cwd 临时目录避 .env）
// 覆盖：普通用户 403 · /perms 仅超管且结构完整 · user/content/resource/feedback/log 五组
//   子权限只读 200/高危 403 · 父 key 旧数据整组继承不缩权 · 不存在 id 时守卫先于处理器
//   （403 vs 404 验证守卫挂载）· 超管任命子 key 落库（非法 key 过滤、中文消息、会话即时生效）·
//   受限管理员任命他人 403 · 超管操作自己 400
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BACKEND = join(ROOT, 'backend');
const PORT = 3111;
const BASE = `http://localhost:${PORT}/api`;

const work = mkdtempSync(join(tmpdir(), 'smk-adminp-'));
const serverEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  PORT: String(PORT),
  DB_PATH: join(work, 'compass.db'),
  SHARE_UPLOAD_DIR: join(work, 'share'),
  HONOR_UPLOAD_DIR: join(work, 'honor'),
  PURCHASE_UPLOAD_DIR: join(work, 'purchase'),
};

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}${extra ? ` → ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`)); };

const req = async (path, opts = {}) => {
  const headers = {
    ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
  };
  const res = await fetch(BASE + path, {
    headers, method: opts.method || 'GET',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { res, status: res.status, data };
};

let server = null, db = null;
const serverLog = [];
try {
  server = spawn(process.execPath, [join(BACKEND, 'server.js')], {
    cwd: work, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  server.stdout.on('data', (b) => String(b).split('\n').filter(Boolean).forEach((l) => serverLog.push(l)));
  server.stderr.on('data', (b) => String(b).split('\n').filter(Boolean).forEach((l) => serverLog.push(l)));

  const ready = await (async () => {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return true; } catch { /* 等 */ }
      await new Promise((s) => setTimeout(s, 250));
    }
    return false;
  })();
  if (!ready) throw new Error('临时后端 15s 内未就绪');

  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(serverEnv.DB_PATH);
  db.exec('PRAGMA busy_timeout=5000');

  // ---------- 账号 ----------
  const stamp = Date.now().toString(36);
  const reg = async (tag) => (await (await fetch(`${BASE}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `adm_${tag}_${stamp}@x.dev`, password: 'pass123456', nickname: `冒烟${tag}` }),
  })).json());
  const tags = ['超', '看户', '封禁', '提醒', '旧父', '帖', '评', '旧容', '看资', '删资', '看馈', '删馈', '日志', '访录', '目标1', '目标2', '目标3', '路人'];
  const acc = {};
  for (const t of tags) acc[t] = (await reg(t)).user;
  const tokenOf = (t) => db.prepare('SELECT token FROM session WHERE user_id = ? ORDER BY rowid DESC LIMIT 1').get(acc[t].id).token;
  // 注册接口是否直接回 token 无所谓：会话表里每人最新一条即当前会话
  const setAdmin = (t, perms) => db.prepare('UPDATE user SET is_admin = 1, admin_perms = ? WHERE id = ?')
    .run(perms == null ? '' : JSON.stringify(perms), acc[t].id);
  const T = {};
  for (const t of tags) T[t] = tokenOf(t);

  setAdmin('超', []);
  setAdmin('看户', ['user:view']);
  setAdmin('封禁', ['user:moderate']);
  setAdmin('提醒', ['user:notify']);
  setAdmin('旧父', ['user']);
  setAdmin('帖', ['content:post']);
  setAdmin('评', ['content:comment']);
  setAdmin('旧容', ['content']);
  setAdmin('看资', ['resource:view']);
  setAdmin('删资', ['resource:delete']);
  setAdmin('看馈', ['feedback:view']);
  setAdmin('删馈', ['feedback:delete']);
  setAdmin('日志', ['log:action']);
  setAdmin('访录', ['log:visit']);
  ok('18 名用户就位（1 超管 + 13 受限 + 3 目标 + 1 路人）', Object.keys(acc).length === 18);

  // ---------- 0. 闸门 ----------
  ok('普通用户 GET /admin/users → 403', (await req('/admin/users', { token: T.路人 })).status === 403);
  ok('普通用户 GET /admin/server-status → 403', (await req('/admin/server-status', { token: T.路人 })).status === 403);
  ok('未登录 GET /admin/users → 401', (await req('/admin/users')).status === 401);

  // ---------- 1. /perms 结构 ----------
  ok('/perms 普通用户 403', (await req('/admin/perms', { token: T.路人 })).status === 403);
  ok('/perms 受限管理员 403（仅超管）', (await req('/admin/perms', { token: T.看户 })).status === 403);
  const prm = await req('/admin/perms', { token: T.超 });
  ok('/perms 超管 200 + 5 个分组 + user 组 3 子项',
    prm.status === 200 && prm.data.groups?.length === 5 &&
    prm.data.groups.find((g) => g.key === 'user')?.children?.length === 3 &&
    prm.data.flat?.competition === '竞赛审核', prm.data);
  ok('/perms 子 key 齐全',
    ['user:view', 'user:moderate', 'user:notify', 'content:post', 'content:comment',
      'resource:view', 'resource:delete', 'feedback:view', 'feedback:delete', 'log:action', 'log:visit']
      .every((k) => prm.data.groups.some((g) => g.children.some((c) => c.key === k))));

  // ---------- 2. user 组 ----------
  let r = await req('/admin/users', { token: T.看户 });
  ok('user:view：用户列表 200', r.status === 200 && Array.isArray(r.data.list));
  ok('user:view：用户详情 200', (await req(`/admin/users/${acc.目标1.id}/detail`, { token: T.看户 })).status === 200);
  ok('user:view：封禁 403', (await req(`/admin/users/${acc.目标1.id}/status`, { method: 'PUT', token: T.看户, body: { status: 1 } })).status === 403);
  ok('user:view：改密提醒 403', (await req('/admin/notices/password-remind', { method: 'POST', token: T.看户 })).status === 403);
  ok('user:view：实名提醒 403', (await req('/admin/notices/realname-remind', { method: 'POST', token: T.看户 })).status === 403);
  ok('user:view：任命管理员 403', (await req(`/admin/users/${acc.目标1.id}/role`, { method: 'PUT', token: T.看户, body: { is_admin: 1, perms: ['server'] } })).status === 403);

  ok('user:moderate：列表 403', (await req('/admin/users', { token: T.封禁 })).status === 403);
  const ban = await req(`/admin/users/${acc.目标1.id}/status`, { method: 'PUT', token: T.封禁, body: { status: 1 } });
  ok('user:moderate：封禁路人 200', ban.status === 200, ban.data);
  ok('user:moderate：改密提醒 403', (await req('/admin/notices/password-remind', { method: 'POST', token: T.封禁 })).status === 403);

  ok('user:notify：列表 403', (await req('/admin/users', { token: T.提醒 })).status === 403);
  ok('user:notify：封禁 403', (await req(`/admin/users/${acc.目标2.id}/status`, { method: 'PUT', token: T.提醒, body: { status: 2 } })).status === 403);
  ok('user:notify：改密提醒 200', (await req('/admin/notices/password-remind', { method: 'POST', token: T.提醒 })).status === 200);
  ok('user:notify：实名提醒 200', (await req('/admin/notices/realname-remind', { method: 'POST', token: T.提醒 })).status === 200);

  // ---------- 3. 旧父 key 零迁移：持 user 整组全通过 ----------
  ok('旧数据 user 父 key：列表 200', (await req('/admin/users', { token: T.旧父 })).status === 200);
  ok('旧数据 user 父 key：详情 200', (await req(`/admin/users/${acc.目标2.id}/detail`, { token: T.旧父 })).status === 200);
  ok('旧数据 user 父 key：禁言 200', (await req(`/admin/users/${acc.目标2.id}/status`, { method: 'PUT', token: T.旧父, body: { status: 2 } })).status === 200);
  ok('旧数据 user 父 key：改密提醒 200', (await req('/admin/notices/password-remind', { method: 'POST', token: T.旧父 })).status === 200);
  ok('旧数据 user 父 key：任命仍 403（任命永远仅超管）', (await req(`/admin/users/${acc.目标2.id}/role`, { method: 'PUT', token: T.旧父, body: { is_admin: 1, perms: [] } })).status === 403);

  // ---------- 4. content 组（不存在 id：守卫 403 先于处理器 404） ----------
  ok('content:post：帖子列表 200', (await req('/admin/posts', { token: T.帖 })).status === 200);
  ok('content:post：评论列表 403', (await req('/admin/comments', { token: T.帖 })).status === 403);
  ok('content:post：删帖过守卫（404 不存在）', (await req('/admin/posts/999999', { method: 'DELETE', token: T.帖 })).status === 404);
  ok('content:post：删评论 403', (await req('/admin/comments/999999', { method: 'DELETE', token: T.帖 })).status === 403);

  ok('content:comment：帖子列表 403', (await req('/admin/posts', { token: T.评 })).status === 403);
  ok('content:comment：评论列表 200', (await req('/admin/comments', { token: T.评 })).status === 200);
  ok('content:comment：删评论过守卫（404 不存在）', (await req('/admin/comments/999999', { method: 'DELETE', token: T.评 })).status === 404);
  ok('content:comment：删帖 403', (await req('/admin/posts/999999', { method: 'DELETE', token: T.评 })).status === 403);

  ok('旧数据 content 父 key：帖子/评论列表均 200',
    (await req('/admin/posts', { token: T.旧容 })).status === 200 &&
    (await req('/admin/comments', { token: T.旧容 })).status === 200);
  ok('旧数据 content 父 key：删帖/删评论均过守卫（404）',
    (await req('/admin/posts/999999', { method: 'DELETE', token: T.旧容 })).status === 404 &&
    (await req('/admin/comments/999999', { method: 'DELETE', token: T.旧容 })).status === 404);

  // ---------- 5. resource 组 ----------
  ok('resource:view：列表 200', (await req('/admin/resources', { token: T.看资 })).status === 200);
  ok('resource:view：删除 403（只读不能越过高危守卫）', (await req('/admin/resources/999999', { method: 'DELETE', token: T.看资 })).status === 403);
  ok('resource:delete：列表 403', (await req('/admin/resources', { token: T.删资 })).status === 403);
  ok('resource:delete：删除过守卫（404 不存在）', (await req('/admin/resources/999999', { method: 'DELETE', token: T.删资 })).status === 404);

  // ---------- 6. feedback 组 ----------
  ok('feedback:view：列表 200', (await req('/admin/feedback', { token: T.看馈 })).status === 200);
  ok('feedback:view：删除 403', (await req('/admin/feedback/999999', { method: 'DELETE', token: T.看馈 })).status === 403);
  ok('feedback:delete：列表 403', (await req('/admin/feedback', { token: T.删馈 })).status === 403);
  ok('feedback:delete：删除过守卫（404 不存在）', (await req('/admin/feedback/999999', { method: 'DELETE', token: T.删馈 })).status === 404);

  // ---------- 7. log 组拆分 ----------
  ok('log:action：操作日志 200', (await req('/admin/logs', { token: T.日志 })).status === 200);
  ok('log:action：访问记录 403', (await req('/admin/visits', { token: T.日志 })).status === 403);
  ok('log:visit：操作日志 403', (await req('/admin/logs', { token: T.访录 })).status === 403);
  ok('log:visit：访问记录 200', (await req('/admin/visits', { token: T.访录 })).status === 200);

  // ---------- 8. 超管任命：子 key 落库 / 非法过滤 / 会话即时生效 ----------
  const role = await req(`/admin/users/${acc.目标3.id}/role`, {
    method: 'PUT', token: T.超,
    body: { is_admin: 1, perms: ['user:view', 'resource:delete', 'bogus:xx', 'user:view'] },
  });
  ok('超管任命子权限 200 + 中文消息含子项名',
    role.status === 200 && /查看用户/.test(role.data.message) && /删除资源/.test(role.data.message), role.data);
  const row = db.prepare('SELECT admin_perms FROM user WHERE id = ?').get(acc.目标3.id);
  ok('落库：非法 key 过滤 + 去重', row.admin_perms === JSON.stringify(['user:view', 'resource:delete']), row.admin_perms);
  ok('新权限会话即时生效：用户列表 200', (await req('/admin/users', { token: T.目标3 })).status === 200);
  ok('新权限会话即时生效：删资源过守卫 404', (await req('/admin/resources/999999', { method: 'DELETE', token: T.目标3 })).status === 404);
  ok('新权限会话即时生效：操作日志 403', (await req('/admin/logs', { token: T.目标3 })).status === 403);
  const listed = (await req('/admin/users', { token: T.超 })).data.list.find((u) => u.id === acc.目标3.id);
  ok('列表 safeUser.perms 回传子 key', Array.isArray(listed.perms) && listed.perms.join(',') === 'user:view,resource:delete', listed);

  // ---------- 9. 超管自我保护 ----------
  ok('超管操作自己 → 400', (await req(`/admin/users/${acc.超.id}/role`, { method: 'PUT', token: T.超, body: { is_admin: 0, perms: [] } })).status === 400);
  const sup = await req('/admin/server-status', { token: T.超 });
  ok('超管：服务器状态 200', sup.status === 200);
} catch (e) {
  fail++;
  console.error('💥 冒烟异常：', e.message);
  console.error(serverLog.slice(-30).join('\n'));
} finally {
  try { db?.close(); } catch { /* 已关 */ }
  if (server) {
    try {
      process.platform === 'win32'
        ? spawnSync('taskkill', ['/F', '/T', '/PID', String(server.pid)])
        : server.kill('SIGKILL');
    } catch { /* 已退出 */ }
  }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* 沙盒清理尽力而为 */ }
}

console.log(`\n管理员分权冒烟：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
