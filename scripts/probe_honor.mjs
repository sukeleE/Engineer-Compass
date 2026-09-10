// 浏览器探针（Playwright + Chromium）：荣誉墙「奖状图片多行反向跑马灯」的守护测试
//
// 被测行为：后台维护（JSON 元数据 + 独立 multipart 图片）→ 前台公开只读 → 多行反向无缝跑马灯
//   → 点击全屏查看 → prefers-reduced-motion 降级 → 上下架/排序/删除的磁盘一致性
//
// 判别力（本探针存在的意义）：
//   ① 跑马灯"看着在动其实是坏的" —— 断 **computed transform 真的在变**，不是断 el.style.transform
//      （动画期间 inline style 恒为空串，断它永远是假绿）
//   ② 无缝循环的数学被破坏 —— 容器 gap 一加，轨道宽就不等于 2×半份宽，每圈横跳半个间距。
//      断 track ≈ 2×half、computed gap 为 0、且每个半份都 ≥ 视口宽（不足一屏就会露缝）
//   ③ 内容不足一屏露缝 —— 用 elementsFromPoint 沿行扫一遍，每个采样点都必须命中卡片
//   ④ 开了"减弱动态效果"就看不到内容 —— 断降级后仍可横滚、卡片仍可点（最坏的降级是内容不可达）
//   ⑤ SVG/文本改扩展名冒充图片被放行（**安全断言**：魔数嗅探是唯一的墙，SVG 能在本站源下执行脚本）
//   ⑥ store_name（磁盘文件名）泄漏给前端
//   ⑦ 换图/删图/删行后磁盘文件残留（外键级联清行、文件永久占盘，本仓有过这个教训）
//
// 前置：后端与 vite 开发服均已启动。对着临时实例跑（探针自己建夹具用户，不碰既有数据）
//   终端1：cd backend && PORT=3106 DB_PATH=/tmp/t7.db node server.js
//   终端2：cd frontend && VITE_API_TARGET=http://localhost:3106 npx vite --port 5198
//   运行：PROBE_API=http://localhost:3106/api PROBE_WEB=http://localhost:5198 PROBE_DB=/tmp/t7.db node scripts/probe_honor.mjs
// 注意：奖状图固定落在真实 backend/uploads/honor（与 DB_PATH 无关，同 smoke_expense 的既有口径），
//       探针跑完会把自己造的文件删干净。
// 自清理：探针自建荣誉/用户，跑完自删，可反复运行。
import { chromium } from 'playwright';
import zlib from 'node:zlib';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_API, openProbeDb } from './lib/probeDb.mjs';

const API = process.env.PROBE_API || DEFAULT_API;
const WEB = process.env.PROBE_WEB || 'http://localhost:5173';
const SHOT = (n) => path.join(os.tmpdir(), `probe_honor_${n}.png`);
const HONOR_DIR = path.resolve('backend', 'uploads', 'honor'); // 直连磁盘断言（探针与后端同机）

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}${extra ? `  ← ${extra}` : ''}`));
};

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
// 上传一张图（multipart，字段名 image）
const putImage = async (token, id, { name = 'a.png', body, type = 'image/png' }) => {
  const fd = new FormData();
  fd.append('image', new Blob([body], { type }), name);
  const res = await fetch(`${API}/admin/honors/${id}/image`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { res, data: await res.json().catch(() => ({})) };
};
const bulkUpload = async (token, items) => {
  const fd = new FormData();
  for (const it of items) fd.append('images', new Blob([it.body], { type: 'image/png' }), it.name);
  const res = await fetch(`${API}/admin/honors/bulk`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  return { res, data: await res.json().catch(() => ({})) };
};
const imgReq = (id) => fetch(`${API}/honor/${id}/image`, { redirect: 'manual' });
const onDisk = (store) => existsSync(path.join(HONOR_DIR, store));
const dirCount = () => { try { return readdirSync(HONOR_DIR).length; } catch { return -1; } };

// —— 造真图：手写最小 PNG 编码器（无依赖），让每张奖状颜色不同，截图/断言都能分辨 ——
const CRC_T = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC_T[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
};
function makePng(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const base = y * (w * 3 + 1);
    raw[base] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const o = base + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
// 8×8 真 JPEG（最小合法字节）
const JPEG_1x1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64');

const pre = async () => {
  try { await fetch(API + '/health'); } catch { throw new Error(`后端 ${API} 未启动`); }
  try { await fetch(WEB, { signal: AbortSignal.timeout(3000) }); } catch { throw new Error(`前端 ${WEB} 未启动`); }
};

const stamp = Date.now().toString().slice(-8);
const EM_ADM = `probe_honor_a_${stamp}@test.dev`;
const EM_USR = `probe_honor_b_${stamp}@test.dev`;

const seedAuth = (page, token, user) => page.addInitScript(([t, u]) => {
  localStorage.setItem('ec_token', t);
  localStorage.setItem('ec_user', JSON.stringify(u));
}, [token, user]);

const lumOf = (page, sel) => page.locator(sel).first().evaluate((el) => {
  const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g) || [];
  const [r, g, b, a = '1'] = m.map(Number);
  if (Number(a) < 0.5) return null;
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
});

let browser = null;
let uidAdm = 0, uidUsr = 0;
const madeIds = [];

try {
  await pre();
  ok(`前置：后端 ${API} 与前端 ${WEB} 均在运行`, true);

  // ---------------- 夹具：一个管理员 + 一个普通用户 ----------------
  const ra = await api('/auth/register', { method: 'POST', body: { email: EM_ADM, password: 'pass123456', nickname: `荣誉管${stamp}` } });
  uidAdm = Number(ra.user.id);
  const rb = await api('/auth/register', { method: 'POST', body: { email: EM_USR, password: 'pass123456', nickname: `荣誉员${stamp}` } });
  uidUsr = Number(rb.user.id);
  const ta = ra.token, tb = rb.token;
  const pdb = openProbeDb(API); // 直连临时库（PROBE_DB 闸门保证库属于该后端）
  pdb.prepare('UPDATE user SET is_admin = 1 WHERE id = ?').run(uidAdm);
  const admUser = { ...ra.user, is_admin: true };

  // ================= ① 后端契约 =================
  const l0 = await api('/honor');
  ok('①① 匿名可读 /api/honor（公开免登录口径）', Array.isArray(l0.list) && l0.list.length === 0);

  ok('①② 匿名打后台列表 → 401', (await jsonReq('/admin/honors')).res.status === 401);
  ok('①③ 普通用户打后台列表 → 403', (await jsonReq('/admin/honors', { token: tb })).res.status === 403);
  ok('①④ 普通用户建荣誉 → 403', (await jsonReq('/admin/honors', { token: tb, method: 'POST', body: { title: 'x' } })).res.status === 403);
  ok('①⑤ 普通用户删荣誉 → 403', (await jsonReq('/admin/honors/1', { token: tb, method: 'DELETE' })).res.status === 403);

  const c1 = await api('/admin/honors', { token: ta, method: 'POST', body: { title: '全国大学生电子设计竞赛 一等奖', winner: '张三 / 李四', award_level: '国家级', award_date: '2025-08', description: '四天三夜' } });
  madeIds.push(c1.id);
  ok('①⑥ 管理员建荣誉（JSON 元数据）→ 201 带 id', Number.isInteger(c1.id));

  ok('①⑦ 标题为空 → 400', (await jsonReq('/admin/honors', { token: ta, method: 'POST', body: { title: '  ' } })).res.status === 400);
  // 超长标题按全仓 strField 口径**截断**而非 400（本路由 winner/award_level/description 同款，
  // 前端 el-input 也带 maxlength）：截断是防手抖的兜底，硬拒只是多一个无谓的失败面
  const cLong = await api('/admin/honors', { token: ta, method: 'POST', body: { title: 'x'.repeat(61) } });
  madeIds.push(cLong.id);
  const longTitle = (await api('/admin/honors', { token: ta })).list.find((x) => x.id === cLong.id).title;
  ok('①⑧ 超长标题截到 60 字上限（截断口径，不是 400）', longTitle.length === 60, `存了 ${longTitle.length} 字`);
  ok('①⑨ 排序值「abc」→ 400（不是静默当缺省）', (await jsonReq('/admin/honors', { token: ta, method: 'POST', body: { title: 't', sort_order: 'abc' } })).res.status === 400);

  const pub1 = (await api('/honor')).list.find((x) => x.id === c1.id);
  ok('①⑩ 列表项**不含** store_name / image_name（磁盘名不外泄）', pub1 && !('store_name' in pub1) && !('image_name' in pub1), JSON.stringify(Object.keys(pub1 || {})));
  ok('①⑪ 新荣誉默认无图：has_image=false 且 image_url 为空', pub1 && pub1.has_image === false && pub1.image_url === '');
  ok('①⑫ 缺省排序值自动排在最前（DESC 口径）', pub1 && pub1.sort_order > 0);

  // —— 真图：JPEG 上传与出图 ——
  const upJ = await putImage(ta, c1.id, { name: '奖状-2025.jpg', body: JPEG_1x1, type: 'image/jpeg' });
  ok('①⑬ 上传真 JPEG（中文文件名）→ 200 且返回新 image_ver', upJ.res.ok && /^[0-9a-f]{8}$/.test(upJ.data.image_ver || ''));
  const pubJ = (await api('/honor')).list.find((x) => x.id === c1.id);
  ok('①⑭ 列表立刻带上新 image_url（含 ?v= 缓存键）', /\/api\/honor\/\d+\/image\?v=[0-9a-f]{8}/.test(pubJ.image_url), pubJ.image_url);

  const img = await imgReq(c1.id);
  const imgBuf = Buffer.from(await img.arrayBuffer());
  ok('①⑮ 匿名取图 200 + content-type: image/jpeg', img.status === 200 && img.headers.get('content-type').includes('image/jpeg'), `${img.status} ${img.headers.get('content-type')}`);
  ok('①⑯ 出图字节与上传的一致（没被二次处理）', imgBuf.length === JPEG_1x1.length && imgBuf.equals(JPEG_1x1), `${imgBuf.length} vs ${JPEG_1x1.length}`);
  const cc = img.headers.get('cache-control') || '';
  ok('①⑰ 出图带 immutable + 长 max-age（几十张图靠它撑住首屏）', /immutable/.test(cc) && /max-age=\d{6,}/.test(cc), cc);
  ok('①⑱ 不存在的 id 出图 → 404 JSON 而不是 500/HTML', (await jsonReq('/honor/999999/image')).res.status === 404);
  ok('①⑲ 路径穿越 id → 404', (await fetch(`${API}/honor/..%2f..%2fdata%2fcompass.db/image`)).status === 404);

  // —— 安全：魔数嗅探是唯一的墙 ——
  const evilSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
  const upSvg = await putImage(ta, c1.id, { name: 'evil.jpg', body: evilSvg, type: 'image/jpeg' });
  ok('①⑳ ★ SVG 改扩展名冒充 jpg → 400（魔数嗅探拦下 XSS 面）', upSvg.res.status === 400, `${upSvg.res.status} ${JSON.stringify(upSvg.data)}`);
  const upTxt = await putImage(ta, c1.id, { name: 'fake.png', body: Buffer.from('just text, not an image'), type: 'image/png' });
  ok('①②① 文本改名 .png → 400', upTxt.res.status === 400);

  const before = dirCount();
  const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(9 * 1024 * 1024, 7)]);
  const upBig = await putImage(ta, c1.id, { name: 'big.jpg', body: huge, type: 'image/jpeg' });
  ok('①②② 超 8MB → 413 且文案是「图片过大」（不是全局那句 128MB）', upBig.res.status === 413 && /图片过大/.test(upBig.data.error || ''), `${upBig.res.status} ${upBig.data.error}`);
  ok('①②③ 超限失败不在盘上留残file', dirCount() === before, `${dirCount()} vs ${before}`);

  // —— 三态：不动 / 替换 / 删除 ——
  const verBefore = pubJ.image_url;
  await api(`/admin/honors/${c1.id}`, { token: ta, method: 'PUT', body: { title: '全国大学生电子设计竞赛 一等奖（改）', is_active: 1 } });
  const afterPut = (await api('/honor')).list.find((x) => x.id === c1.id);
  ok('①②④ 只改元数据不带图 → 图还在且 ?v= 不变（三态之「不动」）', afterPut.image_url === verBefore, `${afterPut.image_url} vs ${verBefore}`);

  // 记下旧磁盘名，换图后断言它被删了
  const storeOld = pdb.prepare('SELECT store_name FROM honor WHERE id = ?').get(c1.id).store_name;
  const png2 = makePng(24, 18, [30, 120, 220]);
  const upR = await putImage(ta, c1.id, { name: 'new.png', body: png2, type: 'image/png' });
  const storeNew = pdb.prepare('SELECT store_name FROM honor WHERE id = ?').get(c1.id).store_name;
  const pubR = (await api('/honor')).list.find((x) => x.id === c1.id);
  ok('①②⑤ 换图 → ?v= 变了（URL 变才击穿浏览器缓存）', upR.res.ok && pubR.image_url !== verBefore);
  ok('①②⑥ ★ 换图后旧磁盘文件已删（不会永久占盘）', storeNew !== storeOld && !onDisk(storeOld) && onDisk(storeNew), `${storeOld} → ${storeNew}`);
  const img2 = await imgReq(c1.id);
  ok('①②⑦ 换图后出的是新图（字节数对得上）', Buffer.from(await img2.arrayBuffer()).length === png2.length);

  const pubNo = await putImage(ta, c1.id, { name: 'x.png', body: Buffer.from('nope') });
  ok('①②⑧ 换图失败时旧图不受影响（先写库再删旧的顺序）', pubNo.res.status === 400 && onDisk(storeNew));

  // —— 上下架 ——
  await api(`/admin/honors/${c1.id}`, { token: ta, method: 'PUT', body: { is_active: 0 } });
  ok('①②⑨ ★ 下架生效（`is_active || 旧值` 的写法会让 0 永远写不进去）',
    !(await api('/honor')).list.some((x) => x.id === c1.id));
  ok('①②⑩ 下架的图匿名取 → 404（不泄露存在性）', (await imgReq(c1.id)).status === 404);
  ok('①②⑪ 下架的图管理员仍能取 → 200（后台上架前要能预览）', (await fetch(`${API}/honor/${c1.id}/image`, { headers: { Authorization: `Bearer ${ta}` } })).status === 200);
  await api(`/admin/honors/${c1.id}`, { token: ta, method: 'PUT', body: { is_active: 1 } });
  ok('①②⑫ 重新上架后回到公开列表', (await api('/honor')).list.some((x) => x.id === c1.id));

  // —— 删图（三态之「删除」）——
  await api(`/admin/honors/${c1.id}/image`, { token: ta, method: 'DELETE' });
  const pubDel = (await api('/honor')).list.find((x) => x.id === c1.id);
  ok('①②⑬ 删图 → has_image=false、image_url 清空、行仍在（退化成纯文字荣誉）',
    pubDel && !pubDel.has_image && pubDel.image_url === '' && pubDel.title.includes('（改）'));
  ok('①②⑭ 删图后磁盘文件也没了', !onDisk(storeNew));
  ok('①②⑮ 再删一次 → 400（本来就没图）', (await jsonReq(`/admin/honors/${c1.id}/image`, { token: ta, method: 'DELETE' })).res.status === 400);

  // —— 批量 ——
  const bulkImgs = [1, 2, 3].map((i) => ({ name: `批量奖状${i}.png`, body: makePng(20 + i * 4, 16, [20 * i, 90, 200 - 20 * i]) }));
  const bk = await bulkUpload(ta, bulkImgs);
  ok('①②⑯ 批量上传 3 张 → 建 3 条', bk.res.status === 201 && bk.data.count === 3, JSON.stringify(bk.data));
  const bulkRows = pdb.prepare('SELECT id, title, sort_order, store_name FROM honor ORDER BY id DESC LIMIT 3').all();
  ok('①②⑰ 批量条目标题取文件名（去扩展名）', bulkRows.every((r) => /^批量奖状[123]$/.test(r.title)), JSON.stringify(bulkRows.map((r) => r.title)));
  ok('①②⑱ 批量条目都落了图且排序值递增', bulkRows.every((r) => r.store_name && onDisk(r.store_name)) && new Set(bulkRows.map((r) => r.sort_order)).size === 3);
  bulkRows.forEach((r) => madeIds.push(r.id));
  const badBulk = await bulkUpload(ta, [{ name: 'ok.png', body: makePng(10, 10, [1, 2, 3]) }, { name: 'bad.png', body: Buffer.from('not an image') }]);
  ok('①②⑲ ★ 批量里混一个假图 → 整体拒绝 400（不留"传 2 张成 1 张"的半成功）', badBulk.res.status === 400, `${badBulk.res.status}`);

  // ================= ② 页面渲染 + 跑马灯 =================
  // 再补足到 14 条（3 行的分档），让跑马灯有足够的行与条数
  const fill = [];
  for (let i = 0; i < 12; i++) fill.push({ name: `填充${i}.png`, body: makePng(28, 20, [(i * 37) % 255, (i * 71) % 255, (i * 113) % 255]) });
  await bulkUpload(ta, fill);
  pdb.prepare('SELECT id FROM honor ORDER BY id DESC LIMIT 12').all().forEach((r) => madeIds.push(r.id));

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await seedAuth(page, tb, rb.user); // 普通用户视角：公开页不该要求登录
  await page.goto(`${WEB}/honor`, { waitUntil: 'networkidle' });

  const nPub = (await api('/honor')).list.length;
  const cards = await page.locator('.hcard').count();
  ok('②① 公开页渲染出卡片（匿名/普通用户都能看）', cards > 0, `${cards}`);
  ok('②② 卡片数是「两份副本 × 半份」的整数倍（无缝循环的前提）', cards % 2 === 0 && cards >= nPub, `${cards} 张 / ${nPub} 条`);

  const imgs = await page.locator('.hcard img').all();
  let decoded = 0;
  for (const im of imgs.slice(0, 6)) decoded += (await im.evaluate((el) => el.naturalWidth > 0)) ? 1 : 0;
  ok('②③ 奖状图片真的解码了（不是 404 破图）', decoded === Math.min(6, imgs.length), `${decoded}`);

  const srcs = await page.locator('img').evaluateAll((els) => els.map((e) => e.getAttribute('src') || ''));
  ok('②④ ★ 图片 URL 里没有 token=（全站硬规矩：token 进 URL 会被 access_log 记进 originalUrl）', !srcs.some((s) => /token=/i.test(s)));

  const rowCount = await page.locator('.marquee').count();
  ok('②⑤ 1600px 下分 3 行（14 条 → 3 行的分档）', rowCount === 3, `${rowCount}`);

  // —— 跑马灯：真的在动 / 反向 / 无缝 ——
  //
  // ⚠️ 本段会**命令式**地 pause()/play() 轨道的动画。这是对自身被测对象的干扰：
  // 一旦用 WAAPI 直接控过某个 CSS 动画，它对 CSS 的 animation-play-state（hover 暂停）
  // 就不再同步 —— 实测表现为"getComputedStyle 说 paused，画面却还在动"。
  // 故本段只碰第 1 行，hover/点击的验证一律用第 2、3 行。

  const anim = await page.locator('.marquee .track').first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { name: s.animationName, state: s.animationPlayState, iter: s.animationIterationCount, timing: s.animationTimingFunction, dur: s.animationDuration };
  });
  ok('②⑥ 轨道是无限线性动画且正在跑', anim.name !== 'none' && anim.state === 'running' && anim.iter === 'infinite' && anim.timing === 'linear', JSON.stringify(anim));

  // ★ 必须读 computed transform —— 动画期间 el.style.transform 恒为空串，断它永远是假绿
  const t1 = await page.locator('.marquee .track').first().evaluate((el) => getComputedStyle(el).transform);
  await page.waitForTimeout(400);
  const t2 = await page.locator('.marquee .track').first().evaluate((el) => getComputedStyle(el).transform);
  ok('②⑦ ★ 位移真的在变（隔 400ms 两次 computed transform 不同）', t1 !== t2, `${t1} → ${t2}`);
  const runs = await page.locator('.marquee .track').first().evaluate((el) => el.getAnimations().filter((a) => a.playState === 'running').length);
  ok('②⑧ getAnimations() 里有 running 的动画', runs >= 1, `${runs}`);

  const directions = await page.locator('.marquee .track').evaluateAll((els) => els.map((e) => getComputedStyle(e).animationName));
  ok('②⑨ ★ 相邻行反向（animationName 一 rtl 一 ltr）',
    directions.length >= 2 && directions[0] !== directions[1] && /rtl/.test(directions[0]) && /ltr/.test(directions[1]), JSON.stringify(directions));

  const durs = await page.locator('.marquee .track').evaluateAll((els) => els.map((e) => e.getAnimations()[0]?.effect.getTiming().duration));
  ok('②⑩ 各行时长不同（否则条目多的行会明显跑得更快、像在互相追）', durs.length >= 2 && new Set(durs).size === durs.length, JSON.stringify(durs));

  const geom = await page.locator('.marquee').first().evaluate((row) => {
    const track = row.querySelector('.track');
    const halves = row.querySelectorAll('.half');
    const card = row.querySelector('.hcard');
    const cs = getComputedStyle(track);
    return {
      track: track.getBoundingClientRect().width,
      half: halves[0]?.getBoundingClientRect().width,
      halves: halves.length,
      vw: row.clientWidth,
      gap: cs.columnGap,
      cardGap: getComputedStyle(card).marginRight,
    };
  });
  ok('②⑪ ★★ 轨道宽 = 2×半份宽（容器的 flex gap 一加就会在这里红）',
    geom.halves === 2 && Math.abs(geom.track - 2 * geom.half) <= 1, `track=${geom.track} half=${geom.half}`);
  ok('②⑫ ★ 间距做在卡片 margin-right 上，容器 gap 为 0（-50% 等式才成立）',
    (geom.gap === '0px' || geom.gap === 'normal') && parseFloat(geom.cardGap) > 0, `gap=${geom.gap} margin=${geom.cardGap}`);
  ok('②⑬ ★ 每个半份都 ≥ 行视口宽（半份不够宽就会滚出空白）',
    geom.half >= geom.vw - 1, `half=${geom.half} vw=${geom.vw}`);

  // ★★ 无缝的判据：**走满一圈的位移量必须恰好等于一份副本的宽度**。
  //    位移比副本宽少一点（比如误写成 -45%）或半份宽算错，回绕那一下就会横跳 —— 这正是
  //    「看着在动、其实是坏的」的典型长相，上面的间距检查都看不见它。
  //    这里不拿"两个相位对比"来做：那种写法只在 副本宽/2 恰好是整数个卡距 时成立
  //    （即 k·n 为偶数），n=5、k=1 的窄屏分档下会假红。
  //    currentTime 取 0.9999 圈而不是整圈：无限动画在**正好**迭代边界处的取值是实现细节。
  const wrap = await page.locator('.marquee').first().evaluate((row) => {
    const an = row.querySelector('.track').getAnimations()[0];
    an.pause();
    an.currentTime = an.effect.getTiming().duration * 0.9999;
    const m = new DOMMatrixReadOnly(getComputedStyle(row.querySelector('.track')).transform);
    const half = row.querySelector('.half').getBoundingClientRect().width;
    return { tx: m.m41, half };
  });
  ok('②⑭ ★★ 一圈的位移恰好等于一份副本的宽度（差一点就是每圈横跳一下）',
    Math.abs(Math.abs(wrap.tx) - wrap.half) <= 1, `位移 ${wrap.tx.toFixed(1)} / 半份宽 ${wrap.half.toFixed(1)}`);

  // 相邻卡之间的空隙必须处处相同：接缝处出现 2 倍宽的空隙 = 间距没做进卡片、被容器 gap 补了
  const bands = await page.locator('.marquee').first().evaluate((row) => {
    const cards = [...row.querySelectorAll('.hcard')]; // DOM 顺序：副本1 全部 → 副本2 全部，接缝对夹在中间
    const b = cards.slice(0, -1).map((c, i) => Math.round(cards[i + 1].getBoundingClientRect().left - c.getBoundingClientRect().right));
    return { min: Math.min(...b), max: Math.max(...b), n: b.length };
  });
  ok('②⑮ ★ 卡片空隙处处一致（含接缝处那对相邻卡）', bands.n > 0 && bands.min === bands.max && bands.min > 0,
    `${bands.min}~${bands.max}px / ${bands.n} 段`);
  await page.locator('.marquee').first().evaluate((row) => { row.querySelector('.track').getAnimations()[0].play(); });

  // hover 暂停：用第 2 行（第 1 行已被上面命令式控过，对 CSS 的暂停不再同步）。
  // hover 行本体而不是轨道 —— 轨道有几千 px 宽，指针落点会跑到视口外
  await page.locator('.marquee').nth(1).hover({ force: true });
  const t2row = page.locator('.marquee .track').nth(1);
  const paused = await t2row.evaluate((el) => getComputedStyle(el).animationPlayState);
  const p1 = await t2row.evaluate((el) => getComputedStyle(el).transform);
  await page.waitForTimeout(300);
  const p2 = await t2row.evaluate((el) => getComputedStyle(el).transform);
  ok('②⑯ hover 暂停且**真的停住了**（不是只有状态字符串变了）', paused === 'paused' && p1 === p2, `${paused} ${p1 === p2 ? '冻结' : '仍在动'}`);
  await page.mouse.move(0, 0);
  const r1 = await t2row.evaluate((el) => getComputedStyle(el).transform);
  await page.waitForTimeout(300);
  const r2 = await t2row.evaluate((el) => getComputedStyle(el).transform);
  ok('②⑰ 鼠标移开后恢复滚动', r1 !== r2);

  await page.screenshot({ path: SHOT('light'), fullPage: true });

  // 点奖状 → 全屏查看器。同样用第 3 行：hover 让 CSS 停住行，再点**行内可见**的那张卡
  // （不能用 .hcard 的第一个 —— 位移过后它可能在视口左侧之外，点不到）
  const row3 = page.locator('.marquee').nth(2);
  await row3.hover({ force: true });
  const visIdx = await row3.evaluate((row) => {
    const rr = row.getBoundingClientRect();
    return [...row.querySelectorAll('.hcard')].findIndex((c) => c.getBoundingClientRect().left > rr.left + 40);
  });
  await row3.locator('.hcard').nth(visIdx).click();
  // 必须 waitFor 而不是点完立刻 isVisible：Vue 的 DOM 更新是异步的（nextTick），
  // 直接读会偶发假阴性 —— 这一步曾经假红过一次
  const see = (p, ms = 4000) => p.locator('.iv-overlay').waitFor({ state: 'visible', timeout: ms }).then(() => true).catch(() => false);
  const gone = (p, ms = 4000) => p.locator('.iv-overlay').waitFor({ state: 'hidden', timeout: ms }).then(() => true).catch(() => false);
  ok('②⑱ 点奖状唤起全屏查看器', await see(page), `卡片序号 ${visIdx}`);
  await page.keyboard.press('Escape');
  ok('②⑲ Esc 关闭查看器', await gone(page));
  await page.mouse.move(0, 0);

  // —— 暗色 ——
  await page.evaluate(() => document.documentElement.classList.add('ghost-mode'));
  const lCard = await lumOf(page, '.hcard');
  const lPic = await lumOf(page, '.hpic');
  ok('②⑳ 暗色下卡片/图盒底色是暗的（写死白底会挂在这里）',
    [lCard, lPic].every((v) => v === null || v < 90), `${lCard} / ${lPic}`);
  await page.screenshot({ path: SHOT('dark'), fullPage: true });
  await page.evaluate(() => document.documentElement.classList.remove('ghost-mode'));
  ok('②㉑ 全程无 JS 报错', pageErrors.length === 0, pageErrors.join(' | '));

  // —— 窄屏 ——
  const ctxN = await browser.newContext({ viewport: { width: 375, height: 780 } });
  const pageN = await ctxN.newPage();
  await seedAuth(pageN, tb, rb.user);
  await pageN.goto(`${WEB}/honor`, { waitUntil: 'networkidle' });
  const overflow = await pageN.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const rowsN = await pageN.locator('.marquee').count();
  ok('②㉒ 375px 无横向溢出（行是 overflow:hidden，不能把页面撑宽）', overflow <= 1, `${overflow}px`);
  ok('②㉓ 375px 收成 2 行', rowsN === 2, `${rowsN}`);
  const stillMoving = await pageN.locator('.marquee .track').first().evaluate(async (el) => {
    const a = getComputedStyle(el).transform;
    await new Promise((r) => setTimeout(r, 350));
    return a !== getComputedStyle(el).transform;
  });
  ok('②㉔ 375px 行仍在滚动', stillMoving);
  await pageN.screenshot({ path: SHOT('narrow'), fullPage: true });

  // —— 降级：prefers-reduced-motion ——
  // 宽 1100（而非与上面同为 1600）：降级后单份宽度必须小于视口才轮得到"可横滚"那条
  const ctxR = await browser.newContext({ viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
  const pageR = await ctxR.newPage();
  await seedAuth(pageR, tb, rb.user);
  await pageR.goto(`${WEB}/honor`, { waitUntil: 'networkidle' });
  const animR = await pageR.locator('.marquee .track').first().evaluate((el) => getComputedStyle(el).animationName);
  const copiesR = await pageR.locator('.marquee').first().locator('.half').count();
  const scrollR = await pageR.locator('.marquee').first().evaluate((el) => ({ ox: getComputedStyle(el).overflowX, sw: el.scrollWidth, cw: el.clientWidth }));
  const nPubR = (await api('/honor')).list.length;
  const cardsR = await pageR.locator('.hcard').count();
  ok('②㉕ ★ 减弱动态效果下动画关闭', animR === 'none', animR);
  ok('②㉖ ★ 降级时只渲染一份（不重复内容）', copiesR === 1 && cardsR === nPubR, `half=${copiesR} cards=${cardsR}/${nPubR}`);
  ok('②㉗ ★ 降级后仍可手动横滚（内容必须可达，这是最坏的降级）',
    ['auto', 'scroll'].includes(scrollR.ox) && scrollR.sw > scrollR.cw, JSON.stringify(scrollR));
  const firstCardR = pageR.locator('.hcard:not(.is-static)').first();
  await firstCardR.click();
  ok('②㉘ ★ 降级后卡片仍可点开大图', await see(pageR));
  await pageR.screenshot({ path: SHOT('reduced'), fullPage: true });

  // —— 空态 ——
  await api('/admin/honors', { token: ta, method: 'POST', body: { title: '临时隐藏用' } });
  const allIds = pdb.prepare('SELECT id FROM honor').all().map((r) => r.id);
  for (const id of allIds) await api(`/admin/honors/${id}`, { token: ta, method: 'PUT', body: { is_active: 0 } });
  const pageE = await ctx.newPage();
  await seedAuth(pageE, tb, rb.user);
  await pageE.goto(`${WEB}/honor`, { waitUntil: 'networkidle' });
  const emptyTxt = await pageE.locator('.honor-rstate').first().textContent().catch(() => '');
  const stillThere = await pageE.locator('.hcard').count();
  ok('②㉙ 全下架后是空态而不是空白/黑带', /建设中/.test(emptyTxt || '') && stillThere === 0, `"${(emptyTxt || '').trim()}" cards=${stillThere}`);
  for (const id of allIds) await api(`/admin/honors/${id}`, { token: ta, method: 'PUT', body: { is_active: 1 } });
  await api(`/admin/honors/${pdb.prepare('SELECT MAX(id) AS m FROM honor').get().m}`, { token: ta, method: 'DELETE' });

  // ================= ③ 前端压缩（单元级，Vite dev 下直接按源码路径 import） =================
  const comp = await page.evaluate(async () => {
    const { compressImage } = await import('/src/utils/imageCompress.js');
    const mk = (w, h) => new Promise((res) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d');
      x.fillStyle = '#3b82f6'; x.fillRect(0, 0, w, h);
      x.fillStyle = '#fff'; x.font = '80px sans-serif'; x.fillText('奖状', 40, 160);
      c.toBlob((b) => res(new File([b], 'big.png', { type: 'image/png' })), 'image/png');
    });
    const big = await mk(3000, 2000);
    const out = await compressImage(big);
    const small = await mk(400, 300);
    const outSmall = await compressImage(small);
    const bmp = await createImageBitmap(out);
    return { inSize: big.size, outSize: out.size, w: bmp.width, h: bmp.height, type: out.type, name: out.name, smallSame: outSmall === small };
  });
  ok('③① ★ 大图被压到长边 1600 以内', Math.max(comp.w, comp.h) <= 1600, `${comp.w}×${comp.h}`);
  ok('③② ★ 压缩后显著变小（这就是首屏能接受的原因）', comp.outSize < comp.inSize / 2, `${comp.inSize} → ${comp.outSize}`);
  ok('③③ 产物是 JPEG 且文件名已换成 .jpg', comp.type === 'image/jpeg' && /\.jpg$/.test(comp.name), `${comp.type} ${comp.name}`);
  ok('③④ 本来就小的图原样返回（不做无谓重编码）', comp.smallSame === true);

  // ================= ④ 后台管理 UI =================
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pageA = await ctxA.newPage();
  const errsA = [];
  pageA.on('pageerror', (e) => errsA.push(String(e)));
  await seedAuth(pageA, ta, admUser);
  await pageA.goto(`${WEB}/admin-console`, { waitUntil: 'networkidle' });
  await pageA.locator('.el-tabs__item', { hasText: '荣誉墙' }).click();
  await pageA.locator('#pane-honors .hon-thumb').first().waitFor({ timeout: 5000 }).catch(() => {});
  const admRows = await pageA.locator('#pane-honors tbody tr').count();
  ok('④① 后台荣誉墙 tab 列出全部条目（含未上架的）', admRows >= nPub, `${admRows} 行 / ${nPub} 公开条`);
  const thumbOk = await pageA.locator('#pane-honors .hon-thumb').first().evaluate((el) => el.naturalWidth > 0).catch(() => false);
  ok('④② 后台缩略图能显示（后台也吃 ?v= 缓存键）', thumbOk);
  await pageA.screenshot({ path: SHOT('admin'), fullPage: true });

  // 操作日志：动作下拉的选项**就是** ACTION_LABELS 的键值（`v-for=(label,key) in ACTION_LABELS`），
  // 所以直接看选项里有没有这 6 个中文标签 —— 既避开了分页/排序的不确定性，也正好就是"标签同步"这件事本身
  await pageA.locator('.el-tabs__item', { hasText: '操作日志' }).click();
  await pageA.waitForTimeout(300);
  await pageA.locator('#pane-logs .el-select').first().click();
  await pageA.locator('.el-select-dropdown__item').first().waitFor({ timeout: 5000 }).catch(() => {});
  const opts = await pageA.locator('.el-select-dropdown__item').allTextContents();
  const HONOR_LABELS = ['添加荣誉', '批量上传奖状', '编辑荣誉', '删除荣誉', '上传奖状图', '删除奖状图'];
  ok('④③ ACTION_LABELS 已同步全部 6 个 honor 动作（缺一个这里就红）',
    HONOR_LABELS.every((l) => opts.includes(l)), `honor 相关选项：${JSON.stringify(opts.filter((o) => /荣誉|奖状/.test(o)))}`);

  // 选一个纯 honor 动作筛一下：表格里必须渲染成中文，不能是英文原串
  await pageA.locator('.el-select-dropdown__item', { hasText: '上传奖状图' }).first().click();
  await pageA.waitForTimeout(600);
  const tags = await pageA.locator('#pane-logs .el-tag').allTextContents();
  ok('④④ 按「上传奖状图」筛出的记录渲染为中文且不含英文原串',
    tags.length > 0 && tags.every((t) => t === '上传奖状图'), JSON.stringify(tags));
  ok('④⑤ 后台全程无 JS 报错', errsA.length === 0, errsA.join(' | '));

  // 审计埋点
  const acts = pdb.prepare("SELECT DISTINCT action FROM audit_log WHERE action LIKE 'honor-%'").all().map((r) => r.action);
  ok('④⑥ 审计埋点齐全（create/update/delete/image-set/image-clear/bulk）',
    ['honor-create', 'honor-update', 'honor-delete', 'honor-image-set', 'honor-image-clear', 'honor-bulk'].every((a) => acts.includes(a)), JSON.stringify(acts));

  // ================= ⑤ 清理与一致性 =================
  const beforeDel = pdb.prepare('SELECT id, store_name FROM honor WHERE store_name IS NOT NULL').all();
  for (const r of pdb.prepare('SELECT id FROM honor').all()) {
    await api(`/admin/honors/${r.id}`, { token: ta, method: 'DELETE' });
    const i = madeIds.indexOf(r.id);
    if (i >= 0) madeIds.splice(i, 1);
  }
  ok('⑤① ★ 删条后磁盘文件同步清掉（外键级联不会帮你删盘）',
    beforeDel.length > 0 && beforeDel.every((r) => !onDisk(r.store_name)),
    JSON.stringify(beforeDel.filter((r) => onDisk(r.store_name)).map((r) => r.store_name)));
  ok('⑤② 删条后公开列表为空', (await api('/honor')).list.length === 0);

  for (const id of madeIds) await jsonReq(`/admin/honors/${id}`, { token: ta, method: 'DELETE' }).catch(() => {});

  console.log(`\n截图：${SHOT('light')} / ${SHOT('dark')} / ${SHOT('narrow')} / ${SHOT('reduced')} / ${SHOT('admin')}`);
} catch (e) {
  fail++;
  console.error('\n💥 探针中断：', e.message);
} finally {
  try { if (browser) await browser.close(); } catch {}
  try {
    const pdb = openProbeDb(API);
    if (uidAdm) {
      // 先清盘再删行（外键级联清行、文件不会）
      for (const r of pdb.prepare('SELECT id, store_name FROM honor').all()) {
        if (r.store_name) { try { const p = path.join(HONOR_DIR, r.store_name); if (existsSync(p)) unlinkSync(p); } catch {} }
      }
      pdb.prepare('DELETE FROM honor').run();
      pdb.prepare('DELETE FROM audit_log WHERE user_id IN (?,?)').run(uidAdm, uidUsr);
      pdb.prepare('DELETE FROM user WHERE id IN (?,?)').run(uidAdm, uidUsr);
    }
  } catch (e) { console.error('清理失败：', e.message); }
  console.log(`\n${pass}/${pass + fail} 通过${fail ? `，${fail} 项失败` : ''}`);
  process.exit(fail ? 1 : 0);
}
