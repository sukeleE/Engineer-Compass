// 日程笔记接口：每日学习笔记（富文本 HTML）+ 学习状态，月历按日期回看
// 归属策略与 user_schedule 一致：登录用户 = 自己 + 匿名 'local'；匿名 = 仅 'local'
// 同用户同一日期只有一条笔记（upsert），状态值域 good/hard/slow/none
import { Router } from 'express';
import db from '../db/database.js';
import { optionalAuth } from './middleware.js';

const r = Router();

const VALID_STATUS = ['good', 'hard', 'slow', 'none'];
// 统一转字符串：node:sqlite 数字绑定不与 TEXT 列宽松匹配（user_id 列存 "37" 而非 37），
// 所有比较/写入必须同型，否则登录用户的笔记会查不到
const owner = (req) => (req.user ? String(req.user.id) : 'local');

// GET /api/notes?month=YYYY-MM — 某月笔记（日历标记 + 面板列表）；不带 month 返回最近 100 条
r.get('/', optionalAuth, (req, res) => {
  const uid = owner(req);
  const month = String(req.query.month || '').match(/^\d{4}-\d{2}$/)?.[0];
  const base = `SELECT id, note_date, schedule_id, status, content, update_time FROM daily_note WHERE user_id = ?`;
  const rows = month
    ? db.prepare(`${base} AND substr(note_date, 1, 7) = ? ORDER BY note_date DESC`).all(uid, month)
    : db.prepare(`${base} ORDER BY note_date DESC LIMIT 100`).all(uid);
  res.json(rows);
});

// GET /api/notes/:date — 单日笔记（含关联竞赛名）
r.get('/:date', optionalAuth, (req, res) => {
  const d = String(req.params.date || '').match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
  if (!d) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
  const row = db.prepare(
    `SELECT n.id, n.note_date, n.schedule_id, n.status, n.content, n.update_time,
            s.comp_id, c.name AS comp_name
     FROM daily_note n
     LEFT JOIN user_schedule s ON s.id = n.schedule_id
     LEFT JOIN competition c ON c.id = s.comp_id
     WHERE n.user_id = ? AND n.note_date = ?`
  ).get(owner(req), d);
  res.json(row || null);
});

// POST /api/notes — 新建 / 更新（同用户同日期 upsert）
r.post('/', optionalAuth, (req, res) => {
  const { note_date, content = '', status = '', schedule_id } = req.body || {};
  const d = String(note_date || '').match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
  if (!d) return res.status(400).json({ error: 'note_date 必填，格式 YYYY-MM-DD' });
  const st = VALID_STATUS.includes(status) ? status : '';
  const uid = owner(req);

  // 只允许关联自己可见的日程（自己的 + 匿名 local）
  let sid = null;
  if (schedule_id) {
    const s = db.prepare("SELECT id FROM user_schedule WHERE id = ? AND (user_id = ? OR user_id = 'local')")
      .get(Number(schedule_id), uid);
    if (s) sid = s.id;
  }

  const existing = db.prepare('SELECT id FROM daily_note WHERE user_id = ? AND note_date = ?').get(uid, d);
  if (existing) {
    db.prepare('UPDATE daily_note SET content = ?, status = ?, schedule_id = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?')
      .run(String(content), st, sid, existing.id);
    return res.json({ id: existing.id, note_date: d, message: '已更新' });
  }
  const rr = db.prepare('INSERT INTO daily_note (user_id, note_date, schedule_id, status, content) VALUES (?,?,?,?,?)')
    .run(String(uid), d, sid, st, String(content));
  res.status(201).json({ id: rr.lastInsertRowid, note_date: d, message: '已保存' });
});

// DELETE /api/notes/:id
r.delete('/:id', optionalAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 非法' });
  const r2 = db.prepare('DELETE FROM daily_note WHERE id = ? AND user_id = ?').run(id, owner(req));
  if (r2.changes === 0) return res.status(404).json({ error: '笔记不存在' });
  res.json({ id, message: '已删除' });
});

export default r;
