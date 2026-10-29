// 周期打卡引擎：周期键 / 应交期计算 / 迟到判定 / 富文本白名单净化 / 定时提醒扫描
// 时间口径统一 Asia/Shanghai（Intl 取当日日期，不依赖服务器 TZ）。
const TZ = 'Asia/Shanghai';

const dtfDate = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dtfTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const dtfDow = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' });
const DOWMAP = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function cnDateStr(d = new Date()) {
  const p = Object.fromEntries(dtfDate.formatToParts(d).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function cnParts(d = new Date()) {
  const time = Object.fromEntries(dtfTime.formatToParts(d).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return { date: cnDateStr(d), dow: DOWMAP[dtfDow.format(d)], hh: time.hour, mm: time.minute };
}

// ISO 周（周一为一周开始），返回 {year, week, key:'YYYY-Www'}
export function isoWeek(dateStr) {
  const [Y, M, D] = String(dateStr).split('-').map(Number);
  const d = new Date(Date.UTC(Y, M - 1, D));
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day + 3); // 本周四
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
  const week = 1 + Math.round((d - firstThu) / (7 * 864e5));
  return { year: d.getUTCFullYear(), week, key: `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}` };
}

const DAY = 864e5;
// 把 'YYYY-MM-DD' 当作东八区当天零点
const cnDay = (dateStr) => {
  const [Y, M, D] = String(dateStr).split('-').map(Number);
  return Date.UTC(Y, M - 1, D) - 8 * 3600e3; // 东八区 00:00 对应的 UTC 时刻
};
const addDays = (dateStr, n) => cnDateStr(new Date(cnDay(dateStr) + n * DAY));

export function parseWeekdays(s) {
  let a = [];
  try { a = JSON.parse(s || '[]'); } catch { a = []; }
  return [...new Set((Array.isArray(a) ? a : []).map(Number))].filter((x) => x >= 1 && x <= 7).sort();
}

export function periodKeyOf(schedule, dateStr) {
  if (schedule.kind === 'once') return dateStr;
  return schedule.freq === 'weekly' ? isoWeek(dateStr).key : dateStr;
}

// ===== 新版周报：weekdays 恰一个值 = 每期「截止星期」；周期自截止日往前 6 天 00:00 开始，周期内可提前提交 =====
// weekdays 多个值为旧版「每周多次打卡」，仍走 dateMatches 旧逻辑
export function isWeeklyV2(schedule) {
  return schedule.kind !== 'once' && schedule.freq === 'weekly'
    && parseWeekdays(schedule.weekdays).length === 1;
}
function weeklyDueDow(schedule) {
  return isWeeklyV2(schedule) ? parseWeekdays(schedule.weekdays)[0] : 0;
}
const dowOfCn = (dateStr) => DOWMAP[dtfDow.format(new Date(cnDay(dateStr)))];
// 任意日期所属周期的截止日（当天正是截止星期时为当天）
function weeklyDueDate(dueDow, dateStr) {
  return addDays(dateStr, (dueDow - dowOfCn(dateStr) + 7) % 7);
}
// 截止日对应的周期对象：periodStart=截止日-6天，periodEnd=截止日；key 取截止日所在 ISO 周
export function weeklyOccurrenceAt(schedule, dueDate) {
  const occ = dueOf(schedule, dueDate);
  occ.periodStart = addDays(dueDate, -6);
  occ.periodEnd = dueDate;
  return occ;
}
// 以截止日为锚向前 n 个周期（n 可为负表示未来）
export function weeklyShiftOccurrence(schedule, occ, n) {
  return weeklyOccurrenceAt(schedule, addDays(occ.date, n * 7));
}

// 某天是否该打卡（在生效窗口内且命中频率规则）
export function dateMatches(schedule, dateStr) {
  if (schedule.start_date && dateStr < schedule.start_date) return false;
  if (schedule.end_date && dateStr > schedule.end_date) return false;
  if (schedule.kind === 'once') return (schedule.once_at || '').slice(0, 10) === dateStr;
  if (schedule.freq === 'weekly') {
    const dow = DOWMAP[dtfDow.format(new Date(cnDay(dateStr)))];
    return parseWeekdays(schedule.weekdays).includes(dow);
  }
  return true;
}

// 某期截止时刻（ms）与展示串
export function dueOf(schedule, dateStr) {
  const hhmm = schedule.kind === 'once'
    ? ((schedule.once_at || '').slice(11, 16) || '23:59')
    : (schedule.due_time || '21:00');
  const dueMs = Date.parse(`${dateStr}T${hhmm}:00+08:00`);
  return { date: dateStr, key: periodKeyOf(schedule, dateStr), dueMs, dueAt: `${dateStr} ${hhmm}` };
}

// 最近一个「当前开放周期」：新版周报周期一开始即返回（截止日可在未来，支持提前提交）；旧版/每日取 <= 今天且命中的最近一期
export function currentDue(schedule, now = new Date()) {
  const today = cnDateStr(now);
  if (schedule.kind === 'once') {
    const d = (schedule.once_at || '').slice(0, 10);
    if (!d || d > today) return null;
    if (schedule.start_date && d < schedule.start_date) return null;
    return dueOf(schedule, d);
  }
  const v2 = weeklyDueDow(schedule);
  if (v2) {
    // 任务已整体结束则不再产生新周期（历史周期仍可按 checkOccurrence 长期补交）
    if (schedule.end_date && today > schedule.end_date) return null;
    const dueDate = weeklyDueDate(v2, today);
    if (schedule.start_date && dueDate < schedule.start_date) return null;
    // 末期：只要本期在任务结束前已经开始（周期开始日 ≤ end_date），本期仍可提交
    if (schedule.end_date && addDays(dueDate, -6) > schedule.end_date) return null;
    return weeklyOccurrenceAt(schedule, dueDate);
  }
  const lookback = 13;
  const start = schedule.start_date || addDays(today, -lookback);
  for (let i = 0; i <= lookback; i++) {
    const d = addDays(today, -i);
    if (d < start) break;
    if (dateMatches(schedule, d)) return dueOf(schedule, d);
  }
  return null;
}

// 提交校验：周期开始后即可提交（可提前）；截止前 late=0；截止后 allow_late 决定补交/拒绝；未开始或无效周期拒绝
export function checkOccurrence(schedule, key, now = new Date()) {
  const today = cnDateStr(now);
  const v2 = weeklyDueDow(schedule);
  if (v2) {
    const fail = (msg) => { const e = new Error(msg); e.status = 400; throw e; };
    // 以当前周期截止日为锚，按周反查 period_key（允许长期补交，向前扫约 5 年）
    const curDueDate = weeklyDueDate(v2, today);
    let dueDate = '';
    for (let j = -300; j <= 2; j++) {
      const d = addDays(curDueDate, j * 7);
      if (periodKeyOf(schedule, d) === key) { dueDate = d; break; }
    }
    if (!dueDate) fail('打卡周期不存在或还未开始');
    if (schedule.start_date && dueDate < schedule.start_date) fail('该周期在任务生效前已截止');
    const occ = weeklyOccurrenceAt(schedule, dueDate);
    if (schedule.end_date && occ.periodStart > schedule.end_date) fail('该周期不在任务生效区间内');
    // 首期可能在 start_date 之前就已开始：实际开放时刻取 max(周期开始, 任务开始)
    const openDate = schedule.start_date && occ.periodStart < schedule.start_date ? schedule.start_date : occ.periodStart;
    if (now.getTime() < cnDay(openDate)) fail('本期打卡还未开始，周期开始后即可提交');
    if (now.getTime() < occ.dueMs) return { ...occ, late: 0 };
    if (!schedule.allow_late) fail(`本期打卡已于 ${occ.dueAt} 截止，不能补交`);
    return { ...occ, late: 1 };
  }
  const maxScan = 400; // 防止 start_date 极早时全表扫描
  let start = schedule.start_date || addDays(today, -30);
  if (today < start) start = today;
  for (let i = 0; i <= maxScan; i++) {
    const d = addDays(start, i);
    if (d > today) break;
    if (!dateMatches(schedule, d)) continue;
    if (periodKeyOf(schedule, d) !== key) continue;
    const due = dueOf(schedule, d);
    if (now.getTime() < due.dueMs) return { date: d, key, late: 0, dueAt: due.dueAt };
    if (!schedule.allow_late) {
      const e = new Error(`本期打卡已于 ${due.dueAt} 截止，不能补交`);
      e.status = 400; throw e;
    }
    return { date: d, key, late: 1, dueAt: due.dueAt };
  }
  const e = new Error('打卡周期不存在或还未开始');
  e.status = 400; throw e;
}

// 看板周期列：每日取近 14 天；新版周报取含当前开放周期在内的近 6 期；旧版周报按已到来的打卡日；一次性取自己
export function boardPeriods(schedule, now = new Date(), days = 14) {
  if (schedule.kind === 'once') {
    const d = (schedule.once_at || '').slice(0, 10);
    return d ? [dueOf(schedule, d)] : [];
  }
  const today = cnDateStr(now);
  const out = [];
  const v2 = weeklyDueDow(schedule);
  if (v2) {
    const cur = weeklyDueDate(v2, today); // 当前周期截止日（可能在未来，本周一到周六即显示本周列）
    for (let j = 5; j >= 0; j--) {
      const d = addDays(cur, -7 * j);
      if (schedule.start_date && d < schedule.start_date) continue;
      if (schedule.end_date && addDays(d, -6) > schedule.end_date) continue;
      out.push(weeklyOccurrenceAt(schedule, d));
    }
    return out;
  }
  if (schedule.freq === 'weekly') {
    const seen = new Set();
    for (let i = 0; i < 7 * days; i++) {
      const d = addDays(today, -i);
      if (!dateMatches(schedule, d)) continue;
      const due = dueOf(schedule, d);
      if (seen.has(due.key)) continue;
      seen.add(due.key);
      out.unshift(due);
      if (out.length >= 6) break;
    }
    return out;
  }
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    if (dateMatches(schedule, d)) out.push(dueOf(schedule, d));
  }
  return out;
}

export function periodLabel(schedule, p) {
  if (schedule.kind === 'once') return `${p.date} 定时`;
  if (schedule.freq === 'weekly') {
    if (isWeeklyV2(schedule)) {
      const mmdd = (x) => x.slice(5).replace('-', '/');
      return `第${isoWeek(p.date).week}周（${mmdd(p.periodStart)}-${mmdd(p.periodEnd)}）`;
    }
    return p.key.replace(/^\d+-W/, '第 ') + ' 周';
  }
  return `${p.date.slice(5)} 周${'日一二三四五六'[DOWMAP[dtfDow.format(new Date(cnDay(p.date)))]]}`;
}

// 连续打卡天数：按东八区日期去重，从今天/昨天向前数连续日
export function streakOf(dates) {
  const set = new Set(dates);
  let anchor = cnDateStr();
  if (!set.has(anchor)) anchor = addDays(anchor, -1);
  let n = 0;
  for (let d = anchor; set.has(d); d = addDays(d, -1)) n++;
  return n;
}

// ============ 富文本白名单净化（零依赖，防 XSS / javascript:） ============
const ALLOW_TAGS = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'blockquote', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'a', 'img', 'span', 'div', 'code', 'pre', 'hr']);
const VOID_TAGS = new Set(['br', 'img', 'hr']);
const ALLOW_ATTR = { a: ['href', 'title'], img: ['src', 'alt', 'title'] };

function safeUrl(u) {
  const v = String(u || '').trim().replace(/[\u0000-\u0020]+/gi, '');
  if (/^(https?:|mailto:|\/|#|\.)/i.test(v)) return v;
  if (/^data:image\/(png|jpe?g|gif|webp|bmp);/i.test(v)) return v;
  return '';
}
// 入参是可信标签内的「重建标签」，属性只取白名单且 URL 过协议
function rebuildTag(name, rawAttrs, closing) {
  if (closing) return `</${name}>`;
  const attrs = [];
  const allowed = ALLOW_ATTR[name] || [];
  const re = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/g;
  let m;
  while ((m = re.exec(rawAttrs || ''))) {
    const k = m[1].toLowerCase();
    if (!allowed.includes(k)) continue;
    let v = m[2] ?? m[3] ?? m[4] ?? '';
    if (k === 'href' || k === 'src') v = safeUrl(v);
    if (v === '') continue;
    attrs.push(`${k}="${v.replace(/"/g, '&quot;')}"`);
  }
  const selfClose = VOID_TAGS.has(name) ? ' /' : '';
  return `<${name}${attrs.length ? ' ' + attrs.join(' ') : ''}${selfClose}>`;
}
export function sanitizeHtml(input) {
  let s = String(input || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ''); // 去注释
  s = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  s = s.replace(/<\?[\s\S]*?\?>/g, '');
  return s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (whole, rawName, rawAttrs) => {
    const name = String(rawName).toLowerCase();
    if (!ALLOW_TAGS.has(name)) return ''; // 非白名单标签整签抹掉（文字保留）
    const closing = /^<\//.test(whole);
    return rebuildTag(name, rawAttrs, closing);
  });
}

// ============ 定时提醒扫描（server.js 每 10 分钟调一次） ============
// 成员是否有「进度汇报」权限（与 middleware.hasPerm 同口径：组长恒可，否则角色并集含 progress）
function canReport(db, teamId, userId, ownerId) {
  if (userId === ownerId) return true;
  const rows = db.prepare(
    `SELECT tr.permissions AS perms FROM team_member_role tmr
     JOIN team_role tr ON tr.id = tmr.role_id
     WHERE tmr.team_id = ? AND tmr.user_id = ?`
  ).all(teamId, userId);
  return rows.some((r) => {
    try { return (JSON.parse(r.perms || '[]') || []).includes('progress'); } catch { return false; }
  });
}

export function runCheckinReminders(db, now = new Date()) {
  const schedules = db.prepare(
    `SELECT cs.*, t.name AS team_name, t.owner_id AS owner_id
     FROM checkin_schedule cs JOIN team t ON t.id = cs.team_id
     WHERE cs.active = 1`
  ).all();
  const membersStmt = db.prepare(
    `SELECT tm.user_id, COALESCE(u.nickname, u.username) AS name
     FROM team_member tm JOIN user u ON u.id = tm.user_id WHERE tm.team_id = ?`
  );
  const findLog = db.prepare(
    'SELECT id FROM progress_log WHERE schedule_id = ? AND user_id = ? AND period_key = ?'
  );
  const existsNotice = db.prepare(
    'SELECT 1 FROM personal_notice WHERE user_id = ? AND type = ? AND link = ? AND is_read = 0'
  );
  const insNotice = db.prepare(
    'INSERT INTO personal_notice (user_id, type, title, content, link) VALUES (?,?,?,?,?)'
  );
  let sent = 0;
  for (const s of schedules) {
    const due = currentDue(s, now);
    if (!due) continue;
    const diffMin = (now.getTime() - due.dueMs) / 60000;
    let phase = null;
    if (diffMin >= 15 && diffMin <= 24 * 60) phase = 'missed';
    else if (diffMin >= -60) phase = 'soon';
    if (!phase) continue;
    for (const m of membersStmt.all(s.team_id)) {
      if (!canReport(db, s.team_id, m.user_id, s.owner_id)) continue;
      if (findLog.get(s.id, m.user_id, due.key)) continue;
      const link = `/team?team=${s.team_id}&ci=${s.id}&p=${encodeURIComponent(due.key)}&ph=${phase}`;
      if (existsNotice.get(m.user_id, 'checkin_remind', link)) continue;
      const title = phase === 'soon' ? '打卡即将截止' : '你有一条打卡未提交';
      const tail = s.allow_late ? '现在仍可补交（会标记迟交）' : '本期已无法补交';
      const when = phase === 'soon' ? `将于 ${due.dueAt} 截止` : `已于 ${due.dueAt} 截止`;
      try {
        insNotice.run(m.user_id, 'checkin_remind', title, `「${s.team_name}」${s.title} ${when}，${tail}`, link);
        sent++;
      } catch { /* 单条失败不影响其它提醒 */ }
    }
  }
  return sent;
}