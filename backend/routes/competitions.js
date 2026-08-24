// 竞赛接口：列表 / 详情 / 搜索 / 知识收录（pending 审核流程）
import { Router } from 'express';
import db from '../db/database.js';

const r = Router();

// 获取单条竞赛详情（含子赛项流程 + 技术栈树）
function getDetail(id) {
  const comp = db.prepare('SELECT * FROM competition WHERE id = ?').get(id);
  if (!comp) return null;
  const process = db.prepare('SELECT * FROM competition_process WHERE comp_id = ? ORDER BY sub_event_order').all(id);
  const stacks = db.prepare('SELECT * FROM tech_stack WHERE comp_id = ? ORDER BY id').all(id);
  const byProcess = new Map();
  for (const p of process) byProcess.set(p.id, []);
  for (const s of stacks) {
    const arr = byProcess.get(s.process_id);
    if (arr) arr.push(s);
  }
  comp.process = process.map((p) => ({ ...p, tech_stack: byProcess.get(p.id) || [] }));
  // 学习资源（视频/文章），附技术栈节点名与所属子赛项
  comp.media = db.prepare(
    `SELECT m.id, m.category, m.platform, m.title, m.keyword, m.url, m.source_type,
            t.node_name AS tech_node, p.phase_name AS process_name
     FROM media_resource m
     LEFT JOIN tech_stack t ON t.id = m.tech_node_id
     LEFT JOIN competition_process p ON p.id = t.process_id
     WHERE m.comp_id = ? ORDER BY m.category, m.platform`
  ).all(id);
  return comp;
}

// GET /api/competition — 全部赛事（筛选：?type=&difficulty=&status=）
r.get('/', (req, res) => {
  const { type, difficulty, status = 'active' } = req.query;
  const conds = ['status = ?'];
  const args = [status];
  if (type) { conds.push('type = ?'); args.push(type); }
  if (difficulty) { conds.push('difficulty = ?'); args.push(Number(difficulty)); }
  const rows = db.prepare(
    `SELECT id, name, short_name, type, start_month, cycle, difficulty, status, source_type
     FROM competition WHERE ${conds.join(' AND ')} ORDER BY start_month, id`
  ).all(...args);
  res.json(rows);
});

// GET /api/competition/search?q= — 查库，未命中提示走 AI 收录流程
r.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: '缺少 q 参数' });
  const like = `%${q}%`;
  const rows = db.prepare(
    `SELECT id, name, short_name, type, start_month, difficulty, status
     FROM competition WHERE status = 'active' AND (name LIKE ? OR short_name LIKE ?)
     ORDER BY start_month LIMIT 20`
  ).all(like, like);
  res.json({
    query: q,
    found: rows.length > 0,
    results: rows,
    hint: rows.length
      ? undefined
      : '未收录该竞赛：可走 AI 收录流程（POST /api/ai/extract 提炼官方资料 → POST /api/competition 暂存待审核）',
  });
});

// GET /api/competition/pending — 待审核列表（管理端）
r.get('/pending', (req, res) => {
  const rows = db.prepare(
    `SELECT id, name, short_name, type, difficulty, source_type, source_url, confidence, create_time
     FROM competition WHERE status = 'pending' ORDER BY create_time DESC`
  ).all();
  res.json(rows);
});

// GET /api/competition/:id — 单条详情
r.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 非法' });
  const comp = getDetail(id);
  if (!comp) return res.status(404).json({ error: '竞赛不存在' });
  res.json(comp);
});

// POST /api/competition/ — AI/用户新增竞赛（status=pending，必须带 source_url）
r.post('/', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name 必填' });
  if (!b.source_url) {
    return res.status(400).json({ error: '知识收录必须提供 source_url（官方来源链接），防止数据污染；无来源请先通过 /api/ai/extract 提炼' });
  }
  const r2 = db.prepare(
    `INSERT INTO competition (name, short_name, type, start_month, sign_start, sign_end,
       province_time, national_time, cycle, difficulty, intro, suitable_major, team,
       source_type, source_url, status, data_year, confidence)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    b.name, b.short_name ?? null, b.type ?? '综合', b.start_month ?? null,
    b.sign_start ?? null, b.sign_end ?? null, b.province_time ?? null, b.national_time ?? null,
    b.cycle ?? null, b.difficulty ?? null, b.intro ?? null, b.suitable_major ?? null, b.team ?? null,
    b.source_type ?? 'ai_search', b.source_url, 'pending',
    b.data_year ?? new Date().getFullYear(), b.confidence ?? null
  );
  res.status(201).json({
    id: r2.lastInsertRowid,
    status: 'pending',
    message: '已入库待审核（status=pending），管理端 /api/competition/pending 可采纳转正',
  });
});

// POST /api/competition/:id/verify — 采纳转正（pending → active）
r.post('/:id/verify', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 非法' });
  const r2 = db.prepare(`UPDATE competition SET status = 'active' WHERE id = ?`).run(id);
  if (r2.changes === 0) return res.status(404).json({ error: '竞赛不存在' });
  res.json({ id, status: 'active', message: '已采纳转正' });
});

// DELETE /api/competition/:id — 删除（拒绝收录或数据有误；级联删子赛项与技术栈）
r.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 非法' });
  const r2 = db.prepare('DELETE FROM competition WHERE id = ?').run(id);
  if (r2.changes === 0) return res.status(404).json({ error: '竞赛不存在' });
  res.json({ id, message: '已删除（含关联子赛项与技术栈）' });
});

export default r;
