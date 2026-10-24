// 认证接口：注册 / 登录 / 当前用户 / 邮箱验证码
import { Router } from 'express';
import { randomBytes, randomInt } from 'node:crypto';
import db from '../db/database.js';
import { hashPassword, verifyPassword, authRequired, logAudit, parseAdminPerms } from './middleware.js';
import sendMail from './mailer.js';

const r = Router();

const CODE_TTL = 10 * 60 * 1000; // 验证码 10 分钟有效
const CODE_COOLDOWN = 60 * 1000; // 同一邮箱 60 秒内只能发一次

// 初始密码：邮箱验证码注册的账号先存它，引导用户去账号安全页改密（env 可覆盖）
const INITIAL_PASSWORD = process.env.INITIAL_PASSWORD || 'gkjsdh123';

// 个人公告：初始密码提醒（发帖/补发都走这一处，文案不漂移）
export function passwordInitNotice(userId) {
  db.prepare(
    `INSERT INTO personal_notice (user_id, type, title, content, link) VALUES (?, 'password_init', ?, ?, ?)`
  ).run(
    userId,
    '【重要】请尽快修改初始密码',
    `系统已为您的账号设置统一初始密码 ${INITIAL_PASSWORD}，为保障账号安全，请通过「邮箱验证码」修改为本人的密码。`,
    '/account-security'
  );
}

// 改密成功后：初始密码提醒自动已读（横幅/红点随之消失）
function clearPasswordInitNotice(userId) {
  db.prepare(
    `UPDATE personal_notice SET is_read = 1, read_time = datetime('now','localtime')
     WHERE user_id = ? AND type = 'password_init' AND is_read = 0`
  ).run(userId);
}

// 个人公告：实名认证提醒（建号即发；NOT EXISTS 防御重复；预约/报销/采购三模块硬门禁）
export function realNameRequiredNotice(userId) {
  db.prepare(
    `INSERT INTO personal_notice (user_id, type, title, content, link)
       SELECT ?, 'realname_required', ?, ?, ?
       WHERE NOT EXISTS (
         SELECT 1 FROM personal_notice WHERE user_id = ? AND type = 'realname_required' AND is_read = 0
       )`
  ).run(
    userId,
    '【重要】请完成实名认证',
    '资源预约、经费报销、物料采购需填写真实姓名后才能使用，请在账号安全页完成实名认证。',
    '/account-security',
    userId
  );
}

// 实名成功后：实名提醒自动已读
function clearRealNameNotice(userId) {
  db.prepare(
    `UPDATE personal_notice SET is_read = 1, read_time = datetime('now','localtime')
     WHERE user_id = ? AND type = 'realname_required' AND is_read = 0`
  ).run(userId);
}

// 顶层保留名：动态路由 /:username/:slug 不能与站内静态路由相撞
const RESERVED_USERNAMES = new Set([
  'share', 'me', 'user', 'users', 'admin', 'admin-console', 'login', 'api', 'schedule', 'study',
  'team', 'honor', 'honors', 'purchase', 'expense', 'ghost-share', 'public', 'static',
  'account-security', 'feishu.html', 'github',
]);

// 任意来源字符串（邮箱前缀 / GitHub login）→ 合法且不撞名/保留名的登录名：
// 非字母数字下划线替 _、截 16、无效回落 user、撞保留名或重名加数字后缀
export function uniqueUsername(baseRaw) {
  let base = (String(baseRaw ?? '').split('@')[0] || 'user').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16);
  if (!/^[A-Za-z0-9_]{2,20}$/.test(base)) base = 'user';
  let name = base, n = 0;
  while (db.prepare('SELECT id FROM user WHERE username = ?').get(name) || (n === 0 && RESERVED_USERNAMES.has(name))) {
    n += 1;
    name = `${base}${n}`.slice(0, 20);
  }
  return name;
}

// 邮箱 → 登录名（email-login 自动注册与密码注册共用）
function genUsername(mail) {
  return uniqueUsername(mail);
}

// 返回给前端的 user 形状（统一含 email / avatar，avatar 未设置为 null）
// 导出供 ghost.js 复用（enter/exit 后返回最新 userCard）
export const userCard = (u) => ({
  id: u.id, username: u.username, nickname: u.nickname, is_admin: !!u.is_admin,
  perms: parseAdminPerms(u.admin_perms), is_ghost: !!u.is_ghost,
  email: u.email || '', avatar: u.avatar || null,
  password_set: u.password_set !== 0, phone: u.phone || '', real_name: u.real_name || '',
});

// POST /api/auth/send-code — 发送邮箱验证码（注册/登录共用；未注册邮箱登录时自动注册）
r.post('/send-code', async (req, res) => {
  const { email, purpose = 'login' } = req.body || {};
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return res.status(400).json({ error: '邮箱格式不正确' });
  if (!['login', 'register', 'bind', 'reset'].includes(purpose)) {
    return res.status(400).json({ error: 'purpose 仅支持 login/register/bind/reset' });
  }
  // 找回/重置密码：邮箱不存在不发码，响应与成功同文案（防账号枚举；dev 模式也不回传 dev_code）
  if (purpose === 'reset' && !db.prepare('SELECT id FROM user WHERE email = ?').get(mail)) {
    return res.json({ message: '验证码已发送到邮箱，10 分钟内有效' });
  }

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
    // 自动注册：用户名由邮箱前缀生成（冲突加数字后缀）；密码先存统一初始密码并标记待修改，
    // 附个人公告引导去账号安全页改为本人密码（不再用随机串——随机密码等于永远登不上密码端）
    const name = genUsername(mail);
    const rr = db.prepare('INSERT INTO user (username, password_hash, nickname, email, password_set) VALUES (?,?,?,?,0)')
      .run(name, hashPassword(INITIAL_PASSWORD), mail.split('@')[0], mail);
    user = { id: rr.lastInsertRowid, username: name, nickname: mail.split('@')[0], is_admin: 0, email: mail, avatar: null, password_set: 0 };
    try { passwordInitNotice(user.id); } catch { /* 通知失败不挡登录 */ }
    try { realNameRequiredNotice(user.id); } catch { /* 同上 */ }
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
  const nu = db.prepare('SELECT * FROM user WHERE id = ?').get(r2.lastInsertRowid);
  try { realNameRequiredNotice(nu.id); } catch { /* 通知失败不挡注册 */ }
  res.status(201).json({ token, user: userCard(nu) });
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
  logAudit(req, 'login', u.email || u.username, { via: 'password', initial_password: u.password_set === 0 });
  res.json({ token, user: userCard(u) });
});

// POST /api/auth/change-password — 登录态改密：邮箱验证码（purpose=reset，验的是本人绑定邮箱）
// 或旧密码二选一；初始密码态禁止把新密码仍设成初始密码
r.post('/change-password', authRequired, (req, res) => {
  const me = db.prepare('SELECT * FROM user WHERE id = ?').get(req.user.id);
  if (!me) return res.status(404).json({ error: '用户不存在' });
  const { new_password, old_password, code } = req.body || {};
  if (!new_password || String(new_password).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  if (String(new_password).length > 64) return res.status(400).json({ error: '新密码最多 64 位' });

  if (code) {
    if (!me.email) return res.status(400).json({ error: '账号未绑定邮箱，请改用旧密码方式' });
    const row = db.prepare(
      "SELECT id FROM email_code WHERE email = ? AND code = ? AND purpose = 'reset' AND expire_at > ? ORDER BY id DESC LIMIT 1"
    ).get(me.email, String(code).trim(), Date.now());
    if (!row) return res.status(400).json({ error: '验证码错误或已过期，请重新获取' });
    db.prepare('DELETE FROM email_code WHERE email = ?').run(me.email);
  } else {
    if (!old_password || !verifyPassword(String(old_password), me.password_hash)) {
      return res.status(400).json({ error: '旧密码不正确' });
    }
  }
  if (me.password_set === 0 && String(new_password) === INITIAL_PASSWORD) {
    return res.status(400).json({ error: '新密码不能与初始密码相同' });
  }
  db.prepare('UPDATE user SET password_hash = ?, password_set = 1 WHERE id = ?')
    .run(hashPassword(String(new_password)), me.id);
  clearPasswordInitNotice(me.id);
  req.user = { id: me.id, username: me.username };
  logAudit(req, 'password-change', me.email || me.username, { via: code ? 'email-code' : 'old-password' });
  const u = db.prepare('SELECT * FROM user WHERE id = ?').get(me.id);
  res.json({ message: '密码修改成功', user: userCard(u) });
});

// POST /api/auth/reset-password — 忘记密码（公开）：邮箱 + 验证码 + 新密码
r.post('/reset-password', (req, res) => {
  const { email, code, new_password } = req.body || {};
  const mail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return res.status(400).json({ error: '邮箱格式不正确' });
  if (!new_password || String(new_password).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  const row = db.prepare(
    "SELECT * FROM email_code WHERE email = ? AND code = ? AND purpose = 'reset' AND expire_at > ? ORDER BY id DESC LIMIT 1"
  ).get(mail, String(code || '').trim(), Date.now());
  const u = db.prepare('SELECT * FROM user WHERE email = ?').get(mail);
  // 用户不存在与验证码错误同语义（防账号枚举）
  if (!row || !u) return res.status(400).json({ error: '验证码错误或已过期，请重新获取' });
  db.prepare('DELETE FROM email_code WHERE email = ?').run(mail);
  db.prepare('UPDATE user SET password_hash = ?, password_set = 1 WHERE id = ?')
    .run(hashPassword(String(new_password)), u.id);
  clearPasswordInitNotice(u.id);
  res.json({ message: '密码已重置，请使用新密码登录' });
});

// PUT /api/auth/phone — 绑定/更换/解绑手机号（本期仅号段校验；phone_verified 预留 SMS 通道）
r.put('/phone', authRequired, (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  if (phone && !/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ error: '手机号格式不正确（11 位大陆手机号）' });
  if (phone) {
    const dup = db.prepare('SELECT id FROM user WHERE phone = ? AND id != ?').get(phone, req.user.id);
    if (dup) return res.status(409).json({ error: '该手机号已被其他账号绑定' });
  }
  db.prepare('UPDATE user SET phone = ?, phone_verified = 0 WHERE id = ?').run(phone, req.user.id);
  const u = db.prepare('SELECT * FROM user WHERE id = ?').get(req.user.id);
  res.json({ message: phone ? '手机号已保存（暂未验证）' : '已解绑手机号', user: userCard(u) });
});

// PUT /api/auth/real-name — 设置/修改真实姓名（本接口自身绝不挂 realNameRequired，否则死锁）
// 2-20 字（按码点计），首尾须为汉字或字母，中间允许空格/间隔号·•/点；拒绝纯数字、纯符号、单字、emoji
const REALNAME_RE = /^[一-龥A-Za-z][一-龥A-Za-z·•.\s]{0,18}[一-龥A-Za-z.]$/;
r.put('/real-name', authRequired, (req, res) => {
  const name = String(req.body?.real_name ?? '').trim().replace(/\s+/g, ' ');
  const len = Array.from(name).length;
  if (len < 2 || len > 20) return res.status(400).json({ error: '姓名长度需为 2-20 个字符' });
  if (!REALNAME_RE.test(name)) return res.status(400).json({ error: '姓名仅支持汉字、英文字母、空格和间隔号（·）' });
  if ((name.match(/[一-龥A-Za-z]/g) || []).length < 2) {
    return res.status(400).json({ error: '姓名不能为纯数字、纯符号或单字' });
  }
  const me = db.prepare('SELECT real_name FROM user WHERE id = ?').get(req.user.id);
  const oldName = me?.real_name || '';
  db.prepare('UPDATE user SET real_name = ? WHERE id = ?').run(name, req.user.id);
  clearRealNameNotice(req.user.id);
  if (oldName) logAudit(req, 'realname-change', name, { old: oldName });
  else logAudit(req, 'realname-set', name);
  const u = db.prepare('SELECT * FROM user WHERE id = ?').get(req.user.id);
  res.json({ message: '实名认证信息已保存', user: userCard(u) });
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
