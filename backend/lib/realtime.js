import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import db from '../db/database.js';
import { unreadSnapshot } from './notificationCounts.js';

const TICKET_TTL_MS = 30 * 1000;
const tickets = new Map();
const userSockets = new Map();
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

let attached = false;
let heartbeatTimer = null;
let watchTimer = null;

function addSocket(userId, ws) {
  const uid = Number(userId);
  if (!userSockets.has(uid)) userSockets.set(uid, new Set());
  userSockets.get(uid).add(ws);
}

function removeSocket(userId, ws) {
  const set = userSockets.get(Number(userId));
  if (!set) return;
  set.delete(ws);
  if (!set.size) userSockets.delete(Number(userId));
}

export function issueRealtimeTicket(userId) {
  const ticket = randomBytes(24).toString('base64url');
  tickets.set(ticket, { userId: Number(userId), expiresAt: Date.now() + TICKET_TTL_MS });
  return { ticket, expires_in: Math.floor(TICKET_TTL_MS / 1000) };
}

function consumeRealtimeTicket(ticket) {
  const row = tickets.get(String(ticket || ''));
  tickets.delete(String(ticket || ''));
  if (!row || row.expiresAt < Date.now()) return null;
  return row.userId;
}

export function publishToUser(userId, event, data = {}) {
  const set = userSockets.get(Number(userId));
  if (!set?.size) return 0;
  const payload = JSON.stringify({ event, ...data });
  let sent = 0;
  for (const ws of set) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    try { ws.send(payload); sent++; } catch { /* 下一轮 close 清理 */ }
  }
  return sent;
}

export function publishUnread(userId) {
  if (!userSockets.get(Number(userId))?.size) return 0;
  return publishToUser(userId, 'unread_changed', {
    counts: unreadSnapshot(db, userId),
  });
}

function maxId(sql) {
  return Number(db.prepare(sql).get()?.id || 0);
}

function startWatchers() {
  const cursors = {
    notification: maxId('SELECT MAX(id) AS id FROM notification'),
    personal_notice: maxId('SELECT MAX(id) AS id FROM personal_notice'),
    dm_message: maxId('SELECT MAX(id) AS id FROM dm_message'),
  };
  const sources = [
    ['notification', 'user_id', 'SELECT id, user_id FROM notification WHERE id > ? ORDER BY id LIMIT 200'],
    ['personal_notice', 'user_id', 'SELECT id, user_id FROM personal_notice WHERE id > ? ORDER BY id LIMIT 200'],
    ['dm_message', 'to_id', 'SELECT id, to_id AS user_id FROM dm_message WHERE id > ? ORDER BY id LIMIT 200'],
  ];
  watchTimer = setInterval(() => {
    for (const [source, , sql] of sources) {
      let rows;
      try { rows = db.prepare(sql).all(cursors[source]); } catch { continue; }
      if (!rows.length) continue;
      cursors[source] = Number(rows[rows.length - 1].id);
      const users = new Set(rows.map((r) => Number(r.user_id)).filter(Boolean));
      for (const userId of users) {
        publishUnread(userId);
        publishToUser(userId, 'notification_new', { source });
      }
    }
  }, 700);
  watchTimer.unref?.();
}

export function attachRealtimeServer(server) {
  if (attached) return;
  attached = true;

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); } catch { socket.destroy(); return; }
    if (url.pathname !== '/api/realtime/ws') { socket.destroy(); return; }
    const userId = consumeRealtimeTicket(url.searchParams.get('ticket'));
    if (!userId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = userId;
      addSocket(userId, ws);
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => removeSocket(ws.userId, ws));
    ws.on('error', () => removeSocket(ws.userId, ws));
    try {
      ws.send(JSON.stringify({ event: 'ready' }));
      ws.send(JSON.stringify({ event: 'unread_changed', counts: unreadSnapshot(db, ws.userId) }));
    } catch { /* 连接已断开 */ }
  });
  wss.on('error', (e) => console.error('WebSocket 服务错误:', e.message));

  heartbeatTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        removeSocket(ws.userId, ws);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* 下一轮清理 */ }
    }
  }, 30000);
  heartbeatTimer.unref?.();

  startWatchers();
  setInterval(() => {
    const now = Date.now();
    for (const [ticket, row] of tickets) {
      if (row.expiresAt < now) tickets.delete(ticket);
    }
  }, 60000).unref?.();
}
