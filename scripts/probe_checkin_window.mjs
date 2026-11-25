// 打卡任务窗口化/缓存 UI 探针：临时后端 + Vite，验证首屏分页、滚动追加、缓存先显。
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3119;
const VITE = 5206;
const API = `http://127.0.0.1:${PORT}/api`;
const WEB = `http://localhost:${VITE}`;
const work = mkdtempSync(path.join(os.tmpdir(), 'probe_checkin_window_'));
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
  const headers = { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) };
  const res = await fetch(API + p, {
    headers, method: o.method || 'GET',
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
  return proc;
}

let browser;
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
  const own = await api('/auth/register', {
    method: 'POST',
    body: { email: `ciw_${stamp}@test.dev`, password: 'pass123456', nickname: '窗口化组长' },
  });
  const team = await api('/team', {
    method: 'POST', token: own.token, body: { name: `打卡窗口化组${stamp}` },
  });
  const TID = team.team?.id || team.id;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  for (let i = 1; i <= 25; i++) {
    await api(`/team/${TID}/checkin/schedules`, {
      method: 'POST', token: own.token,
      body: {
        title: `打卡任务 ${String(i).padStart(2, '0')}`,
        kind: 'recurring', freq: 'daily', due_time: '23:59',
        start_date: today, allow_late: 1,
      },
    });
  }

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const scheduleRequests = [];
  page.on('request', (req) => {
    if (req.url().includes(`/api/team/${TID}/checkin/schedules?`)) scheduleRequests.push(req.url());
  });
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([token, user]) => {
    localStorage.setItem('ec_token', token);
    localStorage.setItem('ec_user', JSON.stringify(user));
  }, [own.token, own.user]);
  await page.goto(`${WEB}/team?team=${TID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ci-card', { timeout: 15000 });

  const firstWindow = await page.locator('.ci-card').count();
  ok('首屏只渲染 8 条打卡任务窗口', firstWindow === 8, firstWindow);
  const firstReq = scheduleRequests.find((u) => u.includes('limit=8') && u.includes('offset=0'));
  ok('首屏请求使用 limit=8 / offset=0', !!firstReq, scheduleRequests.slice(0, 3));
  const heading = await page.locator('.ci-sec').filter({ hasText: '打卡任务' }).first().textContent();
  ok('标题同时展示已加载数与总数', /打卡任务（8\s*\/\s*25）/.test(heading.replace(/\s+/g, ' ')), heading);

  await page.locator('.ci-more').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelectorAll('.ci-card').length > 8, null, { timeout: 10000 });
  const afterScroll = await page.locator('.ci-card').count();
  ok('滚动到尾部后自动追加下一窗口', afterScroll > 8, afterScroll);

  await page.waitForFunction(() => {
    const raw = Object.keys(localStorage)
      .filter((k) => k.startsWith('ec_swr_v1:team:'))
      .map((k) => localStorage.getItem(k))
      .find((v) => v && v.includes('"schedules"'));
    return !!raw;
  }, null, { timeout: 10000 });

  let releaseSchedules;
  let scheduleBlocked = false;
  await page.route(`**/api/team/${TID}/checkin/schedules?*`, async (route) => {
    if (!scheduleBlocked) {
      scheduleBlocked = true;
      await new Promise((resolve) => { releaseSchedules = resolve; });
    }
    try { await route.continue(); } catch { /* unroute 关闭页面时可能已处理 */ }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.ci-card', { timeout: 5000 });
  for (let i = 0; i < 20 && !scheduleBlocked; i++) await sleep(100);
  ok('网络刷新被延迟时缓存仍先渲染打卡任务', scheduleBlocked);
  releaseSchedules?.();
  await sleep(200);
  await page.unroute(`**/api/team/${TID}/checkin/schedules?*`);

  ok('页面无运行时异常', pageErrors.length === 0, pageErrors);
} catch (e) {
  fail++;
  console.log('❌ 探针异常:', e.stack || e.message);
} finally {
  try { await browser?.close(); } catch {}
  for (const proc of children) { try { proc.kill(); } catch {} }
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
