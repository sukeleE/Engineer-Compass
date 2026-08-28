// 认证接口：注册 / 登录 / 当前用户 / 邮箱验证码
import { Router } from 'express';
import { randomBytes, randomInt } from 'node:crypto';
import db from '../db/database.js';
import { hashPassword, verifyPassword, authRequired, logAudit } from './middleware.js';
import sendMail from './mailer.js';

const r = Router();

const CODE_TTL = 10 * 60 * 1000; // 验证码 10 分钟有效
const CODE_COOLDOWN = 60 * 1000; // 同一邮箱 60 秒内只能发一次

// 邮箱 → 登录名：取邮箱前缀（去非法字符），冲突加数字后缀（email-login 自动注册与密码注册共用）
function genUsername(mail) {
  let base = (mail.split('@')[0] || 'user').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16);
  if (!/^[A-Za-z0-9_]{2,20}$/.test(base)) base = 'user';
  let name = base;
  for (let n = 1; db.prepare('SELECT id FROM user WHERE username = ?').get(name); n++) {
    name = `${base}${n}`.slice(0, 20);
  }
  return name;
}

// 返回给前端的 user 形状（统一含 email / avatar，avatar 未设置为 null）
// 导出供 ghost.js 复用（enter/exit 后返回最新 userCard）
export const userCard = (u) => ({
  id: u.id, username: u.username, nickname: u.nickname, is_admin: !!u.is_admin, is_ghost: !!u.is_ghost,
  email: u.email || '', avatar: u.avatar || null,
});

// POST /api/auth/send-code — 发送邮箱验证码（注册/登录共用；未注册邮箱登录时自动注册）
r.post('/send-code', async (req, res) => {
  const { email, purpose = 'login' } = req.body || {};
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return res.status(400).json({ error: '邮箱格式不正确' });
  if (!['login', 'register', 'bind'].includes(purpose)) return res.status(400).json({ error: 'purpose 仅支持 login/register/bind' });

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
  if (user?.status === 1) return res.status(403).json({ error: '账号已被封禁，无法登录' });
  if (!user) {
    // 自动注册：用户名由邮箱前缀生成（冲突加数字后缀）
    const name = genUsername(mail);
    const rr = db.prepare('INSERT INTO user (username, password_hash, nickname, email) VALUES (?,?,?,?)')
      .run(name, hashPassword(randomBytes(16).toString('hex')), mail.split('@')[0], mail);
    user = { id: rr.lastInsertRowid, username: name, nickname: mail.split('@')[0], is_admin: 0, email: mail, avatar: null };
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
  req.user = { id: user.id, username: user.username };
  logAudit(req, 'login', mail, { via: 'email-code', auto_registered: migrated > 0 });
  res.json({ token, user: userCard(user), migrated });
});

// POST /api/auth/register — 注册（邮箱 + 密码；登录名由邮箱前缀自动生成）
r.post('/register', (req, res) => {
  const { email, password, nickname } = req.body || {};
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' });
  }
  if (db.prepare('SELECT id FROM user WHERE email = ?').get(mail)) {
    return res.status(409).json({ error: '该邮箱已被绑定，可直接用邮箱验证码登录' });
  }
  const name = genUsername(mail);

  const r2 = db.prepare('INSERT INTO user (username, password_hash, nickname, email) VALUES (?,?,?,?)')
    .run(name, hashPassword(password), (nickname || '').trim() || name, mail);
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO session (token, user_id) VALUES (?,?)').run(token, r2.lastInsertRowid);
  req.user = { id: r2.lastInsertRowid, username: name };
  logAudit(req, 'register', mail);
  res.status(201).json({
    token, user: { id: r2.lastInsertRowid, username: name, nickname: (nickname || '').trim() || name, is_admin: false, is_ghost: false, email: mail, avatar: null },
  });
});

// POST /api/auth/login — 登录（邮箱 + 密码；兼容存量 username + 密码）
r.post('/login', (req, res) => {
  const { username, email, password } = req.body || {};
  // 前端统一传 email 字段；存量调用传 username。username 精确匹配（老账号可能含大写）；email 入库统一小写 → 小写匹配
  const raw = String(username ?? email ?? '').trim();
  const u = db.prepare('SELECT * FROM user WHERE username = ? OR email = ?').get(raw, raw.toLowerCase());
  if (!u || !verifyPassword(password || '', u.password_hash)) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }
  if (u.status === 1) return res.status(403).json({ error: '账号已被封禁，无法登录' });
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO session (token, user_id) VALUES (?,?)').run(token, u.id);
  req.user = { id: u.id, username: u.username };
  logAudit(req, 'login', u.email || u.username, { via: 'password' });
  res.json({ token, user: userCard(u) });
});

// POST /api/auth/logout — 登出（删除当前会话 + 审计）
r.post('/logout', authRequired, (req, res) => {
  db.prepare('DELETE FROM session WHERE token = ?').run(req.user.token);
  logAudit(req, 'logout');
  res.json({ message: '已退出登录' });
});

// PUT /api/auth/profile — 更新昵称 / 头像（authRequired）
r.put('/profile', authRequired, (req, res) => {
  const { nickname, avatar } = req.body || {};
  const cols = [], vals = [];
  if (nickname !== undefined) {
    const nk = String(nickname).trim();
    if (!nk) return res.status(400).json({ error: '昵称不能为空' });
    if (nk.length > 20) return res.status(400).json({ error: '昵称最多 20 个字符' });
    cols.push('nickname = ?'); vals.push(nk);
  }
  if (avatar !== undefined) {
    if (avatar && !/^data:image\/(jpeg|png|webp);base64,/.test(String(avatar))) {
      return res.status(400).json({ error: '头像格式不支持（仅支持 jpeg/png/webp 的 dataURL）' });
    }
    if (String(avatar).length > 150000) return res.status(400).json({ error: '头像过大，请更换小一点的文件' });
    cols.push('avatar = ?'); vals.push(avatar ? String(avatar) : null); // null/'' → 清除头像
  }
  if (!cols.length) return res.status(400).json({ error: '没有可更新的内容' });
  vals.push(req.user.id);
  db.prepare(`UPDATE user SET ${cols.join(', ')} WHERE id = ?`).run(...vals);
  const u = db.prepare('SELECT * FROM user WHERE id = ?').get(req.user.id);
  res.json({ user: userCard(u) });
});

// PUT /api/auth/email — 绑定 / 更换邮箱（新邮箱验证码校验，purpose=bind）
r.put('/email', authRequired, (req, res) => {
  const { email, code } = req.body || {};
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return res.status(400).json({ error: '邮箱格式不正确' });
  const row = db.prepare('SELECT * FROM email_code WHERE email = ? AND code = ? AND purpose = ? AND expire_at > ? ORDER BY id DESC LIMIT 1')
    .get(mail, String(code || '').trim(), 'bind', Date.now());
  if (!row) return res.status(400).json({ error: '验证码错误或已过期，请重新获取' });
  db.prepare('DELETE FROM email_code WHERE email = ?').run(mail); // 一次性使用
  // 唯一性先查后改（依赖 UNIQUE 索引兜底会抛约束异常 → 500）
  const dup = db.prepare('SELECT id FROM user WHERE email = ? AND id != ?').get(mail, req.user.id);
  if (dup) return res.status(409).json({ error: '该邮箱已被其他账号绑定' });
  db.prepare('UPDATE user SET email = ? WHERE id = ?').run(mail, req.user.id);
  const u = db.prepare('SELECT * FROM user WHERE id = ?').get(req.user.id);
  res.json({ user: userCard(u) });
});

// GET /api/auth/me — 当前用户（含所属小组摘要；多角色 role_names 数组 + role_name 兼容）
r.get('/me', authRequired, (req, res) => {
  const u = db.prepare('SELECT * FROM user WHERE id = ?').get(req.user.id) || req.user;
  // user_id → 角色名数组（全部小组一次性拉取，量小）
  const roleMap = {};
  for (const x of db.prepare(
    `SELECT tmr.team_id, tmr.user_id, tr.name AS role_name
     FROM team_member_role tmr JOIN team_role tr ON tr.id = tmr.role_id
     ORDER BY tr.level DESC, tr.id`
  ).all()) (roleMap[`${x.team_id}:${x.user_id}`] ||= []).push(x.role_name);
  const teams = db.prepare(
    `SELECT t.id, t.name, t.desc, t.invite_code, t.owner_id,
            (SELECT COUNT(*) FROM team_member m2 WHERE m2.team_id = t.id) AS member_count
     FROM team_member tm JOIN team t ON t.id = tm.team_id
     WHERE tm.user_id = ? ORDER BY t.create_time DESC`
  ).all(req.user.id);
  res.json({ user: userCard(u), teams: teams.map((t) => {
    const rns = roleMap[`${t.id}:${req.user.id}`] || [];
    return { ...t, role_names: rns, role_name: rns[0] || null, is_owner: t.owner_id === req.user.id };
  }) });
});

export default r;
