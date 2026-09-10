// 浏览器探针（Playwright + Chromium）：资源分享「Gitee 仓库文件树」的守护测试
//
// 被测行为：粘贴仓库地址 → 服务端拉树入库 → 详情页目录树渲染 → 点文件**由后端代理**取回正文/图片
//
// 判别力（本探针存在的意义）：
//   ① 树入库的**唯一来源必须是服务端自己拉的**：客户端塞不进任何路径（伪造树数据 = 任意路径注入）
//   ② SSRF 闸门：客户端给完整 URL 时只当 owner/repo 解析，不许服务器去请求任意主机
//   ③ 代理闸门：/files/:fid/raw 必须命中该帖已存的 share_file 行，否则本站成了公开的 Gitee 代理
//   ④ 浏览器不直连 gitee.com（假 Gitee 的命中计数只可能来自后端）；预览走 blob 而非 ?token=
//   ⑤ 限流/仓库不存在要变成**可行动的提示**（带 hint），不是白屏也不是 500
//   ⑥ 三态字段：改标题不许把仓库绑定抹掉；空串才是解绑
//   ⑦ 权限：非作者不能同步仓库
//
// 前置：后端必须**带假 Gitee 的环境变量启动**（探针自己起假 Gitee 在 3199 端口）：
//   终端1：cd backend && PORT=3105 DB_PATH=/tmp/t6.db \
//          GITEE_BASE_URL=http://127.0.0.1:3199/api/v5 GITEE_RAW_BASE=http://127.0.0.1:3199 node server.js
//   终端2：cd frontend && VITE_API_TARGET=http://localhost:3105 npx vite --port 5197
//   运行：PROBE_API=http://localhost:3105/api PROBE_WEB=http://localhost:5197 PROBE_DB=/tmp/t6.db \
//         node scripts/probe_share_gitee.mjs
// 自清理：探针自建帖/测试用户，跑完自删，可反复运行；假 Gitee 随进程退出。
import { chromium } from 'playwright';
import { DEFAULT_API, openProbeDb } from './lib/probeDb.mjs';
import { startFakeGitee, OWNER, hits } from './lib/fakeGitee.mjs';
import os from 'node:os';
import path from 'node:path';

const API = process.env.PROBE_API || DEFAULT_API;
const WEB = process.env.PROBE_WEB || 'http://localhost:5173';
const GITEE_PORT = 3199;
const SHOT = (n) => path.join(os.tmpdir(), `probe_gitee_${n}.png`);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}`)); };

const j = async (p, opts = {}) => {
  const res = await fetch(API + p, {
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    method: opts.method || 'GET',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
};
const api = async (p, opts = {}) => {
  const { res, data } = await j(p, opts);
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${p} → ${res.status} ${JSON.stringify(data)}`);
  return data;
};

const pre = async () => {
  try { await fetch(API + '/health'); } catch { throw new Error(`后端 ${API} 未启动`); }
  try { await fetch(WEB, { signal: AbortSignal.timeout(3000) }); } catch { throw new Error(`前端 ${WEB} 未启动`); }
};

const stamp = Date.now().toString().slice(-8);
const T_POST = `探针假仓库 ${stamp}`;
const REPO = `${OWNER}/demo${stamp}`; // 每次跑换仓库名 → 不吃上一次的 10 分钟缓存

let browser = null;
let srv = null;
let uidA = 0, uidB = 0;
let pid = 0;
const seedAuth = (page, token, user) => page.addInitScript(([t, u]) => {
  localStorage.setItem('ec_token', t);
  localStorage.setItem('ec_user', JSON.stringify(u));
}, [token, user]);

try {
  await pre();
  ok(`前置：后端 ${API} 与前端 ${WEB} 均在运行`, true);

  try { srv = await startFakeGitee(GITEE_PORT); }
  catch (e) { throw new Error(`假 Gitee 起不来（端口 ${GITEE_PORT} 被占？先关掉上一个探针）: ${e.message}`); }

  // ---------- 夹具 ----------
  const ra = await api('/auth/register', { method: 'POST', body: { email: `probe_gt_a_${stamp}@test.dev`, password: 'pass123456', nickname: `仓库夹甲${stamp}` } });
  uidA = Number(ra.user.id);
  const rb = await api('/auth/register', { method: 'POST', body: { email: `probe_gt_b_${stamp}@test.dev`, password: 'pass123456', nickname: `仓库夹乙${stamp}` } });
  uidB = Number(rb.user.id);
  const ta = ra.token, tb = rb.token;

  // ① 预览：只入响应不入库。仓库名带上本次时间戳 —— 后端有 10 分钟缓存，用固定仓库名的话
  // 第二次跑探针就吃缓存、测不到「真的去拉了」，还会把缓存断言测成假绿。
  const h0 = hits.tree;
  const prev = await api('/share/gitee/tree', { method: 'POST', token: ta, body: { repo: REPO } });
  ok(`① 预览拉到 ${prev.count} 个文件（tree 条目被过滤，只留 blob）`, prev.count === 4);
  ok('★ ① 假 Gitee 确实被后端请求过（说明 GITEE_BASE_URL 生效）', hits.tree === h0 + 1);
  await api('/share/gitee/tree', { method: 'POST', token: ta, body: { repo: REPO } });
  ok('★ ① 同一仓库再拉一次不再打 Gitee（10 分钟内存缓存，保住匿名配额）', hits.tree === h0 + 1);
  ok('① 预览响应只有路径/体积，没有内容体（拉的是清单不是文件）',
    (prev.files || []).every((f) => typeof f.path === 'string' && f.size >= 0 && !('data' in f) && !('body' in f)));

  // ② SSRF / 错误映射
  const bad = await j('/share/gitee/tree', { method: 'POST', token: ta, body: { repo: 'http://127.0.0.1:9999/evil/repo' } });
  ok(`★ ② 完整 URL 里的主机名被丢弃（只解析出 owner/repo）→ ${bad.res.status}`, bad.res.status === 400 || bad.res.status === 502);
  const miss = await j('/share/gitee/tree', { method: 'POST', token: ta, body: { repo: `${OWNER}/missing` } });
  ok(`② 仓库不存在 → 502 且文案可行动`, miss.res.status === 502 && /不存在/.test(miss.data.error) && !!miss.data.hint);
  const flood = await j('/share/gitee/tree', { method: 'POST', token: ta, body: { repo: `${OWNER}/flood` } });
  ok(`② 限流 → 502 且明说限流（${flood.data.error}）`, flood.res.status === 502 && /限流/.test(flood.data.error));
  const big = await j('/share/gitee/tree', { method: 'POST', token: ta, body: { repo: `${OWNER}/big` } });
  ok('② 仓库过大（truncated）→ 如实拒绝，不给半棵树', big.res.status === 502 && /上限/.test(big.data.error));

  // ---------- 浏览器：作者视角 ----------
  browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const pageErrors = [];
  const giteeDirect = []; // 浏览器直连 gitee.com 的记录（应为空）
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('request', (r) => { if (/gitee\.com/.test(r.url())) giteeDirect.push(r.url()); });
  await seedAuth(page, ta, ra.user);

  // 在真界面里发帖：填标题 + 仓库 + 拉预览
  await page.goto(`${WEB}/share`, { waitUntil: 'domcontentloaded' });
  await page.locator('button', { hasText: /开楼发帖|开幽灵帖/ }).first().click();
  await page.locator('.sh-title input').first().fill(T_POST);
  await page.locator('.gt-repo input').fill(`https://gitee.com/${REPO}/tree/master/`);
  await page.locator('button', { hasText: '拉取预览' }).click();
  const preOk = await page.locator('.gt-ok').waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
  ok('★ ④ 弹窗里「拉取预览」显示已拉取清单', preOk && /共\s*4\s*个文件/.test(await page.locator('.gt-ok').innerText()));
  ok('④ 预览回显解析出的 owner/repo 与分支（不显示用户粘的整串 URL）',
    /probe-owner\/demo/.test(await page.locator('.gt-ok').innerText()) && /@master/.test(await page.locator('.gt-ok').innerText()));

  await page.locator('.editor-dlg button', { hasText: /^发布$/ }).first().click();
  await page.waitForURL(/\/share\/\d+$/, { timeout: 20000 }).catch(() => {});
  const m = page.url().match(/\/share\/(\d+)/);
  pid = m ? Number(m[1]) : 0;
  ok(`④ 发布后跳到详情页 /share/${pid}`, pid > 0);

  const det = await api(`/share/posts/${pid}`, { token: ta });
  ok(`★ ① 入库 4 行、路径与仓库树逐一相等（客户端传不进任何路径）`,
    det.files?.length === 4 && det.files.map((f) => f.path).sort().join(',') === 'README.md,assets/pic.png,src/main.js,src/util/中文名.txt');
  ok('① 全部标为 source=gitee（与上传文件可区分）', det.files.every((f) => f.source === 'gitee'));

  // ---------- 详情页：树 + 预览 ----------
  await page.locator('.ft-wrap').waitFor({ state: 'visible', timeout: 20000 });
  const rows = await page.locator('.ft-row .ft-name').allInnerTexts();
  ok(`④ 目录树按前缀推目录渲染（${rows.join(', ')}）`,
    rows.join(',') === 'assets,pic.png,src,util,中文名.txt,main.js,README.md');
  const giteeIcons = await page.locator('.ft-row .ft-icon.gitee').count();
  ok('④ Gitee 条目用仓库图标（不是普通文件图标）', giteeIcons === 4);
  const subs = await page.locator('.ft-sub').allInnerTexts();
  ok('④ 副信息标明来源 Gitee', subs.filter((t) => t.includes('Gitee')).length === 4);

  // 中文名 + 深层路径：文本预览内容必须来自假 Gitee（= 后端代理成功）
  await page.locator('.ft-row', { hasText: '中文名.txt' }).first().click();
  const pvOk = await page.locator('.fp-pre').waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
  if (!pvOk) console.log('      ↳ 预览状态：', await page.locator('.fp-err').allInnerTexts());
  ok('★ ⑤ Gitee 条目的文本预览取到正文（后端代理，中文名不裂）',
    pvOk && (await page.locator('.fp-pre').innerText()).includes('中文文件名与中文内容都要活下来'));
  ok('★ ③ 预览头标明来源 Gitee + 给「在 Gitee 打开」出口',
    (await page.locator('.fp-tag').innerText()) === 'Gitee'
    && /gitee\.com\/probe-owner\/demo[^/]*\/blob\/master\//.test(await page.locator('a.fp-btn', { hasText: '在 Gitee 打开' }).getAttribute('href')));

  // 图片：走 /raw 代理 → blob → 浏览器解码
  await page.locator('.ft-row', { hasText: 'pic.png' }).first().click();
  await page.locator('.fp-img').waitFor({ state: 'visible', timeout: 15000 });
  const imgsrc = await page.locator('.fp-img').getAttribute('src');
  const decoded = await page.locator('.fp-img').evaluate((el) => el.complete && el.naturalWidth > 0).catch(() => false);
  ok(`★ ③④ 图片经代理预览成功（blob: + naturalWidth>0）：${String(imgsrc).slice(0, 12)}…`, String(imgsrc).startsWith('blob:') && decoded);
  ok(`★ ④ 浏览器全程没直连 gitee.com（${giteeDirect.length} 次）`, giteeDirect.length === 0);
  ok(`③ 假 Gitee 的 raw 请求只来自后端（被请求过 ${hits.raw.length} 条：${[...new Set(hits.raw)].join(', ')}）`, hits.raw.length > 0);

  // 侧栏：仓库入口 + 同步按钮（作者可见）
  const aside = await page.locator('.gh-aside').innerText();
  ok('④ 侧栏显示仓库地址与分支', aside.includes(REPO) && /master/.test(aside));
  ok('④ 作者能看到「同步仓库」按钮', (await page.locator('.gh-aside button.gh-zip', { hasText: '同步仓库' }).count()) === 1);
  // 同步：行 id 会整树换掉，计数不变
  await page.locator('.gh-aside button.gh-zip', { hasText: '同步仓库' }).click();
  // 等这条 toast 自己出现 —— 直接读 .el-message 会抢到上一条（发布成功的「🚀 开楼成功」）
  const syncOk = await page.locator('.el-message', { hasText: '已同步' })
    .waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
  const syncMsg = syncOk ? await page.locator('.el-message', { hasText: '已同步' }).first().innerText() : '(无)';
  ok(`★ ④ 点「同步仓库」成功（${syncMsg.replace(/\s+/g, ' ').trim()}）`, /已同步\s*4\s*个文件/.test(syncMsg));
  await page.waitForTimeout(500);
  ok('④ 同步后目录树仍是 7 行（整树替换，不重复堆积）', (await page.locator('.ft-row').count()) === 7);
  await page.screenshot({ path: SHOT('light'), fullPage: true }).catch(() => {});
  ok(`已存浅色截图 ${SHOT('light')}（供人工看观感）`, true);

  // ---------- 编辑弹窗：回填 + 卸载 ----------
  await page.locator('.gh-readme button', { hasText: /^编辑$/ }).first().click();
  await page.locator('.gt-repo input').waitFor({ state: 'visible', timeout: 8000 });
  ok('★ ⑥ 编辑态回填仓库地址（不是空白，否则一保存就把绑定抹了）',
    (await page.locator('.gt-repo input').inputValue()) === REPO);
  await page.locator('.fol-sum').click(); // 清单默认收起，先展开
  await page.locator('.fol-item').first().waitFor({ state: 'visible', timeout: 5000 });
  ok('⑥ 编辑态文件清单里 Gitee 行不给逐个删除（应由仓库地址统一管理）',
    (await page.locator('.fol-item .fol-gt').count()) === 4
    && (await page.locator('.fol-item').count()) === 4
    && (await page.locator('.fol-item .fol-del').count()) === 0);
  // 只改标题保存：仓库必须还在
  await page.locator('.sh-title input').fill(`${T_POST} 改名`);
  await page.locator('.editor-dlg button', { hasText: /保存|更新/ }).first().click();
  await page.waitForTimeout(1200);
  const after = await api(`/share/posts/${pid}`, { token: ta });
  ok('★ ⑥ 只改标题保存 → 仓库绑定与 4 个文件都还在', after.gitee_repo === REPO && after.files?.length === 4);

  // ---------- 浏览器 2：非作者无同步权限（复用同一个 browser，只开新上下文） ----------
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await seedAuth(pageB, tb, rb.user);
  await pageB.goto(`${WEB}/share/${pid}`, { waitUntil: 'domcontentloaded' });
  await pageB.locator('.ft-wrap').waitFor({ state: 'visible', timeout: 20000 });
  ok('★ ⑦ 非作者看不到「同步仓库」按钮', (await pageB.locator('.gh-aside button.gh-zip', { hasText: '同步仓库' }).count()) === 0);
  const syncOther = await j(`/share/posts/${pid}/gitee-sync`, { method: 'POST', token: tb, body: {} });
  ok('★ ⑦ 非作者直接打同步接口 → 403（按钮藏了不等于权限收了）', syncOther.res.status === 403);
  await ctxB.close();

  ok('全程无未捕获的前端异常', pageErrors.length === 0);
  if (pageErrors.length) console.log(`      ↳ ${pageErrors.slice(0, 3).join(' | ')}`);

  // ---------- 清理 ----------
  await browser.close(); browser = null;
  await api(`/share/posts/${pid}`, { method: 'DELETE', token: ta }).catch(() => {});
  const db = openProbeDb(API);
  db.prepare('DELETE FROM user WHERE id IN (?, ?)').run(uidA, uidB);
  db.close();
  ok('自清理：探针帖子/测试用户已删除', true);
} catch (e) {
  fail++;
  console.log(`❌ 异常中断: ${e.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (srv) srv.close();
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
