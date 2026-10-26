// GitHub OAuth：账号绑定 + 一键登录（挂载 /api/github；仿 routes/feishu.js 的 state/弹窗/postMessage 范式）
// 一键登录口径：已绑定直接登录；未绑定按 GitHub 已验证主邮箱匹配本站账号→自动绑定；都不中→自动建新号。
// token 不存全量（只留前缀排障），不做刷新与 OpenAPI 代理。
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import db from '../db/database.js';
import { authRequired, logAudit, hashPassword } from './middleware.js';
import { userCard, uniqueUsername, realNameRequiredNotice } from './auth.js';
import {
  configured, clientId, webOrigin, exchangeCode, fetchGithubUser, fetchGithubEmails,
} from '../lib/githubClient.js';

const r = Router();

// 回调地址：显式 env 优先；dev 下用 GITHUB_FRONTEND_ORIGIN 走 Vite 代理同源；否则按请求 host 推导
const redirectUri = (req) => {
  if (process.env.GITHUB_REDIRECT_URI) return process.env.GITHUB_REDIRECT_URI;
  const front = process.env.GITHUB_FRONTEND_ORIGIN;
  if (front) return `${front.replace(/\/+$/, '')}/api/github/oauth/callback`;
  return `${req.protocol}://${req.get('host')}/api/github/oauth/callback`;
};

// state 内存表（5 分钟、一次性）：bind 定位本站账号，login 标记一键登录；origin 是回调页同源目标。
// origin 只从服务端 redirect_uri 推导，**绝不读请求 Origin/Referer 头**，防 token postMessage 给攻击者源。
const stateMap = new Map();
const STATE_TTL = 5 * 60 * 1000;
function newState(ent) {
  if (stateMap.size > 200) {
    const now = Date.now();
    for (const [k, v] of stateMap) if (v.exp <= now) stateMap.delete(k);
  }
  const st = randomBytes(16).toString('hex');
  stateMap.set(st, { ...ent, exp: Date.now() + STATE_TTL });
  return st;
}
function takeState(st) {
  const ent = st && stateMap.get(st);
  if (!ent) return null;
  stateMap.delete(st);
  return ent.exp > Date.now() ? ent : null;
}

function authorizeUrl(state, ruri) {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: ruri,
    state,
    scope: 'read:user user:email',
  });
  return `${webOrigin()}/login/oauth/authorize?${params.toString()}`;
}

function bindRow(userId) {
  return db.prepare('SELECT github_id, login, avatar_url, profile_url, update_time FROM github_bind WHERE user_id = ?')
    .get(String(userId));
}

function upsertBind(userId, gh, tok) {
  db.prepare(
    `INSERT INTO github_bind (user_id, github_id, login, avatar_url, profile_url, token_prefix, update_time)
     VALUES (?,?,?,?,?,?,datetime('now','localtime'))
     ON CONFLICT(user_id) DO UPDATE SET
       github_id = excluded.github_id, login = excluded.login, avatar_url = excluded.avatar_url,
       profile_url = excluded.profile_url, token_prefix = excluded.token_prefix,
       update_time = datetime('now','localtime')`
  ).run(String(userId), gh.id, gh.login, gh.avatar_url || '',
    gh.html_url || `${webOrigin()}/${gh.login}`, String(tok.access_token).slice(0, 8));
}

// 已验证邮箱列表 → 首选 primary 的真实邮箱，次选任意 verified 非 noreply
function pickLoginEmail(list) {
  if (!Array.isArray(list)) return null;
  const real = list.filter((e) => e && e.verified && e.email &&
    !String(e.email).toLowerCase().endsWith('@users.noreply.github.com'));
  return real.find((e) => e.primary)?.email || real[0]?.email || null;
}

// GitHub 新身份建新号：随机不可登录密码 + password_set=1（日后走忘记密码），不发初始密码公告
function createGithubUser(gh, email) {
  const username = uniqueUsername(gh.login);
  const secret = randomBytes(18).toString('base64url');
  const nickname = String(gh.name || gh.login || username).trim().slice(0, 20) || username;
  const info = db.prepare(
    'INSERT INTO user (username, password_hash, nickname, email, avatar, password_set) VALUES (?,?,?,?,?,1)'
  ).run(username, hashPassword(secret), nickname, email || null, gh.avatar_url || null);
  const u = db.prepare('SELECT * FROM user WHERE id = ?').get(info.lastInsertRowid);
  try { realNameRequiredNotice(u.id); } catch { /* 通知失败不挡登录 */ }
  return u;
}

function isConstraint(e) {
  return /SQLITE_CONSTRAINT|UNIQUE constraint/i.test(String(e?.message || e));
}
function friendlyError(e) {
  const m = String(e?.message || e || '');
  if (isConstraint(e)) return '绑定冲突：该 GitHub 账号或邮箱已关联其他账号，请稍后重试或联系管理员';
  if (/bad_verification_code|redirect_uri|incorrect.*client/i.test(m)) return 'GitHub 授权失败：授权码无效或回调地址不匹配，请重新发起登录';
  if (/timeout|aborted|ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed|network/i.test(m)) return '无法连接 GitHub，请稍后重试';
  if (/HTTP 401|HTTP 403/.test(m)) return 'GitHub 授权已失效，请重新发起登录';
  return m.slice(0, 150) || 'GitHub 授权失败，请重试';
}

// ---------------- 回调回执页（动态文本一律转义；JSON 防 </script> 注入） ----------------
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
// NOTE: build the backslash-u escape by concatenation -- a template literal `\u${...}` is a SyntaxError.
const embedJson = (obj) => JSON.stringify(obj)
  .replace(/[<>\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

function callbackHtml({ kind, message, post = null, targetOrigin = '*', autoClose = false }) {
  const icon = kind === 'success' ? '✅' : '❌';
  const title = kind === 'success' ? 'GitHub 授权成功' : 'GitHub 授权失败';
  // 无 opener（手机浏览器全屏授权）时的落地页：登录→首页、绑定→账号安全、失败→登录页
  const type = post?.type || '';
  const fallback = type === 'github-bound' ? '/account-security'
    : type === 'github-oauth-error' ? '/login' : '/';
  const btnText = type === 'github-bound' ? '← 返回账号安全'
    : type === 'github-oauth-error' ? '← 返回登录页' : '🚀 立即进入网站';
  const script = post ? `<script>
(function () {
  var payload = ${embedJson(post)};
  var fallback = ${embedJson(fallback)};
  var hasOpener = false;
  try { hasOpener = !!window.opener; } catch (e) {}
  try { if (window.opener) window.opener.postMessage(payload, ${embedJson(targetOrigin)}); } catch (e) {}
  // 桌面弹窗：1.2s 后自关（关不掉也无妨，下方倒计时会兜底跳走）
  ${autoClose ? "setTimeout(function () { try { window.close(); } catch (e) {} }, 1200);" : ''}
  // 手机浏览器全屏授权：没有 opener，postMessage 无人接收、window.close 也关不掉系统标签。
  // 登录态直接写同源 localStorage（与前端 auth.js 的 ec_token/ec_user 同键），随后回站即为登录态。
  if (!hasOpener && payload.type === 'github-login' && payload.token) {
    try {
      localStorage.setItem('ec_token', payload.token);
      localStorage.setItem('ec_user', JSON.stringify(payload.user || {}));
    } catch (e) {}
  }
  // 倒计时兜底：桌面弹窗被 close 后定时器随之销毁；无 opener / close 被拒的环境到时自动返回。
  var delay = hasOpener ? ${autoClose ? '8' : '0'} : (payload.type === 'github-oauth-error' ? 5 : 3);
  var cw = document.getElementById('cdwrap');
  if (!delay) { if (cw) cw.style.display = 'none'; return; }
  var left = delay;
  var cd = document.getElementById('cd');
  if (cd) cd.textContent = left;
  var t = setInterval(function () {
    left -= 1;
    if (cd) cd.textContent = left > 0 ? left : 0;
    if (left <= 0) { clearInterval(t); location.replace(fallback); }
  }, 1000);
})();
</scr` + 'ipt>' : '';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GitHub 授权回调</title>
<style>body{font-family:system-ui;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#0d1117;color:#e6edf3;margin:0;padding:24px}
.box{text-align:center;background:#161b22;padding:40px 48px;border-radius:16px;max-width:520px;border:1px solid #30363d}
h2{margin:0 0 12px}p{margin:0;color:#9ca3af;line-height:1.6;word-break:break-all}
.btn{display:inline-block;margin-top:22px;padding:11px 26px;border-radius:10px;background:#238636;color:#fff!important;text-decoration:none;font-size:15px;font-weight:600}
.btn:active{background:#2ea043}
.cd{color:#9ca3af;font-size:13px;font-weight:400;margin-left:2px}</style></head>
<body><div class="box"><h2>${icon} ${title}</h2><p>${escapeHtml(message)}</p>
<a class="btn" href="${fallback}">${btnText}<span class="cd" id="cdwrap">（<span id="cd">3</span> 秒后自动返回）</span></a>
</div>${script}</body></html>`;
}

// ---------------- 路由 ----------------

// GET /api/github/oauth/configured — 公开：登录页据此决定是否显示 GitHub 入口
r.get('/oauth/configured', (req, res) => {
  res.json({ configured: configured() });
});

// GET /api/github/oauth/status — 当前用户的绑定状态（未配置时 configured=false，前端置灰）
r.get('/oauth/status', authRequired, (req, res) => {
  const b = bindRow(req.user.id);
  res.json({
    configured: configured(),
    bound: !!b,
    github_id: b?.github_id || null,
    login: b?.login || '',
    avatar_url: b?.avatar_url || '',
    profile_url: b?.profile_url || '',
  });
});

// GET /api/github/oauth/auth — 登录态发起「绑定」（弹窗打开）
r.get('/oauth/auth', authRequired, (req, res) => {
  if (!configured()) {
    return res.status(400).json({ error: '请先在 backend/.env 配置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET' });
  }
  const ruri = redirectUri(req);
  const state = newState({ intent: 'bind', userId: req.user.id, origin: new URL(ruri).origin });
  res.json({ url: authorizeUrl(state, ruri) });
});

// GET /api/github/oauth/login — 公开：发起「一键登录」
r.get('/oauth/login', (req, res) => {
  if (!configured()) {
    return res.status(400).json({ error: '未启用 GitHub 登录（服务端未配置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET）' });
  }
  const ruri = redirectUri(req);
  const state = newState({ intent: 'login', origin: new URL(ruri).origin });
  res.json({ url: authorizeUrl(state, ruri) });
});

// GET /api/github/oauth/callback — 无鉴权；换 token、拉身份，按 intent 绑定或登录；回执 HTML 通知 opener
r.get('/oauth/callback', async (req, res) => {
  let origin = '*';
  try {
    const st = takeState(String(req.query.state || ''));
    if (!req.query.code) {
      return res.status(400).send(callbackHtml({
        kind: 'error', message: '回调缺少 code 参数，请重新发起 GitHub 授权',
        post: { type: 'github-oauth-error', message: '回调缺少 code 参数，请重新发起 GitHub 授权' },
      }));
    }
    if (!st) {
      return res.status(400).send(callbackHtml({
        kind: 'error', message: '授权状态已过期或无效（state 校验失败），请重新发起 GitHub 登录或绑定',
        post: { type: 'github-oauth-error', message: '授权状态已过期或无效（state 校验失败），请重新发起 GitHub 登录或绑定' },
      }));
    }
    origin = st.origin;
    const ruri = redirectUri(req);
    const tok = await exchangeCode(String(req.query.code), ruri);
    if (!tok.access_token) throw new Error('GitHub 未返回 access_token，请重试');
    const gh = await fetchGithubUser(tok.access_token);
    if (!gh?.id || !gh?.login) throw new Error('GitHub 用户信息不完整');

    if (st.intent === 'bind') {
      // ---- 绑定分支 ----
      const me = db.prepare('SELECT id, username FROM user WHERE id = ?').get(st.userId);
      if (!me) throw new Error('本站账号不存在或已删除，请重新登录后再绑定');
      const other = db.prepare('SELECT user_id FROM github_bind WHERE github_id = ? AND user_id != ?')
        .get(gh.id, String(me.id));
      if (other) throw new Error(`该 GitHub 账号（@${gh.login}）已绑定其他本站账号，请先在那边解绑`);
      try {
        upsertBind(me.id, gh, tok);
      } catch (e) {
        if (isConstraint(e)) throw new Error('绑定冲突：该 GitHub 账号已关联其他本站账号');
        throw e;
      }
      req.user = { id: me.id, username: me.username };
      logAudit(req, 'github-bind', gh.login, { github_id: gh.id });
      return res.send(callbackHtml({
        kind: 'success', message: `GitHub 用户 @${gh.login} 已绑定到当前账号，窗口即将关闭`,
        post: { type: 'github-bound', login: gh.login, avatar_url: gh.avatar_url || '' },
        targetOrigin: st.origin, autoClose: true,
      }));
    }

    // ---- 登录分支 ----
    let user = db.prepare('SELECT u.* FROM user u JOIN github_bind b ON b.user_id = u.id WHERE b.github_id = ?')
      .get(gh.id);
    let via = 'bound';
    if (!user) {
      // 未绑定：拉已验证邮箱（失败不致命），按小写邮箱匹配本站账号
      let email = null;
      try {
        email = pickLoginEmail(await fetchGithubEmails(tok.access_token));
      } catch { email = null; }
      const hit = email
        ? db.prepare('SELECT * FROM user WHERE lower(email) = ?').get(email.toLowerCase())
        : null;
      if (hit) {
        if (hit.status === 1) throw new Error('账号已被封禁，无法登录');
        const occupied = db.prepare('SELECT github_id FROM github_bind WHERE user_id = ?').get(hit.id);
        if (occupied) {
          throw new Error(`该邮箱对应账号已绑定其他 GitHub 账号（GitHub ID ${occupied.github_id}），请用原 GitHub 账号登录后先解绑`);
        }
        try {
          upsertBind(hit.id, gh, tok);
        } catch (e) {
          if (isConstraint(e)) throw new Error('自动绑定失败：该 GitHub 账号或邮箱已关联其他本站账号');
          throw e;
        }
        user = hit;
        via = 'email-autobind';
      } else {
        // 匹配不上：自动建新号（昵称/头像取自 GitHub；noreply 邮箱不入库，email=NULL）
        try {
          user = createGithubUser(gh, email);
          upsertBind(user.id, gh, tok);
        } catch (e) {
          if (isConstraint(e)) throw new Error('创建账号时遇到唯一约束冲突，请换一种登录方式或稍后重试');
          throw e;
        }
        via = 'register';
      }
    }
    if (user.status === 1) throw new Error('账号已被封禁，无法登录');

    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO session (token, user_id) VALUES (?,?)').run(token, user.id);
    req.user = { id: user.id, username: user.username };
    logAudit(req, 'github-login', gh.login, { via, github_id: gh.id });
    return res.send(callbackHtml({
      kind: 'success', message: `已通过 GitHub 登录：@${gh.login}，窗口即将关闭`,
      post: { type: 'github-login', token, user: userCard(user) },
      targetOrigin: st.origin, autoClose: true,
    }));
  } catch (e) {
    console.error('GitHub OAuth 回调失败：', e.message);
    const message = friendlyError(e);
    return res.status(400).send(callbackHtml({
      kind: 'error', message,
      post: { type: 'github-oauth-error', message },
      targetOrigin: origin,
    }));
  }
});

// POST /api/github/oauth/unbind — 解绑当前账号（记审计：留痕谁解开了哪个 GitHub 登录名）
r.post('/oauth/unbind', authRequired, (req, res) => {
  const b = bindRow(req.user.id);
  db.prepare('DELETE FROM github_bind WHERE user_id = ?').run(String(req.user.id));
  if (b) logAudit(req, 'github-unbind', b.login);
  res.json({ message: '已解绑 GitHub 账号' });
});

export default r;
