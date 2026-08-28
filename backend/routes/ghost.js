// 幽灵模式（秘密通道「水手冰淇淋」）：激活/退出 + 怪奇小队成员名单
// 挂载 /api/ghost：is_ghost 落库持久化（user.is_ghost），激活一次永久生效，可手动退出
// /users 仅幽灵可调（ghostRequired），普通用户不可枚举幽灵身份
import { Router } from 'express';
import db from '../db/database.js';
import { authRequired, ghostRequired, logAudit } from './middleware.js';
import { userCard } from './auth.js';

const r = Router();

// POST /api/ghost/enter — 激活幽灵模式（落库，永久生效）
r.post('/enter', authRequired, (req, res) => {
  db.prepare('UPDATE user SET is_ghost = 1 WHERE id = ?').run(req.user.id);
  logAudit(req, 'ghost-enter');
  const u = db.prepare('SELECT * FROM user WHERE id = ?').get(req.user.id);
  res.json({ user: userCard(u) });
});

// POST /api/ghost/exit — 手动退出幽灵模式（幽灵帖保留，仅幽灵可见）
r.post('/exit', authRequired, (req, res) => {
  db.prepare('UPDATE user SET is_ghost = 0 WHERE id = ?').run(req.user.id);
  logAudit(req, 'ghost-exit');
  const u = db.prepare('SELECT * FROM user WHERE id = ?').get(req.user.id);
  res.json({ user: userCard(u) });
});

// GET /api/ghost/users — 怪奇小队成员名单（同等权限用户，不含自己）
r.get('/users', authRequired, ghostRequired, (req, res) => {
  const rows = db.prepare(
    'SELECT id, username, nickname, avatar FROM user WHERE is_ghost = 1 AND id != ? ORDER BY nickname, id'
  ).all(req.user.id);
  res.json(rows);
});

export default r;
