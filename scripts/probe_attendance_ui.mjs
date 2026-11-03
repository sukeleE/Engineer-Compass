// 考勤记录成员卡片 UI 探针：临时后端(:3115) + Vite(:5202)，验证“记录”页成员小方块
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3115, VITE = 5202;
const API = `http://127.0.0.1:${PORT}/api`, WEB = `http://localhost:${VITE}`;
const work = mkdtempSync(path.join(os.tmpdir(), 'probe_att_'));
const env = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
  PORT: String(PORT), DB_PATH: path.join(work, 'ui.db'),
  SHARE_UPLOAD_DIR: path.join(work, 'share'), HONOR_UPLOAD_DIR: path.join(work, 'honor'),
  PURCHASE_UPLOAD_DIR: path.join(work, 'purchase'),
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log(`✅ ${n}`)) : (fail++, console.log(`❌ ${n}${x !== undefined ? ' → ' + JSON.stringify(x) : ''}`)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUp(url, n = 60) {
  for (let i = 0; i < n; i++) { try { if ((await fetch(url)).ok) return; } catch {} await sleep(500); }
  throw new Error(`服务未就绪：${url}`);
}
const jreq = async (p, o = {}) => {
  const h = { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) };
  const res = await fetch(API + p, { headers: h, method: o.method || 'GET', body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { res, data };
};
const api = async (p, o = {}) => { const { res, data } = await jreq(p, o); if (!res.ok) throw new Error(`${o.method || 'GET'} ${p} → ${res.status} ${JSON.stringify(data)}`); return data; };
const tz = { timeZone: 'Asia/Shanghai' };
const cn = new Intl.DateTimeFormat('en-CA', { ...tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format;
const today = cn(new Date());
const dowMap = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const dow = dowMap[new Intl.DateTimeFormat('en-US', { ...tz, weekday: 'short' }).format(new Date())];
const children = [];
function start(cmd, args, cwd, env2) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env2 }, shell: false });
  children.push(p);
  return p;
}
let browser;
const pageErrors = [], badResp = [];
try {
  const backend = start(process.execPath, [
    '--import', pathToFileURL(path.join(ROOT, 'scripts', 'polyfill_dom.mjs')).href,
    path.join(ROOT, 'backend', 'server.js'),
  ], work, env);
  const vite = start(process.execPath, [path.join(ROOT, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js'),
    '--port', String(VITE), '--strictPort'], path.join(ROOT, 'frontend'), { VITE_API_TARGET: `http://127.0.0.1:${PORT}` });
  await waitUp(`${API}/health`); await waitUp(WEB);
  console.log('—— 服务就绪 ——');

  const stamp = Date.now().toString().slice(-8);
  const reg = async (k, nick, real) => {
    const r = await api('/auth/register', { method: 'POST', body: { email: `atu_${k}_${stamp}@test.dev`, password: 'pass123456', nickname: nick } });
    const rn = await api('/auth/real-name', { method: 'PUT', token: r.token, body: { real_name: real } });
    return { ...r, user: rn.user };
  };
  const A = await reg('a', '考勤甲', '组长甲');
  const B = await reg('b', '考勤乙', '组员乙');
  const C = await reg('c', '考勤丙', '组员丙');
  const tg = await api('/team', { method: 'POST', token: A.token, body: { name: `考勤UI组${stamp}` } });
  const TID = tg.team?.id || tg.id;
  await api(`/team/${TID}/member/add`, { method: 'POST', token: A.token, body: { user_ids: [B.user.id, C.user.id] } });
  const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const t = (mins) => hm(new Date(Date.now() + mins * 60000));
  const s1 = { id: 's1', name: '上午', start: t(-240), late: t(-210), end: t(-180) };
  const s2 = { id: 's2', name: '下午', start: t(-10), late: t(-1), end: t(15) };
  await api(`/team/${TID}/attendance/settings`, { method: 'PUT', token: A.token, body: {
    name: '竞赛考勤', active: 1, workdays: [dow], slots: [s1, s2],
    scope_type: 'all', scope_json: [], managers: [B.user.id], leave_mode: 'register',
    start_date: '', end_date: '', exceptions: [],
  } });
  // 状态组合：A 两时段正常；B 上午正常+下午迟到；C 上午缺勤+下午请假
  await api(`/team/${TID}/attendance/checkin/proxy`, { method: 'POST', token: A.token, body: { user_id: A.user.id, date: today, slot_id: 's1', time: t(-230) } });
  await api(`/team/${TID}/attendance/checkin/proxy`, { method: 'POST', token: A.token, body: { user_id: A.user.id, date: today, slot_id: 's2', time: t(-5) } });
  await api(`/team/${TID}/attendance/checkin/proxy`, { method: 'POST', token: A.token, body: { user_id: B.user.id, date: today, slot_id: 's1', time: t(-220) } });
  await api(`/team/${TID}/attendance/checkin/proxy`, { method: 'POST', token: A.token, body: { user_id: B.user.id, date: today, slot_id: 's2', time: t(0) } });
  await api(`/team/${TID}/attendance/leaves`, { method: 'POST', token: C.token, body: {
    start_date: today, end_date: today, slot_id: 's2', leave_type: '病假', reason: '身体不适',
  } });

  const board = await api(`/team/${TID}/attendance/board?date=${today}`, { token: A.token });
  ok('看板返回 3 名成员 × 2 时段', board.rows.length === 3 && board.slots.length === 2, { rows: board.rows.length, slots: board.slots.length });
  ok('状态组合正确', JSON.stringify(board.rows.map((r) => r.cells.map((c) => c.status))) === JSON.stringify([['normal', 'normal'], ['normal', 'late'], ['absent', 'leave']]), board.rows.map((r) => r.cells.map((c) => c.status)));

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().includes('favicon')) badResp.push(`${r.status()} ${r.url()}`); });
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([t, u]) => {
    localStorage.setItem('ec_token', t);
    localStorage.setItem('ec_user', JSON.stringify(u));
  }, [A.token, A.user]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.goto(`${WEB}/team?team=${TID}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    const st = document.createElement('style');
    st.textContent = '#pane-attendance, #pane-board, .el-tabs__content > .el-tab-pane { display: block !important; }';
    document.head.appendChild(st);
  });
  await page.waitForSelector('.att-member-card', { state: 'attached', timeout: 15000 });
  const cards = await page.locator('.att-member-card').count();
  ok('成员卡片渲染 3 张', cards === 3, cards);
  const names = await page.locator('.am-name').allTextContents();
  ok('卡片姓名正确', JSON.stringify(names) === JSON.stringify(['组长甲', '组员乙', '组员丙']), names);
  const statuses = await page.locator('.am-status').allTextContents();
  ok('卡片状态正确', JSON.stringify(statuses) === JSON.stringify(['正常', '迟到', '请假']), statuses);
  const counts = await page.locator('.am-count').allTextContents();
  ok('卡片已签计数正确', JSON.stringify(counts) === JSON.stringify(['已签 2/2', '已签 2/2', '已签 0/2']), counts);
  const dots = await page.locator('.am-dots i').count();
  ok('状态点渲染 6 个', dots === 6, dots);
  const proxyVisible = await page.locator('.am-proxy').count();
  ok('可代签入口数量正确', proxyVisible === 2, proxyVisible);
  await page.locator('.att-member-card').nth(2).click();
  await page.waitForSelector('.amd-slot', { timeout: 10000 });
  const slotStatuses = await page.locator('.amd-slot .el-tag').allTextContents();
  ok('详情弹窗时段状态正确', JSON.stringify(slotStatuses) === JSON.stringify(['缺勤', '请假']), slotStatuses);
  const detailText = await page.locator('.amd-slot').allTextContents();
  ok('详情显示请假类型', detailText.some((x) => x.includes('病假')), detailText);
  await page.keyboard.press('Escape');
  const calendars = await page.locator('.att-calendar').count();
  ok('我的与月度统计渲染月历', calendars === 2, calendars);
  ok('不再显示最近 14 天列表', (await page.locator('text=最近 14 天').count()) === 0, await page.locator('text=最近 14 天').count());
  await page.locator('.att-calendar').nth(0).locator('.ac-cell.today').click();
  await page.waitForSelector('.el-dialog .cal-member', { timeout: 10000 });
  ok('我的月历点击查看当日详情', (await page.locator('.cal-member').count()) === 1 && (await page.locator('.cal-member .amd-slot').count()) === 2, {
    members: await page.locator('.cal-member').count(), slots: await page.locator('.cal-member .amd-slot').count(),
  });
  await page.keyboard.press('Escape');
  await page.locator('.att-calendar').nth(1).locator('.ac-cell.today').click();
  await page.waitForSelector('.el-dialog .cal-member', { timeout: 10000 });
  ok('月度统计月历点击查看成员当日详情', (await page.locator('.cal-member').count()) === 3 && (await page.locator('.cal-member .amd-slot').count()) === 6, {
    members: await page.locator('.cal-member').count(), slots: await page.locator('.cal-member .amd-slot').count(),
  });
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(ROOT, 'scripts', '.probe_attendance_cards.png'), fullPage: false });
  ok('无页面 JS 错误', pageErrors.length === 0, pageErrors);
  ok('无意外 4xx/5xx', badResp.length === 0, badResp);
  console.log(`—— 探针完成 ${pass} 通过 / ${fail} 失败 ——`);
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const c of children) { try { c.kill(); } catch {} }
  await sleep(500);
  try { rmSync(work, { recursive: true, force: true }); } catch {}
}
process.exit(fail ? 1 : 0);
