// 竞赛接口：列表 / 详情 / 搜索 / 知识收录（pending 审核流程）
import { Router } from 'express';
import db from '../db/database.js';
import { authRequired, adminPermRequired } from './middleware.js';

const r = Router();
// 审核类操作守卫：需「竞赛审核」模块权限（超管恒通过）；POST / 公开（任何用户可提交库外竞赛）
const reviewRequired = [authRequired, adminPermRequired('competition')];
const DATE_FIELDS = ['registration_start_date', 'registration_deadline', 'competition_start_date', 'competition_end_date'];
const DATE_STATUS = new Set(['exact', 'partial', 'month_only', 'unknown']);
const RESOURCE_TYPES = new Set(['docs', 'course', 'video', 'project', 'article', 'tool']);

function cleanDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const err = new Error('日期必须为 YYYY-MM-DD');
    err.status = 400;
    throw err;
  }
  return text;
}

function cleanUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch {
    const err = new Error('链接格式不正确');
    err.status = 400;
    throw err;
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    const err = new Error('链接仅支持 http/https');
    err.status = 400;
    throw err;
  }
  return url.toString();
}

function platformOf(url, fallback = 'official') {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes('bilibili.com')) return 'bilibili';
    if (host.includes('github.com')) return 'github';
    if (host.includes('zhihu.com')) return 'zhihu';
    if (host.includes('csdn.net')) return 'csdn';
    if (host.includes('docs.')) return 'docs';
    if (host.includes('mooc.') || host.includes('coursera.org')) return 'mooc';
  } catch {}
  return fallback;
}

// 获取单条竞赛详情（含子赛项流程 + 技术栈树）
function getDetail(id) {
  const comp = db.prepare('SELECT * FROM competition WHERE id = ?').get(id);
  if (!comp) return null;
  const process = db.prepare('SELECT * FROM competition_process WHERE comp_id = ? ORDER BY sub_event_order').all(id);
  const stacks = db.prepare(
    'SELECT * FROM tech_stack WHERE comp_id = ? ORDER BY process_id, level, sort_order, id'
  ).all(id);
  const byProcess = new Map();
  for (const p of process) byProcess.set(p.id, []);
  for (const s of stacks) {
    const arr = byProcess.get(s.process_id);
    if (arr) arr.push(s);
  }
  comp.process = process.map((p) => ({ ...p, tech_stack: byProcess.get(p.id) || [] }));
  comp.tech_nodes = stacks;
  // 学习资源（视频/文章），附技术栈节点名与所属子赛项
  comp.media = db.prepare(
    `SELECT m.id, m.category, m.platform, m.title, m.keyword, m.url, m.source_type,
            m.tech_node_id, m.resource_type, m.provider, m.verified_at,
            t.node_name AS tech_node, t.level AS tech_level, p.phase_name AS process_name
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
    `SELECT id, name, short_name, type, start_month, cycle, difficulty, status, source_type,
            registration_start_date, registration_deadline, competition_start_date,
            competition_end_date, date_status, date_source_url, data_year, official_url
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
    `SELECT id, name, short_name, type, start_month, difficulty, status,
            registration_start_date, registration_deadline, competition_start_date,
            competition_end_date, date_status, date_source_url, data_year, official_url
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
r.get('/pending', ...reviewRequired, (req, res) => {
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

// PUT /api/competition/:id — 管理端补全竞赛信息和精确日期
r.put('/:id', ...reviewRequired, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 非法' });
    if (!db.prepare('SELECT id FROM competition WHERE id = ?').get(id)) {
      return res.status(404).json({ error: '竞赛不存在' });
    }
    const b = req.body || {};
    const fields = [
      'name', 'short_name', 'type', 'start_month', 'sign_start', 'sign_end',
      'province_time', 'national_time', 'timeline_raw', 'cycle', 'difficulty',
      'intro', 'suitable_major', 'team', 'source_url', 'official_url', 'data_year',
      'date_status', 'date_source_url', ...DATE_FIELDS,
    ];
    const updates = [];
    const params = [];
    for (const key of fields) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) continue;
      let value = b[key];
      if (DATE_FIELDS.includes(key)) value = cleanDate(value);
      else if (key === 'date_status') {
        value = String(value || 'unknown').trim();
        if (!DATE_STATUS.has(value)) return res.status(400).json({ error: 'date_status 非法' });
      } else if (key === 'source_url' || key === 'official_url' || key === 'date_source_url') {
        value = value ? cleanUrl(value) : null;
      } else if (key === 'name') {
        value = String(value || '').trim();
        if (!value) return res.status(400).json({ error: '竞赛名称不能为空' });
      }
      updates.push(`${key} = ?`);
      params.push(value);
    }
    if (!updates.length) return res.status(400).json({ error: '没有可更新字段' });
    if (['date_status', ...DATE_FIELDS, 'date_source_url'].some((key) => Object.prototype.hasOwnProperty.call(b, key))) {
      updates.push('date_updated_at = CURRENT_TIMESTAMP');
    }
    db.prepare(`UPDATE competition SET ${updates.join(', ')} WHERE id = ?`).run(...params, id);
    res.json({ id, competition: getDetail(id), message: '竞赛信息已更新' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /api/competition/:id/process — 管理端新增子赛项/备赛阶段
r.post('/:id/process', ...reviewRequired, (req, res) => {
  try {
    const compId = Number(req.params.id);
    if (!Number.isInteger(compId) || !db.prepare('SELECT id FROM competition WHERE id = ?').get(compId)) {
      return res.status(404).json({ error: '竞赛不存在' });
    }
    const b = req.body || {};
    const name = String(b.phase_name || '').trim();
    if (!name) return res.status(400).json({ error: '阶段/子赛项名称必填' });
    const order = Number(b.sub_event_order) || (
      db.prepare('SELECT COALESCE(MAX(sub_event_order), 0) + 1 AS n FROM competition_process WHERE comp_id = ?').get(compId).n
    );
    const rr = db.prepare(
      `INSERT INTO competition_process
       (comp_id, phase_name, phase_desc, suggest_month, check_standard, sub_event_order)
       VALUES (?,?,?,?,?,?)`
    ).run(
      compId,
      name,
      String(b.phase_desc || '').trim(),
      Number(b.suggest_month) || null,
      String(b.check_standard || '').trim(),
      order,
    );
    res.status(201).json({ id: rr.lastInsertRowid, message: '阶段已新增' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/competition/process/:pid — 管理端删除阶段、技术树和关联资源
r.delete('/process/:pid', ...reviewRequired, (req, res) => {
  const processId = Number(req.params.pid);
  const process = db.prepare('SELECT id FROM competition_process WHERE id = ?').get(processId);
  if (!process) return res.status(404).json({ error: '子赛项不存在' });
  db.exec('BEGIN');
  try {
    const ids = db.prepare('SELECT id FROM tech_stack WHERE process_id = ?').all(processId).map((row) => row.id);
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM media_resource WHERE tech_node_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM tech_stack WHERE id IN (${placeholders})`).run(...ids);
    }
    db.prepare('DELETE FROM competition_process WHERE id = ?').run(processId);
    db.exec('COMMIT');
    res.json({ id: processId, message: '子赛项已删除' });
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

// POST /api/competition/:id/tech-node — 管理端在任意知识点下继续添加子知识点
r.post('/:id/tech-node', ...reviewRequired, (req, res) => {
  try {
    const compId = Number(req.params.id);
    const b = req.body || {};
    const processId = Number(b.process_id);
    const process = db.prepare(
      'SELECT id FROM competition_process WHERE id = ? AND comp_id = ?'
    ).get(processId, compId);
    if (!process) return res.status(400).json({ error: '子赛项不存在或不属于该竞赛' });
    const name = String(b.node_name || '').trim();
    if (!name) return res.status(400).json({ error: '知识点名称必填' });
    if (name.length > 80) return res.status(400).json({ error: '知识点名称不能超过 80 字' });
    const parentId = Number(b.parent_id) || 0;
    let level = 1;
    if (parentId) {
      const parent = db.prepare(
        'SELECT id, level FROM tech_stack WHERE id = ? AND comp_id = ? AND process_id = ?'
      ).get(parentId, compId, processId);
      if (!parent) return res.status(400).json({ error: '父知识点不存在或不属于该子赛项' });
      level = Number(parent.level || 1) + 1;
      if (level > 6) return res.status(400).json({ error: '技术树最多支持 6 层' });
    }
    const sortOrder = Number(b.sort_order) || (
      db.prepare(
        `SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM tech_stack
         WHERE comp_id = ? AND process_id = ? AND parent_id = ?`
      ).get(compId, processId, parentId).n
    );
    const rr = db.prepare(
      `INSERT INTO tech_stack
       (comp_id, process_id, parent_id, node_name, node_desc, level, keywords, sort_order)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      compId,
      processId,
      parentId,
      name,
      String(b.node_desc || '').trim(),
      level,
      String(b.keywords || '').trim(),
      sortOrder,
    );
    res.status(201).json({ id: rr.lastInsertRowid, level, message: '知识点已新增' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PUT /api/competition/tech-node/:nodeId — 管理端编辑知识点
r.put('/tech-node/:nodeId', ...reviewRequired, (req, res) => {
  try {
    const nodeId = Number(req.params.nodeId);
    const node = db.prepare('SELECT * FROM tech_stack WHERE id = ?').get(nodeId);
    if (!node) return res.status(404).json({ error: '知识点不存在' });
    const b = req.body || {};
    const updates = [];
    const params = [];
    for (const key of ['node_name', 'node_desc', 'keywords', 'sort_order']) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) continue;
      updates.push(`${key} = ?`);
      params.push(key === 'sort_order' ? Number(b[key]) || 0 : String(b[key] || '').trim());
    }
    if (!updates.length) return res.status(400).json({ error: '没有可更新字段' });
    db.prepare(`UPDATE tech_stack SET ${updates.join(', ')} WHERE id = ?`).run(...params, nodeId);
    res.json({ id: nodeId, message: '知识点已更新' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/competition/tech-node/:nodeId — 管理端删除知识点及其子树和关联资源
r.delete('/tech-node/:nodeId', ...reviewRequired, (req, res) => {
  const nodeId = Number(req.params.nodeId);
  const node = db.prepare('SELECT id FROM tech_stack WHERE id = ?').get(nodeId);
  if (!node) return res.status(404).json({ error: '知识点不存在' });
  db.exec('BEGIN');
  try {
    const ids = db.prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT id FROM tech_stack WHERE id = ?
         UNION ALL
         SELECT t.id FROM tech_stack t JOIN subtree s ON t.parent_id = s.id
       ) SELECT id FROM subtree`
    ).all(nodeId).map((row) => row.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM media_resource WHERE tech_node_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM tech_stack WHERE id IN (${placeholders})`).run(...ids);
    db.exec('COMMIT');
    res.json({ deleted: ids.length, message: '知识点已删除' });
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

// POST /api/competition/:id/resource — 管理端补充真实学习资源
r.post('/:id/resource', ...reviewRequired, (req, res) => {
  try {
    const compId = Number(req.params.id);
    if (!db.prepare('SELECT id FROM competition WHERE id = ?').get(compId)) {
      return res.status(404).json({ error: '竞赛不存在' });
    }
    const b = req.body || {};
    const category = String(b.category || 'knowledge').trim();
    if (!['intro', 'process', 'knowledge'].includes(category)) {
      return res.status(400).json({ error: '资源分类非法' });
    }
    const url = cleanUrl(b.url);
    if (!url) return res.status(400).json({ error: '资源链接必填' });
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ error: '资源标题必填' });
    const techNodeId = Number(b.tech_node_id) || null;
    if (category === 'knowledge' && !techNodeId) {
      return res.status(400).json({ error: '知识点资源必须绑定技术树节点' });
    }
    if (techNodeId && !db.prepare(
      'SELECT id FROM tech_stack WHERE id = ? AND comp_id = ?'
    ).get(techNodeId, compId)) {
      return res.status(400).json({ error: '技术树节点不存在或不属于该竞赛' });
    }
    const resourceType = RESOURCE_TYPES.has(String(b.resource_type))
      ? String(b.resource_type)
      : 'article';
    const platform = String(b.platform || '').trim() || platformOf(url);
    const rr = db.prepare(
      `INSERT INTO media_resource
       (comp_id, category, platform, title, keyword, url, tech_node_id, source_type,
        resource_type, provider, created_by, verified_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`
    ).run(
      compId,
      category,
      platform,
      title,
      String(b.keyword || '').trim(),
      url,
      techNodeId,
      'manual',
      resourceType,
      String(b.provider || '').trim(),
      req.user.id,
    );
    res.status(201).json({ id: rr.lastInsertRowid, message: '学习资源已补充' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PUT /api/competition/resource/:rid — 管理端编辑资源
r.put('/resource/:rid', ...reviewRequired, (req, res) => {
  try {
    const rid = Number(req.params.rid);
    const row = db.prepare('SELECT * FROM media_resource WHERE id = ?').get(rid);
    if (!row) return res.status(404).json({ error: '资源不存在' });
    const b = req.body || {};
    const updates = [];
    const params = [];
    for (const key of ['title', 'keyword', 'resource_type', 'provider']) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) continue;
      let value = String(b[key] || '').trim();
      if (key === 'resource_type' && !RESOURCE_TYPES.has(value)) return res.status(400).json({ error: '资源类型非法' });
      updates.push(`${key} = ?`);
      params.push(value);
    }
    if (Object.prototype.hasOwnProperty.call(b, 'url')) {
      const url = cleanUrl(b.url);
      if (!url) return res.status(400).json({ error: '资源链接必填' });
      updates.push('url = ?', 'platform = ?', 'source_type = ?', 'verified_at = CURRENT_TIMESTAMP');
      params.push(url, String(b.platform || '').trim() || platformOf(url), 'manual');
    }
    if (!updates.length) return res.status(400).json({ error: '没有可更新字段' });
    db.prepare(`UPDATE media_resource SET ${updates.join(', ')} WHERE id = ?`).run(...params, rid);
    res.json({ id: rid, message: '资源已更新' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/competition/resource/:rid — 管理端删除资源
r.delete('/resource/:rid', ...reviewRequired, (req, res) => {
  const rid = Number(req.params.rid);
  const rr = db.prepare('DELETE FROM media_resource WHERE id = ?').run(rid);
  if (!rr.changes) return res.status(404).json({ error: '资源不存在' });
  res.json({ id: rid, message: '资源已删除' });
});

// POST /api/competition/ — AI/用户新增竞赛（status=pending，必须带 source_url）
r.post('/', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name 必填' });
  if (!b.source_url) {
    return res.status(400).json({ error: '知识收录必须提供 source_url（官方来源链接），防止数据污染；无来源请先通过 /api/ai/extract 提炼' });
  }
  let dateValues;
  let dateSourceUrl = null;
  try {
    dateValues = DATE_FIELDS.map((key) => cleanDate(b[key]));
    dateSourceUrl = b.date_source_url ? cleanUrl(b.date_source_url) : null;
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  const dateStatus = DATE_STATUS.has(String(b.date_status)) ? String(b.date_status) : 'unknown';
  const r2 = db.prepare(
    `INSERT INTO competition (name, short_name, type, start_month, sign_start, sign_end,
       province_time, national_time, registration_start_date, registration_deadline,
       competition_start_date, competition_end_date, date_status, date_source_url,
       cycle, difficulty, intro, suitable_major, team, source_type, source_url, status,
       data_year, confidence, date_updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`
  ).run(
    b.name, b.short_name ?? null, b.type ?? '综合', b.start_month ?? null,
    b.sign_start ?? null, b.sign_end ?? null, b.province_time ?? null, b.national_time ?? null,
    ...dateValues, dateStatus, dateSourceUrl,
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
r.post('/:id/verify', ...reviewRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 非法' });
  const r2 = db.prepare(`UPDATE competition SET status = 'active' WHERE id = ?`).run(id);
  if (r2.changes === 0) return res.status(404).json({ error: '竞赛不存在' });
  res.json({ id, status: 'active', message: '已采纳转正' });
});

// DELETE /api/competition/:id — 删除（拒绝收录或数据有误；级联删子赛项与技术栈）
r.delete('/:id', ...reviewRequired, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 非法' });
  const r2 = db.prepare('DELETE FROM competition WHERE id = ?').run(id);
  if (r2.changes === 0) return res.status(404).json({ error: '竞赛不存在' });
  res.json({ id, message: '已删除（含关联子赛项与技术栈）' });
});

export default r;
