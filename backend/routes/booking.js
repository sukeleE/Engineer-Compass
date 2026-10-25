// 资源预约模块路由（挂载 /api/booking，整路由需登录）
// 与小组域 team_device/device_booking 设备预约完全独立，互不影响。
// 身份两层：建档者=项目负责人（管资源/组队/审批/取消），超级管理员全权；任何登录用户可建档/浏览开放项目/下单。
// 审批为**资源级**开关：approve_mode=first_come 创建即确认（冲突即拒）；approval 走 pending→confirmed/rejected。
// 时间口径：start_time/end_time 为北京时间朴素串 'YYYY-MM-DD HH:MM'，定宽字符串直接半开区间字典序比较，
//   全链路禁止 toLocal 补 Z（否则再差 8 小时）。30 分钟一格，每日开放 07:00–22:00，可跨天连续占用（最长 7 天）。
import { Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { basename, extname } from 'node:path';
import db from '../db/database.js';
import { authRequired, logAudit, realNameRequired, displayNameOf, isSuperAdmin, hasAdminPerm } from './middleware.js';
import {
  BookingImportError, recognizeBookingXlsx, recognizeBookingCsv, buildBookingTemplate,
  BOOKING_IMPORT_LIMIT_BYTES,
} from '../lib/bookingImport.js';

const r = Router();
r.use(authRequired);
// 实名硬门禁：未实名整个预约模块不可用（管理员也不豁免）。
// 唯一例外 POST /projects/:id/conflicts：弹窗内 400ms 防抖的实时冲突校验，只回时间冲突不泄密，
// 避免任何边界场景下未实名页面刷出 403 噪音。
r.use((req, res, next) => (
  req.method === 'POST' && /^\/projects\/\d+\/conflicts\/?$/.test(req.path)
    ? next()
    : realNameRequired(req, res, next)
));

class HttpError extends Error {
  constructor(status, error) { super(error); this.status = status; }
}
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

const tx = (fn) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 连接已回滚 */ }
    throw e;
  }
};

// ==================== 常量 ====================
const KIND_META = {
  item: { label: '物品资源', space: false, icon: '📦' },
  space: { label: '空间资源', space: true, icon: '🏢' },
};
const KINDS = new Set(Object.keys(KIND_META));
const SPACE_KINDS = new Set(['space']);
const MODES = new Set(['approval', 'first_come']);
const BLOCKING = ['pending', 'confirmed']; // pending 即占位
const OPEN_MIN = 7 * 60;          // 07:00
const CLOSE_MIN = 22 * 60;        // 22:00
const SLOT_MS = 30 * 60 * 1000;
const MAX_SPAN_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_HEADCOUNT = 100;
const MAX_TEAM_MEMBERS = 30;

// 表格导入：内存缓冲（不落盘），单文件 ≤10MB
const importMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BOOKING_IMPORT_LIMIT_BYTES, files: 1 },
  defParamCharset: 'utf8',
}).single('file');

const p2 = (n) => String(n).padStart(2, '0');
const nowSlot = () => {
  const n = new Date();
  return `${n.getFullYear()}-${p2(n.getMonth() + 1)}-${p2(n.getDate())} ${p2(n.getHours())}:${p2(n.getMinutes())}`;
};

// ==================== 时间窗（UTC Date 仅做墙上时钟算术，不做任何时区换算） ====================
const SLOT_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
function parseSlot(s) {
  const m = SLOT_RE.exec(String(s ?? ''));
  if (!m) return null;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  // 拒绝 2026-02-30 这类自动进位的假日期
  if (dt.getUTCFullYear() !== +m[1] || dt.getUTCMonth() !== +m[2] - 1 || dt.getUTCDate() !== +m[3]
    || dt.getUTCHours() !== +m[4] || dt.getUTCMinutes() !== +m[5]) return null;
  return dt;
}
const fmtSlot = (dt) =>
  `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())} ${p2(dt.getUTCHours())}:${p2(dt.getUTCMinutes())}`;
function* slotIter(start, end) {
  for (let t = start.getTime(); t < end.getTime(); t += SLOT_MS) yield new Date(t);
}

// 校验并返回 {start:Date, end:Date}；非法一律 400 且带具体原因
function validateSlotWindow(startStr, endStr) {
  const start = parseSlot(startStr);
  const end = parseSlot(endStr);
  if (!start || !end) throw new HttpError(400, '时间格式应为 YYYY-MM-DD HH:MM');
  for (const s of [startStr, endStr]) {
    const min = s.slice(14);
    if (min !== '00' && min !== '30') throw new HttpError(400, '时间须为 30 分钟整数倍');
  }
  if (!(end.getTime() > start.getTime())) throw new HttpError(400, '结束时间必须晚于开始时间');
  if (startStr < nowSlot()) throw new HttpError(400, '开始时间不能早于当前时间');
  if (end.getTime() - start.getTime() > MAX_SPAN_MS) throw new HttpError(400, '最长连续预约 7 天');

  const sMin = start.getUTCHours() * 60 + start.getUTCMinutes();
  const eMin = end.getUTCHours() * 60 + end.getUTCMinutes();
  const sameDay = start.toDateString() === end.toDateString();
  if (sameDay) {
    if (sMin < OPEN_MIN) throw new HttpError(400, '开放时段为每天 07:00–22:00');
    if (eMin > CLOSE_MIN) throw new HttpError(400, '结束时间不能晚于 22:00');
  } else {
    // 跨天连续占用：首日 07:00–21:30 起，末日 07:00–22:00 止，中间完整自然日 24h 不限
    if (sMin < OPEN_MIN || sMin > CLOSE_MIN - 30) throw new HttpError(400, '首日开始时间须在 07:00–21:30 之间');
    if (eMin < OPEN_MIN || eMin > CLOSE_MIN) throw new HttpError(400, '末日结束时间须在 07:00–22:00 之间');
  }
  return { start, end };
}

// ==================== 通用查询/权限 ====================
const getProject = (id) => db.prepare('SELECT * FROM booking_project WHERE id = ?').get(Number(id));
const getResource = (id) => db.prepare('SELECT * FROM booking_resource WHERE id = ?').get(Number(id));
const getBooking = (id) => db.prepare('SELECT * FROM booking WHERE id = ?').get(Number(id));
const getTeam = (id) => db.prepare('SELECT * FROM booking_team WHERE id = ?').get(Number(id));

const canManageProject = (req, p) => !!isSuperAdmin(req.user) || p.created_by === req.user.id;
// 开放项目所有登录用户可见；关闭项目仅负责人/管理员/在该项目有预约者可见
function canViewProject(req, p) {
  if (!p) return false;
  if (p.status === 'open') return true;
  if (canManageProject(req, p)) return true;
  return !!db.prepare(
    `SELECT 1 FROM booking b WHERE b.project_id = ?
      AND (b.booker_id = ? OR EXISTS (SELECT 1 FROM booking_participant bp WHERE bp.booking_id = b.id AND bp.user_id = ?))
     LIMIT 1`
  ).get(p.id, req.user.id, req.user.id);
}
function requireViewProject(req, p) {
  if (!canViewProject(req, p)) throw new HttpError(404, '项目不存在');
}

const resourceOut = (rs) => {
  let params = {};
  try { params = JSON.parse(rs.params || '{}'); } catch { params = {}; }
  return {
    id: rs.id, project_id: rs.project_id, kind: rs.kind, is_space: !!rs.is_space,
    kind_label: KIND_META[rs.kind]?.label || rs.kind, icon: KIND_META[rs.kind]?.icon || '📦',
    name: rs.name, spec: rs.spec || '', location: rs.location || '',
    capacity: rs.capacity, quantity: rs.quantity, unit: rs.unit || '',
    image: rs.image || '', damaged_qty: rs.damaged_qty || 0,
    params, approve_mode: rs.approve_mode, status: rs.status,
    is_carrier: !!rs.is_carrier,
    created_by: rs.created_by, create_time: rs.create_time, update_time: rs.update_time,
  };
};

function projectOut(p, req) {
  const resourceCount = db.prepare(
    "SELECT COUNT(*) AS n FROM booking_resource WHERE project_id = ? AND status = 'active' AND is_carrier = 0"
  ).get(p.id).n;
  const pendingCount = db.prepare(
    "SELECT COUNT(*) AS n FROM booking WHERE project_id = ? AND status = 'pending'"
  ).get(p.id).n;
  const myCount = db.prepare(
    `SELECT COUNT(*) AS n FROM booking b WHERE b.project_id = ?
      AND (b.booker_id = ? OR EXISTS (SELECT 1 FROM booking_participant bp WHERE bp.booking_id = b.id AND bp.user_id = ?))`
  ).get(p.id, req.user.id, req.user.id).n;
  const creator = p.created_by
    ? db.prepare('SELECT nickname, username, real_name FROM user WHERE id = ?').get(p.created_by)
    : null;
  return {
    id: p.id, name: p.name, description: p.description || '',
    default_approve_mode: p.default_approve_mode, status: p.status,
    created_by: p.created_by, creator_name: creator ? displayNameOf(creator) : '',
    create_time: p.create_time, close_time: p.close_time,
    myRole: p.created_by === req.user.id ? 'owner' : null,
    canManage: canManageProject(req, p),
    resource_count: resourceCount, pending_count: pendingCount, my_booking_count: myCount,
  };
}

// ==================== 入参归一 ====================
const trim = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
function normMode(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback || 'approval';
  if (!MODES.has(String(v))) throw new HttpError(400, '审批模式不合法');
  return String(v);
}
function normResourceBody(kind, body, fallbackMode) {
  if (!KINDS.has(String(kind))) throw new HttpError(400, '资源类型不合法（物品资源/空间资源）');
  const isSpace = SPACE_KINDS.has(kind);
  const name = trim(body.name);
  if (!name) throw new HttpError(400, '资源名称不能为空');
  if (name.length > 30) throw new HttpError(400, '资源名称过长（≤30 字）');
  if (name === REGISTRATION_CARRIER_NAME) throw new HttpError(400, '「借用登记」是系统占位名称，请换一个资源名称');
  const spec = trim(body.spec).slice(0, 40);
  const location = trim(body.location).slice(0, 60);
  const approve_mode = normMode(body.approve_mode, fallbackMode);

  let capacity = null, quantity = 1, unit = '';
  let damaged_qty = 0;
  const params = {};
  // 物品/空间都可拍一张实物/现场照（可选）；损坏数量仍是物品专属
  const image = typeof body.image === 'string' ? body.image.slice(0, 400000) : '';
  if (isSpace) {
    capacity = Number(body.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 9999)
      throw new HttpError(400, '空间资源须填写可容纳人数（1–9999 整数）');
    if (Array.isArray(body.params?.equipment) || Array.isArray(body.equipment)) {
      const list = (body.params?.equipment ?? body.equipment ?? [])
        .map((x) => trim(x)).filter(Boolean).slice(0, 20);
      for (const e of list) if (e.length > 20) throw new HttpError(400, '单项设备名称过长（≤20 字）');
      if (list.length) params.equipment = list;
    }
  } else {
    quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999)
      throw new HttpError(400, '物品库存须为 1–9999 的整数');
    unit = trim(body.unit).slice(0, 8);
    damaged_qty = body.damaged_qty === undefined || body.damaged_qty === '' ? 0 : Number(body.damaged_qty);
    if (!Number.isInteger(damaged_qty) || damaged_qty < 0 || damaged_qty > quantity)
      throw new HttpError(400, `损坏数量须为 0–${quantity} 的整数`);
  }
  return { kind, isSpace: isSpace ? 1 : 0, name, spec, location, capacity, quantity, unit, image, damaged_qty, params: JSON.stringify(params), approve_mode };
}

// 取参与人：solo=仅本人；team=本人为队长的组队当前成员展开；custom=临时 id 列表（本人强制并入）
// 返回 {source, team_id, users:[{id,user_name}], headcount}
function normParticipants(projectId, body, me) {
  const source = ['solo', 'team', 'custom'].includes(body.source) ? body.source : 'solo';
  const idSet = new Set([me.id]);
  let teamId = null;
  if (source === 'team') {
    teamId = Number(body.team_id);
    if (!teamId) throw new HttpError(400, '请选择固定组队');
    const team = getTeam(teamId);
    if (!team || team.project_id !== projectId) throw new HttpError(400, '组队不存在或不属于本项目');
    if (team.owner_id !== me.id && !isSuperAdmin(me)) throw new HttpError(403, '只有队长可以用该组队预约');
    for (const m of db.prepare('SELECT user_id FROM booking_team_member WHERE team_id = ?').all(teamId)) idSet.add(m.user_id);
  } else if (source === 'custom') {
    if (!Array.isArray(body.participant_ids)) throw new HttpError(400, '请选择参与人');
    for (const x of body.participant_ids) {
      const id = Number(x);
      if (Number.isInteger(id) && id > 0) idSet.add(id);
    }
  }
  if (idSet.size > MAX_HEADCOUNT) throw new HttpError(400, `单次预约最多 ${MAX_HEADCOUNT} 人`);

  const ids = [...idSet];
  const users = db.prepare(
    `SELECT id, username, nickname, real_name, status FROM user WHERE id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
  if (users.length !== ids.length) throw new HttpError(400, '参与人中包含不存在的账号');
  if (users.some((u) => u.status === 1)) throw new HttpError(400, '参与人中包含已封禁账号');
  return {
    source, team_id: teamId, headcount: users.length,
    users: users.map((u) => ({ id: u.id, user_name: displayNameOf(u) })),
  };
}

// ==================== 冲突检测（必须在 BEGIN IMMEDIATE 事务内调用） ====================
// 返回冲突数组：空间为重叠单（capacity=1），物品为首个超库存的格
function findConflicts(resource, startStr, endStr, needQty, excludeId = 0) {
  const conflicts = [];
  if (resource.is_space) {
    const rows = db.prepare(
      `SELECT id, start_time, end_time, booker_name, headcount FROM booking
        WHERE resource_id = ? AND status IN ('pending','confirmed') AND id IS NOT ?
          AND start_time < ? AND end_time > ? ORDER BY start_time LIMIT 5`
    ).all(resource.id, excludeId, endStr, startStr);
    for (const row of rows) {
      conflicts.push({ booking_id: row.id, start_time: row.start_time, end_time: row.end_time,
        booker_name: row.booker_name, used: 1, capacity: 1, headcount: row.headcount });
    }
  } else {
    const q = db.prepare(
      `SELECT COALESCE(SUM(qty), 0) AS used FROM booking
        WHERE resource_id = ? AND status IN ('pending','confirmed') AND id IS NOT ?
          AND start_time < ? AND end_time > ?`
    );
    const { start, end } = validateSlotWindow(startStr, endStr);
    for (const t of slotIter(start, end)) {
      const ts = fmtSlot(t);
      const te = fmtSlot(new Date(t.getTime() + SLOT_MS));
      const used = q.get(resource.id, excludeId, te, ts).used;
      if (used + needQty > resource.quantity) {
        conflicts.push({ start_time: ts, end_time: te, used, capacity: resource.quantity });
        break;
      }
    }
  }
  return conflicts;
}

// 资源容量/库存下调复检：只看尚未结束的占用单
function shrinkCheck(resource, newCap, newQty) {
  const now = nowSlot();
  const rows = db.prepare(
    `SELECT id, start_time, end_time, qty, headcount FROM booking
      WHERE resource_id = ? AND status IN ('pending','confirmed') AND end_time > ?`
  ).all(resource.id, now);
  if (resource.is_space) {
    const maxHead = rows.reduce((m, x) => Math.max(m, x.headcount), 0);
    if (newCap < maxHead) throw new HttpError(409, `容量不能低于现存预约的最大人数（${maxHead} 人），请先处理相关预约`);
  } else {
    for (const row of rows) {
      const start = parseSlot(row.start_time);
      const end = parseSlot(row.end_time);
      for (const t of slotIter(start, end)) {
        const ts = fmtSlot(t), te = fmtSlot(new Date(t.getTime() + SLOT_MS));
        const used = db.prepare(
          `SELECT COALESCE(SUM(qty),0) AS u FROM booking
            WHERE resource_id = ? AND status IN ('pending','confirmed')
              AND start_time < ? AND end_time > ?`
        ).get(resource.id, te, ts).u;
        if (used > newQty) throw new HttpError(409, `库存不能低于现存预约的峰值占用（${used} ${resource.unit || '件'}），请先处理相关预约`);
      }
    }
  }
}

// ==================== 通知（personal_notice；COMMIT 之后调用，失败不影响主流程） ====================
function notify(userIds, type, title, content, link) {
  const ids = [...new Set(userIds.filter((x) => x))];
  if (!ids.length) return;
  try {
    const exists = db.prepare('SELECT 1 FROM personal_notice WHERE user_id = ? AND type = ? AND is_read = 0');
    const ins = db.prepare('INSERT INTO personal_notice (user_id, type, title, content, link) VALUES (?,?,?,?,?)');
    for (const uid of ids) {
      if (exists.get(uid, type)) continue; // 同单同动作未读去重
      ins.run(uid, type, title, content, link);
    }
  } catch { /* 通知失败不影响预约主流程 */ }
}
const bookingLink = (pId, b) => `/booking/${pId}?bid=${b.id}&date=${b.start_time.slice(0, 10)}`;

// ==================== 借用登记（任意预约项目通用：拍照快速登记设备 / 教室） ====================
// 没有台账的物品/教室只做一次性登记：拍照 + 名称（物品名 / 教室编号）+ 姓名 + 学号，时间按提交时刻记录。
// 登记写 booking（item_kind/item_name/item_image，start=end=now，confirmed），由每项目一个的占位资源
// 承载 resource_id 非空约束；占位资源 is_carrier=1，不进资源列表 / 甘特 / 统计，也不参与库存与冲突检测。
const REGISTRATION_CARRIER_NAME = '借用登记';
const REG_KINDS = {
  device: { label: '设备', nameRequired: '请填写所借物品名称', nameOverflow: '物品名称过长（≤40 字）', imageRequired: '请拍摄或上传所借物品照片', action: '设备借用登记' },
  room: { label: '教室', nameRequired: '请填写所借教室编号', nameOverflow: '教室编号过长（≤40 字）', imageRequired: '请拍摄或上传教室内环境照片', action: '教室借用登记' },
};

// 幂等取得本项目的登记占位资源（老库按名兜底，并补打 is_carrier 标记）
function ensureRegistrationCarrier(p) {
  let rs = db.prepare('SELECT * FROM booking_resource WHERE project_id = ? AND is_carrier = 1').get(p.id);
  if (!rs) rs = db.prepare('SELECT * FROM booking_resource WHERE project_id = ? AND name = ?').get(p.id, REGISTRATION_CARRIER_NAME);
  if (rs && !rs.is_carrier) {
    db.prepare('UPDATE booking_resource SET is_carrier = 1 WHERE id = ?').run(rs.id);
    rs = getResource(rs.id);
  }
  if (!rs) {
    const info = db.prepare(
      `INSERT INTO booking_resource (project_id, kind, is_space, name, quantity, unit, approve_mode, params, is_carrier, created_by)
       VALUES (?,?,?,?,?,?,?,?,1,?)`
    ).run(p.id, 'item', 0, REGISTRATION_CARRIER_NAME, 999999, '件', 'first_come', '{}', p.created_by);
    rs = getResource(info.lastInsertRowid);
  }
  return rs;
}

const assertNotCarrier = (rs) => {
  if (rs?.is_carrier) throw new HttpError(400, '该资源是借用登记的系统占位资源，不能修改或删除');
};

r.post('/projects/:id/borrow-registrations', ah((req, res) => {
  const p = getProject(req.params.id);
  requireViewProject(req, p);
  if (p.status === 'closed') throw new HttpError(403, '项目已关闭，暂时不能登记');
  const kind = REG_KINDS[String(req.body?.kind || '')] ? String(req.body.kind) : 'device';
  const meta = REG_KINDS[kind];
  const itemName = trim(req.body?.item_name);
  if (!itemName) throw new HttpError(400, meta.nameRequired);
  if (itemName.length > 40) throw new HttpError(400, meta.nameOverflow);
  const image = String(req.body?.item_image || '');
  if (!image.startsWith('data:image/')) throw new HttpError(400, meta.imageRequired);
  if (image.length > 400000) throw new HttpError(400, '照片过大，请重新拍摄');
  // 缩略图只用于列表展示（原图最大 40 万字符），缺失时留空不影响登记
  const thumb = String(req.body?.item_thumb || '');
  const itemThumb = thumb.startsWith('data:image/') && thumb.length <= 60000 ? thumb : '';
  const now = nowSlot();
  const purpose = trim(req.body?.purpose).slice(0, 200);

  const bId = tx(() => {
    const rs = ensureRegistrationCarrier(p);
    const info = db.prepare(
      `INSERT INTO booking (project_id, resource_id, start_time, end_time, qty, headcount, purpose,
         status, source, booker_id, booker_name, booker_student_no, item_kind, item_name, item_image, item_thumb)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(p.id, rs.id, now, now, 1, 1, purpose, 'confirmed', 'solo',
      req.user.id, displayNameOf(req.user), req.user.student_no || '', kind, itemName, image, itemThumb);
    db.prepare('INSERT INTO booking_participant (booking_id, user_id, user_name, is_booker, ord) VALUES (?,?,?,?,?)')
      .run(info.lastInsertRowid, req.user.id, displayNameOf(req.user), 1, 0);
    db.prepare('INSERT INTO booking_log (booking_id, action, actor_id, actor_name, comment) VALUES (?,?,?,?,?)')
      .run(info.lastInsertRowid, 'created', req.user.id, displayNameOf(req.user), meta.action);
    return info.lastInsertRowid;
  });
  logAudit(req, 'booking-borrow-register', `${p.name}/${itemName}`, { booking_id: bId, kind });
  res.status(201).json({ booking: bookingOut(getBooking(bId), req), message: `${meta.label}借用登记成功` });
}));

// ==================== 借用记录（借用记录管理员：跨项目全局查看 / 导出） ====================
// 独立管理页用：跨全部项目、全部学生的设备/教室登记全局列表 + 统计 + Excel 导出；需「借用记录」权限。
const REC_STATUS = { pending: '待审批', confirmed: '已确认', rejected: '已驳回', canceled: '已取消' };
const REC_KIND = { device: '设备', room: '教室' };

// 不看 canManageProject —— 登记分散在学生自建的任意项目里，项目建档者不等于借用管理员
function requireLabAdmin(req) {
  if (!hasAdminPerm(req.user, 'lab')) throw new HttpError(403, '需要「借用记录」管理权限');
}

// 全局筛选：project_id / kind（设备/教室）/ status / from~to（登记日期，含端点）/ q（物品名、教室编号、姓名、学号）
function borrowRecordsWhere(req) {
  const where = ["b.item_kind IN ('device','room')"];
  const vals = [];
  const projectId = Number(req.query.project_id) || 0;
  if (projectId) { where.push('b.project_id = ?'); vals.push(projectId); }
  const kind = String(req.query.kind || '');
  if (kind === 'device' || kind === 'room') { where.push('b.item_kind = ?'); vals.push(kind); }
  const status = String(req.query.status || '');
  if (REC_STATUS[status]) { where.push('b.status = ?'); vals.push(status); }
  const from = String(req.query.from || ''), to = String(req.query.to || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { where.push('b.start_time >= ?'); vals.push(from); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { where.push('b.start_time <= ?'); vals.push(`${to} 23:59`); }
  const q = trim(req.query.q).slice(0, 40);
  if (q) {
    where.push('(b.item_name LIKE ? OR b.booker_name LIKE ? OR b.booker_student_no LIKE ? OR p.name LIKE ?)');
    vals.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  return { where: where.join(' AND '), vals };
}

// 列表只回缩略图（原图最大 40 万字符，几十条就传不动）；点开单条再取原图
const borrowRecordOut = (b) => ({
  id: b.id, kind: b.item_kind, item_name: b.item_name || '', item_thumb: b.item_thumb || '',
  has_image: !!b.item_image, project_id: b.project_id, project_name: b.project_name || '',
  booker_id: b.booker_id, booker_name: b.booker_name || '',
  booker_student_no: b.booker_student_no || '', start_time: b.start_time,
  status: b.status, purpose: b.purpose || '',
});

r.get('/borrow-records', ah((req, res) => {
  requireLabAdmin(req);
  const { where, vals } = borrowRecordsWhere(req);
  const rows = db.prepare(
    `SELECT b.*, p.name AS project_name FROM booking b
       JOIN booking_project p ON p.id = b.project_id
      WHERE ${where} ORDER BY b.start_time DESC, b.id DESC LIMIT 500`
  ).all(...vals);
  const matched = db.prepare(
    `SELECT COUNT(*) AS n FROM booking b JOIN booking_project p ON p.id = b.project_id WHERE ${where}`
  ).get(...vals).n;

  const all = db.prepare(
    `SELECT b.status, b.item_kind, b.start_time, b.booker_id, b.booker_student_no
       FROM booking b JOIN booking_project p ON p.id = b.project_id WHERE ${where}`
  ).all(...vals);
  const today = nowSlot().slice(0, 10);
  const stats = {
    total: all.length,
    device: all.filter((x) => x.item_kind === 'device').length,
    room: all.filter((x) => x.item_kind === 'room').length,
    today: all.filter((x) => x.start_time.slice(0, 10) === today).length,
    people: new Set(all.map((x) => x.booker_student_no || `uid:${x.booker_id}`)).size,
  };
  res.json({ records: rows.map(borrowRecordOut), stats, matched });
}));

// 导出 Excel：与列表同一套筛选，列固定（照片是附件，不塞进表格，避免文件几十 MB）
r.get('/borrow-records/export', ah((req, res) => {
  requireLabAdmin(req);
  const { where, vals } = borrowRecordsWhere(req);
  const rows = db.prepare(
    `SELECT b.*, p.name AS project_name FROM booking b
       JOIN booking_project p ON p.id = b.project_id
      WHERE ${where} ORDER BY b.start_time DESC, b.id DESC LIMIT 5000`
  ).all(...vals);

  const aoa = [['序号', '所属项目', '类型', '借用物品 / 教室', '姓名', '学号', '登记时间', '状态', '备注']];
  rows.forEach((b, i) => aoa.push([
    i + 1, b.project_name || '', REC_KIND[b.item_kind] || '', b.item_name || '', b.booker_name || '',
    b.booker_student_no || '', b.start_time, REC_STATUS[b.status] || b.status, b.purpose || '',
  ]));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 6 }, { wch: 18 }, { wch: 8 }, { wch: 24 }, { wch: 14 }, { wch: 16 }, { wch: 18 }, { wch: 10 }, { wch: 24 }];
  ws['!autofilter'] = { ref: `A1:I${aoa.length}` };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '借用记录');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const fname = `借用记录-${nowSlot().slice(0, 10)}.xlsx`;
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="borrow-records.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(buf);
}));

r.get('/projects', ah((req, res) => {
  const scope = ['mine', 'managed'].includes(String(req.query.scope)) ? String(req.query.scope) : 'all';
  let ps = db.prepare('SELECT * FROM booking_project ORDER BY id DESC LIMIT 500').all();
  if (scope === 'managed') ps = ps.filter((p) => canManageProject(req, p));
  else if (scope === 'mine') {
    const partIds = new Set(db.prepare(
      `SELECT DISTINCT b.project_id FROM booking b
        WHERE b.booker_id = ? OR EXISTS (SELECT 1 FROM booking_participant bp WHERE bp.booking_id = b.id AND bp.user_id = ?)`
    ).all(req.user.id, req.user.id).map((x) => x.project_id));
    ps = ps.filter((p) => p.created_by === req.user.id || partIds.has(p.id));
  } else {
    ps = ps.filter((p) => canViewProject(req, p));
  }
  res.json({ projects: ps.map((p) => projectOut(p, req)) });
}));

r.post('/projects', ah((req, res) => {
  const name = trim(req.body?.name);
  if (!name) throw new HttpError(400, '项目名称不能为空');
  if (name.length > 40) throw new HttpError(400, '项目名称过长（≤40 字）');
  const description = trim(req.body?.description).slice(0, 500);
  const default_approve_mode = normMode(req.body?.default_approve_mode, 'approval');
  if (db.prepare('SELECT 1 FROM booking_project WHERE name = ?').get(name)) throw new HttpError(409, '项目名称已存在');

  const info = tx(() => db.prepare(
    `INSERT INTO booking_project (name, description, default_approve_mode, created_by) VALUES (?,?,?,?)`
  ).run(name, description, default_approve_mode, req.user.id));
  const p = getProject(info.lastInsertRowid);
  logAudit(req, 'booking-project-create', name, { project_id: p.id });
  res.status(201).json({ project: projectOut(p, req), message: '项目已创建' });
}));

r.get('/projects/:id', ah((req, res) => {
  const p = getProject(req.params.id);
  requireViewProject(req, p);
  res.json({ project: projectOut(p, req) });
}));

r.put('/projects/:id', ah((req, res) => {
  const p = getProject(req.params.id);
  if (!p) throw new HttpError(404, '项目不存在');
  if (!canManageProject(req, p)) throw new HttpError(403, '只有项目负责人可以修改项目设置');

  const fields = [];
  const vals = [];
  if (req.body?.name !== undefined) {
    const name = trim(req.body.name);
    if (!name) throw new HttpError(400, '项目名称不能为空');
    if (name.length > 40) throw new HttpError(400, '项目名称过长（≤40 字）');
    const dup = db.prepare('SELECT 1 FROM booking_project WHERE name = ? AND id IS NOT ?').get(name, p.id);
    if (dup) throw new HttpError(409, '项目名称已存在');
    fields.push('name = ?'); vals.push(name);
  }
  if (req.body?.description !== undefined) fields.push('description = ?'), vals.push(trim(req.body.description).slice(0, 500));
  if (req.body?.default_approve_mode !== undefined) fields.push('default_approve_mode = ?'), vals.push(normMode(req.body.default_approve_mode, 'approval'));
  if (req.body?.status !== undefined) {
    const status = String(req.body.status);
    if (!['open', 'closed'].includes(status)) throw new HttpError(400, '项目状态不合法');
    fields.push('status = ?'); vals.push(status);
    fields.push(status === 'closed' ? 'close_time = datetime(\'now\',\'localtime\')' : 'close_time = NULL');
  }
  if (!fields.length) return res.json({ project: projectOut(p, req) });
  fields.push('update_time = datetime(\'now\',\'localtime\')');
  tx(() => db.prepare(`UPDATE booking_project SET ${fields.join(', ')} WHERE id = ?`).run(...vals, p.id));
  logAudit(req, 'booking-project-update', p.name, { project_id: p.id, body: req.body });
  res.json({ project: projectOut(getProject(p.id), req), message: '已保存（模式调整只影响新预约，历史单不追溯）' });
}));

// ==================== 用户搜索（全站可搜，排自己/封禁；仿 purchase users/search） ====================
r.get('/users/search', ah((req, res) => {
  const q = trim(req.query.q);
  if (!q) return res.json({ users: [] });
  const like = `%${q}%`;
  const users = db.prepare(
    `SELECT id, username, nickname, real_name, avatar FROM user
     WHERE id != ? AND status != 1 AND (username LIKE ? OR nickname LIKE ? OR real_name LIKE ?) ORDER BY id LIMIT 10`
  ).all(req.user.id, like, like, like);
  res.json({ users });
}));

// ==================== 资源 ====================
r.get('/projects/:id/resources', ah((req, res) => {
  const p = getProject(req.params.id);
  requireViewProject(req, p);
  const status = ['active', 'archived', 'all'].includes(String(req.query.status)) ? String(req.query.status) : 'active';
  const kind = String(req.query.kind || '');
  let rows = db.prepare('SELECT * FROM booking_resource WHERE project_id = ? ORDER BY is_space DESC, kind, id').all(p.id);
  rows = rows.filter((x) => !x.is_carrier); // 借用登记占位资源不进台账
  if (status !== 'all') rows = rows.filter((x) => x.status === status);
  if (KINDS.has(kind)) rows = rows.filter((x) => x.kind === kind);
  res.json({ resources: rows.map(resourceOut), canManage: canManageProject(req, p) });
}));

r.post('/projects/:id/resources', ah((req, res) => {
  const p = getProject(req.params.id);
  if (!p) throw new HttpError(404, '项目不存在');
  if (!canManageProject(req, p)) throw new HttpError(403, '只有项目负责人可以管理资源');
  const norm = normResourceBody(req.body?.kind, req.body || {}, p.default_approve_mode);
  if (db.prepare('SELECT 1 FROM booking_resource WHERE project_id = ? AND name = ?').get(p.id, norm.name))
    throw new HttpError(409, '同项目内已存在同名资源');

  const info = tx(() => db.prepare(
    `INSERT INTO booking_resource (project_id, kind, is_space, name, spec, location, capacity, quantity, unit, image, damaged_qty, params, approve_mode, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(p.id, norm.kind, norm.isSpace, norm.name, norm.spec, norm.location, norm.capacity, norm.quantity, norm.unit, norm.image, norm.damaged_qty, norm.params, norm.approve_mode, req.user.id));
  res.status(201).json({ resource: resourceOut(getResource(info.lastInsertRowid)), message: '资源已添加' });
}));

// 类型表单批量导入：任一坏行整体回滚，错误带行号
r.post('/projects/:id/resources/bulk', ah((req, res) => {
  const p = getProject(req.params.id);
  if (!p) throw new HttpError(404, '项目不存在');
  if (!canManageProject(req, p)) throw new HttpError(403, '只有项目负责人可以管理资源');
  const arr = req.body?.items;
  if (!Array.isArray(arr) || !arr.length) throw new HttpError(400, '导入内容为空（需要 items 数组）');
  if (arr.length > 200) throw new HttpError(400, '一次最多导入 200 条资源');

  const norms = arr.map((x, i) => {
    try {
      const n = normResourceBody(x?.kind, x || {}, p.default_approve_mode);
      n._row = i + 1;
      return n;
    } catch (e) {
      throw new HttpError(e.status || 400, `第 ${i + 1} 行：${e.message}`);
    }
  });
  const created = tx(() => {
    const ins = db.prepare(
      `INSERT INTO booking_resource (project_id, kind, is_space, name, spec, location, capacity, quantity, unit, image, damaged_qty, params, approve_mode, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    const ids = [];
    for (const n of norms) {
      if (db.prepare('SELECT 1 FROM booking_resource WHERE project_id = ? AND name = ?').get(p.id, n.name))
        throw new HttpError(409, `第 ${n._row} 行：同项目内已存在同名资源「${n.name}」`);
      const info = ins.run(p.id, n.kind, n.isSpace, n.name, n.spec, n.location, n.capacity, n.quantity, n.unit, n.image, n.damaged_qty, n.params, n.approve_mode, req.user.id);
      ids.push(info.lastInsertRowid);
    }
    return ids;
  });
  res.status(201).json({ created: created.length, message: `已导入 ${created.length} 条资源` });
}));

// 表格导入模板下载（xlsx，仅表头；权限与 bulk 同）
r.get('/projects/:id/resources/import-template', ah((req, res) => {
  const p = getProject(req.params.id);
  if (!p) throw new HttpError(404, '项目不存在');
  if (!canManageProject(req, p)) throw new HttpError(403, '只有项目负责人可以管理资源');
  const kind = String(req.query.kind || '');
  if (!KINDS.has(kind)) throw new HttpError(400, '资源类型不合法（物品资源/空间资源）');
  const buf = buildBookingTemplate(kind);
  const fname = `资源导入模板_${kind === 'space' ? '空间' : '物品'}.xlsx`;
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="template.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(buf);
}));

// 表格文件解析（multipart；只解析不落库，预览核对后仍走 bulk）
r.post('/projects/:id/resources/parse-import', importMem, ah((req, res) => {
  const p = getProject(req.params.id);
  if (!p) throw new HttpError(404, '项目不存在');
  if (!canManageProject(req, p)) throw new HttpError(403, '只有项目负责人可以管理资源');
  const kind = String(req.body?.kind || '');
  if (!KINDS.has(kind)) throw new HttpError(400, '资源类型不合法（物品资源/空间资源）');
  const file = req.file;
  if (!file) throw new HttpError(400, '未收到文件（字段名 file，multipart/form-data）');
  const ext = extname(basename(file.originalname || '')).slice(1).toLowerCase();
  let out;
  if (ext === 'xlsx' || ext === 'xls') out = recognizeBookingXlsx(kind, file.buffer);
  else if (ext === 'csv') out = recognizeBookingCsv(kind, file.buffer);
  else throw new HttpError(400, '仅支持 .xlsx/.xls/.csv 表格文件');
  res.json(out);
}), (err, req, res, next) => {
  // multer 超限在此转中文 413（BookingImportError 交下方统一中间件）
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件过大（表格文件 ≤10MB）' });
    return res.status(400).json({ error: `上传失败：${err.message}` });
  }
  next(err);
});

r.put('/resources/:rid', ah((req, res) => {
  const rs = getResource(req.params.rid);
  if (!rs) throw new HttpError(404, '资源不存在');
  assertNotCarrier(rs);
  const p = getProject(rs.project_id);
  if (!canManageProject(req, p)) throw new HttpError(403, '只有项目负责人可以修改资源');
  const b = req.body || {};

  const fields = [];
  const vals = [];
  if (b.name !== undefined) {
    const name = trim(b.name);
    if (!name || name.length > 30) throw new HttpError(400, '资源名称不合法（1–30 字）');
    if (db.prepare('SELECT 1 FROM booking_resource WHERE project_id = ? AND name = ? AND id IS NOT ?').get(p.id, name, rs.id))
      throw new HttpError(409, '同项目内已存在同名资源');
    fields.push('name = ?'); vals.push(name);
  }
  if (b.spec !== undefined) fields.push('spec = ?'), vals.push(trim(b.spec).slice(0, 40));
  if (b.location !== undefined) fields.push('location = ?'), vals.push(trim(b.location).slice(0, 60));
  if (b.approve_mode !== undefined) fields.push('approve_mode = ?'), vals.push(normMode(b.approve_mode, rs.approve_mode));
  // 物品/空间都可更新照片（空串=移除照片）
  if (b.image !== undefined) fields.push('image = ?'), vals.push(typeof b.image === 'string' ? b.image.slice(0, 400000) : '');

  if (rs.is_space) {
    if (b.capacity !== undefined) {
      const capacity = Number(b.capacity);
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 9999) throw new HttpError(400, '容量须为 1–9999 的整数');
      shrinkCheck(rs, capacity, rs.quantity);
      fields.push('capacity = ?'); vals.push(capacity);
    }
    if (b.params?.equipment !== undefined || b.equipment !== undefined) {
      const list = (b.params?.equipment ?? b.equipment ?? []).map((x) => trim(x)).filter(Boolean).slice(0, 20);
      for (const e of list) if (e.length > 20) throw new HttpError(400, '单项设备名称过长（≤20 字）');
      fields.push('params = ?'); vals.push(JSON.stringify(list.length ? { equipment: list } : {}));
    }
  } else {
    if (b.quantity !== undefined) {
      const quantity = Number(b.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) throw new HttpError(400, '库存须为 1–9999 的整数');
      shrinkCheck(rs, rs.capacity, quantity);
      fields.push('quantity = ?'); vals.push(quantity);
    }
    if (b.unit !== undefined) fields.push('unit = ?'), vals.push(trim(b.unit).slice(0, 8));
    if (b.damaged_qty !== undefined) {
      const damaged = Number(b.damaged_qty);
      if (!Number.isInteger(damaged) || damaged < 0 || damaged > 9999) throw new HttpError(400, '损坏数量须为 0–9999 的整数');
      fields.push('damaged_qty = ?'); vals.push(damaged);
    }
  }
  if (!fields.length) return res.json({ resource: resourceOut(rs) });
  fields.push('update_time = datetime(\'now\',\'localtime\')');
  tx(() => db.prepare(`UPDATE booking_resource SET ${fields.join(', ')} WHERE id = ?`).run(...vals, rs.id));
  res.json({ resource: resourceOut(getResource(rs.id)), message: '已保存' });
}));

r.delete('/resources/:rid', ah((req, res) => {
  const rs = getResource(req.params.rid);
  if (!rs) throw new HttpError(404, '资源不存在');
  assertNotCarrier(rs);
  const p = getProject(rs.project_id);
  if (!canManageProject(req, p)) throw new HttpError(403, '只有项目负责人可以删除资源');
  const used = db.prepare('SELECT COUNT(*) AS n FROM booking WHERE resource_id = ?').get(rs.id).n;
  if (used) throw new HttpError(409, '该资源已有预约记录，不能删除，请改用归档');
  tx(() => db.prepare('DELETE FROM booking_resource WHERE id = ?').run(rs.id));
  res.json({ message: '资源已删除' });
}));

r.post('/resources/:rid/archive', ah((req, res) => {
  const rs = getResource(req.params.rid);
  if (!rs) throw new HttpError(404, '资源不存在');
  assertNotCarrier(rs);
  const p = getProject(rs.project_id);
  if (!canManageProject(req, p)) throw new HttpError(403, '只有项目负责人可以归档资源');
  tx(() => db.prepare("UPDATE booking_resource SET status = 'archived', update_time = datetime('now','localtime') WHERE id = ?").run(rs.id));
  res.json({ resource: resourceOut(getResource(rs.id)), message: '已归档（不再接受新预约，历史预约保留）' });
}));

r.post('/resources/:rid/restore', ah((req, res) => {
  const rs = getResource(req.params.rid);
  if (!rs) throw new HttpError(404, '资源不存在');
  const p = getProject(rs.project_id);
  if (!canManageProject(req, p)) throw new HttpError(403, '只有项目负责人可以恢复资源');
  tx(() => db.prepare("UPDATE booking_resource SET status = 'active', update_time = datetime('now','localtime') WHERE id = ?").run(rs.id));
  res.json({ resource: resourceOut(getResource(rs.id)), message: '已恢复' });
}));

// ==================== 固定组队 ====================
function teamOut(t, req) {
  // owner_name/member.user_name 均为建队/改队时的署名快照（displayNameOf 文本），直接返回供前端原样渲染，
  // 不再 JOIN 当前 real_name —— 快照文本已是「真名（昵称）」，再组合一次会叠成双层。
  const members = db.prepare(
    `SELECT m.user_id, m.user_name
       FROM booking_team_member m
      WHERE m.team_id = ? ORDER BY m.ord, m.user_id`
  ).all(t.id);
  const p = getProject(t.project_id);
  return {
    id: t.id, project_id: t.project_id, name: t.name,
    owner_id: t.owner_id, owner_name: t.owner_name,
    create_time: t.create_time,
    members: members.map((m) => ({ user_id: m.user_id, user_name: m.user_name })),
    canManage: !!isSuperAdmin(req.user) || t.owner_id === req.user.id || canManageProject(req, p),
    isOwner: t.owner_id === req.user.id,
  };
}
// 成员 id 列表归一（不含队长本人；存在/未封禁/≤30）
function normMemberIds(ids, me, projectId) {
  const set = new Set();
  for (const x of ids || []) {
    const id = Number(x);
    if (Number.isInteger(id) && id > 0 && id !== me.id) set.add(id);
  }
  if (set.size > MAX_TEAM_MEMBERS) throw new HttpError(400, `每队最多 ${MAX_TEAM_MEMBERS} 名成员（不含队长）`);
  const list = [...set];
  if (!list.length) return [];
  const users = db.prepare(
    `SELECT id, username, nickname, real_name, status FROM user WHERE id IN (${list.map(() => '?').join(',')})`
  ).all(...list);
  if (users.length !== list.length) throw new HttpError(400, '成员中包含不存在的账号');
  if (users.some((u) => u.status === 1)) throw new HttpError(400, '成员中包含已封禁账号');
  // 不允许把同一项目别的队的成员？允许多队复用，不做排他
  return users.map((u) => ({ id: u.id, user_name: displayNameOf(u) }));
}

r.get('/projects/:id/teams', ah((req, res) => {
  const p = getProject(req.params.id);
  requireViewProject(req, p);
  const teams = db.prepare('SELECT * FROM booking_team WHERE project_id = ? ORDER BY id').all(p.id);
  res.json({ teams: teams.map((t) => teamOut(t, req)), canManage: canManageProject(req, p) });
}));

r.post('/projects/:id/teams', ah((req, res) => {
  const p = getProject(req.params.id);
  requireViewProject(req, p);
  const name = trim(req.body?.name);
  if (!name || name.length > 20) throw new HttpError(400, '队伍名称不合法（1–20 字）');
  if (db.prepare('SELECT 1 FROM booking_team WHERE project_id = ? AND name = ?').get(p.id, name))
    throw new HttpError(409, '本项目内已有同名队伍');
  const members = normMemberIds(req.body?.member_ids, req.user, p.id);

  const teamId = tx(() => {
    const info = db.prepare(
      'INSERT INTO booking_team (project_id, name, owner_id, owner_name) VALUES (?,?,?,?)'
    ).run(p.id, name, req.user.id, displayNameOf(req.user));
    const ins = db.prepare('INSERT INTO booking_team_member (team_id, user_id, user_name, ord) VALUES (?,?,?,?)');
    members.forEach((m, i) => ins.run(info.lastInsertRowid, m.id, m.user_name, i));
    return info.lastInsertRowid;
  });
  res.status(201).json({ team: teamOut(getTeam(teamId), req), message: '组队已创建' });
}));

r.put('/teams/:tid', ah((req, res) => {
  const t = getTeam(req.params.tid);
  if (!t) throw new HttpError(404, '队伍不存在');
  const p = getProject(t.project_id);
  if (!isSuperAdmin(req.user) && t.owner_id !== req.user.id && !canManageProject(req, p))
    throw new HttpError(403, '只有队长或项目负责人可以管理该组队');
  tx(() => {
    if (req.body?.name !== undefined) {
      const name = trim(req.body.name);
      if (!name || name.length > 20) throw new HttpError(400, '队伍名称不合法（1–20 字）');
      if (db.prepare('SELECT 1 FROM booking_team WHERE project_id = ? AND name = ? AND id IS NOT ?').get(t.project_id, name, t.id))
        throw new HttpError(409, '本项目内已有同名队伍');
      db.prepare('UPDATE booking_team SET name = ? WHERE id = ?').run(name, t.id);
    }
    if (Array.isArray(req.body?.member_ids)) {
      const members = normMemberIds(req.body.member_ids, req.user, t.project_id);
      db.prepare('DELETE FROM booking_team_member WHERE team_id = ?').run(t.id);
      const ins = db.prepare('INSERT INTO booking_team_member (team_id, user_id, user_name, ord) VALUES (?,?,?,?)');
      members.forEach((m, i) => ins.run(t.id, m.id, m.user_name, i));
    }
  });
  res.json({ team: teamOut(getTeam(t.id), req), message: '已保存（历史预约的参与人快照不变）' });
}));

r.delete('/teams/:tid', ah((req, res) => {
  const t = getTeam(req.params.tid);
  if (!t) throw new HttpError(404, '队伍不存在');
  const p = getProject(t.project_id);
  if (!isSuperAdmin(req.user) && t.owner_id !== req.user.id && !canManageProject(req, p))
    throw new HttpError(403, '只有队长或项目负责人可以删除该组队');
  // booking.team_id ON DELETE SET NULL 自动解绑，历史参与人快照保留
  tx(() => db.prepare('DELETE FROM booking_team WHERE id = ?').run(t.id));
  res.json({ message: '组队已删除（历史预约保留）' });
}));

// ==================== 预约 ====================
// user_name 是下单瞬间的署名快照（displayNameOf 文本），原样返回；avatar 仍取实时值
const participantRows = (bookingId) => db.prepare(
  `SELECT bp.user_id, bp.user_name, bp.is_booker, u.avatar
   FROM booking_participant bp LEFT JOIN user u ON u.id = bp.user_id
   WHERE bp.booking_id = ? ORDER BY bp.ord, bp.id`
).all(bookingId).map((x) => ({
  user_id: x.user_id, user_name: x.user_name,
  avatar: x.avatar || null, is_booker: !!x.is_booker,
}));

// fullImage：列表/我的预约不带原图（dataURL 最大 40 万字符），仅单条详情回原图
const bookingOut = (b, req, { fullImage = false } = {}) => {
  const rs = getResource(b.resource_id);
  const p = getProject(b.project_id);
  // booker_name/approver_name/cancel_by_name 均为落库署名快照（displayNameOf 文本），前端原样渲染即可，
  // 不再附实时 real_name —— 快照已含「真名（昵称）」，再与实时真名组合只会叠成双层。
  return {
    ...b,
    item_image: fullImage ? (b.item_image || '') : '',
    is_space: !!rs?.is_space, kind: rs?.kind, resource_name: rs?.name || '',
    resource_status: rs?.status, approve_mode: rs?.approve_mode,
    project_name: p?.name || '',
    participants: participantRows(b.id),
    mine: b.booker_id === req.user.id || participantRows(b.id).some((x) => x.user_id === req.user.id),
    perm: bookingPerm(b, req, p),
  };
};

function bookingPerm(b, req, p) {
  const manager = canManageProject(req, p || getProject(b.project_id));
  const active = b.status === 'pending' || b.status === 'confirmed';
  return {
    canApprove: manager && b.status === 'pending' && (!!isSuperAdmin(req.user) || b.booker_id !== req.user.id),
    canReject: manager && b.status === 'pending' && (!!isSuperAdmin(req.user) || b.booker_id !== req.user.id),
    canCancel: active && (b.booker_id === req.user.id || manager),
    isManager: manager,
  };
}

// 核心建单事务（conflictsOnly=true 时只检不写，供实时校验端点复用）
function createBooking(req, p, body, { conflictsOnly = false, excludeId = 0 } = {}) {
  if (p.status === 'closed' && !conflictsOnly) throw new HttpError(403, '项目已关闭，不能新建预约');
  const rs = getResource(Number(body.resource_id));
  if (!rs || rs.project_id !== p.id) throw new HttpError(400, '资源不存在或不属于本项目');
  if (rs.status !== 'active' && !conflictsOnly) throw new HttpError(400, '资源已归档，不能预约');
  if (rs.is_carrier) throw new HttpError(400, '不能直接预约借用登记占位资源');

  const { start, end } = validateSlotWindow(body.start_time, body.end_time);
  const startStr = fmtSlot(start), endStr = fmtSlot(end);
  const part = normParticipants(p.id, body, req.user);
  const qty = rs.is_space ? 1 : Number(body.qty);
  if (!rs.is_space && (!Number.isInteger(qty) || qty < 1 || qty > rs.quantity))
    throw new HttpError(400, `借用数量须为 1–${rs.quantity} 的整数`);
  if (rs.is_space && part.headcount > rs.capacity)
    throw new HttpError(400, `人数 ${part.headcount} 超过该空间容量 ${rs.capacity} 人`);
  const purpose = trim(body.purpose).slice(0, 200);

  const status = rs.approve_mode === 'first_come' ? 'confirmed' : 'pending';
  // 冲突检测 + 插入必须同一事务（BEGIN IMMEDIATE 已把写操作串行化，堵 TOCTOU）
  const bId = tx(() => {
    const conflicts = findConflicts(rs, startStr, endStr, qty, excludeId);
    if (conflicts.length) {
      const e = new HttpError(409, rs.is_space ? '该时段已被预约（空间同一时段只能一单）' : '该时段库存不足');
      e.conflicts = conflicts;
      throw e;
    }
    if (conflictsOnly) return 0;
    const info = db.prepare(
      `INSERT INTO booking (project_id, resource_id, start_time, end_time, qty, headcount, purpose,
         status, source, team_id, booker_id, booker_name, booker_student_no)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(p.id, rs.id, startStr, endStr, qty, part.headcount, purpose,
      status, part.source, part.team_id, req.user.id, displayNameOf(req.user), req.user.student_no || '');
    const insP = db.prepare('INSERT INTO booking_participant (booking_id, user_id, user_name, is_booker, ord) VALUES (?,?,?,?,?)');
    part.users.forEach((u, i) => insP.run(info.lastInsertRowid, u.id, u.user_name, u.id === req.user.id ? 1 : 0, i));
    db.prepare('INSERT INTO booking_log (booking_id, action, actor_id, actor_name, comment) VALUES (?,?,?,?,?)')
      .run(info.lastInsertRowid, 'created', req.user.id, displayNameOf(req.user), '');
    return info.lastInsertRowid;
  });
  if (conflictsOnly) {
    return { ok: true, conflicts: [], headcount: part.headcount, qty,
      would_status: status };
  }
  const b = getBooking(bId);
  logAudit(req, 'booking-create', `${p.name}/${rs.name}`, { booking_id: bId, status, start: startStr, end: endStr });

  // 通知（COMMIT 后）
  const link = bookingLink(p.id, b);
  const span = `${b.start_time} ~ ${b.end_time}`;
  if (status === 'pending') {
    if (p.created_by && p.created_by !== req.user.id) {
      notify([p.created_by], `bk_submit_${bId}`, `📋 新预约待审批：${rs.name}`,
        `${b.booker_name} 申请预约 ${span}（${b.headcount} 人${rs.is_space ? '' : `，借 ${b.qty} ${rs.unit || '件'}`}）`, link);
    }
  } else {
    notify(part.users.filter((u) => u.id !== req.user.id).map((u) => u.id), `bk_confirm_${bId}`,
      `📅 预约已确认：${rs.name}`, `${b.booker_name} 预约了 ${span}，你在参与人名单中`, link);
  }
  return { booking: bookingOut(b, req), message: status === 'confirmed' ? '预约成功，已确认' : '已提交，待项目负责人审批' };
}

r.post('/projects/:id/conflicts', ah((req, res) => {
  const p = getProject(req.params.id);
  requireViewProject(req, p);
  const excludeId = Number(req.body?.exclude_id) || 0;
  const result = createBooking(req, p, req.body || {}, { conflictsOnly: true, excludeId });
  res.json(result);
}));

r.post('/projects/:id/bookings', ah((req, res) => {
  const p = getProject(req.params.id);
  requireViewProject(req, p);
  const out = createBooking(req, p, req.body || {});
  res.status(201).json(out);
}));

r.get('/projects/:id/bookings', ah((req, res) => {
  const p = getProject(req.params.id);
  requireViewProject(req, p);
  const where = ['b.project_id = ?'];
  const vals = [p.id];
  if (req.query.from) where.push('b.end_time > ?'), vals.push(String(req.query.from));
  if (req.query.to) where.push('b.start_time < ?'), vals.push(String(req.query.to));
  if (req.query.resource_id) where.push('b.resource_id = ?'), vals.push(Number(req.query.resource_id));
  if (['pending', 'confirmed', 'rejected', 'canceled'].includes(String(req.query.status)))
    where.push('b.status = ?'), vals.push(String(req.query.status));
  if (String(req.query.mine) === '1')
    where.push('(b.booker_id = ? OR EXISTS (SELECT 1 FROM booking_participant bp WHERE bp.booking_id = b.id AND bp.user_id = ?))'),
      vals.push(req.user.id, req.user.id);
  const rows = db.prepare(`SELECT * FROM booking b WHERE ${where.join(' AND ')} ORDER BY b.start_time DESC LIMIT 500`).all(...vals);
  res.json({ bookings: rows.map((b) => bookingOut(b, req)) });
}));

// 甘特数据：窗口 [from 07:00, from+days 日 22:00)；默认本周一起 7 天
r.get('/projects/:id/timeline', ah((req, res) => {
  const p = getProject(req.params.id);
  requireViewProject(req, p);
  const days = Math.min(14, Math.max(1, Number(req.query.days) || 7));
  let from = String(req.query.from || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    const n = new Date();
    const dow = (n.getDay() + 6) % 7; // 周一=0
    n.setDate(n.getDate() - dow);
    from = `${n.getFullYear()}-${p2(n.getMonth() + 1)}-${p2(n.getDate())}`;
  }
  const winStart = `${from} 07:00`;
  const endDate = parseSlot(`${from} 07:00`);
  endDate.setUTCDate(endDate.getUTCDate() + days);
  const winEnd = fmtSlot(endDate).slice(0, 10) + ' 22:00';

  const includeAll = String(req.query.all) === '1';
  let resources = db.prepare('SELECT * FROM booking_resource WHERE project_id = ? ORDER BY is_space DESC, kind, id').all(p.id);
  resources = resources.filter((x) => !x.is_carrier); // 借用登记占位资源不画进甘特
  if (!includeAll) resources = resources.filter((x) => x.status === 'active');

  const statusCond = includeAll ? '' : "AND b.status IN ('pending','confirmed')";
  const bookings = db.prepare(
    `SELECT b.* FROM booking b
      WHERE b.project_id = ? AND b.start_time < ? AND b.end_time > ?
        AND COALESCE(b.item_kind, '') = '' ${statusCond}
     ORDER BY b.start_time`
  ).all(p.id, winEnd, winStart).map((b) => ({
    id: b.id, resource_id: b.resource_id, start_time: b.start_time, end_time: b.end_time,
    qty: b.qty, headcount: b.headcount, status: b.status, source: b.source, team_id: b.team_id,
    booker_id: b.booker_id, booker_name: b.booker_name, purpose: b.purpose || '',
    mine: b.booker_id === req.user.id || !!db.prepare(
      'SELECT 1 FROM booking_participant WHERE booking_id = ? AND user_id = ?'
    ).get(b.id, req.user.id),
    participants: participantRows(b.id),
  }));

  res.json({
    from, days, win_start: winStart, win_end: winEnd,
    slot_minutes: 30, open: '07:00', close: '22:00', slots_per_day: 30,
    resources: resources.map(resourceOut),
    bookings,
  });
}));

// /bookings/mine 必须在 /bookings/:id 之前
r.get('/bookings/mine', ah((req, res) => {
  const status = ['pending', 'confirmed', 'rejected', 'canceled'].includes(String(req.query.status))
    ? String(req.query.status) : null;
  const rows = db.prepare(
    `SELECT b.* FROM booking b
      WHERE (b.booker_id = ? OR EXISTS (SELECT 1 FROM booking_participant bp WHERE bp.booking_id = b.id AND bp.user_id = ?))
      ${status ? 'AND b.status = ?' : ''}
     ORDER BY b.start_time DESC LIMIT 200`
  ).all(req.user.id, req.user.id, ...(status ? [status] : []));
  res.json({ bookings: rows.map((b) => bookingOut(b, req)) });
}));

r.get('/bookings/:id', ah((req, res) => {
  const b = getBooking(req.params.id);
  if (!b) throw new HttpError(404, '预约不存在');
  const p = getProject(b.project_id);
  // 借用记录管理员可跨项目打开登记行（全局记录页点开看原图）；其他单仍按项目可见性
  if (!canViewProject(req, p) && !(b.item_kind && hasAdminPerm(req.user, 'lab')))
    throw new HttpError(404, '预约不存在');
  // actor_name 为操作时的署名快照，原样返回
  const logs = db.prepare(
    `SELECT bl.* FROM booking_log bl
      WHERE bl.booking_id = ? ORDER BY bl.id`
  ).all(b.id);
  res.json({ booking: bookingOut(b, req, { fullImage: !!b.item_kind }), logs });
}));

// 审批通过：事务内复检冲突（pending 期间可能有管理员直插/资源变化）
r.post('/bookings/:id/approve', ah((req, res) => {
  const b = getBooking(req.params.id);
  if (!b) throw new HttpError(404, '预约不存在');
  const p = getProject(b.project_id);
  if (!canManageProject(req, p)) throw new HttpError(404, '预约不存在');
  if (b.status !== 'pending') throw new HttpError(400, '该预约已结案，无需审批');
  if (b.booker_id === req.user.id && !isSuperAdmin(req.user)) throw new HttpError(403, '不能审批自己提交的预约');
  const rs = getResource(b.resource_id);

  tx(() => {
    const conflicts = findConflicts(rs, b.start_time, b.end_time, b.qty, b.id);
    if (conflicts.length) {
      throw new HttpError(409, '复检发现时段冲突（可能有已确认预约），请驳回或协调后再审');
    }
    db.prepare(
      `UPDATE booking SET status = 'confirmed', approver_id = ?, approver_name = ?, approve_time = datetime('now','localtime'),
         reject_reason = '', update_time = datetime('now','localtime') WHERE id = ?`
    ).run(req.user.id, displayNameOf(req.user), b.id);
    db.prepare('INSERT INTO booking_log (booking_id, action, actor_id, actor_name, comment) VALUES (?,?,?,?,?)')
      .run(b.id, 'approved', req.user.id, displayNameOf(req.user), trim(req.body?.comment));
  });
  const fresh = getBooking(b.id);
  logAudit(req, 'booking-approve', `${p.name}/${rs.name}`, { booking_id: b.id });
  const link = bookingLink(p.id, b);
  notify(participantRows(b.id).map((x) => x.user_id).filter((uid) => uid !== req.user.id),
    `bk_approve_${b.id}`, `✅ 预约已通过：${rs.name}`,
    `${b.booker_name} 的预约 ${b.start_time} ~ ${b.end_time} 已通过审批`, link);
  res.json({ booking: bookingOut(fresh, req), message: '已通过' });
}));

r.post('/bookings/:id/reject', ah((req, res) => {
  const b = getBooking(req.params.id);
  if (!b) throw new HttpError(404, '预约不存在');
  const p = getProject(b.project_id);
  if (!canManageProject(req, p)) throw new HttpError(404, '预约不存在');
  if (b.status !== 'pending') throw new HttpError(400, '该预约已结案，无需审批');
  if (b.booker_id === req.user.id && !isSuperAdmin(req.user)) throw new HttpError(403, '不能审批自己提交的预约');
  const reason = trim(req.body?.reason);
  if (!reason) throw new HttpError(400, '驳回必须填写理由');
  if (reason.length > 200) throw new HttpError(400, '驳回理由过长（≤200 字）');
  const rs = getResource(b.resource_id);

  tx(() => {
    db.prepare(
      `UPDATE booking SET status = 'rejected', approver_id = ?, approver_name = ?, approve_time = datetime('now','localtime'),
         reject_reason = ?, update_time = datetime('now','localtime') WHERE id = ?`
    ).run(req.user.id, displayNameOf(req.user), reason, b.id);
    db.prepare('INSERT INTO booking_log (booking_id, action, actor_id, actor_name, comment) VALUES (?,?,?,?,?)')
      .run(b.id, 'rejected', req.user.id, displayNameOf(req.user), reason);
  });
  logAudit(req, 'booking-reject', `${p.name}/${rs.name}`, { booking_id: b.id });
  const link = bookingLink(p.id, b);
  notify(participantRows(b.id).map((x) => x.user_id).filter((uid) => uid !== req.user.id),
    `bk_reject_${b.id}`, `❌ 预约未通过：${rs.name}`,
    `${b.booker_name} 的预约 ${b.start_time} ~ ${b.end_time} 未通过：${reason}`, link);
  res.json({ booking: bookingOut(getBooking(b.id), req), message: '已驳回' });
}));

r.post('/bookings/:id/cancel', ah((req, res) => {
  const b = getBooking(req.params.id);
  if (!b) throw new HttpError(404, '预约不存在');
  const p = getProject(b.project_id);
  if (!canViewProject(req, p)) throw new HttpError(404, '预约不存在');
  if (b.status === 'rejected' || b.status === 'canceled') throw new HttpError(400, '该预约已结束，不能重复取消');
  const manager = canManageProject(req, p);
  if (b.booker_id !== req.user.id && !manager) throw new HttpError(403, '只有预约者或项目负责人可以取消');
  const forced = b.booker_id !== req.user.id && manager;
  // 预约者自己取消 confirmed 单：开始后不允许；负责人/管理员可随时强取消。
  // 借用登记是零时长记录（start=end=登记时刻），本人可随时取消
  if (!forced && !b.item_kind && b.status === 'confirmed' && nowSlot() >= b.start_time)
    throw new HttpError(400, '预约已开始，如需取消请联系项目负责人');
  const rs = getResource(b.resource_id);
  const actorName = displayNameOf(req.user);

  tx(() => {
    db.prepare(
      `UPDATE booking SET status = 'canceled', cancel_by_id = ?, cancel_by_name = ?, cancel_time = datetime('now','localtime'),
         update_time = datetime('now','localtime') WHERE id = ?`
    ).run(req.user.id, actorName, b.id);
    db.prepare('INSERT INTO booking_log (booking_id, action, actor_id, actor_name, comment) VALUES (?,?,?,?,?)')
      .run(b.id, 'canceled', req.user.id, actorName, trim(req.body?.comment));
  });
  logAudit(req, forced ? 'booking-force-cancel' : 'booking-cancel', `${p.name}/${rs.name}`, { booking_id: b.id });
  const link = bookingLink(p.id, b);
  const others = participantRows(b.id).map((x) => x.user_id)
    .filter((uid) => uid !== req.user.id);
  notify(others, forced ? `bk_force_cancel_${b.id}` : `bk_cancel_${b.id}`,
    forced ? `🚫 预约被负责人取消：${rs.name}` : `🚫 预约已取消：${rs.name}`,
    forced
      ? `${actorName} 取消了 ${b.booker_name} 的预约 ${b.start_time} ~ ${b.end_time}`
      : `${b.booker_name} 取消了预约 ${b.start_time} ~ ${b.end_time}`,
    link);
  res.json({ booking: bookingOut(getBooking(b.id), req), message: forced ? '已强制取消' : '预约已取消' });
}));

// HttpError → JSON（含冲突明细，供前端格条标红；其余交 server.js 全局兜底）
r.use((err, req, res, next) => {
  if (err instanceof BookingImportError) return res.status(400).json({ error: err.message });
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...(err.conflicts ? { conflicts: err.conflicts } : {}) });
  }
  next(err);
});

export default r;
