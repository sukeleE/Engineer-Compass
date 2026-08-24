// 认证接口：注册 / 登录 / 当前用户 / 邮箱验证码
import { Router } from 'express';
import { randomBytes, randomInt } from 'node:crypto';
import db from '../db/database.js';
import { hashPassword, verifyPassword, authRequired } from './middleware.js';
import sendMail from './mailer.js';

const r = Router();

const CODE_TTL = 10 * 60 * 1000; // 验证码 10 分钟有效
const CODE_COOLDOWN = 60 * 1000; // 同一邮箱 60 秒内只能发一次

// POST /api/auth/send-code — 发送邮箱验证码（注册/登录共用；未注册邮箱登录时自动注册）
r.post('/send-code', async (req, res) => {
  const { email, purpose = 'login' } = req.body || {};
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return res.status(400).json({ error: '邮箱格式不正确' });
  if (!['login', 'register'].includes(purpose)) return res.status(400).json({ error: 'purpose 仅支持 login/register' });

  // 冷却：同邮箱 60s 内重复发送 → 429
  const last = db.prepare('SELECT created_at_ms FROM email_code WHERE email = ? ORDER BY id DESC LIMIT 1').get(mail);
  if (last && Date.now() - last.created_at_ms < CODE_COOLDOWN) {
    const wait = Math.ceil((CODE_COOLDOWN - (Date.now() - last.created_at_ms)) / 1000);
    return res.status(429).json({ error: `发送太频繁，请 ${wait} 秒后再试` });
  }

  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  db.prepare('DELETE FROM email_code WHERE email = ?').run(mail); // 旧码作废，天然防爆破
  db.prepare('INSERT INTO email_code (email, code, purpose, expire_at, created_at_ms) VALUES (?,?,?,?,?)')
    .run(mail, code, purpose, Date.now() + CODE_TTL, Date.now());

  const html = `<div style="font-family:system-ui;max-width:420px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
    <h2 style="margin:0 0 12px;color:#1e293b">Engineer-Compass 工科竞赛导航</h2>
    <p style="color:#475569;line-height:1.7">您的邮箱验证码是：</p>
    <div style="font-size:30px;font-weight:700;letter-spacing:6px;color:#2563eb;background:#eff6ff;border-radius:8px;padding:12px;text-align:center">${code}</div>
    <p style="color:#94a3b8;font-size:12px;margin-top:14px">验证码 10 分钟内有效，请勿泄露给他人。如非本人操作请忽略本邮件。</p>
  </div>`;
  const sent = await sendMail({ to: mail, subject: '【Engineer-Compass】邮箱验证码', html });

  if (sent.dev) {
    // 开发模式（未配置 SMTP）：验证码直接随响应返回，前端自动填充并提示
    console.log(`📧 [DEV] 验证码 ${mail} → ${code}`);
    return res.json({ message: '开发模式：验证码已生成（未配置 SMTP，请配置 backend/.env 的 SMTP_* 后改为真实邮件）', dev_code: code });
  }
  res.json({ message: '验证码已发送到邮箱，10 分钟内有效' });
});

// POST /api/auth/email-login — 邮箱验证码登录（未注册邮箱自动注册，并接管本机匿名数据）
r.post('/email-login', async (req, res) => {
  const { email, code } = req.body || {};
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return res.status(400).json({ error: '邮箱格式不正确' });
  const row = db.prepare('SELECT * FROM email_code WHERE email = ? AND code = ? AND expire_at > ? ORDER BY id DESC LIMIT 1')
    .get(mail, String(code || '').trim(), Date.now());
  if (!row) return res.status(400).json({ error: '验证码错误或已过期，请重新获取' });
  db.prepare('DELETE FROM email_code WHERE email = ?').run(mail); // 验证码一次性使用

  let user = db.prepare('SELECT * FROM user WHERE email = ?').get(mail);
  let migrated = 0;
  if (!user) {
    // 自动注册：用户名取邮箱前缀（去非法字符），冲突加数字后缀
    let base = (mail.split('@')[0] || 'user').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16);
    if (!/^[A-Za-z0-9_]{2,20}$/.test(base)) base = 'user';
    let name = base;
    for (let n = 1; db.prepare('SELECT id FROM user WHERE username = ?').get(name); n++) {
      name = `${base}${n}`.slice(0, 20);
    }
    const rr = db.prepare('INSERT INTO user (username, password_hash, nickname, email) VALUES (?,?,?,?)')
      .run(name, hashPassword(randomBytes(16).toString('hex')), mail.split('@')[0], mail);
    user = { id: rr.lastInsertRowid, username: name, nickname: mail.split('@')[0], is_admin: 0 };
    // 把本机匿名数据接管到该账号：'local' 备赛计划 + 匿名学习日程 + 匿名日程笔记
    // 笔记按 (user_id, note_date) 唯一，账号已有同日笔记的 'local' 行保留（仍可通过列表查询看到）
    migrated += db.prepare("UPDATE user_schedule SET user_id = ? WHERE user_id = 'local'").run(user.id).changes;
    migrated += db.prepare('UPDATE user_study SET user_id = ? WHERE user_id IS NULL').run(user.id).changes;
    migrated += db.prepare(
      `UPDATE daily_note SET user_id = ? WHERE user_id = 'local'
         AND note_date NOT IN (SELECT note_date FROM daily_note WHERE user_id = ?)`
    ).run(String(user.id), String(user.id)).changes;
  }

  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO session (token, user_id) VALUES (?,?)').run(token, user.id);
  res.json({
    token,
    user: { id: user.id, username: user.username, nickname: user.nickname, is_admin: user.is_admin, email: mail },
    migrated,
  });
});

// POST /api/auth/register — 注册（密码；email 选填，填了之后也可用邮箱验证码登录）
r.post('/register', (req, res) => {
  const { username, password, nickname, email } = req.body || {};
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9_]{2,20}$/.test(name)) {
    return res.status(400).json({ error: '用户名需为 2-20 位字母/数字/下划线' });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' });
  }
  const exists = db.prepare('SELECT id FROM user WHERE username = ?').get(name);
  if (exists) return res.status(409).json({ error: '用户名已存在' });
  const mail = email ? String(email).trim().toLowerCase() : '';
  if (mail) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return res.status(400).json({ error: '邮箱格式不正确' });
    if (db.prepare('SELECT id FROM user WHERE email = ?').get(mail)) {
      return res.status(409).json({ error: '该邮箱已被绑定，可直接用邮箱验证码登录' });
    }
  }

  const r2 = db.prepare('INSERT INTO user (username, password_hash, nickname, email) VALUES (?,?,?,?)')
    .run(name, hashPassword(password), (nickname || '').trim() || name, mail || null);
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO session (token, user_id) VALUES (?,?)').run(token, r2.lastInsertRowid);
  res.status(201).json({
    token, user: { id: r2.lastInsertRowid, username: name, nickname: (nickname || '').trim() || name, is_admin: 0 },
  });
});

// POST /api/auth/login — 登录
r.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM user WHERE username = ?').get(String(username || '').trim());
  if (!u || !verifyPassword(password || '', u.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO session (token, user_id) VALUES (?,?)').run(token, u.id);
  res.json({ token, user: { id: u.id, username: u.username, nickname: u.nickname, is_admin: u.is_admin } });
});

// GET /api/auth/me — 当前用户（含所属小组摘要）
r.get('/me', authRequired, (req, res) => {
  const u = db.prepare('SELECT id, username, nickname, email, is_admin FROM user WHERE id = ?').get(req.user.id) || req.user;
  const teams = db.prepare(
    `SELECT t.id, t.name, t.desc, t.invite_code, t.owner_id, tm.role_id, tr.name AS role_name, tr.level AS role_level,
            (SELECT COUNT(*) FROM team_member m2 WHERE m2.team_id = t.id) AS member_count
     FROM team_member tm JOIN team t ON t.id = tm.team_id
     LEFT JOIN team_role tr ON tr.id = tm.role_id
     WHERE tm.user_id = ? ORDER BY t.create_time DESC`
  ).all(req.user.id);
  res.json({ user: u, teams: teams.map((t) => ({
    ...t, is_owner: t.owner_id === req.user.id,
  })) });
});

export default r;
