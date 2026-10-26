// GitHub OAuth 冒烟（沙盒自起后端 3109：临时库 + cwd 临时目录避 .env + 假 GitHub 3199）
// 覆盖：公开 configured/health · 绑定成功（bind 行/token_prefix/审计）· 同 GitHub 绑第二人拒绝 ·
//   一键登录四分支（已绑定 / 验证邮箱自动绑定 / 全新身份建号 / 仅 noreply 邮箱 email=NULL）·
//   邮箱账号已绑别的 GitHub → 拒绝且不增会话 · 封禁拒绝 · state 未知/复用 400 ·
//   错误描述 <script> 转义不渲原文 · 解绑审计。全程不连真 github.com。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { startFakeGithub } from './lib/fakeGithub.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BACKEND = join(ROOT, 'backend');
const PORT = 3109;
const FAKE = 3199;
const BASE = `http://localhost:${PORT}/api`;
const REDIRECT = `http://127.0.0.1:${PORT}/api/github/oauth/callback`;

const work = mkdtempSync(join(tmpdir(), 'smk-github-'));
const serverEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  PORT: String(PORT),
  DB_PATH: join(work, 'compass.db'),
  SHARE_UPLOAD_DIR: join(work, 'share'),
  HONOR_UPLOAD_DIR: join(work, 'honor'),
  PURCHASE_UPLOAD_DIR: join(work, 'purchase'),
  GITHUB_CLIENT_ID: 'smk_cid',
  GITHUB_CLIENT_SECRET: 'smk_secret',
  GITHUB_API_ORIGIN: `http://127.0.0.1:${FAKE}`,
  GITHUB_REDIRECT_URI: REDIRECT,
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
const api = async (path, opts = {}) => {
  const r = await req(path, opts);
  if (!r.res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};

let server = null, fake = null, db = null;
const serverLog = [];
try {
  fake = await startFakeGithub(FAKE);
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
  const reg = async (tag, email) => (await api('/auth/register', {
    method: 'POST',
    body: { email: email || `ghk_${tag}_${stamp}@x.dev`, password: 'pass123456', nickname: `冒烟${tag}` },
  }));
  const rA = await reg('甲');
  const rB = await reg('乙');
  const rC = await reg('丙', `autobind_${stamp}@x.dev`);
  const rD = await reg('丁', `banned_${stamp}@x.dev`);
  const [A, B, C, D] = [rA.user, rB.user, rC.user, rD.user];
  // 假身份 mail/taken 的邮箱夹具固定为 autobind@x.dev —— 把本站丙账号邮箱改成它（走 DB 直改，沙盒库）
  db.prepare('UPDATE user SET email = ? WHERE id = ?').run('autobind@x.dev', C.id);
  db.prepare('UPDATE user SET status = 1 WHERE id = ?').run(D.id); // 丁封禁（邮箱 banned@x.dev 也对齐夹具）
  db.prepare('UPDATE user SET email = ? WHERE id = ?').run('banned@x.dev', D.id);
  ok('四人就位（丙持 autobind 邮箱、丁封禁持 banned 邮箱）', !![A.id, B.id, C.id, D.id].every(Boolean));

  // OAuth 舞步：发起 URL → 抠 state → 打回调页
  const stateOf = (u) => new URL(u, 'http://x').searchParams.get('state');
  const bindUrl = (token) => api('/github/oauth/auth', { token }).then((d) => d.url);
  const loginUrl = () => api('/github/oauth/login').then((d) => d.url);
  const callback = async (code, state) => {
    const q = new URLSearchParams({ code, state: state || 'deadbeef' });
    const res = await fetch(`${BASE}/github/oauth/callback?${q}`);
    return { status: res.status, html: await res.text() };
  };
  const payloadOf = (html) => {
    const m = html.match(/var payload = (\{[\s\S]*?\});\s*\n/);
    return m ? JSON.parse(m[1]) : null;
  };
  const bindCount = (ghId) => db.prepare('SELECT COUNT(*) c FROM github_bind WHERE github_id = ?').get(ghId).c;
  const sessionsOf = (uid) => db.prepare('SELECT COUNT(*) c FROM session WHERE user_id = ?').get(uid).c;
  const lastAudit = (action) => db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action);

  // ---------- 1. 公开开关 ----------
  const health = await (await fetch(`http://localhost:${PORT}/api/health`)).json();
  ok('health.github=true', health.github === true, health);
  const cfg = await (await fetch(`${BASE}/github/oauth/configured`)).json();
  ok('匿名 GET /oauth/configured → true', cfg.configured === true);

  // ---------- 2. A 绑定 bound 身份 ----------
  let cb = await callback('bound', stateOf(await bindUrl(rA.token)));
  let p = payloadOf(cb.html);
  ok('绑定成功：200 + github-bound + targetOrigin 同源',
    cb.status === 200 && p?.type === 'github-bound' && p.login === 'gh-bound' &&
    cb.html.includes('"http://127.0.0.1:3109"'), { p });
  const row = db.prepare('SELECT * FROM github_bind WHERE user_id = ?').get(A.id);
  ok('绑定落库：github_id=1001 login/avatar/token_prefix(8)',
    !!row && row.github_id === 1001 && row.login === 'gh-bound' &&
    row.avatar_url.includes('/u/1001.png') && row.token_prefix === 'tok_boun' && row.token_prefix.length === 8, row);
  const ab = lastAudit('github-bind');
  ok('审计 github-bind（user=甲，target=gh-bound）', ab && ab.user_id === A.id && ab.target === 'gh-bound', ab);
  const st = await req('/github/oauth/status', { token: rA.token });
  ok('status：bound=true + login', st.data.bound === true && st.data.login === 'gh-bound');
  ok('绑定回调页：返回按钮指向账号安全页', /href="\/account-security"/.test(cb.html));

  // ---------- 3. B 再绑同一 GitHub → 友好拒绝（无 SQL 原文） ----------
  cb = await callback('bound', stateOf(await bindUrl(rB.token)));
  p = payloadOf(cb.html);
  ok('第二人绑同一 GitHub：400 + 友好文案 + 不渲 SQL',
    cb.status === 400 && p?.type === 'github-oauth-error' &&
    /已绑定其他本站账号/.test(p.message) && !/SQLITE|CONSTRAINT|sql/i.test(cb.html), p);
  ok('1001 仍只绑一人（B 无 bind 行）', bindCount(1001) === 1 && !db.prepare('SELECT 1 FROM github_bind WHERE user_id=?').get(B.id));
  ok('错误回调页：返回按钮指向登录页', /href="\/login"/.test(cb.html) && /秒后自动返回/.test(cb.html));

  // ---------- 4. 已绑定身份一键登录 = A ----------
  cb = await callback('bound', stateOf(await loginUrl()));
  p = payloadOf(cb.html);
  ok('已绑定登录：github-login 带 token+user', cb.status === 200 && p?.type === 'github-login'
    && /^[0-9a-f]{64}$/.test(p.token) && p.user.id === A.id, p && { type: p.type, uid: p.user?.id });
  const me = await req('/auth/me', { token: p.token });
  ok('会话 token 可用：/auth/me = 甲', me.status === 200 && me.data.user.id === A.id);
  const al = lastAudit('github-login');
  ok('审计 github-login via=bound', al && al.user_id === A.id && JSON.parse(al.detail).via === 'bound', al);
  ok('登录回调页：无 opener 兜底写 ec_token + 按钮回首页',
    cb.html.includes("localStorage.setItem('ec_token'") && /href="\/"/.test(cb.html)
    && /location\.replace\(fallback\)/.test(cb.html),
    cb.html.slice(0, 200));

  // ---------- 5. mail 身份按验证邮箱自动绑到丙 ----------
  const cSessBefore = sessionsOf(C.id);
  cb = await callback('mail', stateOf(await loginUrl()));
  p = payloadOf(cb.html);
  ok('邮箱自动绑定登录：user=丙 + bind 1002', cb.status === 200 && p?.type === 'github-login' &&
    p.user.id === C.id && bindCount(1002) === 1, p && p.user);
  ok('自动绑定新建了会话', sessionsOf(C.id) === cSessBefore + 1);
  ok('审计 via=email-autobind', JSON.parse(lastAudit('github-login').detail).via === 'email-autobind');

  // ---------- 6. taken：同邮箱不同 github_id → 拒绝、不增会话 ----------
  cb = await callback('taken', stateOf(await loginUrl()));
  p = payloadOf(cb.html);
  ok('邮箱账号已绑别的 GitHub：400 拒绝', cb.status === 400 && p?.type === 'github-oauth-error' &&
    /已绑定其他 GitHub/.test(p.message), p);
  ok('拒绝后无新会话、无 1005 bind', sessionsOf(C.id) === cSessBefore + 1 && bindCount(1005) === 0);

  // ---------- 7. new：全新身份自动建新号 ----------
  cb = await callback('new', stateOf(await loginUrl()));
  p = payloadOf(cb.html);
  const nu = p?.user;
  ok('新身份登录成功 + login 净化为 gh_new', cb.status === 200 && p?.type === 'github-login' &&
    nu?.username === 'gh_new', nu);
  const nuRow = db.prepare('SELECT * FROM user WHERE id = ?').get(nu.id);
  ok('新号落库：昵称/邮箱/头像取自 GitHub，password_set=1',
    nuRow.nickname === '新来的 Octo' && nuRow.email === 'brand-new@x.dev' &&
    nuRow.avatar.includes('/u/1003.png') && nuRow.password_set === 1, { nick: nuRow.nickname, email: nuRow.email });
  ok('新号无初始密码公告', db.prepare("SELECT COUNT(*) c FROM personal_notice WHERE user_id=? AND type='password_init'").get(nu.id).c === 0);
  ok('GitHub 新号默认未实名（gh.name 不自动当真名）', nu.real_name === '' && nuRow.real_name === '', { nu, real: nuRow.real_name });
  ok('GitHub 建号即发 1 条未读实名公告',
    db.prepare("SELECT COUNT(*) c FROM personal_notice WHERE user_id=? AND type='realname_required' AND is_read=0").get(nu.id).c === 1);
  ok('审计 via=register + bind 1003', JSON.parse(lastAudit('github-login').detail).via === 'register' && bindCount(1003) === 1);

  // ---------- 8. noreply：登录成功但 email=NULL ----------
  cb = await callback('noreply', stateOf(await loginUrl()));
  p = payloadOf(cb.html);
  ok('noreply 登录成功', cb.status === 200 && p?.type === 'github-login' && /^[0-9a-f]{64}$/.test(p.token));
  const nrRow = db.prepare('SELECT * FROM user WHERE id = ?').get(p.user.id);
  ok('noreply 邮箱不入库（email IS NULL）+ 有 bind + 无公告',
    (nrRow.email === null || nrRow.email === '') && bindCount(1004) === 1 &&
    db.prepare("SELECT COUNT(*) c FROM personal_notice WHERE user_id=? AND type='password_init'").get(nrRow.id).c === 0, nrRow);

  // ---------- 9. banned：封禁账号邮箱匹配 → 拒绝不建会话/bind ----------
  const dSess = sessionsOf(D.id);
  cb = await callback('banned', stateOf(await loginUrl()));
  p = payloadOf(cb.html);
  ok('封禁身份：400 + 封禁文案', cb.status === 400 && p?.type === 'github-oauth-error' && /封禁/.test(p.message), p);
  ok('封禁不建会话、不建 bind', sessionsOf(D.id) === dSess && bindCount(1006) === 0);

  // ---------- 10. state：未知 + 复用 ----------
  cb = await callback('bound', 'deadbeef-state');
  p = payloadOf(cb.html);
  ok('未知 state：400 + 错误消息', cb.status === 400 && p?.type === 'github-oauth-error' && /state/.test(p.message), p);
  const realUrl = await loginUrl();
  const realState = stateOf(realUrl);
  cb = await callback('bound', realState);
  ok('state 首次使用成功', cb.status === 200 && payloadOf(cb.html)?.type === 'github-login');
  cb = await callback('bound', realState);
  p = payloadOf(cb.html);
  ok('state 复用：400（一次性）', cb.status === 400 && p?.type === 'github-oauth-error' && /state/.test(p.message));

  // ---------- 11. 错误描述注入：<script> 必须转义 ----------
  cb = await callback('xss', stateOf(await loginUrl()));
  ok('错误页转义 XSS 原文（页面文本实体化、JSON 里 unicode 转义）',
    cb.status === 400 && !cb.html.includes('<script>alert(1)</script>') &&
    cb.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') &&
    payloadOf(cb.html)?.message === '<script>alert(1)</script>', cb.html.slice(0, 400));

  // ---------- 12. 解绑 + 审计 ----------
  const u = await req('/github/oauth/unbind', { method: 'POST', token: rA.token });
  ok('解绑 200', u.status === 200 && !db.prepare('SELECT 1 FROM github_bind WHERE user_id=?').get(A.id));
  const ub = lastAudit('github-unbind');
  ok('审计 github-unbind（target=gh-bound）', ub && ub.user_id === A.id && ub.target === 'gh-bound', ub);

  // ---------- 13. 未登录闸门 ----------
  const s401 = await req('/github/oauth/status');
  ok('status 未登录 401', s401.status === 401);
  const u401 = await req('/github/oauth/unbind', { method: 'POST' });
  ok('unbind 未登录 401', u401.status === 401);
} catch (e) {
  fail++;
  console.error('💥 冒烟异常：', e.message);
  console.error(serverLog.slice(-30).join('\n'));
} finally {
  try { db?.close(); } catch { /* 已关 */ }
  try { fake?.close(); } catch { /* 已退 */ }
  if (server) {
    try {
      process.platform === 'win32'
        ? spawnSync('taskkill', ['/F', '/T', '/PID', String(server.pid)])
        : server.kill('SIGKILL');
    } catch { /* 已退出 */ }
  }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* 沙盒清理尽力而为 */ }
}

console.log(`\nGitHub 冒烟：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
