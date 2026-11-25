// 学习小工具共享状态：番茄钟 + 倒数日
// 模块级单例：各 tab 页挂载的 FloatingDock 共用同一个计时器与倒数日列表，
// 切换页面/回到小程序时按 endAt 时间戳重算，不依赖后台常驻定时器。
import { reactive } from 'vue';

const POMO_KEY = 'ec_pomodoro';
const CD_KEY = 'ec_countdowns';
const DOCK_KEY = 'ec_dock_pos';

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
  };
  let saved = {};
  try { saved = uni.getStorageSync(POMO_KEY) || {}; } catch { /* 存储不可用 */ }
  const s = { ...defaults, ...saved };
  if (s.day !== todayStr()) {
    s.completedToday = 0;
    s.day = todayStr();
  }
  const duration = (s.mode === 'focus' ? s.focusMin : s.breakMin) * 60;
  if (s.running && (!s.endAt || s.endAt <= Date.now())) {
    s.running = false;
    s.endAt = 0;
    s.remaining = duration;
  }
  if (!Number.isFinite(s.remaining) || s.remaining < 0 || s.remaining > duration) s.remaining = duration;
  return s;
}

export const pomo = reactive(loadPomodoro());

function savePomodoro() {
  try { uni.setStorageSync(POMO_KEY, { ...pomo }); } catch { /* 忽略 */ }
}

let timer = null;
function ensureTimer() {
  if (timer) return;
  timer = setInterval(tick, 1000);
}

function notify(title) {
  try { uni.showToast({ title, icon: 'none', duration: 2600 }); } catch { /* 忽略 */ }
  try { uni.vibrateShort({ type: 'medium' }); } catch { /* 部分设备不支持 */ }
}

function complete() {
  pomo.running = false;
  pomo.endAt = 0;
  if (pomo.mode === 'focus') {
    pomo.completedToday += 1;
    pomo.mode = 'break';
    pomo.remaining = pomo.breakMin * 60;
    notify('专注完成，休息一下');
  } else {
    pomo.mode = 'focus';
    pomo.remaining = pomo.focusMin * 60;
    notify('休息结束，继续专注');
  }
  savePomodoro();
}

function tick() {
  if (!pomo.running) return;
  const left = Math.max(0, Math.ceil((pomo.endAt - Date.now()) / 1000));
  pomo.remaining = left;
  if (left <= 0) complete();
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
  if (pomo.running) return;
  pomo.focusMin = Number(min) || 25;
  if (pomo.mode === 'focus') pomo.remaining = pomo.focusMin * 60;
  savePomodoro();
}

export function setBreakMinutes(min) {
  if (pomo.running) return;
  pomo.breakMin = Number(min) || 5;
  if (pomo.mode === 'break') pomo.remaining = pomo.breakMin * 60;
  savePomodoro();
}

export function formatClock(seconds) {
  const s = Math.max(0, Math.ceil(Number(seconds) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------- 倒数日 ----------------
function loadCountdowns() {
  let list = [];
  try {
    const v = uni.getStorageSync(CD_KEY);
    if (Array.isArray(v)) list = v;
  } catch { /* 忽略 */ }
  return list
    .filter((x) => x && x.title && /^\d{4}-\d{2}-\d{2}$/.test(String(x.date)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

export const countdowns = reactive({ list: loadCountdowns() });

function saveCountdowns() {
  try { uni.setStorageSync(CD_KEY, countdowns.list); } catch { /* 忽略 */ }
}

export function addCountdown(title, date) {
  const t = String(title || '').trim().slice(0, 20);
  if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return false;
  countdowns.list.push({ id: Date.now(), title: t, date: String(date) });
  countdowns.list.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  saveCountdowns();
  return true;
}

export function removeCountdown(id) {
  countdowns.list = countdowns.list.filter((x) => x.id !== id);
  saveCountdowns();
}

// 与今天 0 点比较：正数=还剩几天，0=今天，负数=已过几天
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

// ---------------- 浮标位置（跨 tab 共享 + 本地持久化） ----------------
export const dock = reactive({
  ready: false,
  x: 0,
  y: 0,
  w: 375,
  h: 667,
});

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
let dockTopMin = 8; // 小程序页面坐标系从导航栏下方开始
let dockBottomMin = 8;
// #ifdef H5
dockTopMin = 70; // H5 预览顶部导航栏在页面内，避免浮标被盖住
dockBottomMin = 60; // H5 底部 tabbar 在页面内
// #endif

export function initDockPos() {
  if (dock.ready) return;
  let info = {};
  try {
    info = (uni.getWindowInfo && uni.getWindowInfo()) || uni.getSystemInfoSync() || {};
  } catch { /* 忽略 */ }
  dock.w = Number(info.windowWidth) || 375;
  dock.h = Number(info.windowHeight) || 667;
  const size = dock.w / 7.5; // 100rpx 对应的 px
  const margin = 8;
  let saved = null;
  try { saved = uni.getStorageSync(DOCK_KEY); } catch { /* 忽略 */ }
  const sx = saved && Number.isFinite(Number(saved.x)) ? Number(saved.x) : dock.w - size - 16;
  const sy = saved && Number.isFinite(Number(saved.y)) ? Number(saved.y) : dock.h - size - 72;
  dock.x = clamp(sx, margin, dock.w - size - margin);
  dock.y = clamp(sy, dockTopMin, dock.h - size - dockBottomMin);
  dock.ready = true;
}

export function saveDockPos(x, y) {
  const size = dock.w / 7.5;
  const margin = 8;
  dock.x = clamp(Number(x), margin, dock.w - size - margin);
  dock.y = clamp(Number(y), dockTopMin, dock.h - size - dockBottomMin);
  try { uni.setStorageSync(DOCK_KEY, { x: dock.x, y: dock.y }); } catch { /* 忽略 */ }
}

export function dockSizePx() {
  return dock.w / 7.5;
}

export function dockBounds() {
  const size = dock.w / 7.5;
  return {
    minX: 8,
    maxX: dock.w - size - 8,
    minY: dockTopMin,
    maxY: dock.h - size - dockBottomMin,
  };
}
