// 浏览器探针（Playwright + Chromium）：报销「行卡片认领失效」链路回归 —— 2026-09-10 修复的守护测试
//
// 被测行为：成员在行卡片上触发写操作 → 服务端 403（认领已被负责人重置）→ RowCard emit('claim-lost')
//   → ExpenseView.onClaimLost() 清掉本机认领 token + 软刷新 → 身份条回到「访客只读」并重新给出认领入口。
//
// 判别力（本探针存在的意义）：
//   修复前 RowCard 既没在 defineEmits 声明该事件、父层也没监听 → emit 是静默 no-op：
//   只弹一个错误 toast，localStorage 的认领 token 残留、身份条仍显「已认领」，
//   用户之后每次写操作继续撞 403（且不知道要重新认领）→ 本探针转红。
//   修复后 token 被清、UI 回落访客态 → 转绿。
//
// 前置：后端 :3000 与 vite 开发服 :5173 均已启动
//   终端1：cd backend && npm start
//   终端2：cd frontend && npm run dev
//   运行：node scripts/probe_claimlost.mjs   （或 npm run probe:claimlost）
// 自清理：探针自建项目/名单/行/附件，跑完自删项目与测试用户，可反复运行、可并发于冒烟之后。
import { chromium } from 'playwright';
import { DEFAULT_API, openProbeDb } from './lib/probeDb.mjs';

const API = process.env.PROBE_API || DEFAULT_API;
const WEB = process.env.PROBE_WEB || 'http://localhost:5173';

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}`)); };

const jsonReq = async (path, opts = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) };
  const res = await fetch(API + path, { headers, method: opts.method || 'GET', body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { res, data };
};
const api = async (path, opts = {}) => {
  const { res, data } = await jsonReq(path, opts);
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
};

// ---------- 前置检查：两个服务都在跑 ----------
const pre = async () => {
  try { await fetch(API + '/health'); } catch { throw new Error(`后端 :3000 未启动 —— 先跑 cd backend && npm start`); }
  try { await fetch(WEB, { signal: AbortSignal.timeout(3000) }); } catch { throw new Error(`前端 :5173 未启动 —— 先跑 cd frontend && npm run dev`); }
};

const stamp = Date.now().toString().slice(-8);
const EMAIL = `probe_claimlost_${stamp}@test.dev`;
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let browser = null, P = 0, ta = '', uid = 0;

try {
  await pre();
  ok('前置：后端 :3000 与前端 :5173 均在运行', true);

  // ---------- 夹具：owner + 项目 + 队 + 名单 + 项目级⑥零散票据行 + 图片附件 ----------
  // 用项目级 misc 行：其槽位 ticket 明确接受图片（train 的槽位偏 PDF），且成员认领后即可自理自己名下
  const ra = await api('/auth/register', { method: 'POST', body: { email: EMAIL, password: 'pass123456', nickname: '探针负责人' } });
  ta = ra.token; uid = Number(ra.user.id);
  const proj = await api('/expense', { method: 'POST', token: ta, body: { name: '认领失效探针', event: '电子设计大赛' } });
  P = Number(proj.id);
  const C = proj.code;
  const tm = await api(`/expense/${P}/team`, { method: 'POST', token: ta, body: { name: '探针队' } });
  const mid = Number((await api(`/expense/${P}/team/${Number(tm.id)}/member`, { method: 'POST', token: ta, body: { name: '王小明' } })).id);
  const row = await api(`/expense/o/${C}/row`, {
    method: 'POST', token: ta,
    body: { project_pay: true, category: 'misc', owner_name: '王小明', data: { 票据名称: '探针打车发票', 金额: 45.5, 备注: '', 统一支付范围: '' } },
  });
  const rid = Number(row.row.id);
  const fd = new FormData();
  fd.append('file', new Blob([PNG_1x1]), '探针票据.png');
  const up = await fetch(`${API}/expense/o/${C}/row/${rid}/file?slot=ticket`, { method: 'POST', headers: { Authorization: `Bearer ${ta}` }, body: fd });
  if (!up.ok) throw new Error(`夹具附件上传失败 ${up.status}`);
  ok('夹具就绪：项目+队+名单(王小明)+项目级票据行+图片附件', !!C && !!rid);

  // ---------- 浏览器：匿名进入 → 认领王小明 ----------
  browser = await chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`${WEB}/expense?code=${C}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.claim-box').waitFor({ state: 'visible', timeout: 20000 });
  ok('匿名进入显示认领入口（访客只读态）', true);

  const KEY = `expense_claim_${C}`;
  ok('进入时本机无认领 token', (await page.evaluate((k) => localStorage.getItem(k), KEY)) === null);

  await page.locator('.claim-tag:has-text("王小明")').first().click();
  await page.locator('.who:has-text("已认领")').waitFor({ state: 'visible', timeout: 15000 });
  const tok = await page.evaluate((k) => localStorage.getItem(k), KEY);
  ok('认领王小明成功：身份条显示「已认领」且本机存下 token', !!tok && tok.length === 32);

  const visLink = page.locator('.vis-go:visible').first();
  ok('自己名下行的图片附件出现「🔍识别」入口（editable=true）', (await page.locator('.vis-go:visible').count()) >= 1);

  // ---------- 负责人重置认领 → 成员侧身份在服务端失效（浏览器仍持旧 token，UI 仍是成员态）----------
  await api(`/expense/member/${mid}/reset-claim`, { method: 'POST', token: ta });
  ok('负责人重置认领（服务端已失效；浏览器未刷新仍是成员态 = 真实失效场景）',
    (await page.evaluate((k) => !!localStorage.getItem(k), KEY)) === true
    && (await page.locator('.who:has-text("已认领")').count()) === 1);

  // ---------- 关键一步：点「🔍识别」→ 403 → claim-lost → 清 token + 回落访客 ----------
  // 先挂上响应/提示的等待再点击，避免 toast 自动消失导致漏判
  const respP = page.waitForResponse((r) => r.url().includes('/recognize') && r.request().method() === 'POST', { timeout: 20000 }).catch(() => null);
  const toastP = page.locator('.el-message:has-text("请先认领")').first().waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
  await visLink.click();

  const resp = await respP;
  ok('识别请求命中服务端 403（身份已失效）', !!resp && resp.status() === 403);

  const cleared = await page.waitForFunction((k) => localStorage.getItem(k) === null, KEY, { timeout: 10000 }).then(() => true).catch(() => false);
  ok('★ localStorage 认领 token 被清除（claim-lost → onClaimLost 真正跑通）', cleared);

  const backToGuest = await page.locator('.claim-box').waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
  ok('★ 身份条回落「访客只读」并重新给出认领入口', backToGuest);
  ok('离开已认领态（不再显示「已认领」）', (await page.locator('.who:has-text("已认领")').count()) === 0);

  ok('错误提示告知用户原因（toast 含「请先认领」）', await toastP);

  // ---------- 收尾：重新认领仍可用（链路没把页面搞死）----------
  await page.locator('.claim-tag:has-text("王小明")').first().click();
  const back = await page.locator('.who:has-text("已认领")').waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
  ok('可重新认领（页面状态干净，未卡死）', back);

  ok('全程无未捕获的前端异常', pageErrors.length === 0);
  if (pageErrors.length) console.log(`      ↳ ${pageErrors.slice(0, 3).join(' | ')}`);

  // ---------- 清理 ----------
  await browser.close(); browser = null;
  await api(`/expense/${P}`, { method: 'DELETE', token: ta });
  const db = openProbeDb(API);
  db.prepare('DELETE FROM user WHERE id = ?').run(uid);
  db.close();
  ok('自清理：探针项目与测试用户已删除', true);
} catch (e) {
  fail++;
  console.log(`❌ 异常中断: ${e.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
