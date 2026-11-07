// 微信小程序登录与账号绑定（与 H5 共用同一套 user/session 表，不改动既有登录接口）
// 路由挂载点：/api/auth（server.js 中 app.use('/api/auth', wechat)）
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import db from '../db/database.js';
import { hashPassword, verifyPassword, logAudit } from './middleware.js';
import { userCard, uniqueUsername } from './auth.js';

const r = Router();

// ---- 环境配置惰性读取：ESM import 先于 server.js 的 loadEnvFile 求值，顶层读不到 .env ----
const cfg = () => ({ appid: process.env.WECHAT_APPID || '', secret: process.env.WECHAT_SECRET || '' });

// ---- 绑定票据：未绑定 openid 的微信用户先拿一次性 ticket，再走账号核验/注册 ----
// 单进程 PM2 部署内存存储即可；重启即失效，前端重新 wx.login 无感
const TICKET_TTL = 5 * 60 * 1000;
const tickets = new Map(); // ticket -> { openid, expire }
function putTicket(openid) {
  const ticket = randomBytes(32).toString('hex');
  tickets.set(ticket, { openid, expire: Date.now() + TICKET_TTL });
  return ticket;
}
function takeTicket(ticket) {
  const t = tickets.get(ticket);
  if (!t) return null;
  tickets.delete(ticket); // 一次性
  if (t.expire < Date.now()) return null;
  return t;
}
// 懒清理，防止 Map 无限增长（unref 保证定时器不拖住进程退出）
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.expire < now) tickets.delete(k);
}, 10 * 60 * 1000).unref?.();

// code2session：调微信接口换 openid；未配置 AppID 时支持 mock code 联调
async function code2session(code) {
  const { appid, secret } = cfg();
  // 开发联调：显式传 mock: 前缀（生产环境禁用 mock）
  if (String(code || '').startsWith('mock:')) {
    if (process.env.NODE_ENV === 'production') return { error: '生产环境不支持 mock 登录' };
    return { openid: `mock_${code.slice(5)}`, session_key: '', mock: true };
  }
  if (!appid || !secret) {
    return { error: '后端未配置 WECHAT_APPID/WECHAT_SECRET，开发联调请传 mock:自定义标识 形式的 code' };
  }
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const resp = await fetch(url);
  const data = await resp.json().catch(() => ({}));
  if (data.errcode) return { error: `微信登录失败（${data.errcode}）：${data.errmsg || '未知错误'}` };
  if (!data.openid) return { error: '微信未返回 openid，请重试' };
  return { openid: data.openid, session_key: data.session_key || '', mock: false };
}

// 统一发 session token（格式与 auth.js 既有登录接口完全一致，前端可共用同一套存储）
function issueSession(req, user, via, extra = {}) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO session (token, user_id) VALUES (?,?)').run(token, user.id);
  logAudit(req, 'login', user.email || user.username, { via, ...extra });
  return { token, user: userCard(user) };
}

// GET /api/auth/wechat-status — 小程序启动探测：是否已配置微信凭证（未配置时前端展示 mock 联调提示）
r.get('/wechat-status', (req, res) => {
  const { appid } = cfg();
  res.json({ configured: !!appid, mock_enabled: process.env.NODE_ENV !== 'production' });
});

// POST /api/auth/wechat-login — 入参 { code }（uni.login 拿到）
// 已绑定 → 直接发 token；未绑定 → 返回 need_bind + bind_ticket（5 分钟内调 wechat-bind）
r.post('/wechat-login', async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: '缺少 code' });
  const s = await code2session(code);
  if (s.error) {
    return res.status(502).json({ error: s.error, hint: '检查后端 WECHAT_APPID/WECHAT_SECRET 配置或小程序 AppID' });
  }
  const user = db.prepare('SELECT * FROM user WHERE wechat_openid = ?').get(s.openid);
  if (user) {
    if (user.status === 1) return res.status(403).json({ error: '账号已被封禁，无法登录' });
    return res.json({ ...issueSession(req, user, 'wechat', { mock: s.mock }), mock: s.mock });
  }
  res.json({ need_bind: true, bind_ticket: putTicket(s.openid), mock: s.mock });
});

// POST /api/auth/wechat-bind — 微信 openid 绑定已有账号或注册新账号后登录
// body: { bind_ticket, mode: 'password'|'email-code'|'register', email/username/password/code/nickname }
r.post('/wechat-bind', async (req, res) => {
  const b = req.body || {};
  const t = takeTicket(String(b.bind_ticket || ''));
  if (!t) return res.status(400).json({ error: '绑定票据无效或已过期，请重新微信登录' });
  const openid = t.openid;
  if (db.prepare('SELECT id FROM user WHERE wechat_openid = ?').get(openid)) {
    return res.status(409).json({ error: '该微信已绑定账号，请直接微信登录' });
  }

  let user = null;
  const mail = String(b.email || '').trim().toLowerCase();

  if (b.mode === 'password') {
    const raw = String(b.username ?? b.email ?? '').trim();
    if (!raw || !b.password) return res.status(400).json({ error: '请输入邮箱/用户名和密码' });
    user = db.prepare('SELECT * FROM user WHERE username = ? OR email = ?').get(raw, raw.toLowerCase());
    if (!user || !verifyPassword(String(b.password), user.password_hash)) {
      return res.status(401).json({ error: '邮箱或密码错误' });
    }
  } else if (b.mode === 'email-code') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return res.status(400).json({ error: '邮箱格式不正确' });
    const row = db.prepare(
      "SELECT * FROM email_code WHERE email = ? AND code = ? AND expire_at > ? AND purpose IN ('login','bind') ORDER BY id DESC LIMIT 1"
    ).get(mail, String(b.code || '').trim(), Date.now());
    if (!row) return res.status(400).json({ error: '验证码错误或已过期，请重新获取' });
    db.prepare('DELETE FROM email_code WHERE email = ?').run(mail); // 验证码一次性
    user = db.prepare('SELECT * FROM user WHERE email = ?').get(mail);
    if (!user) return res.status(404).json({ error: '该邮箱尚未注册，请选择注册新账号' });
  } else if (b.mode === 'register') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return res.status(400).json({ error: '邮箱格式不正确' });
    if (db.prepare('SELECT id FROM user WHERE email = ?').get(mail)) {
      return res.status(409).json({ error: '该邮箱已注册，请改用「绑定已有账号」' });
    }
    // 与 H5 邮箱注册同口径：未提供密码则存统一初始密码并标记待修改
    const pw = b.password && String(b.password).length >= 6 ? String(b.password) : (process.env.INITIAL_PASSWORD || 'gkjsdh123');
    const name = uniqueUsername(mail);
    const r2 = db.prepare(
      'INSERT INTO user (username, password_hash, nickname, email, password_set) VALUES (?,?,?,?,?)'
    ).run(name, hashPassword(pw), String(b.nickname || '').trim() || mail.split('@')[0], mail, b.password ? 1 : 0);
    user = db.prepare('SELECT * FROM user WHERE id = ?').get(r2.lastInsertRowid);
  } else {
    return res.status(400).json({ error: '未知的绑定模式' });
  }

  if (!user) return res.status(404).json({ error: '账号不存在' });
  if (user.status === 1) return res.status(403).json({ error: '账号已被封禁，无法绑定' });
  if (user.wechat_openid) return res.status(409).json({ error: '该账号已绑定其他微信' });

  try {
    db.prepare('UPDATE user SET wechat_openid = ? WHERE id = ?').run(openid, user.id);
  } catch (e) {
    // 唯一索引兜底：并发绑定同一个 openid
    return res.status(409).json({ error: '绑定失败：该微信已被其他账号占用', detail: e.message });
  }
  user.wechat_openid = openid;
  res.json({ ...issueSession(req, user, `wechat-bind-${b.mode}`), bound: true });
});

export default r;