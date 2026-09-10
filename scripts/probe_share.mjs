// 浏览器探针（Playwright + Chromium）：资源分享页「GitHub 仓库页」重做后的守护测试
//
// 被测行为（本次重做的核心链路，旧版全无 DOM 级覆盖）：
//   仓库头徽标 ← /api/share/posts 的 stats；一条帖 = 文件表一行；点行 → 下方 README 框展开正文/附件/讨论；
//   tabs（资源/我的帖子/我的收藏）复用 scope；?post=ID 深链直达选中；幽灵帖对普通用户不可见。
//
// 判别力（本探针存在的意义）：
//   ① 徽标/表格数字与 API 不符（stats 口径写错、counts 双持有者漂移）
//   ② 点行后 README 不渲染（选中链路断、normAtts 漏调）
//   ③ README 点赞后表格行与头部徽标不同步（rows 与 cur 两份数据未同写）
//   ④ 深链失效（旧实现只在 onMounted 读一次 query，站内二次跳转不生效）
//   ⑤ 幽灵隔离被 scope 绕过（幽灵帖漏给普通用户）
//
// 前置：后端 :3000 与 vite 开发服 :5173 均已启动
//   终端1：cd backend && npm start
//   终端2：cd frontend && npm run dev
//   运行：node scripts/probe_share.mjs   （或 npm run probe:share）
// 自清理：探针自建帖/标签/测试用户，跑完自删，可反复运行。
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

// 默认打本机开发服；PROBE_API / PROBE_WEB 可覆盖（对着临时实例跑，不必动用户的 :3000）
const API = process.env.PROBE_API || 'http://localhost:3000/api';
const WEB = process.env.PROBE_WEB || 'http://localhost:5173';
const DB_PATH = 'D:\\desktop\\竞赛指导\\backend\\data\\compass.db';
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
async function switchToNewest(pg) {
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

  // ③ 点行 → README 展开
  await rowOf(T_TXT).click();
  await page.locator('.gh-readme .gh-rhead').waitFor({ state: 'visible', timeout: 10000 });
  ok('★ ③ 点行 → README 框出现该帖标题', (await page.locator('.gh-readme .gh-rfile').innerText()).includes(T_TXT));
  ok('★ ③ README 渲染正文内容', (await page.locator('.gh-readme .gh-rbody').innerText()).includes(C_TEXT));
  ok('③ 选中行高亮', (await page.locator('.gh-row.sel').count()) === 1 && (await page.locator('.gh-row.sel').innerText()).includes(T_TXT));

  // ④ 点赞：README 按钮 / 表格行（帖子级计数）+ 头部徽标（全站计数）三处同步
  // 注意口径不同：徽标 = 全站 stats.likes，按钮 = 该帖 like_count —— 不能混用同一个基准数
  const likeBtn = page.locator('.gh-readme .gh-rdock .gh-btn').first();
  const rowAct = rowOf(T_TXT).locator('.gh-act').first();
  const postLikeBefore = numOf(await likeBtn.innerText());
  const rowLikeBefore = numOf(await rowAct.innerText());
  const badgeLikeBefore = await badgeNum(1);
  await likeBtn.click();
  await page.waitForFunction((n) => Number(document.querySelectorAll('.gh-badge')[1].innerText.replace(/[^\d]/g, '')) === n + 1, badgeLikeBefore, { timeout: 10000 }).catch(() => {});
  ok(`★ ④ 点赞 → 头部徽标 +1（${badgeLikeBefore} → ${await badgeNum(1)}）`, (await badgeNum(1)) === badgeLikeBefore + 1);
  ok(`④ 点赞 → README 按钮计数 +1（${postLikeBefore} → ${numOf(await likeBtn.innerText())}）`, numOf(await likeBtn.innerText()) === postLikeBefore + 1);
  ok(`★ ④ 点赞 → 表格该行计数同步（rows 与 cur 双持有者）（${rowLikeBefore} → ${numOf(await rowAct.innerText())}）`,
    numOf(await rowAct.innerText()) === rowLikeBefore + 1);
  ok('④ 点赞按钮进入已赞态', (await likeBtn.getAttribute('class') || '').split(/\s+/).includes('on'));

  // ⑤ 评论
  await page.locator('.gh-readme .gh-cinput input').fill(C_CMT);
  await page.locator('.gh-readme .gh-cinput button').click();
  const cmtOk = await page.locator(`.gh-readme .gh-ctext:has-text("${C_CMT}")`).waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
  ok('★ ⑤ 发评论 → 讨论区出现该评论', cmtOk);
  ok('⑤ 评论按 issue 风排版（commented + 相对时间）',
    (await page.locator('.gh-readme .gh-ctop .gh-ctime').first().innerText()).startsWith('commented'));

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

  // ⑦ 深链：整页加载 /share?post=ID 直达选中（复刻 MyView / 消息中心入口）
  await page.goto(`${WEB}/share?post=${pTxt.id}`, { waitUntil: 'domcontentloaded' });
  const deepOk = await page.locator('.gh-readme .gh-rfile').waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
  ok('★ ⑦ 深链 /share?post=ID 直达选中该书签帖', deepOk && (await page.locator('.gh-readme .gh-rfile').innerText()).includes(T_TXT));

  // ⑦b 深链指向不存在的帖 → 就地报错，不白屏
  await page.goto(`${WEB}/share?post=99999999`, { waitUntil: 'domcontentloaded' });
  const errShown = await page.locator('.gh-rstate.err').waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
  ok('★ ⑦b 深链指向不存在的帖 → README 就地显示错误（不整页白屏）', errShown);

  // ⑦c 站内二次选中（旧缺陷：deepLink 只在 onMounted 读一次 query，第二次点行不生效 —— 必须 watch route.query.post）
  await page.goto(`${WEB}/share`, { waitUntil: 'domcontentloaded' });
  await page.locator('.gh-filebox').waitFor({ state: 'visible', timeout: 20000 });
  await switchToNewest(page);
  await rowOf(T_TXT).click();
  await page.waitForFunction((s) => document.querySelector('.gh-readme .gh-rfile')?.innerText.includes(s), T_TXT, { timeout: 10000 }).catch(() => {});
  await rowOf(T_IMG).click();
  ok('★ ⑦c 连续点两行 → README 跟着换（第二次选中也生效）',
    await page.waitForFunction((s) => document.querySelector('.gh-readme .gh-rfile')?.innerText.includes(s), T_IMG, { timeout: 10000 }).then(() => true).catch(() => false));
  ok('⑦c URL 同步为 ?post=该帖 id', Number(page.url().match(/post=(\d+)/)?.[1]) === Number(pImg.id));

  // ⑩ 幽灵页 /ghost-share：单静态标签 + 只见幽灵帖 + 暗色主题（本页是「模板双主题」最容易出白块的地方）
  await page.goto(`${WEB}/ghost-share`, { waitUntil: 'domcontentloaded' });
  await page.locator('.gh-filebox').waitFor({ state: 'visible', timeout: 20000 });
  ok('★ ⑩ 幽灵页只渲染一个静态标签（scope 非空会绕过幽灵隔离混进普通帖）',
    (await page.locator('.gh-tab').count()) === 1 && (await page.locator('.gh-tab.static').count()) === 1);
  ok('★ ⑩ 幽灵页看得见自己的幽灵帖', (await rowOf(T_GHOST).count()) === 1);
  ok('★ ⑩ 幽灵页看不见普通帖（ghost=1 反向过滤）', (await rowOf(T_TXT).count()) === 0 && (await rowOf(T_IMG).count()) === 0);
  ok('★ ⑩ 幽灵页自动套暗色主题（html.ghost-mode）', await page.evaluate(() => document.documentElement.classList.contains('ghost-mode')));
  await rowOf(T_GHOST).click();
  await page.locator('.gh-readme .gh-rbody').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800); // fullPage 截图前必须等重排结束，否则拼出白色空带（假告警）
  await page.screenshot({ path: SHOT('dark_ghost'), fullPage: true }).catch(() => {});
  ok(`⑩ 已存幽灵页暗色截图 ${SHOT('dark_ghost')}（供人工看观感）`, true);

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
  await pageA.screenshot({ path: SHOT('light'), fullPage: true }).catch(() => {});
  ok(`⑨ 已存浅色截图 ${SHOT('light')}（供人工看观感）`, true);

  // ---------- 清理 ----------
  await browser.close(); browser = null;
  await browserA.close(); browserA = null;
  for (const id of postIds) await api(`/share/posts/${id}`, { method: 'DELETE', token: id === Number(pGhost.id) ? tb : ta }).catch(() => {});
  const db = new DatabaseSync(DB_PATH);
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
