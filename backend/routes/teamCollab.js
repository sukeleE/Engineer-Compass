// 小组协作接口：进度任务对齐 / 进度汇报 / 讨论 / 资料共享 / 设备预约
import { Router } from 'express';
import db from '../db/database.js';
import { authRequired, teamCtx, requirePerm } from './middleware.js';
import { normalizePlan } from './schedule.js';

const r = Router();
r.use(authRequired);

const MAX_FILE = 20 * 1024 * 1024; // 单文件上限 20MB（base64 后约 27MB）
const MAX_ATTACH = 25 * 1024 * 1024; // 单次附件总 base64 上限（留 json 30mb limit 余量）

// 校验并归一化附件数组：[{name,size,mime,data}] → 只留合法项；超限抛错
function sanitizeAttachments(attachments) {
  if (attachments === undefined || attachments === null) return [];
  if (!Array.isArray(attachments)) throw new Error('attachments 需为数组');
  let total = 0;
  const out = [];
  for (const a of attachments) {
    const name = String(a?.name || '').trim();
    const data = String(a?.data || '');
    if (!name || !data) continue;
    total += data.length;
    if (total > MAX_ATTACH) throw new Error(`附件过大（总计 ≤${Math.floor(MAX_ATTACH / 1024 / 1024)}MB）`);
    out.push({ name, size: Number(a.size) || 0, mime: String(a.mime || '').trim() || 'application/octet-stream', data });
  }
  return out;
}

const parseAtt = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
// 旧版前端把 {content, attachments} 整个对象存库串化为 "[object Object]"（文字已不可恢复），读取时清洗为空串
const cleanContent = (s) => (String(s || '') === '[object Object]' ? '' : String(s || ''));

// 批量挂评论：把 type（log/message）目标的评论按 target_id 分组附加
function attachComments(teamId, type, targets) {
  const ids = targets.map((t) => t.id);
  if (!ids.length) return targets.map((t) => ({ ...t, comments: [] }));
  const rows = db.prepare(
    `SELECT c.id, c.target_id, c.user_id, c.content, c.create_time, u.nickname
     FROM comment c JOIN user u ON u.id = c.user_id
     WHERE c.team_id = ? AND c.target_type = ? AND c.target_id IN (${ids.map(() => '?').join(',')})
     ORDER BY c.create_time`
  ).all(teamId, type, ...ids);
  const byTarget = {};
  for (const c of rows) (byTarget[c.target_id] ||= []).push(c);
  return targets.map((t) => ({ ...t, comments: byTarget[t.id] || [] }));
}

// POST /api/team/:id/comment — 评论（log 或 message，全体成员可评论）
r.post('/:id/comment/:type/:tid', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const type = req.params.type === 'log' ? 'log' : req.params.type === 'message' ? 'message' : null;
  if (!type) return res.status(400).json({ error: '评论目标类型非法' });
  const tid = Number(req.params.tid);
  const targetTable = type === 'log' ? 'progress_log' : 'team_message';
  const target = db.prepare(`SELECT id FROM ${targetTable} WHERE id = ? AND team_id = ?`).get(tid, ctx.team.id);
  if (!target) return res.status(404).json({ error: '评论目标不存在' });
  const content = String((req.body || {}).content || '').trim();
  if (!content) return res.status(400).json({ error: '评论内容必填' });
  if (content.length > 500) return res.status(400).json({ error: '评论最长 500 字' });
  const rr = db.prepare('INSERT INTO comment (team_id, target_type, target_id, user_id, content) VALUES (?,?,?,?,?)')
    .run(ctx.team.id, type, tid, req.user.id, content);
  res.status(201).json({ id: rr.lastInsertRowid, message: '已评论' });
});

// DELETE /api/team/:id/comment/:cid — 删除评论（本人或组长/成员管理员）
r.delete('/:id/comment/:cid', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const c = db.prepare('SELECT * FROM comment WHERE id = ? AND team_id = ?').get(Number(req.params.cid), ctx.team.id);
  if (!c) return res.status(404).json({ error: '评论不存在' });
  const canMod = ctx.isOwner || requirePerm(ctx, res, 'member') === null || c.user_id === req.user.id;
  if (!canMod) return res.status(403).json({ error: '仅本人或管理员可删除' });
  db.prepare('DELETE FROM comment WHERE id = ?').run(c.id);
  res.json({ message: '已删除' });
});

// ==================== 进度对齐 ====================

// POST /api/team/:id/task — 创建任务（task 权限）
r.post('/:id/task', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  const deny = requirePerm(ctx, res, 'task');
  if (deny) return deny;
  const { title, desc, deadline, assignee_id, progress, status } = req.body || {};
  if (!String(title || '').trim()) return res.status(400).json({ error: '任务标题必填' });
  if (assignee_id) {
    const m = db.prepare('SELECT id FROM team_member WHERE team_id = ? AND user_id = ?').get(ctx.team.id, Number(assignee_id));
    if (!m) return res.status(400).json({ error: '负责人不是小组成员' });
  }
  const rr = db.prepare(
    'INSERT INTO team_task (team_id, title, desc, deadline, assignee_id, status, progress) VALUES (?,?,?,?,?,?,?)'
  ).run(ctx.team.id, String(title).trim(), (desc || '').trim() || null, deadline || null,
    assignee_id ? Number(assignee_id) : null, status || 'todo', Math.max(0, Math.min(100, Number(progress) || 0)));
  res.status(201).json({ id: rr.lastInsertRowid, message: '任务已创建' });
});

// PUT /api/team/:id/task/:tid — 更新任务（负责人本人或 task 权限）
r.put('/:id/task/:tid', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const task = db.prepare('SELECT * FROM team_task WHERE id = ? AND team_id = ?').get(Number(req.params.tid), ctx.team.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const canEdit = task.assignee_id === req.user.id || requirePerm(ctx, res, 'task') === null;
  if (!canEdit) return res.status(403).json({ error: '仅负责人或「任务管理」权限可修改' });

  const { title, desc, deadline, assignee_id, status, progress } = req.body || {};
  db.prepare(
    'UPDATE team_task SET title = ?, desc = ?, deadline = ?, assignee_id = ?, status = ?, progress = ? WHERE id = ?'
  ).run(
    title !== undefined ? String(title).trim() : task.title,
    desc !== undefined ? ((desc || '').trim() || null) : task.desc,
    deadline !== undefined ? deadline : task.deadline,
    assignee_id !== undefined ? (assignee_id ? Number(assignee_id) : null) : task.assignee_id,
    status || task.status,
    progress !== undefined ? Math.max(0, Math.min(100, Number(progress))) : task.progress,
    task.id
  );
  res.json({ message: '任务已更新' });
});

// DELETE /api/team/:id/task/:tid — 删除任务（task 权限）
r.delete('/:id/task/:tid', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  const deny = requirePerm(ctx, res, 'task');
  if (deny) return deny;
  const rr = db.prepare('DELETE FROM team_task WHERE id = ? AND team_id = ?').run(Number(req.params.tid), ctx.team.id);
  if (rr.changes === 0) return res.status(404).json({ error: '任务不存在' });
  res.json({ message: '任务已删除' });
});

// POST /api/team/:id/log — 成员进度汇报（progress 权限；富文本 + 附件）
r.post('/:id/log', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  const deny = requirePerm(ctx, res, 'progress');
  if (deny) return deny;
  const { content, attachments } = req.body || {};
  if (content !== undefined && typeof content !== 'string') {
    return res.status(400).json({ error: '汇报内容格式错误' });
  }
  if (!String(content || '').replace(/<[^>]*>/g, '').trim() && !(attachments || []).length) {
    return res.status(400).json({ error: '汇报内容或附件至少填写一项' });
  }
  let att = [];
  try { att = sanitizeAttachments(attachments); } catch (e) { return res.status(413).json({ error: e.message }); }
  const rr = db.prepare('INSERT INTO progress_log (team_id, user_id, content, attachments) VALUES (?,?,?,?)')
    .run(ctx.team.id, req.user.id, String(content || ''), JSON.stringify(att));
  res.status(201).json({ id: rr.lastInsertRowid, message: '进度已汇报' });
});

// GET /api/team/:id/logs — 进度汇报时间线
r.get('/:id/logs', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const rows = db.prepare(
    `SELECT l.id, l.content, l.attachments, l.create_time, u.id AS user_id, u.nickname
     FROM progress_log l JOIN user u ON u.id = l.user_id
     WHERE l.team_id = ? ORDER BY l.create_time DESC LIMIT 100`
  ).all(ctx.team.id).map((l) => ({ ...l, content: cleanContent(l.content), attachments: parseAtt(l.attachments) }));
  res.json(attachComments(ctx.team.id, 'log', rows));
});

// ==================== 计划同步（成员备赛计划 + 学习日程，供小组对齐） ====================

// GET /api/team/:id/plans — 小组成员的竞赛备赛计划与学习日程
r.get('/:id/plans', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const members = db.prepare(
    `SELECT u.id, u.nickname, tm.role_id, tr.name AS role_name FROM team_member tm
     JOIN user u ON u.id = tm.user_id LEFT JOIN team_role tr ON tr.id = tm.role_id
     WHERE tm.team_id = ? ORDER BY (tm.role_id IS NULL) DESC, tr.level DESC, tm.join_time`
  ).all(ctx.team.id);

  const rows = members.map((m) => {
    const schedules = db.prepare(
      `SELECT s.id, s.plan_json, s.create_time, c.name AS comp_name, c.short_name
       FROM user_schedule s LEFT JOIN competition c ON c.id = s.comp_id WHERE s.user_id = ? ORDER BY s.create_time DESC`
    ).all(m.id).map((s) => {
      const plan = normalizePlan(JSON.parse(s.plan_json || '{}'));
      const all = plan.phases.flatMap((p) => p.tasks || []);
      return {
        id: s.id, comp_name: s.comp_name || '未知竞赛', short_name: s.short_name,
        phaseCount: plan.phases.length,
        done: all.filter((t) => t.done).length, total: all.length,
        phases: plan.phases.map((p) => ({ phase: p.phase, date: p.date, done: p.tasks.filter((t) => t.done).length, total: p.tasks.length })),
      };
    });
    const studies = db.prepare(
      `SELECT id, topic, level, goal, hours, plan_json, create_time FROM user_study WHERE user_id = ? ORDER BY create_time DESC`
    ).all(m.id).map((s) => {
      const plan = normalizePlan(JSON.parse(s.plan_json || '{}'));
      const all = plan.phases.flatMap((p) => p.tasks || []);
      return {
        id: s.id, topic: s.topic, level: s.level,
        phaseCount: plan.phases.length,
        done: all.filter((t) => t.done).length, total: all.length,
        phases: plan.phases.map((p) => ({ phase: p.phase, date: p.date, done: p.tasks.filter((t) => t.done).length, total: p.tasks.length })),
      };
    });
    return { user_id: m.id, nickname: m.nickname, role_name: m.role_name, is_owner: m.id === ctx.team.owner_id, schedules, studies };
  });
  res.json(rows);
});

// ==================== 讨论 ====================

// GET /api/team/:id/messages — 讨论消息
r.get('/:id/messages', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const rows = db.prepare(
    `SELECT m.id, m.content, m.attachments, m.create_time, u.id AS user_id, u.nickname
     FROM team_message m JOIN user u ON u.id = m.user_id
     WHERE m.team_id = ? ORDER BY m.create_time DESC LIMIT 200`
  ).all(ctx.team.id).map((m) => ({ ...m, content: cleanContent(m.content), attachments: parseAtt(m.attachments) }));
  res.json(attachComments(ctx.team.id, 'message', rows));
});

// POST /api/team/:id/message — 发消息（message 权限；可附图片）
r.post('/:id/message', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  const deny = requirePerm(ctx, res, 'message');
  if (deny) return deny;
  const { content, attachments } = req.body || {};
  if (content !== undefined && typeof content !== 'string') {
    return res.status(400).json({ error: '消息内容格式错误' });
  }
  if (!String(content || '').trim() && !(attachments || []).length) {
    return res.status(400).json({ error: '消息内容或图片至少填写一项' });
  }
  let att = [];
  try { att = sanitizeAttachments(attachments); } catch (e) { return res.status(413).json({ error: e.message }); }
  const rr = db.prepare('INSERT INTO team_message (team_id, user_id, content, attachments) VALUES (?,?,?,?)')
    .run(ctx.team.id, req.user.id, String(content || ''), JSON.stringify(att));
  res.status(201).json({ id: rr.lastInsertRowid, message: '已发送' });
});

// DELETE /api/team/:id/message/:mid — 删除（本人或 task 权限持有者——用 message 权限管理员）
r.delete('/:id/message/:mid', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const msg = db.prepare('SELECT * FROM team_message WHERE id = ? AND team_id = ?').get(Number(req.params.mid), ctx.team.id);
  if (!msg) return res.status(404).json({ error: '消息不存在' });
  const canMod = ctx.isOwner || requirePerm(ctx, res, 'task') === null || msg.user_id === req.user.id;
  if (!canMod) return res.status(403).json({ error: '仅本人或管理员可删除' });
  db.prepare('DELETE FROM team_message WHERE id = ?').run(msg.id);
  res.json({ message: '已删除' });
});

// ==================== 资料共享 ====================

// GET /api/team/:id/files — 文件列表
r.get('/:id/files', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const rows = db.prepare(
    `SELECT f.id, f.file_name, f.file_size, f.file_type, f.create_time, u.nickname AS uploader
     FROM team_file f JOIN user u ON u.id = f.user_id
     WHERE f.team_id = ? ORDER BY f.create_time DESC`
  ).all(ctx.team.id);
  res.json(rows);
});

// POST /api/team/:id/file — 上传资料（file_upload 权限；base64 JSON，零依赖）
r.post('/:id/file', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  const deny = requirePerm(ctx, res, 'file_upload');
  if (deny) return deny;
  const { file_name, file_type, data } = req.body || {};
  const name = String(file_name || '').trim();
  if (!name) return res.status(400).json({ error: '文件名必填' });
  if (!data) return res.status(400).json({ error: '文件内容为空' });
  const buf = Buffer.from(String(data), 'base64');
  if (buf.length > MAX_FILE) return res.status(413).json({ error: `文件过大（≤${MAX_FILE / 1024 / 1024}MB）` });
  const rr = db.prepare('INSERT INTO team_file (team_id, user_id, file_name, file_size, file_type, data) VALUES (?,?,?,?,?,?)')
    .run(ctx.team.id, req.user.id, name, buf.length, (file_type || '').trim() || null, buf.toString('base64'));
  res.status(201).json({ id: rr.lastInsertRowid, file_name: name, file_size: buf.length, message: '已上传' });
});

// GET /api/team/file/:fid/download — 下载（返回原始字节流）
r.get('/file/:fid/download', (req, res) => {
  const f = db.prepare('SELECT * FROM team_file WHERE id = ?').get(Number(req.params.fid));
  if (!f) return res.status(404).json({ error: '文件不存在' });
  const ctx = teamCtx(f.team_id, req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  res.setHeader('Content-Type', f.file_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.file_name)}`);
  res.send(Buffer.from(f.data, 'base64'));
});

// DELETE /api/team/:id/file/:fid — 删除（上传者本人或 file_delete 权限）
r.delete('/:id/file/:fid', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const f = db.prepare('SELECT * FROM team_file WHERE id = ? AND team_id = ?').get(Number(req.params.fid), ctx.team.id);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  const canDel = f.user_id === req.user.id || requirePerm(ctx, res, 'file_delete') === null;
  if (!canDel) return res.status(403).json({ error: '仅上传者或「删除资料」权限可删除' });
  db.prepare('DELETE FROM team_file WHERE id = ?').run(f.id);
  res.json({ message: '已删除' });
});

// ==================== 设备预约 ====================

// POST /api/team/:id/device — 添加设备（device 权限）
r.post('/:id/device', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  const deny = requirePerm(ctx, res, 'device');
  if (deny) return deny;
  const { name, spec } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: '设备名必填' });
  const rr = db.prepare('INSERT INTO team_device (team_id, name, spec) VALUES (?,?,?)')
    .run(ctx.team.id, String(name).trim(), (spec || '').trim() || null);
  res.status(201).json({ id: rr.lastInsertRowid, message: '设备已添加' });
});

// DELETE /api/team/:id/device/:did — 删除设备（device 权限）
r.delete('/:id/device/:did', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  const deny = requirePerm(ctx, res, 'device');
  if (deny) return deny;
  const rr = db.prepare('DELETE FROM team_device WHERE id = ? AND team_id = ?').run(Number(req.params.did), ctx.team.id);
  if (rr.changes === 0) return res.status(404).json({ error: '设备不存在' });
  res.json({ message: '设备已删除' });
});

// GET /api/team/:id/bookings — 预约列表（含预约人与审批状态）
r.get('/:id/bookings', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const rows = db.prepare(
    `SELECT b.*, u.nickname AS user_name, d.name AS device_name
     FROM device_booking b JOIN user u ON u.id = b.user_id JOIN team_device d ON d.id = b.device_id
     WHERE b.team_id = ? ORDER BY b.create_time DESC LIMIT 200`
  ).all(ctx.team.id);
  res.json(rows);
});

// POST /api/team/:id/booking — 提交预约（全体成员；时间段冲突检测）
r.post('/:id/booking', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const { device_id, start_time, end_time, purpose } = req.body || {};
  const device = db.prepare('SELECT * FROM team_device WHERE id = ? AND team_id = ?').get(Number(device_id), ctx.team.id);
  if (!device) return res.status(404).json({ error: '设备不存在' });
  if (!start_time || !end_time || start_time >= end_time) {
    return res.status(400).json({ error: '时间区间非法（需 start < end）' });
  }
  const clash = db.prepare(
    `SELECT id FROM device_booking WHERE device_id = ? AND status = 'approved' AND start_time < ? AND end_time > ? LIMIT 1`
  ).get(device.id, end_time, start_time);
  if (clash) return res.status(409).json({ error: '该时段已有已批准的预约，请更换时间' });
  const rr = db.prepare(
    'INSERT INTO device_booking (team_id, device_id, user_id, start_time, end_time, purpose) VALUES (?,?,?,?,?,?)'
  ).run(ctx.team.id, device.id, req.user.id, start_time, end_time, (purpose || '').trim() || null);
  res.status(201).json({ id: rr.lastInsertRowid, message: '预约已提交，等待审批' });
});

// PUT /api/team/:id/booking/:bid — 审批（device_approve 权限）或本人取消
r.put('/:id/booking/:bid', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const booking = db.prepare('SELECT * FROM device_booking WHERE id = ? AND team_id = ?').get(Number(req.params.bid), ctx.team.id);
  if (!booking) return res.status(404).json({ error: '预约不存在' });
  const { status } = req.body || {};
  if (status) { // 审批
    const deny = requirePerm(ctx, res, 'device_approve');
    if (deny) return deny;
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: '状态需为 approved / rejected' });
    if (status === 'approved') {
      const clash = db.prepare(
        `SELECT id FROM device_booking WHERE id != ? AND device_id = ? AND status = 'approved' AND start_time < ? AND end_time > ? LIMIT 1`
      ).get(booking.id, booking.device_id, booking.end_time, booking.start_time);
      if (clash) return res.status(409).json({ error: '审批失败：该时段已有批准的预约' });
    }
    db.prepare("UPDATE device_booking SET status = ? WHERE id = ?").run(status, booking.id);
    res.json({ message: status === 'approved' ? '已批准' : '已驳回' });
  } else { // 本人取消
    if (booking.user_id !== req.user.id && !ctx.isOwner) return res.status(403).json({ error: '仅本人或组长可取消' });
    db.prepare("UPDATE device_booking SET status = 'rejected' WHERE id = ?").run(booking.id);
    res.json({ message: '已取消预约' });
  }
});

export default r;
