// 小组考勤：考勤规则（工作日/多时段/范围/负责人/请假模式）、打卡（本人/代签/签到码）、请假审批、日看板与月统计
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import db from '../db/database.js';
import { authRequired, teamCtx, hasPerm, requirePerm, logAudit, displayNameOf } from './middleware.js';
import { cnDateStr } from '../lib/checkin.js';

const r = Router();
r.use(authRequired);

const TZ = 'Asia/Shanghai';
const DAY = 864e5;
const cnDay = (dateStr) => {
  const [Y, M, D] = String(dateStr).split('-').map(Number);
  return Date.UTC(Y, M - 1, D) - 8 * 3600e3;
};
const addDays = (dateStr, n) => cnDateStr(new Date(cnDay(dateStr) + n * DAY));
const hmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false, hourCycle: 'h23' });
const dowFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
const DOWMAP = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const nowHm = (d = new Date()) => {
  const p = Object.fromEntries(hmFmt.formatToParts(d).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute}`;
};
const dowOf = (dateStr) => DOWMAP[dowFmt.format(new Date(cnDay(dateStr)))];
const parseArr = (s, d = '[]') => { try { return JSON.parse(s || d); } catch { return JSON.parse(d); } };
const dateOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const hmOk = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
const slotMs = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+08:00`);
const bad = (msg) => { const e = new Error(msg); e.status = 400; return e; };
const handle = (res, e) => res.status(e.status || 500).json({ error: e.message || '服务器错误' });
const int01 = (v) => (v ? 1 : 0);
const num = (v, min, max, msg) => {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) throw bad(msg);
  return n;
};

function policyRow(teamId) {
  const p = db.prepare('SELECT * FROM attendance_policy WHERE team_id = ?').get(teamId);
  if (!p) return null;
  return {
    ...p,
    workdays: parseArr(p.workdays),
    slots: parseArr(p.slots),
    scope_json: parseArr(p.scope_json),
    managers_json: parseArr(p.managers_json),
    exceptions: parseArr(p.exceptions_json),
  };
}
function ensurePolicy(teamId, userId) {
  let p = policyRow(teamId);
  if (!p) {
    const defSlots = [{ id: 's1', name: '上午签到', start: '08:30', late: '09:00', end: '10:00' }];
    db.prepare(
      'INSERT INTO attendance_policy (team_id, created_by, workdays, slots) VALUES (?,?,?,?)'
    ).run(teamId, userId || null, JSON.stringify([1, 2, 3, 4, 5]), JSON.stringify(defSlots));
    p = policyRow(teamId);
  }
  return p;
}

function memberIdsOf(teamId) {
  return db.prepare('SELECT user_id FROM team_member WHERE team_id = ?').all(teamId).map((x) => x.user_id);
}
function membersInScope(teamId, p) {
  const all = memberIdsOf(teamId);
  if (p.scope_type === 'all') return all;
  if (p.scope_type === 'roles') {
    const ids = [...new Set(p.scope_json.map(Number))].filter((x) => Number.isFinite(x));
    if (!ids.length) return [];
    const rows = db.prepare(
      `SELECT DISTINCT user_id FROM team_member_role WHERE team_id = ? AND role_id IN (${ids.map(() => '?').join(',')})`
    ).all(teamId, ...ids);
    return rows.map((x) => x.user_id);
  }
  const ids = new Set(p.scope_json.map(Number));
  return all.filter((id) => ids.has(id));
}
function isAttendanceManager(ctx, p, userId) {
  if (ctx?.isOwner) return true;
  if (hasPerm(ctx, 'attendance')) return true;
  return (p?.managers_json || []).map(Number).includes(Number(userId));
}
function managerUserIds(teamId, p) {
  const ids = new Set((p?.managers_json || []).map(Number).filter((x) => Number.isFinite(x)));
  for (const row of db.prepare(
    `SELECT tmr.user_id, tr.permissions FROM team_member_role tmr JOIN team_role tr ON tr.id = tmr.role_id WHERE tmr.team_id = ?`
  ).all(teamId)) {
    if (parseArr(row.permissions).includes('attendance')) ids.add(row.user_id);
  }
  const owner = db.prepare('SELECT owner_id FROM team WHERE id = ?').get(teamId)?.owner_id;
  if (owner) ids.add(owner);
  return [...ids];
}
function managerDeny(ctx, p, req, res) {
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  if (!isAttendanceManager(ctx, p, req.user.id)) {
    return res.status(403).json({ error: '无权限：需要「考勤管理」权限或为考勤负责人' });
  }
  return null;
}

function notify(userIds, type, title, content, link) {
  const ids = [...new Set(userIds.filter((x) => x))];
  if (!ids.length) return;
  try {
    const exists = db.prepare('SELECT 1 FROM personal_notice WHERE user_id = ? AND type = ? AND is_read = 0');
    const ins = db.prepare('INSERT INTO personal_notice (user_id, type, title, content, link) VALUES (?,?,?,?,?)');
    for (const uid of ids) {
      if (exists.get(uid, type)) continue;
      ins.run(uid, type, title, content, link);
    }
  } catch { /* 通知失败不影响考勤主流程 */ }
}

function dateException(p, date) {
  return (p.exceptions || []).find((x) => String(x.date) === date);
}
function isWorkingDate(p, date) {
  if (!p || int01(p.active) !== 1) return false;
  const ex = dateException(p, date);
  if (ex) return ex.type === 'work';
  if (p.start_date && date < p.start_date) return false;
  if (p.end_date && date > p.end_date) return false;
  return (p.workdays || []).includes(dowOf(date));
}
function slotById(p, slotId) {
  return (p.slots || []).find((s) => String(s.id) === String(slotId));
}
function recordStatus(slot, date, hhmm) {
  return slotMs(date, hhmm) > slotMs(date, slot.late) ? 'late' : 'normal';
}

const MEMBER_SQL = `
  SELECT u.id, COALESCE(u.nickname, u.username) AS nickname, u.real_name, u.avatar
  FROM team_member tm JOIN user u ON u.id = tm.user_id
  WHERE tm.team_id = ? ORDER BY tm.join_time, u.id`;
function roleNamesOf(teamId, userId) {
  return db.prepare(
    `SELECT tr.name FROM team_member_role tmr JOIN team_role tr ON tr.id = tmr.role_id
     WHERE tmr.team_id = ? AND tmr.user_id = ? ORDER BY tr.level DESC, tr.id`
  ).all(teamId, userId).map((x) => x.name);
}
function memberMap(teamId, userIds) {
  if (!userIds.length) return {};
  const rows = db.prepare(
    `SELECT u.id, COALESCE(u.nickname, u.username) AS nickname, u.real_name, u.avatar
     FROM user u WHERE u.id IN (${userIds.map(() => '?').join(',')})`
  ).all(...userIds);
  const m = {};
  for (const row of rows) m[row.id] = row;
  return m;
}

// ============ 考勤规则 ============
r.get('/:id/attendance/settings', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const p = ensurePolicy(ctx.team.id, req.user.id);
  const mgr = isAttendanceManager(ctx, p, req.user.id);
  res.json({
    settings: { ...p, managers_json: mgr ? p.managers_json : [] },
    is_manager: mgr,
  });
});

r.put('/:id/attendance/settings', (req, res) => {
  try {
    const ctx = teamCtx(Number(req.params.id), req.user.id);
    if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
    const p = ensurePolicy(ctx.team.id, req.user.id);
    const deny = managerDeny(ctx, p, req, res);
    if (deny) return deny;
    const b = req.body || {};

    const name = String(b.name ?? (p.name || '考勤规则')).trim();
    if (!name || name.length > 30) throw bad('考勤规则名称需 1-30 字');
    const active = int01(b.active ?? p.active);

    const workdays = [...new Set((Array.isArray(b.workdays) ? b.workdays : p.workdays).map(Number))]
      .filter((x) => x >= 1 && x <= 7).sort();
    if (!workdays.length) throw bad('请至少选择 1 个工作日');

    let slots = Array.isArray(b.slots) ? b.slots : p.slots;
    if (!slots.length) throw bad('请至少设置 1 个考勤时段');
    if (slots.length > 8) throw bad('考勤时段最多 8 个');
    slots = slots.map((s, i) => {
      const sn = String(s.name || '').trim();
      const start = String(s.start || '').trim();
      const late = String(s.late || '').trim();
      const end = String(s.end || '').trim();
      if (!sn || sn.length > 20) throw bad(`时段 ${i + 1} 名称需 1-20 字`);
      if (!hmOk(start) || !hmOk(late) || !hmOk(end)) throw bad(`时段 ${sn} 时间格式错误（HH:MM）`);
      if (start > late || late > end) throw bad(`时段 ${sn} 时间顺序应为 开始 ≤ 迟到 ≤ 结束`);
      const id = String(s.id || '').trim() || `s_${Date.now().toString(36)}_${i}`;
      return { id, name: sn, start, late, end };
    });

    const scopeType = String(b.scope_type ?? (p.scope_type || 'all'));
    if (!['all', 'roles', 'members'].includes(scopeType)) throw bad('考勤范围类型错误');
    let scope = Array.isArray(b.scope_json) ? b.scope_json.map(Number) : p.scope_json;
    if (scopeType === 'roles') {
      const valid = new Set(db.prepare('SELECT id FROM team_role WHERE team_id = ?').all(ctx.team.id).map((x) => x.id));
      scope = scope.filter((x) => valid.has(x));
    } else if (scopeType === 'members') {
      const valid = new Set(memberIdsOf(ctx.team.id));
      scope = scope.filter((x) => valid.has(x));
    } else scope = [];

    let managers = Array.isArray(b.managers) ? b.managers.map(Number) : p.managers_json;
    const validMembers = new Set(memberIdsOf(ctx.team.id));
    managers = [...new Set(managers.filter((x) => validMembers.has(x)))];

    const leaveMode = String(b.leave_mode ?? (p.leave_mode || 'approval'));
    if (!['approval', 'register'].includes(leaveMode)) throw bad('请假模式错误');

    const startDate = String(b.start_date ?? (p.start_date || '')).trim();
    const endDate = String(b.end_date ?? (p.end_date || '')).trim();
    if (startDate && !dateOk(startDate)) throw bad('生效开始日期格式错误');
    if (endDate && !dateOk(endDate)) throw bad('生效结束日期格式错误');
    if (startDate && endDate && endDate < startDate) throw bad('生效结束日期不能早于开始日期');

    let exceptions = Array.isArray(b.exceptions) ? b.exceptions : p.exceptions;
    const seen = new Set();
    exceptions = exceptions.slice(0, 200).map((x) => {
      const d = String(x.date || '').trim();
      const type = x.type === 'work' ? 'work' : 'off';
      if (!dateOk(d)) throw bad('特殊日期格式错误');
      if (seen.has(d)) throw bad(`特殊日期 ${d} 重复`);
      seen.add(d);
      const en = String(x.name || '').trim();
      return { date: d, type, name: en.length > 30 ? en.slice(0, 30) : en };
    });

    db.prepare(
      `UPDATE attendance_policy SET name=?, workdays=?, slots=?, scope_type=?, scope_json=?, managers_json=?,
         leave_mode=?, start_date=?, end_date=?, exceptions_json=?, active=?,
         update_time=datetime('now','localtime') WHERE team_id=?`
    ).run(
      name, JSON.stringify(workdays), JSON.stringify(slots), scopeType, JSON.stringify(scope),
      JSON.stringify(managers), leaveMode, startDate || null, endDate || null,
      JSON.stringify(exceptions), active, ctx.team.id
    );
    logAudit(req, 'attendance-settings', ctx.team.name, { slots: slots.length, scope: scopeType, leave_mode: leaveMode });
    res.json({ message: '考勤规则已保存' });
  } catch (e) { return handle(res, e); }
});

// ============ 打卡 ============
function currentCells(p, date, userId, records, leaves, now) {
  return p.slots.map((s) => {
    const rec = records.find((x) => x.slot_id === s.id);
    const leave = leaves.find((x) => !x.slot_id || x.slot_id === s.id);
    if (leave) return { slot_id: s.id, slot_name: s.name, status: leave.status === 'approved' ? 'leave' : 'leave_pending', record: null, leave: { id: leave.id, leave_type: leave.leave_type, status: leave.status } };
    if (rec) return { slot_id: s.id, slot_name: s.name, status: rec.status, record: { id: rec.id, checkin_time: rec.checkin_time, source: rec.source, note: rec.note } };
    if (now < slotMs(date, s.start)) return { slot_id: s.id, slot_name: s.name, status: 'waiting' };
    if (now <= slotMs(date, s.end)) return { slot_id: s.id, slot_name: s.name, status: 'can_checkin' };
    return { slot_id: s.id, slot_name: s.name, status: 'absent' };
  });
}

r.get('/:id/attendance/my', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const p = ensurePolicy(ctx.team.id, req.user.id);
  const today = cnDateStr();
  const now = Date.now();
  const inScope = membersInScope(ctx.team.id, p).includes(req.user.id);
  const workingToday = isWorkingDate(p, today);
  const todayRecords = db.prepare(
    'SELECT * FROM attendance_record WHERE team_id = ? AND user_id = ? AND date = ?'
  ).all(ctx.team.id, req.user.id, today);
  const todayLeaves = db.prepare(
    `SELECT * FROM attendance_leave WHERE team_id = ? AND user_id = ? AND status IN ('approved','pending')
       AND start_date <= ? AND end_date >= ?`
  ).all(ctx.team.id, req.user.id, today, today);

  const recent = [];
  for (let i = 13; i >= 0; i--) {
    const d = addDays(today, -i);
    if (!isWorkingDate(p, d)) { recent.push({ date: d, working: false }); continue; }
    const dRecords = db.prepare(
      'SELECT * FROM attendance_record WHERE team_id = ? AND user_id = ? AND date = ?'
    ).all(ctx.team.id, req.user.id, d);
    const dLeaves = db.prepare(
      `SELECT * FROM attendance_leave WHERE team_id = ? AND user_id = ? AND status IN ('approved','pending')
         AND start_date <= ? AND end_date >= ?`
    ).all(ctx.team.id, req.user.id, d, d);
    recent.push({ date: d, working: true, cells: currentCells(p, d, req.user.id, dRecords, dLeaves, now) });
  }

  const myLeaves = db.prepare(
    `SELECT l.*, u.nickname, u.real_name FROM attendance_leave l JOIN user u ON u.id = l.user_id
     WHERE l.team_id = ? AND l.user_id = ? ORDER BY l.create_time DESC LIMIT 30`
  ).all(ctx.team.id, req.user.id);
  res.json({
    policy: {
      name: p.name, active: p.active, workdays: p.workdays, slots: p.slots,
      scope_type: p.scope_type, scope_json: p.scope_json, leave_mode: p.leave_mode,
      start_date: p.start_date, end_date: p.end_date, exceptions: p.exceptions,
    },
    is_manager: isAttendanceManager(ctx, p, req.user.id),
    in_scope: inScope,
    today_working: workingToday,
    today: workingToday ? currentCells(p, today, req.user.id, todayRecords, todayLeaves, now) : [],
    recent,
    leaves: myLeaves,
  });
});

function insertRecord(ctx, userId, date, slot, hhmm, source, opts = {}) {
  const status = recordStatus(slot, date, hhmm);
  const rr = db.prepare(
    `INSERT INTO attendance_record (team_id, user_id, date, slot_id, slot_name, checkin_time, status, source, proxy_by, code_id, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    ctx.team.id, userId, date, slot.id, slot.name, `${date} ${hhmm}:00`, status, source,
    opts.proxy_by ?? null, opts.code_id ?? null, opts.note || ''
  );
  return { id: Number(rr.lastInsertRowid), status };
}
function redeemCode(ctx, p, codeStr, userId, now = Date.now()) {
  const code = String(codeStr).trim().toUpperCase();
  const c = db.prepare('SELECT * FROM attendance_code WHERE code = ?').get(code);
  if (!c || c.team_id !== ctx.team.id) throw bad('签到码无效');
  if (c.status !== 'active' || c.date !== cnDateStr()) throw bad('签到码已失效');
  if (now > Date.parse(c.expires_at)) throw bad('签到码已过期');
  if (c.max_uses && c.use_count >= c.max_uses) throw bad('签到码使用次数已用完');
  const slot = slotById(p, c.slot_id);
  if (!slot) throw bad('签到码对应的考勤时段已不存在');
  const rec = insertRecord(ctx, userId, c.date, slot, nowHm(), 'code', { code_id: c.id });
  db.prepare('UPDATE attendance_code SET use_count = use_count + 1 WHERE id = ?').run(c.id);
  return { rec, code: c };
}
r.post('/:id/attendance/checkin', (req, res) => {
  try {
    const ctx = teamCtx(Number(req.params.id), req.user.id);
    if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
    const p = ensurePolicy(ctx.team.id, req.user.id);
    const today = cnDateStr();
    if (!isWorkingDate(p, today)) throw bad('今天不是考勤工作日');
    if (!membersInScope(ctx.team.id, p).includes(req.user.id)) throw bad('你不在当前考勤范围内');
    const body = req.body || {};
    const now = Date.now();

    if (body.code) {
      const { rec } = redeemCode(ctx, p, body.code, req.user.id, now);
      return res.status(201).json({ id: rec.id, status: rec.status, message: rec.status === 'late' ? '已通过签到码打卡（迟到）' : '签到码打卡成功' });
    }

    const slot = slotById(p, String(body.slot_id || ''));
    if (!slot) throw bad('考勤时段不存在');
    if (now < slotMs(today, slot.start)) throw bad('该时段还未到打卡时间');
    if (now > slotMs(today, slot.end)) throw bad('该时段打卡已结束，请联系考勤负责人');
    const rec = insertRecord(ctx, req.user.id, today, slot, nowHm(), 'self');
    return res.status(201).json({ id: rec.id, status: rec.status, message: rec.status === 'late' ? '打卡成功（迟到）' : '打卡成功' });
  } catch (e) {
    if (e.status === 400) return handle(res, e);
    if (/UNIQUE/.test(e.message || '')) return res.status(409).json({ error: '该时段已经打过卡' });
    return handle(res, e);
  }
});

r.post('/:id/attendance/checkin/proxy', (req, res) => {
  try {
    const ctx = teamCtx(Number(req.params.id), req.user.id);
    if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
    const p = ensurePolicy(ctx.team.id, req.user.id);
    const deny = managerDeny(ctx, p, req, res);
    if (deny) return deny;
    const b = req.body || {};
    const date = String(b.date || '').trim();
    if (!dateOk(date)) throw bad('打卡日期格式错误');
    const today = cnDateStr();
    if (date > today) throw bad('不能为未来日期代签');
    if (!isWorkingDate(p, date)) throw bad('该日期不是考勤工作日');
    const userId = Number(b.user_id);
    if (!Number.isFinite(userId) || !membersInScope(ctx.team.id, p).includes(userId)) throw bad('代签对象不在考勤范围内');
    const slot = slotById(p, String(b.slot_id || ''));
    if (!slot) throw bad('考勤时段不存在');
    let hh = String(b.time || '').trim();
    if (!hh) hh = date === today ? nowHm() : (slot.late || slot.start);
    if (!hmOk(hh)) throw bad('打卡时间格式错误（HH:MM）');
    if (date === today && slotMs(today, hh) > Date.now() + 60000) throw bad('打卡时间不能晚于当前时间');
    const note = String(b.note || '').trim().slice(0, 100);
    const rec = insertRecord(ctx, userId, date, slot, hh, 'proxy', { proxy_by: req.user.id, note });
    logAudit(req, 'attendance-proxy', ctx.team.name, { user_id: userId, date, slot: slot.name });
    res.status(201).json({ id: rec.id, status: rec.status, message: rec.status === 'late' ? '已代签（迟到）' : '已代签' });
  } catch (e) {
    if (/UNIQUE/.test(e.message || '')) return res.status(409).json({ error: '该时段已经打过卡' });
    return handle(res, e);
  }
});

// ============ 签到码 ============
const genCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[randomBytes(1)[0] % chars.length];
  return s;
};

r.get('/:id/attendance/codes', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const p = ensurePolicy(ctx.team.id, req.user.id);
  const deny = managerDeny(ctx, p, req, res);
  if (deny) return deny;
  const rows = db.prepare(
    `SELECT c.*, COALESCE(u.nickname, u.username) AS creator_name
     FROM attendance_code c LEFT JOIN user u ON u.id = c.created_by
     WHERE c.team_id = ? ORDER BY c.create_time DESC LIMIT 30`
  ).all(ctx.team.id);
  res.json({ codes: rows });
});

r.post('/:id/attendance/codes', (req, res) => {
  try {
    const ctx = teamCtx(Number(req.params.id), req.user.id);
    if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
    const p = ensurePolicy(ctx.team.id, req.user.id);
    const deny = managerDeny(ctx, p, req, res);
    if (deny) return deny;
    const b = req.body || {};
    const today = cnDateStr();
    const date = String(b.date || today);
    if (!dateOk(date) || date !== today) throw bad('签到码只能针对今天发布');
    if (!isWorkingDate(p, date)) throw bad('今天不是考勤工作日');
    const slot = slotById(p, String(b.slot_id || ''));
    if (!slot) throw bad('考勤时段不存在');
    if (Date.now() > slotMs(date, slot.end)) throw bad('该时段已结束，不能发布签到码');
    const maxUses = num(b.max_uses ?? 0, 0, 999, '使用次数上限需为 0-999（0=不限）');
    let code = genCode();
    while (db.prepare('SELECT 1 FROM attendance_code WHERE code = ?').get(code)) code = genCode();
    const rr = db.prepare(
      `INSERT INTO attendance_code (team_id, code, date, slot_id, slot_name, expires_at, max_uses, created_by)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(ctx.team.id, code, date, slot.id, slot.name, `${date}T${slot.end}:00+08:00`, maxUses, req.user.id);
    logAudit(req, 'attendance-code', ctx.team.name, { code, slot: slot.name });
    res.status(201).json({
      id: Number(rr.lastInsertRowid), code, date, slot_id: slot.id, slot_name: slot.name,
      expires_at: `${date}T${slot.end}:00+08:00`, max_uses: maxUses,
    });
  } catch (e) { return handle(res, e); }
});

r.delete('/:id/attendance/codes/:cid', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const p = ensurePolicy(ctx.team.id, req.user.id);
  const deny = managerDeny(ctx, p, req, res);
  if (deny) return deny;
  const c = db.prepare('SELECT * FROM attendance_code WHERE id = ? AND team_id = ?').get(Number(req.params.cid), ctx.team.id);
  if (!c) return res.status(404).json({ error: '签到码不存在' });
  db.prepare('UPDATE attendance_code SET status = ? WHERE id = ?').run('disabled', c.id);
  res.json({ message: '签到码已停用' });
});

r.post('/:id/attendance/codes/:code/redeem', (req, res) => {
  try {
    const ctx = teamCtx(Number(req.params.id), req.user.id);
    if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
    const p = ensurePolicy(ctx.team.id, req.user.id);
    if (!membersInScope(ctx.team.id, p).includes(req.user.id)) throw bad('你不在当前考勤范围内');
    const { rec } = redeemCode(ctx, p, req.params.code, req.user.id);
    res.status(201).json({ id: rec.id, status: rec.status, message: rec.status === 'late' ? '已通过签到码打卡（迟到）' : '签到码打卡成功' });
  } catch (e) {
    if (/UNIQUE/.test(e.message || '')) return res.status(409).json({ error: '该时段已经打过卡' });
    return handle(res, e);
  }
});

// ============ 请假 ============
r.get('/:id/attendance/leaves', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const p = ensurePolicy(ctx.team.id, req.user.id);
  const mgr = isAttendanceManager(ctx, p, req.user.id);
  const status = String(req.query.status || '');
  const params = [ctx.team.id];
  let where = 'l.team_id = ?';
  if (!mgr) { where += ' AND l.user_id = ?'; params.push(req.user.id); }
  if (['pending', 'approved', 'rejected'].includes(status)) { where += ' AND l.status = ?'; params.push(status); }
  const rows = db.prepare(
    `SELECT l.*, COALESCE(u.nickname, u.username) AS nickname, u.real_name,
            COALESCE(rv.nickname, rv.username) AS reviewer_name
     FROM attendance_leave l
     JOIN user u ON u.id = l.user_id
     LEFT JOIN user rv ON rv.id = l.reviewer_id
     WHERE ${where} ORDER BY l.create_time DESC LIMIT 100`
  ).all(...params);
  res.json({ leaves: rows, is_manager: mgr });
});

r.post('/:id/attendance/leaves', (req, res) => {
  try {
    const ctx = teamCtx(Number(req.params.id), req.user.id);
    if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
    const p = ensurePolicy(ctx.team.id, req.user.id);
    const b = req.body || {};
    const start = String(b.start_date || '').trim();
    const end = String(b.end_date || '').trim();
    if (!dateOk(start) || !dateOk(end)) throw bad('请假日期格式错误');
    if (end < start) throw bad('结束日期不能早于开始日期');
    if (cnDay(end) - cnDay(start) > 90 * DAY) throw bad('单次请假最多 90 天');
    const slotId = String(b.slot_id || '').trim() || null;
    if (slotId && !slotById(p, slotId)) throw bad('考勤时段不存在');
    const leaveType = String(b.leave_type || '事假').trim().slice(0, 10);
    if (!leaveType) throw bad('请选择请假类型');
    const reason = String(b.reason || '').trim();
    if (!reason || reason.length > 200) throw bad('请假原因需 1-200 字');

    const overlap = db.prepare(
      `SELECT 1 FROM attendance_leave WHERE team_id = ? AND user_id = ?
         AND status IN ('pending','approved') AND start_date <= ? AND end_date >= ?
         AND (slot_id IS NULL OR slot_id = ? OR ? IS NULL) LIMIT 1`
    ).get(ctx.team.id, req.user.id, end, start, slotId, slotId);
    if (overlap) throw Object.assign(new Error('请假时间与已有请假重叠'), { status: 409 });

    const register = p.leave_mode === 'register';
    const rr = db.prepare(
      `INSERT INTO attendance_leave (team_id, user_id, start_date, end_date, slot_id, leave_type, reason, status, reviewer_id, review_note, review_time)
       VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))`
    ).run(
      ctx.team.id, req.user.id, start, end, slotId, leaveType, reason,
      register ? 'approved' : 'pending',
      register ? req.user.id : null,
      register ? '仅登记' : ''
    );
    const lid = Number(rr.lastInsertRowid);
    if (!register) {
      const me = db.prepare('SELECT nickname, real_name FROM user WHERE id = ?').get(req.user.id);
      const range = start === end ? start : `${start} 至 ${end}`;
      notify(managerUserIds(ctx.team.id, p).filter((x) => x !== req.user.id), 'attendance_leave',
        '新请假申请', `${displayNameOf(me)} 请假 ${range}（${leaveType}）：${reason}`, `/team?team=${ctx.team.id}`);
    }
    logAudit(req, 'attendance-leave', ctx.team.name, { lid, range: `${start}~${end}`, mode: register ? 'register' : 'approval' });
    res.status(201).json({ id: lid, status: register ? 'approved' : 'pending', message: register ? '请假已登记' : '请假已提交，等待负责人审批' });
  } catch (e) { return handle(res, e); }
});

r.put('/:id/attendance/leaves/:lid/status', (req, res) => {
  try {
    const ctx = teamCtx(Number(req.params.id), req.user.id);
    if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
    const p = ensurePolicy(ctx.team.id, req.user.id);
    const deny = managerDeny(ctx, p, req, res);
    if (deny) return deny;
    const l = db.prepare('SELECT * FROM attendance_leave WHERE id = ? AND team_id = ?').get(Number(req.params.lid), ctx.team.id);
    if (!l) return res.status(404).json({ error: '请假单不存在' });
    if (l.status !== 'pending') return res.status(400).json({ error: '该请假单已处理' });
    const status = String((req.body || {}).status || '');
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: '审批状态错误' });
    const note = String((req.body || {}).review_note || '').trim().slice(0, 100);
    db.prepare(
      `UPDATE attendance_leave SET status = ?, reviewer_id = ?, review_note = ?, review_time = datetime('now','localtime') WHERE id = ?`
    ).run(status, req.user.id, note, l.id);
    const me = db.prepare('SELECT nickname, real_name FROM user WHERE id = ?').get(req.user.id);
    notify([l.user_id], 'attendance_leave', status === 'approved' ? '请假已批准' : '请假已驳回',
      `${status === 'approved' ? '批准' : '驳回'}你的请假（${l.start_date} 至 ${l.end_date}）${note ? `：${note}` : ''}`,
      `/team?team=${ctx.team.id}`);
    logAudit(req, 'attendance-leave-review', ctx.team.name, { lid: l.id, status });
    res.json({ message: status === 'approved' ? '已批准' : '已驳回' });
  } catch (e) { return handle(res, e); }
});

r.delete('/:id/attendance/leaves/:lid', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const p = ensurePolicy(ctx.team.id, req.user.id);
  const mgr = isAttendanceManager(ctx, p, req.user.id);
  const l = db.prepare('SELECT * FROM attendance_leave WHERE id = ? AND team_id = ?').get(Number(req.params.lid), ctx.team.id);
  if (!l) return res.status(404).json({ error: '请假单不存在' });
  if (l.user_id !== req.user.id && !mgr) return res.status(403).json({ error: '仅本人或考勤负责人可删除' });
  if (l.status === 'approved') return res.status(400).json({ error: '已批准的请假不能删除' });
  db.prepare('DELETE FROM attendance_leave WHERE id = ?').run(l.id);
  res.json({ message: '请假单已删除' });
});

// ============ 看板与统计 ============
r.get('/:id/attendance/board', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const p = ensurePolicy(ctx.team.id, req.user.id);
  const deny = managerDeny(ctx, p, req, res);
  if (deny) return deny;
  const date = dateOk(req.query.date) ? req.query.date : cnDateStr();
  const working = isWorkingDate(p, date);
  const scope = membersInScope(ctx.team.id, p);
  if (!working || !scope.length) return res.json({ date, working, slots: working ? p.slots : [], rows: [] });
  const now = Date.now();
  const records = db.prepare(
    'SELECT * FROM attendance_record WHERE team_id = ? AND date = ?'
  ).all(ctx.team.id, date);
  const leaves = db.prepare(
    `SELECT * FROM attendance_leave WHERE team_id = ? AND status IN ('approved','pending') AND start_date <= ? AND end_date >= ?`
  ).all(ctx.team.id, date, date);
  const memberRows = db.prepare(MEMBER_SQL).all(ctx.team.id)
    .filter((m) => scope.includes(m.id))
    .map((m) => {
      const r2 = records.filter((x) => x.user_id === m.id);
      const l2 = leaves.filter((x) => x.user_id === m.id);
      return {
        ...m, is_owner: m.id === ctx.team.owner_id,
        role_names: roleNamesOf(ctx.team.id, m.id),
        cells: currentCells(p, date, m.id, r2, l2, now),
      };
    });
  res.json({ date, working, slots: p.slots, rows: memberRows });
});

r.get('/:id/attendance/stats', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const p = ensurePolicy(ctx.team.id, req.user.id);
  const deny = managerDeny(ctx, p, req, res);
  if (deny) return deny;
  const today = cnDateStr();
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : today.slice(0, 7);
  const [Y, M] = month.split('-').map(Number);
  const last = new Date(Date.UTC(Y, M, 0)).getUTCDate();
  const scope = membersInScope(ctx.team.id, p);
  const rows = scope.map((uid) => ({ user_id: uid, normal: 0, late: 0, leave: 0, leave_pending: 0, absent: 0, total: 0 }));
  for (let day = 1; day <= last; day++) {
    const d = `${month}-${String(day).padStart(2, '0')}`;
    if (!isWorkingDate(p, d)) continue;
    const records = db.prepare('SELECT * FROM attendance_record WHERE team_id = ? AND date = ?').all(ctx.team.id, d);
    const leaves = db.prepare(
      `SELECT * FROM attendance_leave WHERE team_id = ? AND status IN ('approved','pending') AND start_date <= ? AND end_date >= ?`
    ).all(ctx.team.id, d, d);
    for (const row of rows) {
      const recs = records.filter((x) => x.user_id === row.user_id);
      const ls = leaves.filter((x) => x.user_id === row.user_id);
      for (const s of p.slots) {
        row.total++;
        const leave = ls.find((x) => !x.slot_id || x.slot_id === s.id);
        const rec = recs.find((x) => x.slot_id === s.id);
        if (leave) {
          if (leave.status === 'approved') row.leave++;
          else row.leave_pending++;
        } else if (rec) {
          if (rec.status === 'late') row.late++; else row.normal++;
        } else {
          row.absent++;
        }
      }
    }
  }
  const memberMapRows = memberMap(ctx.team.id, rows.map((x) => x.user_id));
  res.json({
    month,
    rows: rows.map((x) => ({ ...x, nickname: memberMapRows[x.user_id]?.nickname || '', real_name: memberMapRows[x.user_id]?.real_name || '' })),
  });
});

export default r;
