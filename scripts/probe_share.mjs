// 浏览器探针（Playwright + Chromium）：资源分享页「GitHub 仓库页 + 详情子路由」的守护测试
//
// 被测行为（核心链路）：
//   仓库头徽标 ← /api/share/posts 的 stats；一条帖 = 文件表一行；**点行 → 跳 /share/:id 独立详情页**；
//   tabs（资源/我的帖子/我的收藏）复用 scope；?post=ID 老链接重定向到新子路由；幽灵帖对普通用户不可见。
//
// 判别力（本探针存在的意义）：
//   ① 徽标/表格数字与 API 不符（stats 口径写错、counts 双持有者漂移）
//   ② 点行后详情页不渲染（路由没接上、normAtts 漏调）
//   ③ 详情页点赞后列表行/头部徽标不同步（拆页后两个数据持有者各自失效）
//   ④ 深链失效 / ?post= 兼容层断（老链接、消息通知、我的收藏全部落空）
//   ⑤ 幽灵隔离被 scope 绕过（幽灵帖漏给普通用户）；详情页误报「不在当前列表视图」
//   ⑥ scrollBehavior 缺失（详情页停在列表的滚动位置）
//
// 前置：后端 :3000 与 vite 开发服 :5173 均已启动
//   终端1：cd backend && npm start
//   终端2：cd frontend && npm run dev
//   运行：node scripts/probe_share.mjs   （或 npm run probe:share）
// 自清理：探针自建帖/标签/测试用户，跑完自删，可反复运行。
import { chromium } from 'playwright';
import { DEFAULT_API, openProbeDb } from './lib/probeDb.mjs';
import os from 'node:os';
import path from 'node:path';

// 默认打本机开发服；PROBE_API / PROBE_WEB 可覆盖（对着临时实例跑，不必动用户的 :3000）
const API = process.env.PROBE_API || DEFAULT_API;
const WEB = process.env.PROBE_WEB || 'http://localhost:5173';
// 截图是给人工看观感的副产品，落系统临时目录（不进仓库、不脏 git status）
const SHOT = (n) => path.join(os.tmpdir(), `probe_share_${n}.png`);

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}`)); };
const numOf = (s) => Number(String(s).replace(/[^\d]/g, '')); // 「👍 12」→ 12

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

const pre = async () => {
  try { await fetch(API + '/health'); } catch { throw new Error('后端 :3000 未启动 —— 先跑 cd backend && npm start'); }
  try { await fetch(WEB, { signal: AbortSignal.timeout(3000) }); } catch { throw new Error('前端 :5173 未启动 —— 先跑 cd frontend && npm run dev'); }
};

const stamp = Date.now().toString().slice(-8);
const EMAIL_A = `probe_share_a_${stamp}@test.dev`;
const EMAIL_B = `probe_share_b_${stamp}@test.dev`;
const TAG_A = `探针甲${stamp}`;
const TAG_B = `探针乙${stamp}`;
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const T_IMG = `探针图片资源${stamp}`;
const T_TXT = `探针纯文字${stamp}`;
const T_GHOST = `探针幽灵帖${stamp}`;
const C_TEXT = `这是一段纯文字正文，用于断言 README 正文渲染${stamp}`;
const C_CMT = `探针评论内容${stamp}`;

let browser = null, browserA = null;
let uidA = 0, uidB = 0;
const postIds = [];

// 用 localStorage 直接种登录态（键名同 auth.js:4-5），跳过 UI 登录
const seedAuth = (page, token, user) => page.addInitScript(([t, u]) => {
  localStorage.setItem('ec_token', t);
  localStorage.setItem('ec_user', JSON.stringify(u));
}, [token, user]);

// 切排序到「最新」：夹具是刚建的，最新序才保证它们落在第 1 页
// （页面 size 硬编码 10，且 size/tag 都不从 query 读 —— 只能从 UI 改排序）
// 幂等：列表状态在 ShareView 模块级缓存里，「详情页返回」时排序还是上次那个最新 ——
// 再点一次会撞上 :disabled 的当前项、并把下拉留在展开态挡住后续点击
async function switchToNewest(pg) {
  if ((await pg.locator('.gh-sortbtn').innerText()).includes('最新')) return;
  await pg.locator('.gh-sortbtn').click();
  await pg.locator('.el-dropdown-menu__item:has-text("最新")').click();
  await pg.waitForFunction(() => document.querySelector('.gh-sortbtn')?.innerText.includes('最新'), null, { timeout: 10000 }).catch(() => {});
}

try {
  await pre();
  ok(`前置：后端 ${API} 与前端 ${WEB} 均在运行`, true);

  // ---------- 夹具（走 API 快速造） ----------
  const ra = await api('/auth/register', { method: 'POST', body: { email: EMAIL_A, password: 'pass123456', nickname: `探针甲作者${stamp}` } });
  uidA = Number(ra.user.id);
  const rb = await api('/auth/register', { method: 'POST', body: { email: EMAIL_B, password: 'pass123456', nickname: `探针乙读者${stamp}` } });
  uidB = Number(rb.user.id);
  const ta = ra.token, tb = rb.token;

  // A 发两帖：一帖带图（首列应显示图片类图标）、一帖纯文字（应显示文件图标），标签各一
  const pImg = await api('/share/posts', { method: 'POST', token: ta, body: { title: T_IMG, content: '<p>图片帖正文</p>', tags: [TAG_A], attachments: [{ name: '封面.png', size: 68, mime: 'image/png', data: PNG_1x1 }] } });
  postIds.push(Number(pImg.id));
  const pTxt = await api('/share/posts', { method: 'POST', token: ta, body: { title: T_TXT, content: `<p>${C_TEXT}</p>`, tags: [TAG_B] } });
  postIds.push(Number(pTxt.id));

  // B 开幽灵身份并留一条幽灵帖（用于验证普通用户看不到）
  const enter = await api('/ghost/enter', { method: 'POST', token: tb });
  const userB = enter.user || { ...rb.user, is_ghost: true };
  const pGhost = await api('/share/posts', { method: 'POST', token: tb, body: { title: T_GHOST, content: '<p>幽灵内容</p>' } });
  postIds.push(Number(pGhost.id));

  // B 收藏图片帖（供「我的收藏」tab 断言）
  await api(`/share/posts/${pImg.id}/fav`, { method: 'POST', token: tb });
  ok('夹具就绪：A 两帖（图/文）+ B 幽灵帖 + B 收藏图片帖', Number(pGhost.id) > 0 && !!userB.is_ghost);

  // 参考数据：B（幽灵）在 /share 默认视图（无 scope/ghost 参数 → 只普通帖）下的 stats 与 total
  const ref = await api('/share/posts?size=1', { token: tb });
  const stats = ref.stats || {};
  const refNew = await api('/share/posts?sort=new&size=10', { token: tb }); // 供排序断言对账

  // ---------- 浏览器 1：B 视角 ----------
  browser = await chromium.launch();
  const ctxB = await browser.newContext();
  const page = await ctxB.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await seedAuth(page, tb, userB);

  await page.goto(`${WEB}/share`, { waitUntil: 'domcontentloaded' });
  await page.locator('.gh-filebox').waitFor({ state: 'visible', timeout: 20000 });
  await switchToNewest(page);

  const rows = () => page.locator('.gh-row');
  const rowOf = (title) => page.locator('.gh-row', { hasText: title });
  const titles = () => page.locator('.gh-row .gh-fname').allInnerTexts();
  const badgeNum = async (i) => numOf(await page.locator('.gh-badge').nth(i).innerText());

  // ① 仓库头
  ok('① 仓库头面包屑渲染（Engineer-Compass / 资源分享）',
    (await page.locator('.gh-crumb:has-text("Engineer-Compass")').count()) === 1
    && (await page.locator('.gh-crumb:has-text("资源分享")').count()) === 1);
  ok('① 板块描述渲染', (await page.locator('.gh-desc').first().innerText()).includes('交流区'));
  ok(`① 徽标「资源数」= API stats.posts（UI ${await badgeNum(0)} / API ${stats.posts}）`, (await badgeNum(0)) === Number(stats.posts));
  ok(`① 徽标「点赞」= API stats.likes（UI ${await badgeNum(1)} / API ${stats.likes}）`, (await badgeNum(1)) === Number(stats.likes));
  ok(`① 徽标「收藏」= API stats.favs（UI ${await badgeNum(2)} / API ${stats.favs}）`, (await badgeNum(2)) === Number(stats.favs));
  ok(`① 徽标「评论」= API stats.comments（UI ${await badgeNum(3)} / API ${stats.comments}）`, (await badgeNum(3)) === Number(stats.comments));

  // ② 文件表格：行数 = min(total, 每页 10)；图标随附件类型变化
  const rowCount = await rows().count();
  ok(`② 表格行数 = min(API total, 每页 10)（UI ${rowCount} / API ${ref.total}）`, rowCount === Math.min(Number(ref.total), 10));
  ok('② 两个夹具帖都在表内', (await rowOf(T_IMG).count()) === 1 && (await rowOf(T_TXT).count()) === 1);

  const iconOf = async (title) => (await rowOf(title).locator('svg path').first().getAttribute('d') || '').slice(0, 40);
  const iconImg = await iconOf(T_IMG);
  const iconTxt = await iconOf(T_TXT);
  ok('★ ② 行图标随附件类型变化（图片帖 ≠ 纯文字帖）', !!iconImg && !!iconTxt && iconImg !== iconTxt);
  ok('② 时间列是相对时间', /刚刚|分钟前|小时前|天前|个月前|^\d{4}-\d{2}-\d{2}$/.test((await rowOf(T_IMG).locator('.c-time').innerText()).trim()));

  // ⑧ 排序：切「最新」后首行应与 API sort=new 的首页一致（且新帖在老帖前面）
  const t = await titles();
  ok(`★ ⑧ 排序切「最新」→ 首行 = API sort=new 首行（${t[0]}）`, t[0] === refNew.rows[0]?.title);
  ok('⑧ 排序生效：晚建的纯文字帖排在图片帖之前', t.indexOf(T_TXT) >= 0 && t.indexOf(T_IMG) >= 0 && t.indexOf(T_TXT) < t.indexOf(T_IMG));

  // ③ 点行 → 跳独立详情子路由 /share/:id
  await rowOf(T_TXT).click();
  await page.locator('.gh-readme .gh-rhead').waitFor({ state: 'visible', timeout: 10000 });
  ok(`★ ③ 点行 → URL 变为 /share/:id（实际 ${new URL(page.url()).pathname}）`,
    new URL(page.url()).pathname === `/share/${pTxt.id}`);
  ok('★ ③ 详情页出现该帖标题', (await page.locator('.gh-readme .gh-rfile').innerText()).includes(T_TXT));
  ok('★ ③ 详情页渲染正文内容', (await page.locator('.gh-readme .gh-rbody').innerText()).includes(C_TEXT));
  ok('★ ③ 独立页不出现「不在当前列表视图」误报（standalone 生效，冷启动深链必真）',
    (await page.locator('.gh-rhint').count()) === 0);
  ok('③ 详情页无表格（列表已卸载，不是同页展开）', (await page.locator('.gh-row').count()) === 0);

  // ④ 点赞：详情页按钮 +1；**返回列表后该行计数同步** —— 拆页后两份数据各自成立（不再靠同页双写）
  // 注意口径不同：徽标 = 全站 stats.likes，按钮 = 该帖 like_count —— 不能混用同一个基准数
  const likeBtn = page.locator('.gh-readme .gh-rdock .gh-btn').first();
  const postLikeBefore = numOf(await likeBtn.innerText());
  const likeBeforeApi = Number((await api(`/share/posts/${pTxt.id}`)).like_count);
  await likeBtn.click();
  await page.waitForFunction((n) => document.querySelector('.gh-readme .gh-rdock .gh-btn')?.innerText.includes(String(n + 1)), postLikeBefore, { timeout: 10000 }).catch(() => {});
  ok(`④ 点赞 → 详情页按钮计数 +1（${postLikeBefore} → ${numOf(await likeBtn.innerText())}）`, numOf(await likeBtn.innerText()) === postLikeBefore + 1);
  ok('④ 点赞按钮进入已赞态', (await likeBtn.getAttribute('class') || '').split(/\s+/).includes('on'));
  ok(`④ 点赞已落库（API like_count = ${likeBeforeApi + 1}）`, Number((await api(`/share/posts/${pTxt.id}`)).like_count) === likeBeforeApi + 1);

  // ⑤ 评论（详情页）
  await page.locator('.gh-readme .gh-cinput input').fill(C_CMT);
  await page.locator('.gh-readme .gh-cinput button').click();
  const cmtOk = await page.locator(`.gh-readme .gh-ctext:has-text("${C_CMT}")`).waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
  ok('★ ⑤ 发评论 → 讨论区出现该评论', cmtOk);
  ok('⑤ 评论按 issue 风排版（commented + 相对时间）',
    (await page.locator('.gh-readme .gh-ctop .gh-ctime').first().innerText()).startsWith('commented'));

  // ⑤b 返回按钮 → 列表；点赞计数已落到行上（两个页面各持一份数据，返回时自愈）
  await page.locator('.gh-back').click();
  await page.locator('.gh-filebox').waitFor({ state: 'visible', timeout: 10000 });
  await switchToNewest(page);
  // 返回时列表会拿缓存先画、再 load() 静默刷新，故必须等那一行刷成新值再断言（否则读到的是缓存里的旧数）
  const likeSynced = await page.waitForFunction(([s, n]) => {
    const r = [...document.querySelectorAll('.gh-row')].find((x) => x.innerText.includes(s));
    return r && Number(r.querySelector('.gh-act').innerText.replace(/[^\d]/g, '')) === n;
  }, [T_TXT, likeBeforeApi + 1], { timeout: 10000 }).then(() => true).catch(() => false);
  ok(`★ ⑤b 返回列表（URL ${new URL(page.url()).pathname}）且该行点赞数刷新为详情页那份（${likeBeforeApi + 1}）`,
    new URL(page.url()).pathname === '/share' && likeSynced);

  // ⑥ tabs：我的收藏 → 只剩收藏过的帖
  await page.locator('.gh-tab:has-text("我的收藏")').click();
  await page.waitForFunction((s) => document.querySelectorAll('.gh-row').length > 0
    && [...document.querySelectorAll('.gh-row')].every((r) => r.innerText.includes(s)), T_IMG, { timeout: 10000 }).catch(() => {});
  const favRows = await rows().count();
  ok(`★ ⑥ 切「我的收藏」→ 列表只剩收藏过的图片帖（${favRows} 行）`,
    favRows === 1 && (await rowOf(T_IMG).count()) === 1 && (await rowOf(T_TXT).count()) === 0);

  // ⑧b 标签过滤（先回「资源」tab）
  await page.locator('.gh-tab:has-text("资源")').click();
  await page.locator(`.gh-topic:has-text("${TAG_A}")`).click();
  await page.waitForFunction((s) => document.querySelectorAll('.gh-row').length === 1
    && document.querySelector('.gh-row').innerText.includes(s), T_IMG, { timeout: 10000 }).catch(() => {});
  ok('★ ⑧ 点 Topics 标签 → 列表收敛到该子板块',
    (await rows().count()) === 1 && (await rowOf(T_IMG).count()) === 1);
  ok('⑧ 出现可清除的筛选条', (await page.locator('.gh-filterbar').count()) === 1);

  await page.locator(`.gh-topic:has-text("${TAG_B}")`).click();
  await page.waitForFunction((s) => document.querySelectorAll('.gh-row').length === 1
    && document.querySelector('.gh-row').innerText.includes(s), T_TXT, { timeout: 10000 }).catch(() => {});
  ok('⑧ 换标签 → 列表跟着换', (await rowOf(T_TXT).count()) === 1);

  await page.locator('.gh-filterx').click();
  await page.waitForTimeout(500);
  ok('⑧ 清除筛选 → 回到全部', (await page.locator('.gh-filterbar').count()) === 0);

  // ⑨ 幽灵隔离（B 已开幽灵身份，默认视图只普通帖；幽灵帖不混入）
  ok('★ ⑨ 幽灵帖不出现在默认列表（普通帖视图）', (await rowOf(T_GHOST).count()) === 0);

  // ⑦ 冷启动深链 /share/:id（正式形态：从消息通知、我的收藏、外部分享的链接直接落地）
  await page.goto(`${WEB}/share/${pTxt.id}`, { waitUntil: 'domcontentloaded' });
  const deepOk = await page.locator('.gh-readme .gh-rhead').waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
  ok('★ ⑦ 冷启动 /share/:id 直达该帖详情（含没进过列表的直链）',
    deepOk && (await page.locator('.gh-readme .gh-rfile').innerText()).includes(T_TXT));

  // ⑦b 深链指向不存在的帖 → 就地报错，不白屏
  await page.goto(`${WEB}/share/99999999`, { waitUntil: 'domcontentloaded' });
  const errShown = await page.locator('.gh-rstate.err').waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
  ok('★ ⑦b 深链指向不存在的帖 → 详情页就地显示错误（不整页白屏）', errShown);

  // ⑦c 兼容层：老链接 /share?post=ID 必须重定向到 /share/:id（消息通知、MyView、历史书签全走这条）
  await page.goto(`${WEB}/share?post=${pTxt.id}`, { waitUntil: 'domcontentloaded' });
  const oldOk = await page.locator('.gh-readme .gh-rhead').waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
  ok('★ ⑦c 老链接 /share?post=ID 重定向到 /share/:id 并渲染出该帖',
    oldOk && new URL(page.url()).pathname === `/share/${pTxt.id}`
    && (await page.locator('.gh-readme .gh-rfile').innerText()).includes(T_TXT));
  ok('⑦c 老链接的 ?post= 已从 URL 上清掉（不留兼容残渣）', !page.url().includes('post='));

  // ⑦d 连续点两行（站内第二次选中：列表 → 详情 → 返回 → 另一条帖）
  await page.goto(`${WEB}/share`, { waitUntil: 'domcontentloaded' });
  await page.locator('.gh-filebox').waitFor({ state: 'visible', timeout: 20000 });
  await switchToNewest(page);
  await rowOf(T_TXT).click();
  await page.waitForFunction((s) => document.querySelector('.gh-readme .gh-rfile')?.innerText.includes(s), T_TXT, { timeout: 10000 }).catch(() => {});
  await page.locator('.gh-back').click();
  await page.locator('.gh-filebox').waitFor({ state: 'visible', timeout: 10000 });
  await switchToNewest(page);
  await rowOf(T_IMG).click();
  ok('★ ⑦d 连续点两条帖 → 第二次也落到对应的详情页',
    await page.waitForFunction((s) => document.querySelector('.gh-readme .gh-rfile')?.innerText.includes(s), T_IMG, { timeout: 10000 }).then(() => true).catch(() => false)
    && new URL(page.url()).pathname === `/share/${pImg.id}`);

  // ⑦e 滚动：换页回顶 + 返回列表还原位置。需列表真的满一屏才有意义 → 临时造 12 条凑满首页。
  // 「是否可滚动」不能听天由命：页面总高随库里数据变（右栏标签条数、标题换行都会撑高），
  // 在老库上够高、在空库上就静默跳过断言 —— 探针最怕这种自己把自己绕过去的绿。
  // 改为把视口压矮，满 10 行必然溢出，判定就成了确定性的，不达标即真回归。
  const scrollIds = [];
  for (let i = 0; i < 12; i++) {
    const p = await api('/share/posts', { method: 'POST', token: ta, body: { title: `探针滚屏${stamp}_${i}`, content: '<p>占位</p>' } });
    scrollIds.push(Number(p.id));
  }
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.goto(`${WEB}/share`, { waitUntil: 'domcontentloaded' });
  await page.locator('.gh-filebox').waitFor({ state: 'visible', timeout: 20000 });
  await switchToNewest(page);
  await page.waitForFunction(() => document.querySelectorAll('.gh-row').length >= 10, null, { timeout: 15000 }).catch(() => {});
  ok('⑦e 列表满一页时可滚动（矮视口下必然溢出）',
    await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 200));
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForTimeout(200);
  const s0 = await page.evaluate(() => window.scrollY);
  await page.locator('.gh-row').nth(9).click();          // 第 10 行（矮视口首屏外）
  await page.locator('.gh-readme .gh-rhead').waitFor({ state: 'visible', timeout: 10000 });
  ok(`★ ⑦e 从列表滚动位置点行 → 详情页回到顶部（列表曾滚到 ${s0}）`,
    (await page.evaluate(() => window.scrollY)) === 0);
  await page.goBack();
  await page.locator('.gh-filebox').waitFor({ state: 'visible', timeout: 10000 });
  const restored = await page.waitForFunction((n) => Math.abs(window.scrollY - n) < 40, s0, { timeout: 10000 }).then(() => true).catch(() => false);
  ok(`★ ⑦e 浏览器后退回列表 → 还原到离开时的滚动位置（${s0}）`, restored);
  await page.setViewportSize({ width: 1280, height: 720 });
  // 滚屏夹具用完即删：它们比 T_TXT/T_IMG 新，留着会把两个夹具帖挤出第 1 页（浏览器 A 那节要按标题找行）
  for (const id of scrollIds) await api(`/share/posts/${id}`, { method: 'DELETE', token: ta }).catch(() => {});

  // ⑩ 幽灵页 /ghost-share：单静态标签 + 只见幽灵帖 + 暗色主题（本页是「模板双主题」最容易出白块的地方）
  await page.goto(`${WEB}/ghost-share`, { waitUntil: 'domcontentloaded' });
  await page.locator('.gh-filebox').waitFor({ state: 'visible', timeout: 20000 });
  ok('★ ⑩ 幽灵页只渲染一个静态标签（scope 非空会绕过幽灵隔离混进普通帖）',
    (await page.locator('.gh-tab').count()) === 1 && (await page.locator('.gh-tab.static').count()) === 1);
  // 列表是异步拉的：.gh-filebox 在 loading 态就已可见，据此直接数行会偶发数到 0（flaky）。
  // 先等幽灵帖这一行真的渲染出来，后面的正/负断言才都有意义。
  await rowOf(T_GHOST).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
  ok('★ ⑩ 幽灵页看得见自己的幽灵帖', (await rowOf(T_GHOST).count()) === 1);
  ok('★ ⑩ 幽灵页看不见普通帖（ghost=1 反向过滤）', (await rowOf(T_TXT).count()) === 0 && (await rowOf(T_IMG).count()) === 0);
  ok('★ ⑩ 幽灵页自动套暗色主题（html.ghost-mode）', await page.evaluate(() => document.documentElement.classList.contains('ghost-mode')));
  await rowOf(T_GHOST).click();
  await page.locator('.gh-readme .gh-rbody').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  ok(`★ ⑩ 幽灵帖点行 → 落 /ghost-share/:id（不串到普通详情页）`,
    new URL(page.url()).pathname === `/ghost-share/${pGhost.id}`);
  ok('★ ⑩ 幽灵详情页仍是暗色主题（html.ghost-mode，新页未漏白）',
    await page.evaluate(() => document.documentElement.classList.contains('ghost-mode')));
  await page.waitForTimeout(800); // fullPage 截图前必须等重排结束，否则拼出白色空带（假告警）
  await page.screenshot({ path: SHOT('dark_ghost'), fullPage: true }).catch(() => {});
  ok(`⑩ 已存幽灵详情页暗色截图 ${SHOT('dark_ghost')}（供人工看观感）`, true);

  // ⑩b 移动端 375px：两栏折单栏 + 表格瘦身（作者/互动列隐藏）
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${WEB}/share`, { waitUntil: 'domcontentloaded' });
  await page.locator('.gh-filebox').waitFor({ state: 'visible', timeout: 20000 });
  await switchToNewest(page);
  // 列是 display:none 藏起来的（DOM 里仍在），所以断言可见性而不是节点数
  const vis = (sel) => page.locator(sel).first().isVisible();
  ok('⑩b 375px 下表格瘦身：作者/互动列隐藏，名称与时间仍在',
    !(await vis('.gh-row .c-author')) && !(await vis('.gh-row .c-acts'))
    && (await vis('.gh-row .c-name')) && (await vis('.gh-row .c-time'))
    && await page.evaluate(() => getComputedStyle(document.querySelector('.gh-row')).gridTemplateColumns.split(' ').length === 2));
  ok('⑩b 375px 下两栏折成单栏（About 提到表格上方）',
    await page.evaluate(() => {
      const body = document.querySelector('.gh-body'); const aside = document.querySelector('.gh-aside'); const main = document.querySelector('.gh-main');
      return !!body && getComputedStyle(body).gridTemplateColumns.split(' ').length === 1 && aside.getBoundingClientRect().top < main.getBoundingClientRect().top;
    }));
  await page.waitForTimeout(800);
  await page.screenshot({ path: SHOT('mobile375'), fullPage: true }).catch(() => {});
  ok(`⑩b 已存移动端截图 ${SHOT('mobile375')}（供人工看观感）`, true);
  await page.setViewportSize({ width: 1280, height: 720 });

  ok('全程无未捕获的前端异常', pageErrors.length === 0);
  if (pageErrors.length) console.log(`      ↳ ${pageErrors.slice(0, 3).join(' | ')}`);

  // ---------- 浏览器 2：A（普通用户）视角，验证幽灵帖不可见 ----------
  browserA = await chromium.launch();
  const ctxA = await browserA.newContext();
  const pageA = await ctxA.newPage();
  await seedAuth(pageA, ta, ra.user);
  await pageA.goto(`${WEB}/share`, { waitUntil: 'domcontentloaded' });
  await pageA.locator('.gh-filebox').waitFor({ state: 'visible', timeout: 20000 });
  await switchToNewest(pageA);
  ok('★ ⑨ 普通用户 A 看不到幽灵帖（服务端隔离未被前端绕过）', (await pageA.locator('.gh-row', { hasText: T_GHOST }).count()) === 0);
  ok('⑨ 普通用户 A 能看到普通帖', (await pageA.locator('.gh-row', { hasText: T_TXT }).count()) === 1);
  // 幽灵帖的详情子路由是新增的第二个入口 —— 直连深链必须同样拿不到
  await pageA.goto(`${WEB}/share/${pGhost.id}`, { waitUntil: 'domcontentloaded' });
  const ghostErr = await pageA.locator('.gh-rstate.err').waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
  ok('★ ⑨ 普通用户直链幽灵帖详情 /share/:id → 就地 404，不泄露内容', ghostErr);
  await pageA.goto(`${WEB}/share/${pTxt.id}`, { waitUntil: 'domcontentloaded' });
  await pageA.locator('.gh-readme .gh-rhead').waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  ok('⑩ 匿名/普通视角下正常帖详情仍可读（改权限没误伤）',
    (await pageA.locator('.gh-readme .gh-rfile').innerText()).includes(T_TXT));
  await pageA.screenshot({ path: SHOT('light'), fullPage: true }).catch(() => {});
  ok(`⑨ 已存浅色截图 ${SHOT('light')}（供人工看观感）`, true);

  // ---------- 清理 ----------
  await browser.close(); browser = null;
  await browserA.close(); browserA = null;
  for (const id of postIds) await api(`/share/posts/${id}`, { method: 'DELETE', token: id === Number(pGhost.id) ? tb : ta }).catch(() => {});
  // 直连 DB 清标签/用户 —— 库必须属于所打的后端，闸门在 lib/probeDb.mjs（非同源直接抛错）。
  const db = openProbeDb(API);
  db.prepare('DELETE FROM share_post_tag WHERE tag_id IN (SELECT id FROM share_tag WHERE name IN (?, ?))').run(TAG_A, TAG_B);
  db.prepare('DELETE FROM share_tag WHERE name IN (?, ?)').run(TAG_A, TAG_B);
  db.prepare('DELETE FROM user WHERE id IN (?, ?)').run(uidA, uidB);
  db.close();
  ok('自清理：探针帖子/标签/测试用户已删除', true);
} catch (e) {
  fail++;
  console.log(`❌ 异常中断: ${e.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (browserA) await browserA.close().catch(() => {});
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
