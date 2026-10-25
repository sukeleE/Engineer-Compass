// 物料采购申请模块路由（挂载 /api/purchase，整路由需登录）
// 身份三层：学生本人（只看/改自己的）、事件审批人（purchase_event_approver：leader 负责人 / teacher 老师）、
//   is_admin 全权。审批按**比赛/项目档案**分别指定（用户表不加角色列）。
// 状态机：pending 待审批 → approved 已通过·待传发票 → invoiced 已传发票；
//   pending → rejected（驳回，可修改重新提交回 pending）；发票删光 invoiced 退回 approved。
// 文件落盘 backend/uploads/purchase/{rid}/shots|invoices/，DB 只存元数据（lib/purchaseFiles.js 统一清盘）。
import { Router } from 'express';
import multer from 'multer';
import { mkdirSync, existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import db from '../db/database.js';
import { authRequired, logAudit, realNameRequired, displayNameOf, isSuperAdmin } from './middleware.js';
import { callDeepSeek } from './ai.js';
import {
  dirs, MAX_FILE, REQUEST_QUOTA,
  storeNameOf, absPathOf, usedBytes, deleteFile, unlinkQuiet, purgeRequestFiles,
  mimeByExt, isInlineMime, sanitizeName,
} from '../lib/purchaseFiles.js';
import {
  recognizeBomXlsx, recognizeBomCsv, recognizeBomPdf, recognizeBomVision,
} from '../lib/bomVision.js';
import { VisionError } from '../lib/vision.js';
import { PdfInputError } from '../lib/pdfDoc.js';
import { buildPurchaseWorkbook } from '../lib/purchaseExcel.js';

const r = Router();
r.use(authRequired);
r.use(realNameRequired);                       // 实名硬门禁：未实名整个采购模块不可用（管理员不豁免）

const KINDS = new Set(['比赛', '项目']);
const EDITABLE = new Set(['pending', 'rejected']);
const INVOICEABLE = new Set(['approved', 'invoiced']);
const APPROVED_STATES = new Set(['approved', 'invoiced']);
const IMG_EXT = new Set(['jpg', 'jpeg', 'jfif', 'png', 'webp', 'gif', 'bmp']);
const IMG_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
};
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

class HttpError extends Error {
  constructor(status, error) { super(error); this.status = status; }
}
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

// ==================== 通用查询/权限 ====================
const getEvent = (id) => db.prepare('SELECT * FROM purchase_event WHERE id = ?').get(Number(id));
const approverRow = (eventId, userId) => db.prepare(
  'SELECT * FROM purchase_event_approver WHERE event_id = ? AND user_id = ?'
).get(Number(eventId), Number(userId));
const myApproverEventIds = (userId) => new Set(
  db.prepare('SELECT event_id FROM purchase_event_approver WHERE user_id = ?').all(Number(userId)).map((x) => x.event_id)
);
// 审批权：管理员或本档案审批人（leader/teacher 均可，任一通过即生效）
const canApproveEvent = (req, ev) => !!isSuperAdmin(req.user) || !!approverRow(ev.id, req.user.id);
// 成员管理（加/减审批人）：管理员、建档者、本档案 leader
const canManageApprovers = (req, ev) =>
  !!isSuperAdmin(req.user) || ev.created_by === req.user.id || approverRow(ev.id, req.user.id)?.role === 'leader';
// 档案设置（改名/关闭）：仅管理员或建档者
const canManageSettings = (req, ev) => !!isSuperAdmin(req.user) || ev.created_by === req.user.id;

const eventOut = (ev, req) => {
  const row = approverRow(ev.id, req.user.id);
  return {
    id: ev.id, name: ev.name, kind: ev.kind, description: ev.description || '',
    status: ev.status, created_by: ev.created_by, create_time: ev.create_time, close_time: ev.close_time,
    myRole: row?.role || null,
    canApprove: canApproveEvent(req, ev),
    canManage: canManageApprovers(req, ev),
    canSettings: canManageSettings(req, ev),
  };
};

const getRequest = (id) => db.prepare('SELECT * FROM purchase_request WHERE id = ?').get(Number(id));
function canViewRequest(req, rq, ev) {
  return rq.user_id === req.user.id || !!isSuperAdmin(req.user) || canApproveEvent(req, ev);
}

// 明细入参白名单归一（金额一律服务端算；qty/price 范围兜底防呆）
function normItems(arr) {
  if (!Array.isArray(arr)) throw new HttpError(400, '物料明细格式不正确（需要数组）');
  const items = arr.map((x, i) => {
    if (!x || typeof x !== 'object') throw new HttpError(400, `第 ${i + 1} 行明细格式不正确`);
    const name = String(x.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name) throw new HttpError(400, `第 ${i + 1} 行物料名称不能为空`);
    if (name.length > 60) throw new HttpError(400, `第 ${i + 1} 行物料名称过长（≤60 字）`);
    const spec = String(x.spec ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const qty = Number(x.qty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1e6) throw new HttpError(400, `第 ${i + 1} 行数量不正确（大于 0 的数字）`);
    const unit_price = Number(x.unit_price);
    if (!Number.isFinite(unit_price) || unit_price < 0 || unit_price > 1e7) throw new HttpError(400, `第 ${i + 1} 行单价不正确`);
    let link = String(x.link ?? '').trim();
    if (link && !/^https?:\/\//i.test(link)) throw new HttpError(400, `第 ${i + 1} 行购买链接需以 http:// 或 https:// 开头`);
    link = link.slice(0, 300);
    const id = Number.isInteger(Number(x.id)) && Number(x.id) > 0 ? Number(x.id) : null;
    return { id, name, spec, qty: round2(qty), unit_price: round2(unit_price), amount: round2(qty * unit_price), link };
  });
  if (!items.length) throw new HttpError(400, '至少填写一条物料明细');
  if (items.length > 200) throw new HttpError(400, '一次最多 200 条物料');
  return items;
}
const sumAmount = (items) => round2(items.reduce((s, x) => s + x.amount, 0));

// 申请详情聚合（含权限位）；无权访问返回 null（路由对外统一 404，不泄露存在性）
function detailOf(rqId, req) {
  const rq = typeof rqId === 'object' ? rqId : getRequest(rqId);
  if (!rq) return null;
  const ev = getEvent(rq.event_id);
  if (!ev || !canViewRequest(req, rq, ev)) return null;
  const items = db.prepare('SELECT * FROM purchase_item WHERE request_id = ? ORDER BY ord, id').all(rq.id);
  const shots = db.prepare("SELECT * FROM purchase_file WHERE request_id = ? AND kind = 'shot' ORDER BY id").all(rq.id);
  const shotByItem = new Map();
  for (const f of shots) if (!shotByItem.has(f.item_id)) shotByItem.set(f.item_id, f);
  const invoices = db.prepare("SELECT * FROM purchase_file WHERE request_id = ? AND kind = 'invoice' ORDER BY id").all(rq.id);
  // applicant_name/approver_name/log.approver_name 都是落库署名快照（displayNameOf 文本），原样返回
  const logs = db.prepare(
    `SELECT l.* FROM purchase_approval_log l
      WHERE l.request_id = ? ORDER BY l.id`
  ).all(rq.id);
  const owner = rq.user_id === req.user.id;
  return {
    id: rq.id, event_id: rq.event_id, event_name: ev.name, kind: ev.kind,
    user_id: rq.user_id, applicant_name: rq.applicant_name,
    remark: rq.remark || '',
    status: rq.status, amount: rq.amount,
    approver_id: rq.approver_id, approver_name: rq.approver_name || '',
    approver_role: rq.approver_role || '',
    approve_time: rq.approve_time, reject_reason: rq.reject_reason || '', invoice_count: rq.invoice_count,
    submit_time: rq.submit_time, create_time: rq.create_time, update_time: rq.update_time,
    items: items.map((it) => ({
      id: it.id, name: it.name, spec: it.spec, qty: it.qty, unit_price: it.unit_price, amount: it.amount,
      link: it.link || '', shot: fileOut(shotByItem.get(it.id) || null),
    })),
    invoices: invoices.map(fileOut),
    logs: logs.map((l) => ({
      id: l.id, approver_name: l.approver_name,
      role: l.role, result: l.result,
      comment: l.comment || '', create_time: l.create_time,
    })),
    perm: {
      canEdit: owner && EDITABLE.has(rq.status),
      canDelete: owner && EDITABLE.has(rq.status),
      canApprove: (!owner || isSuperAdmin(req.user)) && rq.status === 'pending' && (!!isSuperAdmin(req.user) || !!approverRow(ev.id, req.user.id)),
      canInvoice: owner && INVOICEABLE.has(rq.status),
      isOwner: owner,
      isApprover: canApproveEvent(req, ev),
      isSuperAdmin: !!isSuperAdmin(req.user),
    },
  };
}
function fileOut(f) {
  return f ? { id: f.id, item_id: f.item_id, kind: f.kind, orig_name: f.orig_name,
    mime: f.mime, size: f.size, create_time: f.create_time } : null;
}

// 发票计数 + 状态回退（删光发票：invoiced → approved 待传发票）
function refreshInvoiceState(rid) {
  const n = db.prepare("SELECT COUNT(*) AS n FROM purchase_file WHERE request_id = ? AND kind = 'invoice'").get(rid).n;
  const rq = getRequest(rid);
  if (rq?.status === 'invoiced' && n === 0) {
    db.prepare("UPDATE purchase_request SET invoice_count = 0, status = 'approved', update_time = datetime('now','localtime') WHERE id = ?").run(rid);
  } else {
    db.prepare('UPDATE purchase_request SET invoice_count = ? WHERE id = ?').run(n, rid);
  }
  return n;
}

// ==================== 比赛/项目档案 ====================
// GET /events — open 档案人人可见；closed 仅：建档者/审批人/在该档案有申请的人/管理员
r.get('/events', (req, res) => {
  const rows = db.prepare('SELECT * FROM purchase_event ORDER BY status ASC, id DESC').all();
  const out = [];
  for (const ev of rows) {
    if (ev.status === 'open' || isSuperAdmin(req.user) || ev.created_by === req.user.id
      || approverRow(ev.id, req.user.id)
      || db.prepare('SELECT 1 FROM purchase_request WHERE event_id = ? AND user_id = ?').get(ev.id, req.user.id)) {
      out.push(eventOut(ev, req));
    }
  }
  res.json({ events: out });
});

// POST /events — 建档者自动成为 leader（事务）
r.post('/events', ah((req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name || name.length > 40) throw new HttpError(400, '名称必填且 ≤40 字');
  const kind = KINDS.has(req.body?.kind) ? req.body.kind : '比赛';
  const description = String(req.body?.description ?? '').trim().slice(0, 500);
  if (db.prepare('SELECT 1 FROM purchase_event WHERE name = ?').get(name)) {
    throw new HttpError(409, '已存在同名的比赛/项目档案，请直接选择或换个名称');
  }
  let id;
  db.exec('BEGIN');
  try {
    const info = db.prepare('INSERT INTO purchase_event (name, kind, description, created_by) VALUES (?,?,?,?)')
      .run(name, kind, description, req.user.id);
    id = Number(info.lastInsertRowid);
    db.prepare('INSERT INTO purchase_event_approver (event_id, user_id, role, add_by) VALUES (?,?,?,?)')
      .run(id, req.user.id, 'leader', req.user.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logAudit(req, 'purchase-event-create', name, { event_id: id, kind });
  res.status(201).json({ event: eventOut(getEvent(id), req), message: '建档成功，你已自动成为该档案的负责人' });
}));

// GET /events/:id/approvers
r.get('/events/:id/approvers', (req, res) => {
  const ev = getEvent(req.params.id);
  if (!ev) throw new HttpError(404, '比赛/项目不存在');
  if (!canApproveEvent(req, ev) && !canManageSettings(req, ev)) throw new HttpError(403, '无权查看审批人');
  const rows = db.prepare(
    `SELECT a.user_id, a.role, a.create_time, u.username, u.nickname, u.real_name, u.avatar, e.created_by
       FROM purchase_event_approver a JOIN user u ON u.id = a.user_id
       JOIN purchase_event e ON e.id = a.event_id
      WHERE a.event_id = ? ORDER BY a.role DESC, a.user_id`
  ).all(ev.id);
  res.json({
    approvers: rows.map((x) => ({
      user_id: x.user_id, username: x.username, nickname: x.nickname, real_name: x.real_name || '',
      avatar: x.avatar, role: x.role, is_creator: x.created_by === x.user_id, create_time: x.create_time,
    })),
  });
});

// POST /events/:id/approvers {user_id, role}
r.post('/events/:id/approvers', ah((req, res) => {
  const ev = getEvent(req.params.id);
  if (!ev) throw new HttpError(404, '比赛/项目不存在');
  if (!canManageApprovers(req, ev)) throw new HttpError(403, '仅建档者/负责人/管理员可添加审批人');
  const userId = Number(req.body?.user_id);
  const role = req.body?.role === 'teacher' ? 'teacher' : 'leader';
  const target = db.prepare('SELECT id, username, nickname, status FROM user WHERE id = ?').get(userId);
  if (!target) throw new HttpError(404, '用户不存在');
  if (target.status === 1) throw new HttpError(400, '该账号已被封禁，不能设为审批人');
  const exist = approverRow(ev.id, userId);
  if (exist) {
    if (exist.role === role) return res.json({ message: '该用户已是此身份' });
    db.prepare('UPDATE purchase_event_approver SET role = ? WHERE event_id = ? AND user_id = ?').run(role, ev.id, userId);
  } else {
    db.prepare('INSERT INTO purchase_event_approver (event_id, user_id, role, add_by) VALUES (?,?,?,?)')
      .run(ev.id, userId, role, req.user.id);
  }
  logAudit(req, 'purchase-approver-add', target.nickname || target.username, { event_id: ev.id, target_id: userId, role });
  res.json({ message: `已添加${target.nickname || target.username}为${role === 'teacher' ? '老师' : '负责人'}` });
}));

// DELETE /events/:id/approvers/:uid — 建档者不可移除；至少保留 1 名 leader
r.delete('/events/:id/approvers/:uid', (req, res) => {
  const ev = getEvent(req.params.id);
  if (!ev) throw new HttpError(404, '比赛/项目不存在');
  if (!canManageApprovers(req, ev)) throw new HttpError(403, '仅建档者/负责人/管理员可移除审批人');
  const userId = Number(req.params.uid);
  if (ev.created_by === userId) throw new HttpError(400, '建档者不能被移除（可在档案设置里关闭档案）');
  const exist = approverRow(ev.id, userId);
  if (!exist) throw new HttpError(404, '该用户不是此档案的审批人');
  if (exist.role === 'leader') {
    const leaders = db.prepare("SELECT COUNT(*) AS n FROM purchase_event_approver WHERE event_id = ? AND role = 'leader'").get(ev.id).n;
    if (leaders <= 1) throw new HttpError(400, '至少保留一名负责人');
  }
  db.prepare('DELETE FROM purchase_event_approver WHERE event_id = ? AND user_id = ?').run(ev.id, userId);
  logAudit(req, 'purchase-approver-remove', `user#${userId}`, { event_id: ev.id, target_id: userId, role: exist.role });
  res.json({ message: '已移除' });
});

// PUT /events/:id — 改名/说明/类型/关闭重开（建档者或管理员）
r.put('/events/:id', ah((req, res) => {
  const ev = getEvent(req.params.id);
  if (!ev) throw new HttpError(404, '比赛/项目不存在');
  if (!canManageSettings(req, ev)) throw new HttpError(403, '仅建档者或管理员可修改档案设置');
  const fields = [];
  const vals = [];
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name || name.length > 40) throw new HttpError(400, '名称必填且 ≤40 字');
    const dup = db.prepare('SELECT 1 FROM purchase_event WHERE name = ? AND id != ?').get(name, ev.id);
    if (dup) throw new HttpError(409, '已存在同名档案');
    fields.push('name = ?'); vals.push(name);
  }
  if (req.body?.kind !== undefined) {
    if (!KINDS.has(req.body.kind)) throw new HttpError(400, '类型只能是 比赛/项目');
    fields.push('kind = ?'); vals.push(req.body.kind);
  }
  if (req.body?.description !== undefined) {
    fields.push('description = ?'); vals.push(String(req.body.description).trim().slice(0, 500));
  }
  if (req.body?.status !== undefined) {
    const st = req.body.status === 'closed' ? 'closed' : 'open';
    fields.push('status = ?'); vals.push(st);
    fields.push("close_time = CASE WHEN ? = 'closed' THEN datetime('now','localtime') ELSE NULL END"); vals.push(st);
  }
  if (!fields.length) return res.json({ event: eventOut(getEvent(ev.id), req) });
  vals.push(ev.id);
  db.prepare(`UPDATE purchase_event SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  logAudit(req, 'purchase-event-update', ev.name, { event_id: ev.id, body: req.body });
  res.json({ event: eventOut(getEvent(ev.id), req), message: '已保存' });
}));

// DELETE /events/:id — 删除比赛/项目档案（建档者或超管）；其下仍有申请时拒绝（财务记录不能随档案静默消失）
r.delete('/events/:id', ah((req, res) => {
  const ev = getEvent(req.params.id);
  if (!ev) throw new HttpError(404, '比赛/项目不存在');
  if (!canManageSettings(req, ev)) throw new HttpError(403, '仅建档者或管理员可删除档案');
  const n = db.prepare('SELECT COUNT(*) AS n FROM purchase_request WHERE event_id = ?').get(ev.id).n;
  if (n) throw new HttpError(409, `该${ev.kind}下还有 ${n} 条采购申请，请先删除申请后再删除档案`);
  db.prepare('DELETE FROM purchase_event WHERE id = ?').run(ev.id); // 审批人随 FK CASCADE
  logAudit(req, 'purchase-event-delete', ev.name, { event_id: ev.id });
  res.json({ message: '档案已删除' });
}));

// GET /users/search?q=&event_id= — 添加审批人用（同 friends/search 范式，可排除已是审批人的人）
r.get('/users/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ users: [] });
  const eventId = Number(req.query.event_id);
  const like = `%${q}%`;
  let rows = db.prepare(
    `SELECT id, username, nickname, real_name, avatar FROM user
     WHERE id != ? AND status != 1 AND (username LIKE ? OR nickname LIKE ? OR real_name LIKE ?) ORDER BY id LIMIT 10`
  ).all(req.user.id, like, like, like);
  if (eventId) {
    const have = new Set(
      db.prepare('SELECT user_id FROM purchase_event_approver WHERE event_id = ?').all(eventId).map((x) => x.user_id)
    );
    rows = rows.filter((u) => !have.has(u.id));
  }
  res.json({ users: rows });
});

// ==================== BOM 识别（只读，不落库） ====================
const bomMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE + 1 }, defParamCharset: 'utf8' });
function bomErr(err, req, res, next) {
  if (err instanceof VisionError) return res.status(502).json({ error: err.message, hint: err.hint });
  if (err instanceof PdfInputError) return res.status(400).json({ error: err.message, hint: err.hint });
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件过大（单文件 ≤25MB）' });
    return res.status(400).json({ error: `上传失败：${err.message}` });
  }
  next(err);
}
r.post('/recognize-bom', bomMem.single('file'), ah(async (req, res) => {
  const file = req.file;
  if (!file) throw new HttpError(400, '未收到文件（字段名 file，multipart/form-data）');
  const ext = extname(basename(file.originalname || '')).slice(1).toLowerCase();
  let out;
  if (ext === 'xlsx' || ext === 'xls') out = recognizeBomXlsx(file.buffer);
  else if (ext === 'csv') out = recognizeBomCsv(file.buffer);
  else if (ext === 'pdf') out = await recognizeBomPdf(file.buffer, callDeepSeek);
  else if (IMG_EXT.has(ext)) {
    out = await recognizeBomVision([{ mime: IMG_MIME[ext] || 'image/jpeg', b64: file.buffer.toString('base64') }]);
  } else {
    throw new HttpError(400, '不支持的文件类型（支持 .xlsx/.xls/.csv/.pdf/.jpg/.png 等图片）');
  }
  res.json(out);
}), bomErr);

// ==================== 申请单 ====================
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 列表过滤条件构造（学生强制只看自己；审批人看本档案；管理员全部；mine=1 任何人只看自己）
function listFilter(req) {
  const where = [];
  const params = [];
  const myEvents = myApproverEventIds(req.user.id);
  const mine = String(req.query.mine || '') === '1';
  const isApprover = myEvents.size > 0;
  if (mine || (!isSuperAdmin(req.user) && !isApprover)) {
    where.push('rq.user_id = ?'); params.push(req.user.id);
  } else if (!isSuperAdmin(req.user)) {
    const eid = Number(req.query.event_id);
    if (eid) {
      if (!myEvents.has(eid)) throw new HttpError(403, '你不是该比赛/项目的审批人');
      where.push('rq.event_id = ?'); params.push(eid);
    } else {
      where.push(`rq.event_id IN (${[...myEvents].map(() => '?').join(',')})`);
      params.push(...myEvents);
    }
  } else if (req.query.event_id) {
    where.push('rq.event_id = ?'); params.push(Number(req.query.event_id));
  }
  const status = String(req.query.status || '');
  if (status) {
    if (!/^(pending|approved|invoiced|rejected)$/.test(status)) throw new HttpError(400, '状态筛选不正确');
    where.push('rq.status = ?'); params.push(status);
  }
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (from) {
    if (!DATE_RE.test(from)) throw new HttpError(400, '起始日期格式应为 YYYY-MM-DD');
    where.push("rq.submit_time >= ?"); params.push(`${from} 00:00:00`);
  }
  if (to) {
    if (!DATE_RE.test(to)) throw new HttpError(400, '截止日期格式应为 YYYY-MM-DD');
    where.push("rq.submit_time <= ?"); params.push(`${to} 23:59:59`);
  }
  return { where, params };
}

// GET /requests
r.get('/requests', (req, res) => {
  const { where, params } = listFilter(req);
  // applicant_name/approver_name 为落库署名快照，无需再 JOIN user 取名
  const rows = db.prepare(
    `SELECT rq.*, e.name AS event_name, e.kind AS kind,
            (SELECT COUNT(*) FROM purchase_item it WHERE it.request_id = rq.id) AS item_count
       FROM purchase_request rq JOIN purchase_event e ON e.id = rq.event_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY rq.id DESC LIMIT 500`
  ).all(...params);
  res.json({
    requests: rows.map((x) => ({
      id: x.id, event_id: x.event_id, event_name: x.event_name, kind: x.kind,
      user_id: x.user_id, applicant_name: x.applicant_name,
      remark: x.remark || '',
      status: x.status, amount: x.amount, approver_name: x.approver_name || '',
      approver_role: x.approver_role || '',
      reject_reason: x.reject_reason || '', invoice_count: x.invoice_count, item_count: x.item_count,
      submit_time: x.submit_time, update_time: x.update_time,
    })),
  });
});

// POST /requests
r.post('/requests', ah((req, res) => {
  const ev = getEvent(req.body?.event_id);
  if (!ev) throw new HttpError(404, '请选择比赛/项目');
  if (ev.status !== 'open') throw new HttpError(403, '该比赛/项目已关闭申请，如需采购请联系负责人');
  const items = normItems(req.body?.items);
  const remark = String(req.body?.remark ?? '').trim().slice(0, 300);
  const amount = sumAmount(items);
  const name = displayNameOf(req.user);
  let id;
  db.exec('BEGIN');
  try {
    const info = db.prepare(
      'INSERT INTO purchase_request (event_id, user_id, applicant_name, remark, amount) VALUES (?,?,?,?,?)'
    ).run(ev.id, req.user.id, name, remark, amount);
    id = Number(info.lastInsertRowid);
    const insItem = db.prepare(
      'INSERT INTO purchase_item (request_id, name, spec, qty, unit_price, amount, link, ord) VALUES (?,?,?,?,?,?,?,?)'
    );
    items.forEach((it, i) => insItem.run(id, it.name, it.spec, it.qty, it.unit_price, it.amount, it.link, i));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logAudit(req, 'purchase-request-create', name, { rid: id, event: ev.name, amount });
  res.status(201).json({ detail: detailOf(id, req), message: '申请已提交，等待审批' });
}));

// GET /requests/:id
r.get('/requests/:id', (req, res) => {
  const detail = detailOf(Number(req.params.id), req);
  if (!detail) throw new HttpError(404, '申请不存在或无权查看');
  res.json({ detail });
});

// PUT /requests/:id — 本人在 pending/rejected 全量改明细（带 id 的行保留其截图，其余行连同截图删除）；
//   rejected → 重新提交回 pending（审批轨迹保留，主表旧裁决清空）
r.put('/requests/:id', ah((req, res) => {
  const rq = getRequest(req.params.id);
  if (!rq) throw new HttpError(404, '申请不存在');
  if (rq.user_id !== req.user.id) throw new HttpError(403, '只能修改自己的申请');
  if (!EDITABLE.has(rq.status)) throw new HttpError(400, '已审批的申请不能修改');
  const ev = getEvent(req.body?.event_id ?? rq.event_id);
  if (!ev) throw new HttpError(404, '比赛/项目不存在');
  if (ev.status !== 'open') throw new HttpError(403, '该比赛/项目已关闭申请');
  const items = normItems(req.body?.items);
  const remark = String(req.body?.remark ?? '').trim().slice(0, 300);
  const amount = sumAmount(items);

  const oldIds = new Set(db.prepare('SELECT id FROM purchase_item WHERE request_id = ?').all(rq.id).map((x) => x.id));
  const keepIds = new Set(items.filter((x) => x.id && oldIds.has(x.id)).map((x) => x.id));
  const removed = [...oldIds].filter((x) => !keepIds.has(x));
  const removedShots = removed.length
    ? db.prepare(`SELECT * FROM purchase_file WHERE kind = 'shot' AND item_id IN (${removed.map(() => '?').join(',')})`).all(...removed)
    : [];

  db.exec('BEGIN');
  try {
    if (removed.length) {
      db.prepare(`DELETE FROM purchase_item WHERE request_id = ? AND id IN (${removed.map(() => '?').join(',')})`)
        .run(rq.id, ...removed); // purchase_file 随 FK 级联删库行
    }
    const upd = db.prepare('UPDATE purchase_item SET name=?, spec=?, qty=?, unit_price=?, amount=?, link=?, ord=? WHERE id=? AND request_id=?');
    const ins = db.prepare('INSERT INTO purchase_item (request_id, name, spec, qty, unit_price, amount, link, ord) VALUES (?,?,?,?,?,?,?,?)');
    items.forEach((it, i) => {
      if (it.id && keepIds.has(it.id)) upd.run(it.name, it.spec, it.qty, it.unit_price, it.amount, it.link, i, it.id, rq.id);
      else ins.run(rq.id, it.name, it.spec, it.qty, it.unit_price, it.amount, it.link, i);
    });
    db.prepare(
      `UPDATE purchase_request SET event_id=?, remark=?, amount=?, status='pending',
         approver_id=NULL, approver_name='', approver_role='', approve_time=NULL, reject_reason='',
         submit_time=datetime('now','localtime'), update_time=datetime('now','localtime') WHERE id=?`
    ).run(ev.id, remark, amount, rq.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  removedShots.forEach((f) => unlinkQuiet(absPathOf(f)));
  logAudit(req, 'purchase-request-edit', rq.applicant_name, { rid: rq.id, resubmit: rq.status === 'rejected', amount });
  res.json({ detail: detailOf(rq.id, req), message: rq.status === 'rejected' ? '已重新提交，等待审批' : '申请已更新' });
}));

// DELETE /requests/:id — 本人撤回（仅 pending/rejected）；超级管理员可强删任意状态（含已通过/已传发票）。
//   两种口径都先清盘再删（明细/文件/审批轨迹随库级联）
r.delete('/requests/:id', ah((req, res) => {
  const rq = getRequest(req.params.id);
  if (!rq) throw new HttpError(404, '申请不存在');
  const owner = rq.user_id === req.user.id;
  const admin = !!isSuperAdmin(req.user);
  if (!owner && !admin) throw new HttpError(403, '只能撤回自己的申请');
  if (!admin && !EDITABLE.has(rq.status)) throw new HttpError(400, '已审批的申请不能撤回（如需删除请联系管理员）');
  purgeRequestFiles(rq.id);
  db.prepare('DELETE FROM purchase_request WHERE id = ?').run(rq.id);
  logAudit(req, 'purchase-request-delete', rq.applicant_name,
    { rid: rq.id, by: owner && !admin ? 'self' : 'admin', status: rq.status });
  res.json({ message: owner && !admin ? '申请已撤回' : '申请已删除' });
}));

// 审批通用：仅本档案审批人/管理员；仅 pending；写主表 + 轨迹
function adjudicate(req, res, result, comment) {
  const rq = getRequest(req.params.id);
  if (!rq) throw new HttpError(404, '申请不存在');
  const ev = getEvent(rq.event_id);
  if (!canApproveEvent(req, ev)) throw new HttpError(403, '你不是该比赛/项目的审批人');
  if (rq.user_id === req.user.id && !isSuperAdmin(req.user)) throw new HttpError(403, '不能审批自己提交的申请');
  if (rq.status !== 'pending') throw new HttpError(400, '该申请已审批过了');
  const role = isSuperAdmin(req.user) && !approverRow(ev.id, req.user.id) ? 'leader' : approverRow(ev.id, req.user.id)?.role || 'leader';
  const name = displayNameOf(req.user);
  db.exec('BEGIN');
  try {
    if (result === 'approved') {
      db.prepare(
        `UPDATE purchase_request SET status='approved', approver_id=?, approver_name=?, approver_role=?,
           approve_time=datetime('now','localtime'), reject_reason='', update_time=datetime('now','localtime') WHERE id=?`
      ).run(req.user.id, name, role, rq.id);
    } else {
      db.prepare(
        `UPDATE purchase_request SET status='rejected', approver_id=?, approver_name=?, approver_role=?,
           approve_time=datetime('now','localtime'), reject_reason=?, update_time=datetime('now','localtime') WHERE id=?`
      ).run(req.user.id, name, role, comment, rq.id);
    }
    db.prepare('INSERT INTO purchase_approval_log (request_id, user_id, approver_name, role, result, comment) VALUES (?,?,?,?,?,?)')
      .run(rq.id, req.user.id, name, role, result, comment);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  logAudit(req, `purchase-${result}`, rq.applicant_name, { rid: rq.id, role, comment });
  res.json({ detail: detailOf(rq.id, req), message: result === 'approved' ? '已通过，等待申请人上传发票' : '已驳回' });
}
r.post('/requests/:id/approve', ah((req, res) => {
  const comment = String(req.body?.comment ?? '').trim().slice(0, 200);
  adjudicate(req, res, 'approved', comment);
}));
r.post('/requests/:id/reject', ah((req, res) => {
  const comment = String(req.body?.reason ?? '').trim().slice(0, 200);
  if (!comment) throw new HttpError(400, '驳回时必须填写理由（学生据此修改）');
  adjudicate(req, res, 'rejected', comment);
}));

// ==================== 附件（购买截图 / 发票） ====================
const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) { cb(null, req.uploadDir); },
    filename(req, file, cb) { cb(null, storeNameOf(file.originalname)); },
  }),
  limits: { fileSize: MAX_FILE + 1 }, // busboy 等值即触发 → +1（全站约定）
  defParamCharset: 'utf8',
});
function uploadErr(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件过大（单文件 ≤25MB）' });
    return res.status(400).json({ error: `上传失败：${err.message}` });
  }
  next(err);
}
// 闸门：加载申请 + 权限校验 + 建目录（multer 之前，非法请求不落盘）
function gateFile(kind) {
  return (req, res, next) => {
    try {
      const rq = getRequest(req.params.id);
      if (!rq) return res.status(404).json({ error: '申请不存在' });
      if (rq.user_id !== req.user.id) return res.status(403).json({ error: '只能在自己的申请上传文件' });
      if (kind === 'shot') {
        if (!EDITABLE.has(rq.status)) return res.status(400).json({ error: '当前状态不能上传购买截图（仅待审批/已驳回可改）' });
        const item = db.prepare('SELECT * FROM purchase_item WHERE id = ? AND request_id = ?').get(Number(req.params.iid), rq.id);
        if (!item) return res.status(404).json({ error: '物料行不存在' });
        req.pItem = item;
        req.uploadDir = dirs.shots(rq.id);
      } else {
        if (!INVOICEABLE.has(rq.status)) return res.status(400).json({ error: '申请通过后才能上传发票' });
        req.uploadDir = dirs.invoices(rq.id);
      }
      req.pReq = rq;
      mkdirSync(req.uploadDir, { recursive: true });
      next();
    } catch (e) { next(e); }
  };
}
const finishUpload = (req, res, next) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: '未收到文件（字段名 file，multipart/form-data）' });
    if (file.size === 0) { unlinkQuiet(file.path); return res.status(400).json({ error: '文件为空' }); }
    next();
  } catch (e) { next(e); }
};

// POST /requests/:id/items/:iid/shot — 每物料行一张截图，重传=替换
r.post('/requests/:id/items/:iid/shot', gateFile('shot'), upload.single('file'), finishUpload, (req, res, next) => {
  try {
    const orig = sanitizeName(req.file.originalname, 120);
    const mime = mimeByExt(orig);
    if (!mime.startsWith('image/')) {
      unlinkQuiet(req.file.path);
      return res.status(400).json({ error: '购买截图仅支持图片（jpg/png/webp/gif/bmp）' });
    }
    if (usedBytes(req.pReq.id) + req.file.size > REQUEST_QUOTA) {
      unlinkQuiet(req.file.path);
      return res.status(413).json({ error: '该申请附件空间不足（200MB），请先删除旧附件' });
    }
    const old = db.prepare("SELECT * FROM purchase_file WHERE item_id = ? AND kind = 'shot'").get(req.pItem.id);
    if (old) deleteFile(old);
    const info = db.prepare(
      'INSERT INTO purchase_file (request_id, item_id, kind, orig_name, store_name, mime, size, uploader_id) VALUES (?,?,?,?,?,?,?,?)'
    ).run(req.pReq.id, req.pItem.id, 'shot', orig, basename(req.file.filename), mime, req.file.size, req.user.id);
    logAudit(req, 'purchase-shot-upload', req.pReq.applicant_name, { rid: req.pReq.id, item_id: req.pItem.id });
    res.status(201).json({ file: fileOut(db.prepare('SELECT * FROM purchase_file WHERE id = ?').get(Number(info.lastInsertRowid))) });
  } catch (e) { if (req.file) unlinkQuiet(req.file.path); next(e); }
}, uploadErr);

// POST /requests/:id/invoices — 多张只增；approved → invoiced
r.post('/requests/:id/invoices', gateFile('invoice'), upload.single('file'), finishUpload, (req, res, next) => {
  try {
    const orig = sanitizeName(req.file.originalname, 120);
    const mime = mimeByExt(orig);
    if (!isInlineMime(mime)) {
      unlinkQuiet(req.file.path);
      return res.status(400).json({ error: '发票仅支持 PDF 或图片（jpg/png/webp/gif/bmp）' });
    }
    if (usedBytes(req.pReq.id) + req.file.size > REQUEST_QUOTA) {
      unlinkQuiet(req.file.path);
      return res.status(413).json({ error: '该申请附件空间不足（200MB），请先删除旧附件' });
    }
    const info = db.prepare(
      'INSERT INTO purchase_file (request_id, item_id, kind, orig_name, store_name, mime, size, uploader_id) VALUES (?,?,?,?,?,?,?,?)'
    ).run(req.pReq.id, null, 'invoice', orig, basename(req.file.filename), mime, req.file.size, req.user.id);
    if (req.pReq.status === 'approved') {
      db.prepare("UPDATE purchase_request SET status='invoiced', invoice_count = (SELECT COUNT(*) FROM purchase_file WHERE request_id = ? AND kind='invoice'), update_time=datetime('now','localtime') WHERE id=?").run(req.pReq.id, req.pReq.id);
    } else refreshInvoiceState(req.pReq.id);
    logAudit(req, 'purchase-invoice-upload', req.pReq.applicant_name, { rid: req.pReq.id });
    res.status(201).json({
      file: fileOut(db.prepare('SELECT * FROM purchase_file WHERE id = ?').get(Number(info.lastInsertRowid))),
      status: getRequest(req.pReq.id).status,
    });
  } catch (e) { if (req.file) unlinkQuiet(req.file.path); next(e); }
}, uploadErr);

// GET /files/:fid — 申请人/本档案审批人/管理员；图片·PDF 内联，其余附件下载
r.get('/files/:fid', (req, res) => {
  const f = db.prepare('SELECT * FROM purchase_file WHERE id = ?').get(Number(req.params.fid));
  if (!f) return res.status(404).json({ error: '文件不存在' });
  const rq = getRequest(f.request_id);
  const ev = rq && getEvent(rq.event_id);
  if (!rq || !ev || !canViewRequest(req, rq, ev)) return res.status(404).json({ error: '文件不存在' });
  const abs = absPathOf(f);
  if (!existsSync(abs)) return res.status(404).json({ error: '文件已丢失' });
  if (isInlineMime(f.mime) && req.query.dl !== '1') return res.sendFile(abs);
  res.download(abs, f.orig_name);
});

// DELETE /files/:fid — 截图：本人可编辑态；发票：本人 approved/invoiced 或管理员
r.delete('/files/:fid', (req, res) => {
  const f = db.prepare('SELECT * FROM purchase_file WHERE id = ?').get(Number(req.params.fid));
  if (!f) throw new HttpError(404, '文件不存在');
  const rq = getRequest(f.request_id);
  if (!rq) throw new HttpError(404, '文件不存在');
  if (f.kind === 'shot') {
    if (rq.user_id !== req.user.id) throw new HttpError(403, '只能删除自己申请的截图');
    if (!EDITABLE.has(rq.status)) throw new HttpError(400, '当前状态不能删除截图');
  } else {
    const isAdmin = !!isSuperAdmin(req.user);
    const isOwner = rq.user_id === req.user.id && INVOICEABLE.has(rq.status);
    if (!isAdmin && !isOwner) throw new HttpError(403, '无权删除该发票');
  }
  deleteFile(f);
  if (f.kind === 'invoice') refreshInvoiceState(rq.id);
  logAudit(req, 'purchase-file-delete', rq.applicant_name, { rid: rq.id, kind: f.kind, fid: f.id });
  res.json({ message: '已删除', status: getRequest(rq.id)?.status || rq.status });
});

// ==================== 统计 / 导出 ====================
// 复用列表过滤取申请行（统计/导出共用）；调用方必须保证有审批权或带 mine
function queryRequests(req) {
  const { where, params } = listFilter(req);
  return db.prepare(
    `SELECT rq.*, e.name AS event_name, e.kind AS kind
       FROM purchase_request rq JOIN purchase_event e ON e.id = rq.event_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY rq.id DESC LIMIT 1000`
  ).all(...params);
}

// GET /stats — 审批人/管理员（学生走 mine=1 个人统计也允许）
r.get('/stats', (req, res) => {
  const mine = String(req.query.mine || '') === '1';
  if (!mine && !isSuperAdmin(req.user) && !myApproverEventIds(req.user.id).size) {
    throw new HttpError(403, '仅审批人可查看整体统计');
  }
  const rows = queryRequests(req);
  const byEvent = new Map();
  const byUser = new Map();
  const byStatus = {
    pending: { count: 0, amount: 0 }, approved: { count: 0, amount: 0 },
    invoiced: { count: 0, amount: 0 }, rejected: { count: 0, amount: 0 },
  };
  for (const x of rows) {
    if (!byEvent.has(x.event_id)) byEvent.set(x.event_id, {
      event_id: x.event_id, name: x.event_name, kind: x.kind,
      count: 0, approved_amount: 0, pending_amount: 0, rejected_amount: 0, invoice_pending: 0,
    });
    const g = byEvent.get(x.event_id);
    g.count += 1;
    if (!byUser.has(x.user_id)) byUser.set(x.user_id, { user_id: x.user_id, name: x.applicant_name, count: 0, approved_amount: 0, invoice_pending: 0 });
    const u = byUser.get(x.user_id);
    u.count += 1;
    byStatus[x.status]?.count !== undefined && (byStatus[x.status].count += 1, byStatus[x.status].amount += x.amount);
    if (APPROVED_STATES.has(x.status)) {
      g.approved_amount = round2(g.approved_amount + x.amount);
      u.approved_amount = round2(u.approved_amount + x.amount);
    } else if (x.status === 'pending') {
      g.pending_amount = round2(g.pending_amount + x.amount);
    } else if (x.status === 'rejected') {
      g.rejected_amount = round2(g.rejected_amount + x.amount);
    }
    if (x.status === 'approved') { g.invoice_pending += 1; u.invoice_pending += 1; }
  }
  // by_user.name 取申请时署名快照（displayNameOf 文本），原样输出即可，不再补实时 real_name
  res.json({
    total: rows.length,
    total_amount: round2(rows.reduce((s, x) => s + (APPROVED_STATES.has(x.status) ? x.amount : 0), 0)),
    by_event: [...byEvent.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh')),
    by_user: [...byUser.values()].sort((a, b) => b.approved_amount - a.approved_amount),
    by_status: byStatus,
  });
});

// GET /export.xlsx — 与列表同权限/筛选（学生可导自己 mine=1）
r.get('/export.xlsx', (req, res) => {
  const rows = queryRequests(req);
  const details = rows.map((rq) => detailOf(rq, req));
  const buf = buildPurchaseWorkbook(details);
  const parts = [];
  if (req.query.event_id) parts.push(String(rows[0]?.event_name || 'event'));
  if (req.query.from || req.query.to) parts.push(`${req.query.from || '起'}_${req.query.to || '今'}`);
  parts.push(new Date().toISOString().slice(0, 10));
  const fname = `物料采购_${parts.join('_')}.xlsx`;
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="purchase.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(buf);
});

// HttpError → JSON（其余交 server.js 全局兜底）
r.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  next(err);
});

export default r;
