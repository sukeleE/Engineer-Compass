// 浏览器探针（Playwright + Chromium）：资源分享「项目文件夹 + 在线预览」的守护测试
//
// 被测行为（核心链路）：
//   上传文件夹（相对路径 → 落盘 → 暂存行）→ 发帖绑树 → 详情页目录树（缩进/展开/图标）
//   → 点文件就地预览（文本走 <pre> 插值、图片走 blob objectURL）→ 整包 ZIP（保留目录结构）
//
// 判别力（本探针存在的意义）：
//   ① 目录树不渲染或层次塌陷（buildTree 前缀推导写错、缩进没跟 depth 走）
//   ② 缩进/展开失效 → 几十个文件糊成一坨，看不出项目结构（本功能的全部意义所在）
//   ③ 文本预览走了 v-html（XSS 面）或内容是错的（端点截断/编码错）
//   ④ 预览不能带请求头 → 幽灵/登录态下取不到文件（objectURL 方案退化成 ?token= 或直接 404）
//   ⑤ 恶意相对路径（../）被落盘（**安全断言**：穿越必须被拒）
//   ⑥ 幽灵帖的文件被普通用户/匿名直取（归属校验漏在 /files/:fid 上）
//   ⑦ ZIP 丢目录结构（条目名用 basename 而不是 path）
//
// 前置：后端与 vite 开发服均已启动；对着临时实例跑更方便（探针自己会建夹具用户）
//   终端1：cd backend && PORT=3101 DB_PATH=/tmp/t.db node server.js
//   终端2：cd frontend && VITE_API_TARGET=http://localhost:3101 npx vite --port 5198
//   运行：PROBE_API=http://localhost:3101/api PROBE_WEB=http://localhost:5198 PROBE_DB=/tmp/t.db node scripts/probe_share_folder.mjs
// 自清理：探针自建帖/测试用户，跑完自删，可反复运行。
import { chromium } from 'playwright';
import { DEFAULT_API, openProbeDb } from './lib/probeDb.mjs';
import os from 'node:os';
import path from 'node:path';

const API = process.env.PROBE_API || DEFAULT_API;
const WEB = process.env.PROBE_WEB || 'http://localhost:5173';
const SHOT = (n) => path.join(os.tmpdir(), `probe_folder_${n}.png`);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}`)); };

const jsonReq = async (p, opts = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) };
  const res = await fetch(API + p, { headers, method: opts.method || 'GET', body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { res, data };
};
const api = async (p, opts = {}) => {
  const { res, data } = await jsonReq(p, opts);
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${p} → ${res.status} ${JSON.stringify(data)}`);
  return data;
};
// multipart 上传（paths 与 files 下标对齐）—— 与前端 api.shareUploads 同形状
const upload = async (token, files) => {
  const fd = new FormData();
  for (const [rel, body, type] of files) fd.append('files', new Blob([body], { type: type || 'application/octet-stream' }), rel.split('/').pop());
  fd.append('paths', JSON.stringify(files.map((f) => f[0])));
  const res = await fetch(`${API}/share/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST /share/uploads → ${res.status} ${JSON.stringify(data)}`);
  return data;
};

const pre = async () => {
  try { await fetch(API + '/health'); } catch { throw new Error(`后端 ${API} 未启动`); }
  try { await fetch(WEB, { signal: AbortSignal.timeout(3000) }); } catch { throw new Error(`前端 ${WEB} 未启动`); }
};

const stamp = Date.now().toString().slice(-8);
const EMAIL_A = `probe_fol_a_${stamp}@test.dev`;
const EMAIL_B = `probe_fol_b_${stamp}@test.dev`;
// 1×1 透明 PNG（真图，浏览器能解码渲染）
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const T_PROJ = `探针项目文件夹${stamp}`;
const T_GHOST = `探针幽灵项目${stamp}`;
const MD_BODY = `# 项目说明 ${stamp}\n\n**加粗**与 <script>alert(1)</script> 标签`;

let browser = null, browserA = null;
let uidA = 0, uidB = 0;
const postIds = [];

const seedAuth = (page, token, user) => page.addInitScript(([t, u]) => {
  localStorage.setItem('ec_token', t);
  localStorage.setItem('ec_user', JSON.stringify(u));
}, [token, user]);

try {
  await pre();
  ok(`前置：后端 ${API} 与前端 ${WEB} 均在运行`, true);

  // ---------- 夹具 ----------
  const ra = await api('/auth/register', { method: 'POST', body: { email: EMAIL_A, password: 'pass123456', nickname: `探针夹甲${stamp}` } });
  uidA = Number(ra.user.id);
  const rb = await api('/auth/register', { method: 'POST', body: { email: EMAIL_B, password: 'pass123456', nickname: `探针夹乙${stamp}` } });
  uidB = Number(rb.user.id);
  const ta = ra.token, tb = rb.token;

  // 三层目录 + 一个文本 + 一个图片，全部挂在同一个根目录下（模拟「上传一个文件夹」）
  const up = await upload(ta, [
    ['proj/README.md', MD_BODY, 'text/markdown'],
    ['proj/src/main.js', 'console.log("深层文件")', 'text/javascript'],
    ['proj/src/deep/c.txt', '第三层文本', 'text/plain'],
    ['proj/assets/pic.png', PNG_1x1, 'image/png'],
  ]);
  ok(`夹具：上传 4 个文件（含 3 层目录）→ ${up.rows.length} 行落库`, up.rows.length === 4);

  // 安全断言：恶意相对路径必须被拒（既不入库、也不落盘）
  const bad = await upload(ta, [['../../evil.txt', 'x']]);
  ok('★ ⑤ 恶意相对路径 ../../evil.txt 被拒（rejected，不入库）', bad.rows.length === 0 && bad.rejected.length === 1);

  const p = await api('/share/posts', { method: 'POST', token: ta, body: { title: T_PROJ, content: `<p>项目正文 ${stamp}</p>`, tags: [], files: up.rows.map((r) => r.id) } });
  const pid = Number(p.id);
  postIds.push(pid);
  const det = await api(`/share/posts/${pid}`, { token: ta });
  ok(`夹具：绑树成功，详情 files = ${det.files?.length}`, det.files?.length === 4);
  const fidMd = det.files.find((f) => f.path === 'proj/README.md')?.id;
  const fidPng = det.files.find((f) => f.path === 'proj/assets/pic.png')?.id;

  // 幽灵项目（B 视角；用于 /files/:fid 的归属隔离断言）
  await api('/ghost/enter', { method: 'POST', token: tb });
  const upG = await upload(tb, [['g/secret.txt', '幽灵项目的文件内容', 'text/plain']]);
  const pg = await api('/share/posts', { method: 'POST', token: tb, body: { title: T_GHOST, content: '<p>幽灵</p>', tags: [], files: upG.rows.map((r) => r.id) } });
  const gid = Number(pg.id);
  postIds.push(gid);
  const fidGhost = upG.rows[0].id;
  const raw = async (p2, tk) => (await fetch(API + p2, { headers: tk ? { Authorization: `Bearer ${tk}` } : {} })).status;
  ok('★ ⑥ 普通用户直取幽灵帖文件 → 404', (await raw(`/share/files/${fidGhost}`, ta)) === 404);
  ok('★ ⑥ 匿名直取幽灵帖文件 → 404', (await raw(`/share/files/${fidGhost}`)) === 404);
  ok('⑥ 匿名直取普通帖文件 → 200（公开帖本就可分享）', (await raw(`/share/files/${fidMd}`)) === 200);

  // ZIP：条目名必须是完整相对路径（保留目录结构），内容与原文一致
  const zres = await fetch(`${API}/share/posts/${pid}/zip`);
  const zbuf = Buffer.from(await zres.arrayBuffer());
  ok(`⑦ 整包 ZIP 可下载（${zres.status}，${zbuf.length}B）`, zres.status === 200 && zbuf.subarray(0, 2).toString() === 'PK');
  ok('★ ⑦ ZIP 保留目录结构（条目名是 proj/src/deep/c.txt 而非 c.txt）', zbuf.includes(Buffer.from('proj/src/deep/c.txt')));
  ok('⑦ ZIP 内含文本原文', zbuf.includes(Buffer.from('第三层文本')));

  // ---------- 浏览器：作者视角 ----------
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await seedAuth(page, ta, ra.user);

  // 冷启动直链详情页（不经过列表）——子路由必须自己站得住
  await page.goto(`${WEB}/share/${pid}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.ft-wrap').waitFor({ state: 'visible', timeout: 20000 });
  ok('① 冷启动直链 /share/:id 渲染出目录树（不依赖列表页预热）', true);

  // 全展开时 8 行：proj / assets, pic.png / src, deep, c.txt, main.js / README.md
  // 同层目录排前、各自按名排序（与 GitHub 一致）
  const rowTexts = await page.locator('.ft-row .ft-name').allInnerTexts();
  ok(`① 树节点齐全（${rowTexts.length} 行：${rowTexts.join(', ')}）`, rowTexts.length === 8);
  ok('① 同层目录排前，子目录挂在对的父目录下（proj → assets/svg 分支独立于 src 分支）',
    rowTexts.join(',') === 'proj,assets,pic.png,src,deep,c.txt,main.js,README.md');

  // 缩进：目录树 4 层 → 恰好 4 档 padding-left（层次必须一眼看得出来）
  const pads = [...new Set(await page.locator('.ft-row').evaluateAll((els) => els.map((e) => parseInt(getComputedStyle(e).paddingLeft, 10))))].sort((a, b) => a - b);
  ok(`★ ② 缩进按层级分档（4 层 → ${pads.length} 档：${pads.join(' / ')}px）`, pads.length === 4 && pads.every((v, i) => i === 0 || v > pads[i - 1]));
  ok('② 4 个目录行都有展开箭头且默认展开', (await page.locator('.ft-row.dir .ft-caret.open').count()) === 4);

  // 收起/展开：点 proj 应把整棵子树收掉（只剩 1 行）
  await page.locator('.ft-row', { hasText: 'proj' }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('.ft-row').length === 1, null, { timeout: 5000 }).catch(() => {});
  ok('★ ② 收起根目录 → 只剩 1 行', (await page.locator('.ft-row').count()) === 1);
  await page.locator('.ft-row', { hasText: 'proj' }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('.ft-row').length === 8, null, { timeout: 5000 }).catch(() => {});
  ok('② 再展开 → 恢复 8 行', (await page.locator('.ft-row').count()) === 8);

  // 文本预览：内容必须一致，且尖括号必须是**转义后的文本**（不是真标签）
  await page.locator('.ft-row', { hasText: 'README.md' }).click();
  const pvShown = await page.locator('.fp-pre').waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
  if (!pvShown) {
    // 预览没出来时把面板真实状态打出来（是报错、还是压根没渲染），否则只剩「超时」两个字无从下手
    console.log('      ↳ 预览面板状态：', await page.locator('.fp-wrap').count() ? JSON.stringify({
      err: await page.locator('.fp-err').allInnerTexts(),
      kind: await page.locator('.fp-other').allInnerTexts(),
      body: (await page.locator('.fp-body').innerText().catch(() => '')).slice(0, 160),
    }) : '整个 .fp-wrap 未渲染（selFile 没被设上）');
  }
  ok('★ ③ 文本预览面板出现', pvShown);
  // 等正文真的填进来（面板是「取完再一次性上屏」，但 innerText 仍可能抢在填充前跑到）
  await page.locator('.fp-pre').filter({ hasText: '项目说明' }).waitFor({ timeout: 10000 }).catch(() => {});
  const pvText = await page.locator('.fp-pre').innerText();
  ok('★ ③ 文本预览内容与原文一致（含中文与 markdown 原文）', pvText.includes(`# 项目说明 ${stamp}`) && pvText.includes('**加粗**'));
  ok('★ ③ 正文里的 <script> 被当**文本**展示（未被解析执行 → 无 XSS）',
    pvText.includes('<script>alert(1)</script>') && (await page.locator('.fp-pre script').count()) === 0);

  // 图片预览：<img> 的 src 必须是 blob:（= 走请求头取字节），且浏览器真的解码成功
  await page.locator('.ft-row', { hasText: 'pic.png' }).click();
  await page.locator('.fp-img').waitFor({ state: 'visible', timeout: 10000 });
  const src = await page.locator('.fp-img').getAttribute('src');
  ok(`★ ④ 图片预览走 blob objectURL（不是 ?token= 直链）：${String(src).slice(0, 12)}…`, String(src).startsWith('blob:'));
  const decoded = await page.locator('.fp-img').evaluate((el) => el.complete && el.naturalWidth > 0).catch(() => false);
  ok('④ 图片真的解码出来了（naturalWidth > 0）', decoded);
  await page.screenshot({ path: SHOT('light'), fullPage: true }).catch(() => {});
  ok(`已存浅色截图 ${SHOT('light')}（供人工看观感）`, true);

  // 弹窗里的文件清单（编辑态）
  // 精确匹配「编辑」—— hasText 是子串匹配，「飞书编辑」也含「编辑」且在 DOM 里更靠前
  await page.locator('.gh-readme button', { hasText: /^编辑$/ }).first().click().catch(() => {});
  const dlgOk = await page.locator('.fol-sum').waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  if (dlgOk) {
    const sum = await page.locator('.fol-sum').innerText();
    ok(`⑧ 发帖弹窗显示项目文件清单（${sum.replace(/\s+/g, ' ').trim()}）`, /4\s*个文件/.test(sum));
    await page.locator('.fol-sum').click();
    await page.locator('.fol-item').first().waitFor({ state: 'visible', timeout: 5000 });
    ok('⑧ 展开后逐条列出相对路径（含二级目录）', (await page.locator('.fol-item').count()) === 4
      && (await page.locator('.fol-item .fol-path').allInnerTexts()).some((t) => t === 'proj/src/deep/c.txt'));
  } else {
    ok('⑧ 发帖弹窗显示项目文件清单', false);
  }
  // ---------- ⑨ 暗色（幽灵页）：树/预览面板是最后加的一层，最容易在暗色里糊出白块 ----------
  // 断言的是「面板底色跟着主题变量走」，不是「某个具体色值」：写死 #fff 的卡片在这里必红。
  const lumOf = (pg, sel) => pg.locator(sel).first().evaluate((el) => {
    const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g) || [];
    const [r, g, b, a = '1'] = m.map(Number);
    if (Number(a) < 0.5) return null; // 透明（继承父底色）不算，避免把没设底色的面板误判成白
    return 0.299 * r + 0.587 * g + 0.114 * b;
  });
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await seedAuth(pageB, tb, rb.user); // 幽灵帖的作者（B）：守卫会用 /me 自愈 is_ghost 缓存
  await pageB.goto(`${WEB}/ghost-share/${gid}`, { waitUntil: 'domcontentloaded' });
  const treeDark = await pageB.locator('.ft-wrap').waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
  ok('⑨ 幽灵项目页作者自己能看见目录树', treeDark);
  ok('⑨ 幽灵详情页仍是暗色主题（html.ghost-mode）', (await pageB.locator('html.ghost-mode').count()) === 1);
  await pageB.locator('.ft-row', { hasText: 'secret.txt' }).click();
  await pageB.locator('.fp-pre').waitFor({ state: 'visible', timeout: 15000 });
  ok('⑨ 幽灵帖的文件也能就地预览（内容正确）', (await pageB.locator('.fp-pre').innerText()).includes('幽灵项目的文件内容'));
  const lTree = await lumOf(pageB, '.ft-wrap');
  const lPrev = await lumOf(pageB, '.fp-wrap');
  const lHead = await lumOf(pageB, '.fp-head');
  ok(`★ ⑨ 暗色下树/预览面板底色是暗的（亮度 ${lTree} / ${lPrev} / ${lHead}，写死白底会挂在这里）`,
    [lTree, lPrev, lHead].every((v) => v === null || v < 90));
  await pageB.screenshot({ path: SHOT('dark'), fullPage: true }).catch(() => {});
  ok(`已存暗色截图 ${SHOT('dark')}（供人工看观感）`, true);
  await ctxB.close();

  // ---------- ⑩ 375px：树与预览堆叠、长路径不撑破页面 ----------
  const ctxM = await browser.newContext({ viewport: { width: 375, height: 780 } });
  const pageM = await ctxM.newPage();
  await seedAuth(pageM, ta, ra.user);
  await pageM.goto(`${WEB}/share/${pid}`, { waitUntil: 'domcontentloaded' });
  await pageM.locator('.ft-wrap').waitFor({ state: 'visible', timeout: 20000 });
  await pageM.locator('.ft-row', { hasText: 'README.md' }).click();
  await pageM.locator('.fp-pre').waitFor({ state: 'visible', timeout: 15000 });
  const boxTree = await pageM.locator('.ft-wrap').boundingBox();
  const boxPrev = await pageM.locator('.fp-wrap').boundingBox();
  ok('★ ⑩ 375px 下树与预览上下堆叠（预览在树下方，不并排挤成两条窄柱）',
    !!boxTree && !!boxPrev && boxPrev.y >= boxTree.y + boxTree.height - 1);
  const overflow = await pageM.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(`★ ⑩ 375px 下页面无横向溢出（长路径被省略号收住，overflow=${overflow}px）`, overflow <= 1);
  ok('⑩ 375px 下副信息（体积/类型）让位隐藏', !(await pageM.locator('.ft-sub').first().isVisible()));
  ok('⑩ 375px 下两栏折单栏（About 提到上方）',
    (await pageM.locator('.gh-body').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)) === 1);
  await pageM.screenshot({ path: SHOT('mobile375'), fullPage: true }).catch(() => {});
  ok(`已存移动端截图 ${SHOT('mobile375')}（供人工看观感）`, true);
  await ctxM.close();

  ok('全程无未捕获的前端异常', pageErrors.length === 0);
  if (pageErrors.length) console.log(`      ↳ ${pageErrors.slice(0, 3).join(' | ')}`);

  // ---------- 浏览器 2：普通用户 A 看不到幽灵项目 ----------
  browserA = await chromium.launch();
  const pageA = await (await browserA.newContext()).newPage();
  await seedAuth(pageA, ta, ra.user);
  await pageA.goto(`${WEB}/share/${gid}`, { waitUntil: 'domcontentloaded' });
  const ghostErr = await pageA.locator('.gh-rstate.err').waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
  ok('★ ⑥ 普通用户直链幽灵项目详情 → 就地 404', ghostErr);
  ok('★ ⑥ 幽灵项目页不留目录树（不泄露文件名）', (await pageA.locator('.ft-wrap').count()) === 0);

  // ---------- 清理 ----------
  await browser.close(); browser = null;
  await browserA.close(); browserA = null;
  for (const id of postIds) await api(`/share/posts/${id}`, { method: 'DELETE', token: id === gid ? tb : ta }).catch(() => {});
  // 直连 DB 清用户 —— 库必须属于所打的后端，闸门在 lib/probeDb.mjs（非同源直接抛错）
  const db = openProbeDb(API);
  db.prepare('DELETE FROM user WHERE id IN (?, ?)').run(uidA, uidB);
  db.close();
  ok('自清理：探针帖子/测试用户已删除', true);
} catch (e) {
  fail++;
  console.log(`❌ 异常中断: ${e.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (browserA) await browserA.close().catch(() => {});
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
