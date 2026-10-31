// 周期打卡 / 定时汇报：任务管理、提交（含自评）、组长评分与优秀标记、提交看板、排行榜、优秀墙
import { Router } from 'express';
import db from '../db/database.js';
import { authRequired, teamCtx, requirePerm, hasPerm } from './middleware.js';
import { sanitizeAttachments } from './teamCollab.js';
import {
  cnDateStr, parseWeekdays, currentDue, checkOccurrence, boardPeriods,
  periodLabel, streakOf, sanitizeHtml, isWeeklyV2, weeklyShiftOccurrence,
} from '../lib/checkin.js';

const r = Router();
r.use(authRequired);

const MEMBER_SQL = `
  SELECT u.id, COALESCE(u.nickname, u.username) AS name, u.real_name, u.avatar
  FROM team_member tm JOIN user u ON u.id = tm.user_id
  WHERE tm.team_id = ? ORDER BY tm.join_time, u.id`;

function scheduleRow(teamId, sid) {
  return db.prepare('SELECT * FROM checkin_schedule WHERE id = ? AND team_id = ?').get(Number(sid), Number(teamId));
}
const int01 = (v) => (v ? 1 : 0);

// 归一化并校验建/改任务字段；partial=false（创建）要求关键字段齐全
function normBody(body, { partial = false, prev = null } = {}) {
  const get = (k, d) => (body[k] === undefined ? d : body[k]);
  const kind = get('kind', prev?.kind || 'recurring');
  if (!['recurring', 'once'].includes(kind)) throw bad('任务类型错误');
  const out = { kind };
  out.title = String(get('title', prev?.title || '')).trim();
  if (out.title.length < 1 || out.title.length > 40) throw bad('任务标题需 1–40 字');
  out.allow_late = int01(get('allow_late', prev ? prev.allow_late : 1));
  out.need_self_progress = int01(get('need_self_progress', prev?.need_self_progress ?? 0));
  out.need_self_rating = int01(get('need_self_rating', prev?.need_self_rating ?? 0));
  const auto = Number(get('auto_feature', prev?.auto_feature ?? 0));
  out.auto_feature = [0, 4, 5].includes(auto) ? auto : 0;

  if (kind === 'once') {
    out.once_at = String(get('once_at', prev?.once_at || '')).trim();
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/.test(out.once_at)) throw bad('请选择定时汇报的截止日期与时间');
    out.freq = 'daily';
    out.weekdays = '[]';
    out.due_time = '21:00';
    out.start_date = out.once_at.slice(0, 10);
    out.end_date = out.start_date;
  } else {
    out.freq = get('freq', prev?.freq || 'daily');
    if (!['daily', 'weekly'].includes(out.freq)) throw bad('周期类型错误');
    out.due_time = String(get('due_time', prev?.due_time || '21:00')).trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(out.due_time)) throw bad('截止时间格式错误（HH:MM）');
    out.weekdays = '[]';
    if (out.freq === 'weekly') {
      const prevWd = prev ? parseWeekdays(prev.weekdays) : [];
      const wd = parseWeekdays(JSON.stringify(get('weekdays', prev ? JSON.parse(prev.weekdays || '[]') : [])));
      if (!wd.length) throw bad('请选择每周截止星期');
      // 新版周报一个周期只有一个截止星期；旧版一周多次打卡（历史数据）保留多选
      if (wd.length > 1 && prevWd.length <= 1) {
        throw bad('每周周期任务只能选择一个截止星期；如需一周多次提交，请创建多个每周任务或使用每日任务');
      }
      out.weekdays = JSON.stringify(wd);
    }
    out.start_date = String(get('start_date', prev?.start_date || cnDateStr())).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.start_date)) throw bad('开始日期格式错误');
    const end = get('end_date', prev?.end_date || '');
    out.end_date = end ? String(end).trim() : '';
    if (out.end_date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(out.end_date)) throw bad('结束日期格式错误');
      if (out.end_date < out.start_date) throw bad('结束日期不能早于开始日期');
    }
    out.once_at = '';
  }
  out.active = int01(get('active', prev ? prev.active : 1));
  return out;
}
function bad(msg) { const e = new Error(msg); e.status = 400; return e; }
function handle(res, e) { return res.status(e.status || 500).json({ error: e.message || '服务器错误' }); }

// ============ 打卡任务 CRUD ============
r.get('/:id/checkin/schedules', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const rows = db.prepare(
    'SELECT * FROM checkin_schedule WHERE team_id = ? ORDER BY active DESC, id DESC'
  ).all(ctx.team.id);
  res.json({ schedules: rows.map((s) => ({ ...s, weekdays: parseWeekdays(s.weekdays) })), can_manage: hasPerm(ctx, 'task') });
});

r.post('/:id/checkin/schedules', (req, res) => {
  try {
    const ctx = teamCtx(Number(req.params.id), req.user.id);
    const deny = requirePerm(ctx, res, 'task');
    if (deny) return deny;
    const b = normBody(req.body || {});
    const rr = db.prepare(
      `INSERT INTO checkin_schedule
       (team_id, title, kind, freq, weekdays, due_time, start_date, end_date, once_at,
        allow_late, need_self_progress, need_self_rating, auto_feature, active, creator_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(ctx.team.id, b.title, b.kind, b.freq, b.weekdays, b.due_time, b.start_date, b.end_date || null,
      b.once_at || null, b.allow_late, b.need_self_progress, b.need_self_rating, b.auto_feature, b.active, req.user.id);
    res.status(201).json({ id: rr.lastInsertRowid, message: '打卡任务已创建' });
  } catch (e) { return handle(res, e); }
});

r.put('/:id/checkin/schedules/:sid', (req, res) => {
  try {
    const ctx = teamCtx(Number(req.params.id), req.user.id);
    const deny = requirePerm(ctx, res, 'task');
    if (deny) return deny;
    const sched = scheduleRow(ctx.team.id, req.params.sid);
    if (!sched) return res.status(404).json({ error: '打卡任务不存在' });
    const b = normBody(req.body || {}, { prev: sched });
    db.prepare(
      `UPDATE checkin_schedule SET title=?, kind=?, freq=?, weekdays=?, due_time=?, start_date=?, end_date=?,
        once_at=?, allow_late=?, need_self_progress=?, need_self_rating=?, auto_feature=?, active=? WHERE id=?`
    ).run(b.title, b.kind, b.freq, b.weekdays, b.due_time, b.start_date, b.end_date || null,
      b.once_at || null, b.allow_late, b.need_self_progress, b.need_self_rating, b.auto_feature, b.active, sched.id);
    res.json({ message: '已保存' });
  } catch (e) { return handle(res, e); }
});

r.delete('/:id/checkin/schedules/:sid', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  const deny = requirePerm(ctx, res, 'task');
  if (deny) return deny;
  const sched = scheduleRow(ctx.team.id, req.params.sid);
  if (!sched) return res.status(404).json({ error: '打卡任务不存在' });
  // 历史汇报保留为普通时间线条目（解除挂接，不删数据）
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE progress_log SET schedule_id = NULL WHERE schedule_id = ?').run(sched.id);
    db.prepare('DELETE FROM checkin_schedule WHERE id = ?').run(sched.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ message: '打卡任务已删除（历史汇报保留在时间线）' });
});

// ============ 提交 / 今日待办 ============
r.post('/:id/checkin/submit', (req, res) => {
  try {
    const ctx = teamCtx(Number(req.params.id), req.user.id);
    const deny = requirePerm(ctx, res, 'progress');
    if (deny) return deny;
    const body = req.body || {};
    const sched = scheduleRow(ctx.team.id, body.schedule_id);
    if (!sched || !sched.active) return res.status(404).json({ error: '打卡任务不存在或已停用' });
    if (!body.period_key) return res.status(400).json({ error: '缺少周期标识' });
    const occ = checkOccurrence(sched, String(body.period_key));

    const content = sanitizeHtml(body.content || '');
    let att = [];
    try { att = sanitizeAttachments(body.attachments); } catch (e) { return res.status(413).json({ error: e.message }); }
    if (!content.replace(/<[^>]*>/g, '').trim() && !att.length) {
      return res.status(400).json({ error: '汇报内容或附件至少填写一项' });
    }
    const sp = body.self_progress;
    const sr = body.self_rating;
    const selfProgress = sched.need_self_progress ? clampInt(sp, 0, 100, '自评进度需为 0–100') : null;
    const selfRating = sched.need_self_rating ? clampInt(sr, 1, 5, '自评星级需为 1–5') : null;

    const existing = db.prepare(
      'SELECT * FROM progress_log WHERE schedule_id = ? AND user_id = ? AND period_key = ?'
    ).get(sched.id, req.user.id, occ.key);
    if (existing) {
      if (existing.user_id !== req.user.id && !hasPerm(ctx, 'task')) {
        return res.status(403).json({ error: '仅本人或有任务管理权限者可修改' });
      }
      db.prepare(
        `UPDATE progress_log SET content=?, attachments=?, self_progress=?, self_rating=?, is_late=? WHERE id=?`
      ).run(content, JSON.stringify(att), selfProgress, selfRating, occ.late, existing.id);
      return res.json({ id: existing.id, late: occ.late, message: occ.late ? '已补交（标记迟交）' : '打卡已更新' });
    }
    const rr = db.prepare(
      `INSERT INTO progress_log (team_id, user_id, content, attachments, schedule_id, period_key,
        self_progress, self_rating, is_late) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(ctx.team.id, req.user.id, content, JSON.stringify(att), sched.id, occ.key,
      selfProgress, selfRating, occ.late);
    res.status(201).json({ id: rr.lastInsertRowid, late: occ.late, message: occ.late ? '已补交（标记迟交）' : '打卡成功' });
  } catch (e) { return handle(res, e); }
});

function clampInt(v, min, max, msg) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n < min || n > max) { const e = new Error(msg); e.status = 400; throw e; }
  return n;
}

// 今日（含最近一期未交）待办：供进度页顶部待办条
r.get('/:id/checkin/my', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const now = new Date();
  const list = db.prepare('SELECT * FROM checkin_schedule WHERE team_id = ? AND active = 1 ORDER BY id DESC')
    .all(ctx.team.id);
  const logStmt = db.prepare(
    'SELECT id, is_late, self_progress, self_rating, score, featured FROM progress_log WHERE schedule_id = ? AND user_id = ? AND period_key = ?'
  );
  const toItem = (s, due, log, overdue = false) => ({
    schedule: { ...s, weekdays: parseWeekdays(s.weekdays) },
    period_key: due.key, due_at: due.dueAt,
    period_start: due.periodStart || null, period_end: due.periodEnd || due.date,
    late: !!log?.is_late, overdue,
    status: log ? 'submitted' : (now.getTime() > due.dueMs ? (s.allow_late ? 'late_window' : 'missed') : 'waiting'),
    log: log || null,
  });
  const out = [];
  for (const s of list) {
    const due = currentDue(s, now);
    if (due) out.push(toItem(s, due, logStmt.get(s.id, req.user.id, due.key)));
    // 新版周报（长期允许补交）：再找最近一期已截止但未提交的历史周期，作为补交入口
    if (due && isWeeklyV2(s) && s.allow_late) {
      for (let i = 1; i <= 52; i++) {
        const prev = weeklyShiftOccurrence(s, due, -i);
        if (s.start_date && prev.date < s.start_date) break;
        if (now.getTime() <= prev.dueMs) continue;
        const prevLog = logStmt.get(s.id, req.user.id, prev.key);
        if (!prevLog) { out.push(toItem(s, prev, null, true)); break; }
      }
    }
  }
  res.json({ dues: out });
});

// ============ 看板（谁已交/迟交/缺卡） ============
r.get('/:id/checkin/schedules/:sid/board', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const sched = scheduleRow(ctx.team.id, req.params.sid);
  if (!sched) return res.status(404).json({ error: '打卡任务不存在' });
  const periods = boardPeriods(sched, new Date());
  const roles = db.prepare('SELECT id, name, level FROM team_role WHERE team_id = ? ORDER BY level DESC, id').all(ctx.team.id);
  // 成员 → 角色（含组长标记），与 team.js roleMapOf 同口径
  const roleRows = db.prepare(
    `SELECT tmr.user_id, tr.id AS role_id, tr.name AS role_name
     FROM team_member_role tmr JOIN team_role tr ON tr.id = tmr.role_id
     WHERE tmr.team_id = ? ORDER BY tr.level DESC, tr.id`
  ).all(ctx.team.id);
  const roleMap = {};
  for (const rr of roleRows) (roleMap[rr.user_id] ||= []).push(rr);
  let members = db.prepare(MEMBER_SQL).all(ctx.team.id).map((m) => ({
    ...m,
    is_owner: m.id === ctx.team.owner_id,
    role_ids: (roleMap[m.id] || []).map((x) => x.role_id),
    role_names: (roleMap[m.id] || []).map((x) => x.role_name),
  }));
  // 可选：按角色筛选（role_id=数字 或 owner 仅看组长）
  const roleFilter = String(req.query.role_id || '');
  if (roleFilter === 'owner') members = members.filter((m) => m.is_owner);
  else if (roleFilter === 'none') members = members.filter((m) => !m.is_owner && !m.role_ids.length);
  else if (/^\d+$/.test(roleFilter)) members = members.filter((m) => m.role_ids.includes(Number(roleFilter)));
  const logs = periods.length
    ? db.prepare(
      `SELECT id, user_id, period_key, is_late, score, featured, create_time,
              self_progress, self_rating
       FROM progress_log WHERE team_id = ? AND schedule_id = ? AND period_key IN (${periods.map(() => '?').join(',')})`
    ).all(ctx.team.id, sched.id, ...periods.map((p) => p.key))
    : [];
  const now = Date.now();
  const cells = {};
  for (const l of logs) cells[`${l.user_id}:${l.period_key}`] = l;
  const grid = members.map((m) => ({
    ...m,
    cells: periods.map((p) => {
      const l = cells[`${m.id}:${p.key}`];
      let state = 'wait';
      if (l) state = l.is_late ? 'late' : 'on';
      else if (now > p.dueMs) state = 'miss';
      return {
        key: p.key, label: p.label, due_at: p.dueAt, state,
        log_id: l?.id || null, score: l?.score || null, featured: !!l?.featured,
        submitted_at: l?.create_time || null,
        self_progress: l?.self_progress ?? null, self_rating: l?.self_rating ?? null,
      };
    }),
  }));
  res.json({
    schedule: { ...sched, weekdays: parseWeekdays(sched.weekdays) },
    periods: periods.map((p) => ({ ...p, label: periodLabel(sched, p) })),
    members: grid, roles, role_filter: roleFilter,
    // 筛选角色的提交汇总（用于头部小统计）；未筛选时与 grid 同口径
    submitted_total: grid.reduce((n, m) => n + m.cells.filter((c) => c.state === 'on' || c.state === 'late').length, 0),
  });
});

// ============ 组长评分 / 优秀标记 ============
r.post('/:id/checkin/logs/:lid/review', (req, res) => {
  try {
    const ctx = teamCtx(Number(req.params.id), req.user.id);
    const deny = requirePerm(ctx, res, 'task');
    if (deny) return deny;
    const log = db.prepare('SELECT * FROM progress_log WHERE id = ? AND team_id = ?').get(Number(req.params.lid), ctx.team.id);
    if (!log) return res.status(404).json({ error: '汇报不存在' });
    if (!log.schedule_id) return res.status(400).json({ error: '只有周期打卡汇报可以评分' });
    const body = req.body || {};
    let score = log.score;
    if (body.score !== undefined) score = body.score === null ? null : clampInt(body.score, 1, 5, '评分需为 1–5');
    let review = log.review;
    if (body.review !== undefined) review = String(body.review || '').slice(0, 500);
    const sched = scheduleRow(ctx.team.id, log.schedule_id);
    let featured = log.featured ? 1 : 0;
    if (body.featured === 0 || body.featured === 1) featured = body.featured;            // 手动优先
    else if (score && sched?.auto_feature) featured = score >= sched.auto_feature ? 1 : 0; // 自动规则
    db.prepare('UPDATE progress_log SET score=?, review=?, reviewer_id=?, featured=? WHERE id=?')
      .run(score, review, req.user.id, featured, log.id);
    res.json({ message: '已评价', score, featured });
  } catch (e) { return handle(res, e); }
});

// ============ 排行榜 ============
r.get('/:id/checkin/leaderboard', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const range = String(req.query.range || 'month');
  const schedId = Number(req.query.schedule_id || 0);
  const where = ['l.team_id = ?', 'l.schedule_id IS NOT NULL'];
  const args = [ctx.team.id];
  if (schedId) { where.push('l.schedule_id = ?'); args.push(schedId); }
  if (range !== 'all') {
    const monthStart = `${cnDateStr().slice(0, 7)}-01`;
    where.push("date(l.create_time, '+8 hours') >= ?"); args.push(monthStart);
  }
  const rows = db.prepare(
    `SELECT l.user_id,
            COUNT(*) AS cnt,
            SUM(CASE WHEN l.is_late = 0 THEN 1 ELSE 0 END) AS ontime,
            AVG(NULLIF(l.score, 0)) AS avg_score,
            SUM(COALESCE(l.featured, 0)) AS featured_cnt
     FROM progress_log l WHERE ${where.join(' AND ')}
     GROUP BY l.user_id`
  ).all(...args);
  const dateRows = db.prepare(
    `SELECT DISTINCT l.user_id, date(l.create_time, '+8 hours') AS d
     FROM progress_log l WHERE ${where.join(' AND ')}`
  ).all(...args);
  const datesByUser = {};
  for (const x of dateRows) (datesByUser[x.user_id] ||= []).push(x.d);
  const members = db.prepare(MEMBER_SQL).all(ctx.team.id);
  const stats = new Map(rows.map((x) => [x.user_id, x]));
  const board = members.map((m) => {
    const s = stats.get(m.id);
    const cnt = s?.cnt || 0;
    return {
      ...m, cnt,
      ontime: s?.ontime || 0,
      punctuality: cnt ? Math.round((s.ontime / cnt) * 100) : 0,
      avg_score: s?.avg_score ? Math.round(s.avg_score * 10) / 10 : null,
      featured_cnt: s?.featured_cnt || 0,
      streak: streakOf(datesByUser[m.id] || []),
    };
  });
  board.sort((a, b) => b.cnt - a.cnt || b.featured_cnt - a.featured_cnt
    || (b.avg_score || 0) - (a.avg_score || 0) || b.streak - a.streak);
  res.json({ board, range });
});

// ============ 优秀汇报墙 ============
r.get('/:id/checkin/featured', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const schedId = Number(req.query.schedule_id || 0);
  const where = ['l.team_id = ?', 'l.featured = 1'];
  const args = [ctx.team.id];
  if (schedId) { where.push('l.schedule_id = ?'); args.push(schedId); }
  const rows = db.prepare(
    `SELECT l.id, l.content, l.attachments, l.create_time, l.period_key, l.score, l.review,
            l.is_late, l.self_progress, l.self_rating,
            u.id AS user_id, COALESCE(u.nickname, u.username) AS nickname, u.avatar,
            cs.title AS schedule_title, cs.freq AS schedule_freq
     FROM progress_log l
     JOIN user u ON u.id = l.user_id
     LEFT JOIN checkin_schedule cs ON cs.id = l.schedule_id
     WHERE ${where.join(' AND ')}
     ORDER BY l.score DESC, l.create_time DESC LIMIT 30`
  ).all(...args).map((l) => ({
    ...l, attachments: safeParse(l.attachments), is_late: !!l.is_late,
  }));
  res.json({ reports: rows });
});
function safeParse(s) { try { return JSON.parse(s || '[]'); } catch { return []; } }

export default r;
