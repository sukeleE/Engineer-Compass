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

// 最近一个「应交期」（<= 今天且命中规则），周报提醒/今日待办都基于它；无则 null
export function currentDue(schedule, now = new Date()) {
  const today = cnDateStr(now);
  if (schedule.kind === 'once') {
    const d = (schedule.once_at || '').slice(0, 10);
    if (!d || d > today) return null;
    if (schedule.start_date && d < schedule.start_date) return null;
    return dueOf(schedule, d);
  }
  const lookback = schedule.freq === 'weekly' ? 13 : 7;
  const start = schedule.start_date || addDays(today, -lookback);
  for (let i = 0; i <= lookback; i++) {
    const d = addDays(today, -i);
    if (d < start) break;
    if (dateMatches(schedule, d)) return dueOf(schedule, d);
  }
  return null;
}

// 提交校验：period_key 必须是真实应交期；未来期拒；过期看 allow_late。返回 {date,key,late}
export function checkOccurrence(schedule, key, now = new Date()) {
  const today = cnDateStr(now);
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

// 看板周期列：每日取近 14 天；每周取近 6 周；一次性取自己
export function boardPeriods(schedule, now = new Date(), days = 14) {
  if (schedule.kind === 'once') {
    const d = (schedule.once_at || '').slice(0, 10);
    return d ? [dueOf(schedule, d)] : [];
  }
  const today = cnDateStr(now);
  const out = [];
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
  if (schedule.freq === 'weekly') return p.key.replace(/^\d+-W/, '第 ') + ' 周';
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
    if (diffMin >= 15) phase = 'missed';
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