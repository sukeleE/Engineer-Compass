// 消息通知实时性 UI 探针：新通知轮询、红点出现、已读后红点立即消失。
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3120;
const VITE = 5207;
const API = `http://127.0.0.1:${PORT}/api`;
const WEB = `http://localhost:${VITE}`;
const work = mkdtempSync(path.join(os.tmpdir(), 'probe_notify_'));
const env = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
  PORT: String(PORT), DB_PATH: path.join(work, 'ui.db'),
  SHARE_UPLOAD_DIR: path.join(work, 'share'), HONOR_UPLOAD_DIR: path.join(work, 'honor'),
  PURCHASE_UPLOAD_DIR: path.join(work, 'purchase'),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${extra !== undefined ? ` → ${JSON.stringify(extra)}` : ''}`); }
};
async function waitUp(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error(`服务未就绪：${url}`);
}
const jreq = async (p, o = {}) => {
  const res = await fetch(API + p, {
    headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
    method: o.method || 'GET',
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
};
const api = async (p, o = {}) => {
  const { res, data } = await jreq(p, o);
  if (!res.ok) throw new Error(`${o.method || 'GET'} ${p} → ${res.status} ${JSON.stringify(data)}`);
  return data;
};

const children = [];
function start(cmd, args, cwd, extraEnv = {}) {
  const proc = spawn(cmd, args, { cwd, env: { ...process.env, ...extraEnv }, shell: false });
  children.push(proc);
}

let browser;
let page;
let db;
const pageErrors = [];
try {
  start(process.execPath, [
    '--import', pathToFileURL(path.join(ROOT, 'scripts', 'polyfill_dom.mjs')).href,
    path.join(ROOT, 'backend', 'server.js'),
  ], work, env);
  start(process.execPath, [
    path.join(ROOT, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js'),
    '--port', String(VITE), '--strictPort',
  ], path.join(ROOT, 'frontend'), { VITE_API_TARGET: `http://127.0.0.1:${PORT}` });
  await waitUp(`${API}/health`);
  await waitUp(WEB);

  const stamp = Date.now().toString().slice(-8);
  const reg = async (tag, nick) => api('/auth/register', {
    method: 'POST',
    body: { email: `notify_${tag}_${stamp}@test.dev`, password: 'pass123456', nickname: nick },
  });
  const setRealName = async (account, name) => {
    const r = await api('/auth/real-name', {
      method: 'PUT', token: account.token, body: { real_name: name },
    });
    return { ...account, user: r.user };
  };
  const me = await setRealName(await reg('me', '实时通知甲'), '实时通知甲');
  const actor = await setRealName(await reg('actor', '实时通知乙'), '实时通知乙');
  ok('测试账号 token/user 完整', !!me.token && !!me.user?.id, { token: !!me.token, user: me.user?.id });

  db = new DatabaseSync(env.DB_PATH);
  db.exec('PRAGMA busy_timeout=5000');
  const post = db.prepare("INSERT INTO share_post (user_id, title, content) VALUES (?, '实时通知测试帖', '正文')")
    .run(me.user.id);
  const postId = Number(post.lastInsertRowid);
  const insertNotice = () => db.prepare(
    "INSERT INTO notification (user_id, actor_id, type, post_id) VALUES (?, ?, 'like', ?)"
  ).run(me.user.id, actor.user.id, postId);

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const sockets = [];
  page.on('websocket', (socket) => sockets.push(socket));
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([token, user]) => {
    localStorage.setItem('ec_token', token);
    localStorage.setItem('ec_user', JSON.stringify(user));
  }, [me.token, me.user]);
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.dock-fab', { timeout: 10000 });
  for (let i = 0; i < 50 && !sockets.length; i++) await sleep(100);
  ok('页面已建立 WebSocket 通知通道', sockets.length > 0, sockets.length);

  const noticeStarted = Date.now();
  insertNotice();
  await page.waitForFunction(() => document.querySelector('.dock-badge')?.textContent.trim() === '1', null, { timeout: 5000 });
  const noticeElapsed = Date.now() - noticeStarted;
  ok('新通知经 WebSocket 及时触发红点', noticeElapsed < 2500, noticeElapsed);

  await page.locator('.dock-fab').click();
  await page.locator('.dock-tool').filter({ hasText: '消息中心' }).click();
  await page.locator('.m-panel .el-tabs__item').filter({ hasText: '点赞' }).click();
  await page.waitForSelector('.m-panel .n-item.unread', { timeout: 5000 });
  ok('消息面板显示未读通知内容', true);

  const started = Date.now();
  await page.locator('.m-panel .n-item.unread').first().click();
  await page.waitForFunction(() => !document.querySelector('.dock-badge'), null, { timeout: 1000 });
  const elapsed = Date.now() - started;
  ok('点击已读后红点在 1 秒内立即消失', elapsed < 1000, elapsed);
  let hidden = null;
  for (let i = 0; i < 30; i++) {
    hidden = db.prepare('SELECT is_read FROM notification WHERE user_id = ?').get(me.user.id);
    if (Number(hidden?.is_read) === 1) break;
    await sleep(100);
  }
  ok('服务端通知已落库为已读', Number(hidden.is_read) === 1, hidden);

  insertNotice();
  await page.waitForFunction(() => document.querySelector('.dock-badge')?.textContent.trim() === '1', null, { timeout: 5000 });
  ok('已读后新通知仍能继续触发红点', true);

  const count = await api('/notifications/unread-count', { token: me.token });
  ok('未读计数接口一次返回完整分组', count.total === 1 && count.likes === 1 && count.comments === 0, count);
  ok('页面无运行时异常', pageErrors.length === 0, pageErrors);
} catch (e) {
  fail++;
  console.log('❌ 探针异常:', e.stack || e.message);
  if (pageErrors.length) console.log('页面错误:', pageErrors);
  try { console.log('页面文本:', (await page?.locator('body').innerText()).slice(0, 600)); } catch {}
} finally {
  try { db?.close(); } catch {}
  try { await browser?.close(); } catch {}
  for (const proc of children) { try { proc.kill(); } catch {} }
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
