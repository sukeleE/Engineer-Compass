// 学习小工具状态：番茄钟 / 倒数日 / 今日待办 / 学习统计
// 模块级单例 + localStorage；计时用 endAt 时间戳校准，刷新/后台恢复不丢。
import { reactive } from 'vue';

const POMO_KEY = 'ec_pomodoro';
const COUNT_KEY = 'ec_countdowns';
const TODO_KEY = 'ec_study_todos';
const SESSION_KEY = 'ec_study_sessions';

export function todayStr(d = new Date()) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 隐私模式/超额忽略 */ }
}

// ---------------- 番茄钟 ----------------
function loadPomodoro() {
  const defaults = {
    focusMin: 25,
    breakMin: 5,
    mode: 'focus',
    running: false,
    endAt: 0,
    remaining: 25 * 60,
    completedToday: 0,
    day: todayStr(),
    task: '',
  };
  const s = { ...defaults, ...(read(POMO_KEY, {}) || {}) };
  if (s.day !== todayStr()) { s.completedToday = 0; s.day = todayStr(); }
  const duration = (s.mode === 'focus' ? s.focusMin : s.breakMin) * 60;
  if (s.running && (!s.endAt || s.endAt <= Date.now())) {
    s.running = false; s.endAt = 0; s.remaining = duration;
  }
  if (!Number.isFinite(s.remaining) || s.remaining < 0 || s.remaining > duration) s.remaining = duration;
  return s;
}

export const pomo = reactive(loadPomodoro());
let completeHandler = null;
let timer = null;

export function setPomodoroCompleteHandler(fn) { completeHandler = typeof fn === 'function' ? fn : null; }
export function savePomodoro() { write(POMO_KEY, { ...pomo }); }

export function formatClock(seconds) {
  const s = Math.max(0, Math.ceil(Number(seconds) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function ensureTimer() {
  if (timer) return;
  timer = setInterval(tick, 1000);
  if (typeof window !== 'undefined') {
    window.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  }
}

function tick() {
  if (!pomo.running) return;
  pomo.remaining = Math.max(0, Math.ceil((pomo.endAt - Date.now()) / 1000));
  if (pomo.remaining <= 0) complete();
}

function complete() {
  const wasFocus = pomo.mode === 'focus';
  pomo.running = false;
  pomo.endAt = 0;
  if (wasFocus) {
    pomo.completedToday += 1;
    addSession({
      id: Date.now(),
      date: todayStr(),
      endedAt: new Date().toISOString(),
      minutes: pomo.focusMin,
      task: pomo.task.trim(),
    });
    pomo.mode = 'break';
    pomo.remaining = pomo.breakMin * 60;
  } else {
    pomo.mode = 'focus';
    pomo.remaining = pomo.focusMin * 60;
  }
  savePomodoro();
  if (completeHandler) completeHandler({ wasFocus, minutes: pomo.focusMin });
}

export function pomodoroStart() {
  if (pomo.running) return;
  const duration = (pomo.mode === 'focus' ? pomo.focusMin : pomo.breakMin) * 60;
  if (!pomo.remaining || pomo.remaining > duration) pomo.remaining = duration;
  pomo.endAt = Date.now() + pomo.remaining * 1000;
  pomo.running = true;
  ensureTimer();
  savePomodoro();
}

export function pomodoroPause() {
  if (!pomo.running) return;
  pomo.remaining = Math.max(0, Math.ceil((pomo.endAt - Date.now()) / 1000));
  pomo.running = false;
  pomo.endAt = 0;
  savePomodoro();
}

export function pomodoroToggle() {
  if (pomo.running) pomodoroPause();
  else pomodoroStart();
}

export function pomodoroReset() {
  pomo.running = false;
  pomo.endAt = 0;
  pomo.remaining = (pomo.mode === 'focus' ? pomo.focusMin : pomo.breakMin) * 60;
  savePomodoro();
}

export function setFocusMinutes(min) {
  if (pomo.running) return false;
  pomo.focusMin = Number(min) || 25;
  if (pomo.mode === 'focus') pomo.remaining = pomo.focusMin * 60;
  savePomodoro();
  return true;
}

export function setBreakMinutes(min) {
  if (pomo.running) return false;
  pomo.breakMin = Number(min) || 5;
  if (pomo.mode === 'break') pomo.remaining = pomo.breakMin * 60;
  savePomodoro();
  return true;
}

// ---------------- 学习记录 / 统计 ----------------
export const sessions = reactive(read(SESSION_KEY, []));

function addSession(s) {
  sessions.push(s);
  if (sessions.length > 2000) sessions.splice(0, sessions.length - 2000);
  write(SESSION_KEY, [...sessions]);
}

export function todayFocusMinutes() {
  const today = todayStr();
  return sessions.filter((s) => s.date === today).reduce((n, s) => n + (Number(s.minutes) || 0), 0);
}

export function weekFocusMinutes() {
  const days = new Set();
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.add(todayStr(d));
  }
  return sessions.filter((s) => days.has(s.date)).reduce((n, s) => n + (Number(s.minutes) || 0), 0);
}

export function streakDays() {
  const set = new Set(sessions.map((s) => s.date));
  let n = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    if (!set.has(todayStr(d))) {
      if (i === 0) continue; // 今天还没专注不打断连续记录
      break;
    }
    n++;
  }
  return n;
}

export function last7Days() {
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = todayStr(d);
    out.push({
      key,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      minutes: sessions.filter((s) => s.date === key).reduce((n, s) => n + (Number(s.minutes) || 0), 0),
    });
  }
  return out;
}

// ---------------- 倒数日 ----------------
function loadCountdowns() {
  const list = read(COUNT_KEY, []);
  return (Array.isArray(list) ? list : [])
    .filter((x) => x && x.title && /^\d{4}-\d{2}-\d{2}$/.test(String(x.date)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

export const countdowns = reactive(loadCountdowns());

function saveCountdowns() { write(COUNT_KEY, [...countdowns]); }

export function addCountdown(title, date) {
  const t = String(title || '').trim().slice(0, 20);
  if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return false;
  countdowns.push({ id: Date.now(), title: t, date: String(date) });
  countdowns.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  saveCountdowns();
  return true;
}

export function removeCountdown(id) {
  const i = countdowns.findIndex((x) => x.id === id);
  if (i >= 0) { countdowns.splice(i, 1); saveCountdowns(); }
}

export function daysLeft(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return 0;
  const target = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}

export function daysText(dateStr) {
  const n = daysLeft(dateStr);
  if (n === 0) return '就是今天';
  if (n > 0) return `D-${n}`;
  return `已过 ${-n} 天`;
}

// ---------------- 今日待办 ----------------
function loadTodos() {
  const list = read(TODO_KEY, []);
  return (Array.isArray(list) ? list : []).filter((x) => x && x.text);
}

export const todos = reactive(loadTodos());

function saveTodos() { write(TODO_KEY, [...todos]); }

export function addTodo(text) {
  const t = String(text || '').trim().slice(0, 60);
  if (!t) return false;
  todos.push({ id: Date.now(), text: t, done: false, date: todayStr() });
  saveTodos();
  return true;
}

export function toggleTodo(id) {
  const t = todos.find((x) => x.id === id);
  if (t) { t.done = !t.done; saveTodos(); }
}

export function removeTodo(id) {
  const i = todos.findIndex((x) => x.id === id);
  if (i >= 0) { todos.splice(i, 1); saveTodos(); }
}

export function clearDoneTodos() {
  for (let i = todos.length - 1; i >= 0; i--) if (todos[i].done) todos.splice(i, 1);
  saveTodos();
}

// ---------------- 跨标签页同步 ----------------
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (!e.key || !e.newValue) return;
    try {
      const v = JSON.parse(e.newValue);
      if (e.key === POMO_KEY) Object.assign(pomo, v);
      if (e.key === COUNT_KEY && Array.isArray(v)) {
        countdowns.splice(0, countdowns.length, ...v);
      }
      if (e.key === TODO_KEY && Array.isArray(v)) {
        todos.splice(0, todos.length, ...v);
      }
      if (e.key === SESSION_KEY && Array.isArray(v)) {
        sessions.splice(0, sessions.length, ...v);
      }
    } catch { /* 忽略坏数据 */ }
  });
}
