// DOCX 周报预览探针：真实打卡附件 → 时间线懒加载 → docx-preview 渲染。
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const JSZip = require(path.resolve('frontend/node_modules/jszip'));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3121;
const VITE = 5208;
const API = `http://127.0.0.1:${PORT}/api`;
const WEB = `http://localhost:${VITE}`;
const work = mkdtempSync(path.join(os.tmpdir(), 'probe_docx_'));
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
const api = async (p, o = {}) => {
  const res = await fetch(API + p, {
    headers: { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
    method: o.method || 'GET',
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${o.method || 'GET'} ${p} → ${res.status} ${JSON.stringify(data)}`);
  return data;
};

async function makeDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.folder('word').file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>DOCX 预览验收</w:t></w:r></w:p><w:sectPr/></w:body>
</w:document>`);
  zip.folder('word').folder('_rels').file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const children = [];
function start(cmd, args, cwd, extraEnv = {}) {
  const proc = spawn(cmd, args, { cwd, env: { ...process.env, ...extraEnv }, shell: false });
  children.push(proc);
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
  let me = await api('/auth/register', {
    method: 'POST',
    body: { email: `docx_${stamp}@test.dev`, password: 'pass123456', nickname: 'Word预览验收' },
  });
  me = { ...me, user: (await api('/auth/real-name', {
    method: 'PUT', token: me.token, body: { real_name: 'Word预览验收' },
  })).user };
  const team = await api('/team', {
    method: 'POST', token: me.token, body: { name: `Word预览组${stamp}` },
  });
  const TID = team.team?.id || team.id;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const dowMap = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', weekday: 'short',
  }).format(new Date())];
  const sched = await api(`/team/${TID}/checkin/schedules`, {
    method: 'POST', token: me.token,
    body: {
      title: 'DOCX 周报', kind: 'recurring', freq: 'weekly', weekdays: [dow],
      due_time: '23:59', start_date: today, allow_late: 1,
    },
  });
  const weekKey = (dateStr) => {
    const [Y, M, D] = dateStr.split('-').map(Number);
    const d = new Date(Date.UTC(Y, M - 1, D));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
    const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
    const week = 1 + Math.round((d - firstThu) / (7 * 864e5));
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  };
  const docx = await makeDocx();
  await api(`/team/${TID}/checkin/submit`, {
    method: 'POST', token: me.token,
    body: {
      schedule_id: sched.id, period_key: weekKey(today), content: '',
      attachments: [{
        name: 'Word预览验收.docx',
        size: docx.length,
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        data: docx.toString('base64'),
      }],
    },
  });

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([token, user]) => {
    localStorage.setItem('ec_token', token);
    localStorage.setItem('ec_user', JSON.stringify(user));
  }, [me.token, me.user]);
  await page.goto(`${WEB}/team?team=${TID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tp-logs', { timeout: 15000 });
  const fileLink = page.getByText('Word预览验收.docx').first();
  await fileLink.waitFor({ state: 'visible', timeout: 10000 });
  const fullLogResp = page.waitForResponse((r) => r.url().includes('/checkin/logs/by-ids'), { timeout: 10000 });
  await fileLink.click();
  const fullResp = await fullLogResp;
  ok('点击附件触发按需详情接口', fullResp.status() < 400, fullResp.status());
  const fullLogJson = await fullResp.json();
  const fullData = fullLogJson?.[0]?.attachments?.[0]?.data || '';
  const fullBytes = Buffer.from(fullData, 'base64');
  ok('懒加载接口返回的 DOCX 是有效 ZIP', fullBytes.subarray(0, 4).toString('hex') === '504b0304', {
    bytes: fullBytes.length,
    magic: fullBytes.subarray(0, 4).toString('hex'),
  });
  await page.waitForSelector('.att-office-dlg', { timeout: 5000 });
  await page.waitForSelector('.att-office-dlg iframe.office-word-frame, .att-office-dlg .office-error', { timeout: 15000 });
  const errorText = await page.locator('.att-office-dlg .office-error').textContent().catch(() => '');
  const frameCount = await page.locator('.att-office-dlg iframe.office-word-frame').count();
  ok('合法 DOCX 附件能完成解析并渲染 iframe', frameCount === 1, { frameCount, errorText });
  ok('DOCX 预览无 ZIP central directory 错误', !/central directory|zip file/i.test(errorText), errorText);
  ok('页面无运行时异常', pageErrors.length === 0, pageErrors);
} catch (e) {
  fail++;
  console.log('❌ 探针异常:', e.stack || e.message);
  if (pageErrors.length) console.log('页面错误:', pageErrors);
} finally {
  try { await browser?.close(); } catch {}
  for (const proc of children) { try { proc.kill(); } catch {} }
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
