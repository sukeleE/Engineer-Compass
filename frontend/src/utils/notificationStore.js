import { computed, reactive } from 'vue';
import { api } from '../api.js';
import auth from '../auth.js';

const EMPTY = { total: 0, comments: 0, likes: 0, favs: 0, dm: 0, notices: 0 };

export const notificationState = reactive({
  counts: { ...EMPTY },
  loading: false,
  error: '',
  updatedAt: 0,
});

export const unreadTotal = computed(() => notificationState.counts.total || 0);

let timer = null;
let inFlight = null;
let started = false;
let fastHolds = 0;
let bound = false;
let stateVersion = 0;
let ws = null;
let realtimeTimer = null;
let realtimeAttempts = 0;

function normalize(next = {}) {
  const raw = { ...EMPTY, ...next };
  const counts = {
    comments: Number(raw.comments) || 0,
    likes: Number(raw.likes) || 0,
    favs: Number(raw.favs) || 0,
    dm: Number(raw.dm) || 0,
    notices: Number(raw.notices) || 0,
  };
  counts.total = counts.comments + counts.likes + counts.favs + counts.dm + counts.notices;
  return counts;
}

export function applyUnreadCounts(next) {
  Object.assign(notificationState.counts, normalize(next));
  notificationState.updatedAt = Date.now();
  notificationState.error = '';
  stateVersion++;
}

export function setUnreadKey(key, value) {
  if (!(key in notificationState.counts) || key === 'total') return;
  notificationState.counts[key] = Math.max(0, Number(value) || 0);
  notificationState.counts.total =
    notificationState.counts.comments + notificationState.counts.likes +
    notificationState.counts.favs + notificationState.counts.dm + notificationState.counts.notices;
  notificationState.updatedAt = Date.now();
  stateVersion++;
}

export function clearNotificationTypes(types = []) {
  const map = { comment: 'comments', like: 'likes', fav: 'favs', notice: 'notices' };
  for (const type of types) {
    const key = map[type];
    if (key) notificationState.counts[key] = 0;
  }
  notificationState.counts.total =
    notificationState.counts.comments + notificationState.counts.likes +
    notificationState.counts.favs + notificationState.counts.dm + notificationState.counts.notices;
  notificationState.updatedAt = Date.now();
  stateVersion++;
}

export async function refreshUnread({ force = false } = {}) {
  if (!auth.user?.id) {
    applyUnreadCounts(EMPTY);
    return notificationState.counts;
  }
  if (inFlight && !force) return inFlight;
  if (inFlight) return inFlight;
  notificationState.loading = true;
  const requestVersion = stateVersion;
  inFlight = api.notificationsUnread()
    .then((r) => {
      if (requestVersion === stateVersion) applyUnreadCounts(r);
      return notificationState.counts;
    })
    .catch((e) => {
      notificationState.error = e.message || '未读数刷新失败';
      return notificationState.counts;
    })
    .finally(() => {
      notificationState.loading = false;
      inFlight = null;
    });
  return inFlight;
}

function intervalMs() {
  if (typeof document !== 'undefined' && document.hidden) return 30000;
  return fastHolds > 0 ? 1200 : 3000;
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    await refreshUnread();
    if (started) schedule();
  }, intervalMs());
}

function onVisibility() {
  if (document.visibilityState === 'visible') {
    refreshUnread({ force: true });
    connectRealtime();
  }
  schedule();
}

function bindEvents() {
  if (bound || typeof window === 'undefined') return;
  bound = true;
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onVisibility);
  window.addEventListener('online', onVisibility);
  window.addEventListener('pageshow', onVisibility);
}

function unbindEvents() {
  if (!bound || typeof window === 'undefined') return;
  bound = false;
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('focus', onVisibility);
  window.removeEventListener('online', onVisibility);
  window.removeEventListener('pageshow', onVisibility);
}

function scheduleRealtimeReconnect() {
  if (!started || !auth.user?.id || typeof window === 'undefined') return;
  clearTimeout(realtimeTimer);
  const delay = Math.min(15000, 1000 * (2 ** Math.min(realtimeAttempts, 4)));
  realtimeAttempts++;
  realtimeTimer = setTimeout(connectRealtime, delay);
}

async function connectRealtime() {
  if (!started || !auth.user?.id || typeof WebSocket === 'undefined') return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(realtimeTimer);
  try {
    const { ticket } = await api.realtimeTicket();
    if (!ticket || !started) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/api/realtime/ws?ticket=${encodeURIComponent(ticket)}`;
    ws = new WebSocket(url);
    ws.onopen = () => {
      realtimeAttempts = 0;
      refreshUnread({ force: true });
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data || '{}');
        if (msg.event === 'unread_changed' && msg.counts) applyUnreadCounts(msg.counts);
      } catch { /* 忽略坏帧 */ }
    };
    ws.onclose = () => {
      ws = null;
      scheduleRealtimeReconnect();
    };
    ws.onerror = () => {
      try { ws?.close(); } catch { /* 已关闭 */ }
    };
  } catch {
    scheduleRealtimeReconnect();
  }
}

function disconnectRealtime() {
  clearTimeout(realtimeTimer);
  realtimeTimer = null;
  realtimeAttempts = 0;
  if (ws) {
    ws.onclose = null;
    try { ws.close(); } catch { /* 已关闭 */ }
    ws = null;
  }
}

export function startNotificationRealtime() {
  if (started) return;
  started = true;
  bindEvents();
  refreshUnread({ force: true });
  connectRealtime();
  schedule();
}

export function stopNotificationRealtime() {
  started = false;
  clearTimeout(timer);
  timer = null;
  disconnectRealtime();
  unbindEvents();
}

export function holdFastPolling() {
  fastHolds++;
  schedule();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fastHolds = Math.max(0, fastHolds - 1);
    if (started) schedule();
  };
}
