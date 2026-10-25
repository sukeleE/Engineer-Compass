// 资源预约后端冒烟（沙盒自起后端：临时库 + 临时上传目录 + 临时 cwd，端口 3107）
// 覆盖：项目/资源台账（两类 item/space·空间独占/物品库存）·批量导入回滚·表格导入
//   （xlsx/csv 解析预览·GBK·表头启发·坏值透传·截断·模板下载）·归档·组队·
//   时间窗（30 分对齐/07–22/跨天/7 天上限）·冲突（pending 占位/半开区间首尾相接）·
//   资源级审批（先到先得 vs 需审批/自审批禁令/审批复检）·取消口径·多人快照·timeline 契约·通知·外键级联。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BACKEND = join(ROOT, 'backend');
const PORT = 3107;
const BASE = `http://localhost:${PORT}/api`;

// 造表/编码直接用后端自己的依赖（iconv-lite 是 xlsx 的传递依赖，已提升到 backend/node_modules）
const backendRequire = createRequire(join(BACKEND, 'server.js'));
const XLSX = backendRequire('xlsx');
const iconv = backendRequire('iconv-lite');

const xlsxBuffer = (aoa, sheetName = 'Sheet1') => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};
const xlsxFirstRow = (buf) => {
  const wb = XLSX.read(buf, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false })[0];
};

const work = mkdtempSync(join(tmpdir(), 'smk-booking-'));
const serverEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  PORT: String(PORT),
  DB_PATH: join(work, 'compass.db'),
  SHARE_UPLOAD_DIR: join(work, 'share'),
  HONOR_UPLOAD_DIR: join(work, 'honor'),
  PURCHASE_UPLOAD_DIR: join(work, 'purchase'),
};

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { cond ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}${extra ? ` → ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`)); };

const req = async (path, opts = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) };
  const res = await fetch(BASE + path, {
    headers, method: opts.method || 'GET',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { res, status: res.status, data };
};
const api = async (path, opts = {}) => {
  const { res, data } = await req(path, opts);
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
};
const expect = async (path, expected, opts = {}) => {
  const { data, status: got } = await req(path, opts);
  return { ok: got === expected, got, data };
};

// multipart 上传（表格解析专用）：不带 JSON 头，让 undici 自动补 multipart boundary
const upload = async (path, { token, kind, file, filename, field = 'file' } = {}) => {
  const fd = new FormData();
  if (kind !== undefined) fd.append('kind', kind);
  if (file !== undefined) fd.append(field, new Blob([file]), filename || 'upload.bin');
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  return { res, status: res.status, data };
};
// 二进制下载（模板）
const download = async (path, token) => {
  const res = await fetch(BASE + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, status: res.status, buf };
};

// 本地墙上时钟造朴素串（与服务端同机同时区）
const pad = (n) => String(n).padStart(2, '0');
function slot(dayOffset, hh, mm = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hh, mm, 0, 0);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(hh)}:${pad(mm)}`;
}
const dateOf = (dayOffset) => slot(dayOffset, 7).slice(0, 10);

let server = null;
const serverLog = [];
let db = null;
try {
  server = spawn(process.execPath, [join(BACKEND, 'server.js')], {
    cwd: work, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  server.stdout.on('data', (b) => String(b).split('\n').filter(Boolean).forEach((l) => serverLog.push(l)));
  server.stderr.on('data', (b) => String(b).split('\n').filter(Boolean).forEach((l) => serverLog.push(l)));

  const ready = await (async () => {
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return true; } catch { /* 等 */ }
      await new Promise((s) => setTimeout(s, 250));
    }
    return false;
  })();
  if (!ready) throw new Error('临时后端 15s 内未就绪');

  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(serverEnv.DB_PATH);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');

  // ---------- 0. 三人 + 一个待封禁账号 ----------
  const stamp = Date.now().toString(36);
  const rA = await api('/auth/register', { method: 'POST', body: { email: `bka_${stamp}@x.dev`, password: 'pass123456', nickname: '冒烟负责人甲' } });
  const rB = await api('/auth/register', { method: 'POST', body: { email: `bkb_${stamp}@x.dev`, password: 'pass123456', nickname: '冒烟路人乙' } });
  const rC = await api('/auth/register', { method: 'POST', body: { email: `bkc_${stamp}@x.dev`, password: 'pass123456', nickname: '冒烟同学丙' } });
  const rD = await api('/auth/register', { method: 'POST', body: { email: `bkd_${stamp}@x.dev`, password: 'pass123456', nickname: '冒烟封禁丁' } });
  const [A, B, C, D] = [rA.user, rB.user, rC.user, rD.user];
  const [tA, tB, tC, tD] = [rA.token, rB.token, rC.token, rD.token];
  ok('注册四人（建号初始均未实名）', !![A, B, C, D].every((u) => u?.id) && [rA, rB, rC, rD].every((r) => r.user.real_name === ''));
  // 业务夹具：甲/乙/丙注册后立即实名（丁保持未实名，专供门禁断言）
  const setRn = (token, name) => api('/auth/real-name', { method: 'PUT', token, body: { real_name: name } });
  await setRn(tA, '王甲');
  await setRn(tB, '李乙');
  await setRn(tC, '赵丙');

  // ---------- 0b. 实名硬门禁：未实名整个预约模块不可用 ----------
  let g2 = await expect('/booking/projects', 403, { token: tD });
  ok('未实名 GET 项目列表 403 need_real_name', g2.ok && g2.data.code === 'need_real_name', g2.data);
  g2 = await req('/booking/projects', { method: 'POST', token: tD, body: { name: '丁偷建项目' } });
  ok('未实名写接口（建档）同样 403 need_real_name', g2.status === 403 && g2.data.code === 'need_real_name', g2.data);

  // ---------- 1. 项目 ----------
  let g = await expect('/booking/projects', 200, { token: tC });
  ok('未登录 401', (await expect('/booking/projects', 401)).ok);
  const pc = await api('/booking/projects', { method: 'POST', token: tA, body: { name: `预约主项目-${stamp}`, description: '冒烟用', default_approve_mode: 'approval' } });
  const P = pc.project;
  ok('建档 201，负责人即 owner', pc.project.id && pc.project.myRole === 'owner' && pc.project.canManage === true);
  g = await expect('/booking/projects', 409, { method: 'POST', token: tA, body: { name: `预约主项目-${stamp}` } });
  ok('项目重名 409', g.ok);
  g = await expect('/booking/projects', 400, { method: 'POST', token: tA, body: { name: `坏模式-${stamp}`, default_approve_mode: 'nope' } });
  ok('非法默认审批模式 400', g.ok);
  g = await expect(`/booking/projects/${P.id}`, 403, { method: 'PUT', token: tB, body: { description: '黑进来' } });
  ok('非负责人改项目设置 403', g.ok);
  g = await req('/booking/projects', { token: tC });
  ok('开放项目对所有登录用户可见', g.data.projects.some((x) => x.id === P.id));

  // 关闭项目：外人列表不可见、不能下单；重开
  await api(`/booking/projects/${P.id}`, { method: 'PUT', token: tA, body: { status: 'closed' } });
  g = await req('/booking/projects', { token: tC });
  ok('关闭项目对外人隐藏', !g.data.projects.some((x) => x.id === P.id));
  await api(`/booking/projects/${P.id}`, { method: 'PUT', token: tA, body: { status: 'open' } });

  // ---------- 2. 资源台账 ----------
  const resCreate = (token, body) => req(`/booking/projects/${P.id}/resources`, { method: 'POST', token, body });
  g = await resCreate(tA, { kind: 'space', name: '无容量教室' });
  ok('空间缺 capacity 400', g.status === 400, g.data);
  g = await resCreate(tA, { kind: 'item', name: '零库存道具', quantity: 0 });
  ok('物品 quantity=0 400', g.status === 400, g.data);
  g = await resCreate(tA, { kind: 'rocket', name: '火箭', capacity: 3 });
  ok('kind 白名单 400', g.status === 400);
  g = await resCreate(tB, { kind: 'space', name: '别人加的教室', capacity: 10 });
  ok('非负责人加资源 403', g.status === 403);

  const roomA = (await api(`/booking/projects/${P.id}/resources`, { method: 'POST', token: tA,
    body: { kind: 'space', name: '审批教室A', location: '工训 301', capacity: 30, equipment: ['投影仪', '白板'], approve_mode: 'approval' } })).resource;
  ok('教室建成：容量/设备 params 回显', roomA.capacity === 30 && roomA.is_space === true &&
    Array.isArray(roomA.params.equipment) && roomA.params.equipment[0] === '投影仪' && roomA.approve_mode === 'approval', roomA);
  const itemA = (await api(`/booking/projects/${P.id}/resources`, { method: 'POST', token: tA,
    body: { kind: 'item', name: '库存道具甲', quantity: 3, unit: '件', approve_mode: 'first_come' } })).resource;
  ok('道具建成：库存池/先到先得', itemA.quantity === 3 && itemA.is_space === false && itemA.approve_mode === 'first_come');
  const roomT = (await api(`/booking/projects/${P.id}/resources`, { method: 'POST', token: tA,
    body: { kind: 'space', name: '时间窗教室', capacity: 10, approve_mode: 'approval' } })).resource;
  const roomS = (await api(`/booking/projects/${P.id}/resources`, { method: 'POST', token: tA,
    body: { kind: 'space', name: '小容量实验室', location: '实验楼 B201', capacity: 2, approve_mode: 'approval' } })).resource;
  g = await resCreate(tA, { kind: 'item', name: '库存道具甲', quantity: 1 });
  ok('同项目资源重名 409', g.status === 409);

  // bulk：3 条成功 + 坏行整体回滚
  const before = (await req(`/booking/projects/${P.id}/resources?status=all`, { token: tA })).data.resources.length;
  g = await req(`/booking/projects/${P.id}/resources/bulk`, { method: 'POST', token: tA, body: {
    items: [
      { kind: 'item', name: '批量器材1', quantity: 2, unit: '台' },
      { kind: 'item', name: '批量器械2', quantity: 1 },
      { kind: 'item', name: '批量道具3', quantity: 5, unit: '套' },
    ] } });
  ok('bulk 导入 3 条', g.status === 201 && g.data.created === 3, g.data);
  g = await req(`/booking/projects/${P.id}/resources/bulk`, { method: 'POST', token: tA, body: {
    items: [
      { kind: 'item', name: '不该出现的器材X', quantity: 1 },
      { kind: 'space', name: '坏行教室Y' }, // 缺容量
    ] } });
  ok('bulk 坏行带行号 400', g.status === 400 && /第 2 行/.test(g.data.error), g.data);
  const after = (await req(`/booking/projects/${P.id}/resources?status=all`, { token: tA })).data.resources.length;
  ok('bulk 坏行整体回滚（计数不变）', after === before + 3, [before, after]);

  // ---------- 2a2. 资源照片：物品/空间都可选拍照，编辑可改可删 ----------
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  g = await req(`/booking/projects/${P.id}/resources`, { method: 'POST', token: tA,
    body: { kind: 'space', name: '带照片教室', location: '工训 302', capacity: 10, image: PNG } });
  ok('空间资源带照片创建 201 且图片回显', g.status === 201 && g.data.resource.image === PNG, g.status);
  const photoRoom = g.data.resource;
  g = await req(`/booking/resources/${photoRoom.id}`, { method: 'PUT', token: tA, body: { image: '' } });
  ok('空间资源 PUT 可移除照片', g.status === 200 && g.data.resource.image === '', g.status);
  g = await req(`/booking/resources/${itemA.id}`, { method: 'PUT', token: tA, body: { image: PNG } });
  ok('物品资源 PUT 可补照片并回显', g.status === 200 && g.data.resource.image === PNG, g.status);
  g = await req(`/booking/resources/${itemA.id}`, { method: 'PUT', token: tA, body: { image: '' } });
  ok('物品资源 PUT 可移除照片', g.status === 200 && g.data.resource.image === '', g.status);

  // ---------- 2b. 表格导入（xlsx/csv 解析预览 → bulk 落库；模板下载） ----------
  const tplUrl = (kind) => `/booking/projects/${P.id}/resources/import-template?kind=${kind}`;
  const parseUrl = `/booking/projects/${P.id}/resources/parse-import`;

  // xlsx：表头前 2 行垃圾 + 别名表头；设备多分隔符；合计/序号残留行
  const spaceAoa = [
    ['XX实验室资源登记表（勿动）'],
    ['制表日期：2026 年'],
    ['空间名称', '房间号', '可容纳人数', '室内设备', '预约方式'],
    ['表格教室一', '工训 101', 40, '投影仪、白板；电脑/音箱', '需审批'],
    ['表格教室二', '工训 102', 8, '投影仪，电脑', '先到先得'],
    ['合计', '', '', '', ''],
    ['1', '', '', '', ''],
  ];
  g = await upload(parseUrl, { token: tA, kind: 'space', file: xlsxBuffer(spaceAoa, '空间一览'), filename: 'spaces.xlsx' });
  ok('xlsx 解析 200：垃圾行后定位表头、跳过合计/序号', g.status === 200 && g.data.source === 'xlsx' &&
    g.data.items.length === 2 && /第 3 行/.test(g.data.warnings.join()) && /跳过 2 行/.test(g.data.warnings.join()), g.data);
  const sp = g.data.items;
  ok('xlsx 行映射：数字字符串化、设备多分隔符切 4 项、审批归一',
    sp[0].name === '表格教室一' && sp[0].capacity === '40' && sp[0].location === '工训 101' &&
    sp[0].equipment.join('|') === '投影仪|白板|电脑|音箱' && sp[0].approve_mode === 'approval' &&
    sp[1].capacity === '8' && sp[1].approve_mode === 'first_come', sp);
  g = await req(`/booking/projects/${P.id}/resources/bulk`, { method: 'POST', token: tA, body: { items: sp } });
  ok('解析结果直走 bulk 落库 201', g.status === 201 && g.data.created === 2, g.data);
  const listedSp = (await req(`/booking/projects/${P.id}/resources?status=all&kind=space`, { token: tA })).data.resources;
  const foundRoom = listedSp.find((x) => x.name === '表格教室一');
  ok('落库回读：容量 40 + 设备数组 4 项 + 审批模式', !!foundRoom && foundRoom.capacity === 40 &&
    Array.isArray(foundRoom.params.equipment) && foundRoom.params.equipment.length === 4 &&
    foundRoom.approve_mode === 'approval', foundRoom);

  // 坏数字原样透传：解析不兜底，bulk 报「第 N 行」
  const badAoa = [
    ['名称', '容量'],
    ['好教室', 10],
    ['坏教室', 'abc'],
  ];
  g = await upload(parseUrl, { token: tA, kind: 'space', file: xlsxBuffer(badAoa), filename: 'bad.xlsx' });
  ok('坏容量原样透传（不静默兜底）', g.status === 200 && g.data.items[1].capacity === 'abc', g.data.items);
  g = await req(`/booking/projects/${P.id}/resources/bulk`, { method: 'POST', token: tA, body: { items: g.data.items } });
  ok('坏容量经 bulk 报第 2 行 400', g.status === 400 && /第 2 行/.test(g.data.error), g.data);

  // CSV：UTF-8 与 GBK 中文无损
  const csvUtf8 = ['资源名称,规格型号,库存数量,单位,存放位置,审批方式',
    '表格电阻包,1/4W 10Ω,100,袋,器材柜 A1,先到先得',
    '表格焊锡丝,0.8mm,20,卷,,需审批'].join('\n');
  const csvGbk = ['资源名称,规格型号,库存数量,单位,存放位置,审批方式',
    '表格电容排（GBK）,10uF,50,盒,器材柜 B2,先到先得',
    '表格转接板（GBK）,杜邦转接,30,块,,需审批'].join('\n');
  g = await upload(parseUrl, { token: tA, kind: 'item', file: Buffer.from(csvUtf8, 'utf8'), filename: 'items-utf8.csv' });
  ok('CSV(UTF-8) 解析：中文/Ω 无损、空位置透空串', g.status === 200 && g.data.source === 'csv' &&
    g.data.items[0].name === '表格电阻包' && g.data.items[0].spec === '1/4W 10Ω' &&
    g.data.items[0].quantity === '100' && g.data.items[1].location === '', g.data.items);
  const itemsUtf = g.data.items;
  g = await upload(parseUrl, { token: tA, kind: 'item', file: iconv.encode(csvGbk, 'gbk'), filename: 'items-gbk.csv' });
  ok('CSV(GBK) 解析：编码回落、中文无损', g.status === 200 &&
    g.data.items[0].name === '表格电容排（GBK）' && g.data.items[0].quantity === '50' &&
    g.data.items[1].approve_mode === 'approval', g.data.items);
  const itemsGbk = g.data.items;
  g = await req(`/booking/projects/${P.id}/resources/bulk`, { method: 'POST', token: tA, body: { items: itemsUtf } });
  ok('UTF-8 CSV 批量落库 201', g.status === 201 && g.data.created === 2, g.data);
  g = await req(`/booking/projects/${P.id}/resources/bulk`, { method: 'POST', token: tA, body: { items: itemsGbk } });
  ok('GBK CSV 批量落库 201', g.status === 201 && g.data.created === 2, g.data);

  // 205 数据行截断 200 + warning（只解析不落库）
  const bigAoa = [['名称', '容量'], ...Array.from({ length: 205 }, (_, i) => [`截断教室${i + 1}`, 10])];
  g = await upload(parseUrl, { token: tA, kind: 'space', file: xlsxBuffer(bigAoa), filename: 'big205.xlsx' });
  ok('205 数据行截断为 200 并告警', g.status === 200 && g.data.items.length === 200 &&
    /截断后续 5 行/.test(g.data.warnings.join()), { n: g.data.items?.length, w: g.data.warnings });

  // 无表头 400；有表头无数据 200 items=[]
  g = await upload(parseUrl, { token: tA, kind: 'space', file: xlsxBuffer([['随便一列', '另一列'], ['foo', 'bar']]), filename: 'nohead.xlsx' });
  ok('无名称列表头 400（BookingImportError）', g.status === 400 && /未识别到表头/.test(g.data.error), g.data);
  g = await upload(parseUrl, { token: tA, kind: 'space', file: xlsxBuffer([['名称', '位置', '容量']]), filename: 'headonly.xlsx' });
  ok('仅有表头 200：items 为空 + 提示', g.status === 200 && g.data.items.length === 0 &&
    /没有有效数据行/.test(g.data.warnings.join()), g.data);

  // 坏输入与权限闸门
  g = await upload(parseUrl, { token: tA, kind: 'space', file: Buffer.from('not a table'), filename: 'note.txt' });
  ok('.txt 扩展名 400', g.status === 400 && /\.xlsx\/\.xls\/\.csv/.test(g.data.error), g.data);
  g = await upload(parseUrl, { token: tA, kind: 'space' });
  ok('无 file 字段 400', g.status === 400 && /未收到文件/.test(g.data.error), g.data);
  g = await upload(parseUrl, { token: tA, kind: 'rocket', file: xlsxBuffer([['名称']]), filename: 'x.xlsx' });
  ok('坏 kind 400', g.status === 400, g.data);
  g = await upload(parseUrl, { token: tB, kind: 'space', file: xlsxBuffer([['名称']]), filename: 'x.xlsx' });
  ok('非负责人解析 403', g.status === 403, g.data);
  g = await upload(parseUrl, { kind: 'space', file: xlsxBuffer([['名称']]), filename: 'x.xlsx' });
  ok('匿名解析 401', g.status === 401);
  g = await upload('/booking/projects/99999999/resources/parse-import',
    { token: tA, kind: 'space', file: xlsxBuffer([['名称']]), filename: 'x.xlsx' });
  ok('不存在项目解析 404', g.status === 404);
  g = await upload(parseUrl, { token: tA, kind: 'space', file: Buffer.alloc(11 * 1024 * 1024), filename: 'huge.xlsx' });
  ok('11MB 文件 413 中文文案', g.status === 413 && /文件过大/.test(g.data.error), g.status);

  // 模板：两 kind 的 PK 魔数 + 表头精确断言；坏 kind/权限/404
  g = await download(tplUrl('space'), tA);
  ok('空间模板 200：xlsx(PK) + 表头精确', g.status === 200 && g.buf[0] === 0x50 && g.buf[1] === 0x4b &&
    JSON.stringify(xlsxFirstRow(g.buf)) === JSON.stringify(['名称', '位置', '容量', '室内设备（多个用逗号或顿号分隔）', '审批方式（需审批/先到先得，留空用项目默认）']),
    xlsxFirstRow(g.buf));
  g = await download(tplUrl('item'), tA);
  ok('物品模板 200：xlsx(PK) + 表头精确', g.status === 200 && g.buf[0] === 0x50 && g.buf[1] === 0x4b &&
    JSON.stringify(xlsxFirstRow(g.buf)) === JSON.stringify(['名称', '规格型号', '库存', '单位', '位置', '审批方式（需审批/先到先得，留空用项目默认）']),
    xlsxFirstRow(g.buf));
  g = await download(tplUrl('rocket'), tA);
  ok('模板坏 kind 400', g.status === 400);
  g = await download(tplUrl('space'), tB);
  ok('模板非负责人 403', g.status === 403);
  g = await download(tplUrl('space'));
  ok('模板匿名 401', g.status === 401);
  g = await download('/booking/projects/99999999/resources/import-template?kind=space', tA);
  ok('模板不存在项目 404', g.status === 404);

  // 重复导入：重名 409 带行号（表格教室一已落库）
  g = await req(`/booking/projects/${P.id}/resources/bulk`, { method: 'POST', token: tA, body: { items: sp } });
  ok('重复导入同名 409 带行号', g.status === 409 && /第 1 行/.test(g.data.error), g.data);

  // 未引用资源可硬删
  const tmp = (await api(`/booking/projects/${P.id}/resources`, { method: 'POST', token: tA,
    body: { kind: 'item', name: '临时待删', quantity: 1 } })).resource;
  g = await expect(`/booking/resources/${tmp.id}`, 200, { method: 'DELETE', token: tA });
  ok('无引用资源硬删 200', g.ok);

  // 归档流程：有引用后不能硬删、归档后不能新约、历史单仍可取
  const roomArch = (await api(`/booking/projects/${P.id}/resources`, { method: 'POST', token: tA,
    body: { kind: 'space', name: '将归档教室', capacity: 12, approve_mode: 'approval' } })).resource;
  const bArch = (await api(`/booking/projects/${P.id}/bookings`, { method: 'POST', token: tB,
    body: { resource_id: roomArch.id, start_time: slot(9, 9), end_time: slot(9, 10), source: 'solo', purpose: '归档前预约' } })).booking;
  g = await expect(`/booking/resources/${roomArch.id}`, 409, { method: 'DELETE', token: tA });
  ok('有预约引用硬删 409（引导归档）', g.ok);
  await api(`/booking/resources/${roomArch.id}/archive`, { method: 'POST', token: tA });
  g = await expect(`/booking/projects/${P.id}/bookings`, 400, { method: 'POST', token: tB,
    body: { resource_id: roomArch.id, start_time: slot(9, 14), end_time: slot(9, 15), source: 'solo' } });
  ok('归档资源不能新预约 400', g.ok);
  g = await expect(`/booking/bookings/${bArch.id}`, 200, { token: tB });
  ok('归档资源上的历史预约仍 200 可取', g.ok);
  await api(`/booking/resources/${roomArch.id}/restore`, { method: 'POST', token: tA });

  // 资源编辑：容量下调不能低于现存预约人头（bArch 仅 1 人，调到 1 可成，库存收缩在第 9 节后补测）
  g = await req(`/booking/resources/${roomArch.id}`, { method: 'PUT', token: tA, body: { capacity: 1 } });
  ok('空间容量下调至现存最大人头（1）可成功', g.status === 200, g.data);

  // ---------- 3. 固定组队 ----------
  const tm = (await api(`/booking/projects/${P.id}/teams`, { method: 'POST', token: tA,
    body: { name: '甲的固定队', member_ids: [B.id, C.id] } })).team;
  ok('组队建成：队长不在成员表，成员 2 人', tm.owner_id === A.id && tm.members.length === 2);
  g = await expect(`/booking/teams/${tm.id}`, 403, { method: 'PUT', token: tB, body: { name: '乙想改名' } });
  ok('非队长非负责人改队 403', g.ok);
  g = await expect(`/booking/projects/${P.id}/teams`, 409, { method: 'POST', token: tA, body: { name: '甲的固定队' } });
  ok('同项目队名重复 409', g.ok);

  // ---------- 4. 时间窗 ----------
  const book = (token, body) => req(`/booking/projects/${P.id}/bookings`, { method: 'POST', token, body });
  g = await book(tB, { resource_id: roomT.id, start_time: slot(1, 6, 30), end_time: slot(1, 7, 30), source: 'solo' });
  ok('06:30 早于开放时间 400', g.status === 400 && /07:00/.test(g.data.error), g.data.error);
  g = await book(tB, { resource_id: roomT.id, start_time: slot(1, 21, 30), end_time: slot(1, 22, 30), source: 'solo' });
  ok('22:30 晚于关闭时间 400', g.status === 400 && /22:00/.test(g.data.error), g.data.error);
  g = await book(tB, { resource_id: roomT.id, start_time: slot(1, 10, 7), end_time: slot(1, 11), source: 'solo' });
  ok('非 30 分钟整点 400', g.status === 400);
  g = await book(tB, { resource_id: roomT.id, start_time: slot(-1, 10), end_time: slot(-1, 11), source: 'solo' });
  ok('开始时间在过去 400', g.status === 400);
  g = await book(tB, { resource_id: roomT.id, start_time: slot(1, 21, 30), end_time: slot(1, 22), source: 'solo' });
  ok('[21:30,22:00) 合法（贴边收档）', g.status === 201, g.data);
  g = await book(tB, { resource_id: roomT.id, start_time: slot(2, 20), end_time: slot(3, 8), source: 'solo' });
  ok('跨天 20:00→次日 08:00 合法', g.status === 201, g.data);
  g = await book(tB, { resource_id: roomT.id, start_time: slot(3, 8), end_time: slot(3, 9), source: 'solo' });
  ok('跨天单与 [08:00,09:00) 首尾相接不冲突', g.status === 201, g.data);
  g = await book(tC, { resource_id: roomT.id, start_time: slot(3, 7, 30), end_time: slot(3, 8), source: 'solo' });
  ok('与跨天单 [07:30,08:00) 重叠 → 409 带 conflicts', g.status === 409 && Array.isArray(g.data.conflicts) && g.data.conflicts.length, g.data);
  g = await book(tB, { resource_id: roomT.id, start_time: slot(4, 8), end_time: slot(12, 8), source: 'solo' });
  ok('跨度 8 天 400', g.status === 400 && /7 天/.test(g.data.error), g.data.error);
  g = await book(tB, { resource_id: roomT.id, start_time: slot(4, 8), end_time: slot(11, 8), source: 'solo' });
  ok('跨度整 7 天合法', g.status === 201, g.data);

  // ---------- 5. 空间独占 + 容量 ----------
  g = await book(tB, { resource_id: roomS.id, start_time: slot(5, 9), end_time: slot(5, 10),
    source: 'custom', participant_ids: [C.id, A.id] });
  ok('人头 3 > 容量 2 → 400', g.status === 400 && /容量/.test(g.data.error), g.data.error);
  const bs1 = (await api(`/booking/projects/${P.id}/bookings`, { method: 'POST', token: tB,
    body: { resource_id: roomS.id, start_time: slot(5, 9), end_time: slot(5, 10), source: 'custom', participant_ids: [C.id] } })).booking;
  ok('2 人约容量 2 空间成功（pending 占位）', bs1.id && bs1.headcount === 2 && bs1.status === 'pending');
  g = await book(tC, { resource_id: roomS.id, start_time: slot(5, 9), end_time: slot(5, 10), source: 'solo' });
  ok('空间同时段第二单 409（pending 也占位）', g.status === 409 && g.data.conflicts?.[0]?.booking_id === bs1.id, g.data);
  g = await book(tC, { resource_id: roomS.id, start_time: slot(5, 10), end_time: slot(5, 11), source: 'solo' });
  ok('空间首尾相接 201', g.status === 201);

  // ---------- 6. 物品库存池（先到先得） ----------
  const ib = (token, body) => req(`/booking/projects/${P.id}/bookings`, { method: 'POST', token,
    body: { resource_id: itemA.id, source: 'solo', ...body } });
  const i1 = await ib(tB, { start_time: slot(6, 9), end_time: slot(6, 10), qty: 2 });
  ok('道具 qty2 直接 confirmed', i1.status === 201 && i1.data.booking.status === 'confirmed', i1.data);
  const i1id = i1.data.booking.id;
  g = await ib(tC, { start_time: slot(6, 9), end_time: slot(6, 10), qty: 2 });
  ok('重叠再借 2 > 库存余 1 → 409 带格占用', g.status === 409 && g.data.conflicts?.[0]?.used === 2, g.data);
  const i2 = await ib(tC, { start_time: slot(6, 9), end_time: slot(6, 10), qty: 1 });
  ok('重叠借 1（恰好占满）201', i2.status === 201, i2.data);
  g = await ib(tC, { start_time: slot(6, 11), end_time: slot(6, 12), qty: 4 });
  ok('单次借用超过总库存 400', g.status === 400);
  await api(`/booking/bookings/${i1id}/cancel`, { method: 'POST', token: tB });
  g = await ib(tC, { start_time: slot(6, 9), end_time: slot(6, 10), qty: 2 });
  ok('取消释放后库存回归，可再借 2', g.status === 201);

  // conflicts 只检不写
  g = await req(`/booking/projects/${P.id}/conflicts`, { method: 'POST', token: tB,
    body: { resource_id: roomA.id, start_time: slot(8, 9), end_time: slot(8, 10), source: 'solo' } });
  ok('/conflicts 空闲返回 ok', g.status === 200 && g.data.ok === true, g.data);
  g = await req(`/booking/projects/${P.id}/conflicts`, { method: 'POST', token: tD,
    body: { resource_id: roomA.id, start_time: slot(8, 9), end_time: slot(8, 10), source: 'solo' } });
  ok('未实名用户 /conflicts 白名单放行（弹窗实时校验不泄密）', g.status === 200 && g.data.ok === true, g.data);
  g = await req('/auth/real-name', { method: 'PUT', token: tD, body: { real_name: '孙丁' } });
  ok('丁完成实名 200', g.status === 200 && g.data.user.real_name === '孙丁', g.data);
  g = await req('/booking/projects', { token: tD });
  ok('丁实名后预约模块立即可用 200', g.status === 200 && g.data.projects.some((x) => x.id === P.id), g.status);

  // ---------- 7. 资源级审批流 ----------
  const b1 = (await api(`/booking/projects/${P.id}/bookings`, { method: 'POST', token: tB,
    body: { resource_id: roomA.id, start_time: slot(7, 9), end_time: slot(7, 10), source: 'solo', purpose: '乙的申请' } })).booking;
  ok('审批资源上下单为 pending', b1.status === 'pending');
  ok('下单人快照署名为「真名（昵称）」（快照原样返回，不再附 *_real_name 二次组合）',
    b1.booker_name === '李乙（冒烟路人乙）' && !('booker_real_name' in b1),
    { name: b1.booker_name, keys: Object.keys(b1).filter((k) => k.includes('real')) });
  g = await book(tC, { resource_id: roomA.id, start_time: slot(7, 9), end_time: slot(7, 10), source: 'solo' });
  ok('pending 占位：他人重叠 409', g.status === 409);
  const b2 = (await api(`/booking/projects/${P.id}/bookings`, { method: 'POST', token: tC,
    body: { resource_id: roomA.id, start_time: slot(7, 10), end_time: slot(7, 11), source: 'solo' } })).booking;

  // 乙自建项目：自审批禁令 + 外人 404
  const PB = (await api('/booking/projects', { method: 'POST', token: tB, body: { name: `乙自己的项目-${stamp}` } })).project;
  const roomB = (await api(`/booking/projects/${PB.id}/resources`, { method: 'POST', token: tB,
    body: { kind: 'space', name: '乙的教室', capacity: 20, approve_mode: 'approval' } })).resource;
  const b3 = (await api(`/booking/projects/${PB.id}/bookings`, { method: 'POST', token: tB,
    body: { resource_id: roomB.id, start_time: slot(7, 14), end_time: slot(7, 15), source: 'solo' } })).booking;
  g = await expect(`/booking/bookings/${b3.id}/approve`, 403, { method: 'POST', token: tB, body: {} });
  ok('负责人不能审批自己的申请 403（管理员豁免在后验）', g.ok);
  g = await expect(`/booking/bookings/${b3.id}/approve`, 404, { method: 'POST', token: tC, body: {} });
  ok('外人审批他项目预约 → 统一 404 防探测', g.ok);

  // 驳回理由必填
  g = await expect(`/booking/bookings/${b1.id}/reject`, 400, { method: 'POST', token: tA, body: { reason: '' } });
  ok('驳回理由必填 400', g.ok);

  // 审批复检：直插一条同时段 confirmed 冲突 → 审批必须 409；拔走后通过
  db.prepare(
    `INSERT INTO booking (project_id, resource_id, start_time, end_time, qty, headcount, status, source, booker_id, booker_name)
     VALUES (?,?,?,?,1,1,'confirmed','solo',?,?)`
  ).run(P.id, roomA.id, slot(7, 9), slot(7, 10), C.id, C.nickname);
  const injectId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  g = await expect(`/booking/bookings/${b1.id}/approve`, 409, { method: 'POST', token: tA, body: {} });
  ok('审批时复检冲突 409', g.ok, g.data);
  db.prepare('DELETE FROM booking WHERE id = ?').run(injectId);
  await api(`/booking/bookings/${b1.id}/approve`, { method: 'POST', token: tA });
  g = await expect(`/booking/bookings/${b1.id}`, 200, { token: tB });
  ok('审批通过：confirmed + 轨迹 2 条（created/approved）',
    g.data.booking.status === 'confirmed' && g.data.logs.length === 2, [g.data.booking.status, g.data.logs?.length]);

  // 驳回释放：他人即可提交
  const b4 = (await api(`/booking/projects/${P.id}/bookings`, { method: 'POST', token: tB,
    body: { resource_id: roomA.id, start_time: slot(7, 11), end_time: slot(7, 12), source: 'solo' } })).booking;
  g = await book(tC, { resource_id: roomA.id, start_time: slot(7, 11), end_time: slot(7, 12), source: 'solo' });
  ok('驳回前 pending 占位 409', g.status === 409);
  await api(`/booking/bookings/${b4.id}/reject`, { method: 'POST', token: tA, body: { reason: '测试驳回' } });
  g = await book(tC, { resource_id: roomA.id, start_time: slot(7, 11), end_time: slot(7, 12), source: 'solo' });
  ok('驳回释放后他人可提交 201', g.status === 201, g.data);
  const b5id = g.data.booking.id;
  g = await expect(`/booking/bookings/${b4.id}/reject`, 400, { method: 'POST', token: tA, body: { reason: 'x' } });
  ok('已结案单再驳回 400', g.ok);
  await api(`/booking/bookings/${b5id}/approve`, { method: 'POST', token: tA });

  // ---------- 8. 取消 ----------
  await api(`/booking/bookings/${b2.id}/cancel`, { method: 'POST', token: tC });
  g = await book(tB, { resource_id: roomA.id, start_time: slot(7, 10), end_time: slot(7, 11), source: 'solo' });
  ok('pending 取消后槽位释放，他人可约', g.status === 201, g.data);
  g = await expect(`/booking/bookings/${b2.id}/cancel`, 400, { method: 'POST', token: tC });
  ok('终态重复取消 400', g.ok);

  // confirmed 已开始：预约者不能取消，负责人/管理员可强取消
  const b6 = (await api(`/booking/projects/${P.id}/bookings`, { method: 'POST', token: tA,
    body: { resource_id: itemA.id, start_time: slot(8, 9), end_time: slot(8, 9, 30), qty: 1, source: 'solo' } })).booking;
  db.prepare('UPDATE booking SET start_time = ?, end_time = ? WHERE id = ?')
    .run(slot(-2, 9), slot(-2, 9, 30), b6.id);
  g = await expect(`/booking/bookings/${b6.id}/cancel`, 400, { method: 'POST', token: tA });
  ok('已开始的 confirmed 单预约者取消 400', g.ok && /联系/.test(g.data.error), g.data);
  db.prepare('UPDATE user SET is_admin = 1 WHERE id = ?').run(B.id); // 乙提权为管理员（不回退：后续断言需要）
  g = await expect(`/booking/bookings/${b6.id}/cancel`, 200, { method: 'POST', token: tB });
  ok('管理员强取消 200', g.ok);
  g = await expect(`/booking/bookings/${b6.id}/cancel`, 400, { method: 'POST', token: tB });
  ok('强取消后再取消 400', g.ok);

  // ---------- 9. 多人：组队/临时选人/封禁/搜索/我的 ----------
  const bTeam = (await api(`/booking/projects/${P.id}/bookings`, { method: 'POST', token: tA,
    body: { resource_id: roomA.id, start_time: slot(8, 14), end_time: slot(8, 16), source: 'team', team_id: tm.id } })).booking;
  ok('组队下单：参与人=队员 2 + 队长，booker 标记正确',
    bTeam.participants.length === 3 && bTeam.headcount === 3 &&
    bTeam.participants.find((x) => x.is_booker)?.user_id === A.id, bTeam.participants);
  g = await req('/booking/bookings/mine', { token: tC });
  ok('队员丙在 /bookings/mine 见到队预约', g.data.bookings.some((x) => x.id === bTeam.id));

  const bCustom = (await api(`/booking/projects/${P.id}/bookings`, { method: 'POST', token: tA,
    body: { resource_id: roomS.id, start_time: slot(8, 9), end_time: slot(8, 10),
      source: 'custom', participant_ids: [C.id, C.id, A.id] } })).booking;
  ok('临时选人重复 id 与本人自动去重（2 人）', bCustom.participants.length === 2);

  db.prepare('UPDATE user SET status = 1 WHERE id = ?').run(D.id);
  g = await book(tB, { resource_id: roomS.id, start_time: slot(8, 11), end_time: slot(8, 12),
    source: 'custom', participant_ids: [D.id] });
  ok('参与人含封禁账号 400', g.status === 400, g.data);
  db.prepare('UPDATE user SET status = 0 WHERE id = ?').run(D.id);

  g = await req('/booking/users/search?q=' + encodeURIComponent('冒烟'), { token: tA });
  ok('全站用户搜索（无需好友关系）命中乙丙且带 real_name', g.status === 200 && g.data.users.length >= 3 &&
    !g.data.users.some((u) => u.id === A.id) &&
    g.data.users.find((u) => u.id === B.id)?.real_name === '李乙', g.data.users?.map((u) => u.id));

  // 回归（2026-10-16 双层署名 bug）：昵称本身已含真名（学号风格「张玉磊（284806020）」）时不得再包一层
  const rE = await api('/auth/register', { method: 'POST', body: { email: `bke_${stamp}@x.dev`, password: 'pass123456', nickname: '张玉磊（284806020）' } });
  await setRn(rE.token, '张玉磊');
  const bE = await api(`/booking/projects/${P.id}/bookings`, { method: 'POST', token: rE.token,
    body: { resource_id: roomS.id, start_time: slot(12, 9), end_time: slot(12, 10), source: 'solo', purpose: '双层回归' } });
  ok('昵称已含真名时落库署名不双层嵌套', bE.booking.booker_name === '张玉磊（284806020）', bE.booking.booker_name);

  // 非队长不能用别人的队
  g = await book(tC, { resource_id: roomS.id, start_time: slot(8, 14), end_time: slot(8, 15), source: 'team', team_id: tm.id });
  ok('非队长用他人组队下单 403', g.status === 403, g.data);

  // 容量/库存下调复检：低于未来占用峰值必须 409
  g = await expect(`/booking/resources/${roomA.id}`, 409, { method: 'PUT', token: tA, body: { capacity: 2 } });
  ok('容量下调低于现存 3 人预约 → 409', g.ok);
  g = await expect(`/booking/resources/${itemA.id}`, 409, { method: 'PUT', token: tA, body: { quantity: 2 } });
  ok('库存下调低于占用峰值（3 件）→ 409', g.ok);
  g = await req(`/booking/resources/${itemA.id}`, { method: 'PUT', token: tA, body: { quantity: 3 } });
  ok('库存维持峰值 3 可保存', g.status === 200);

  // 删队：booking.team_id 置空，参与人快照不变
  await api(`/booking/teams/${tm.id}`, { method: 'DELETE', token: tA });
  const bTeamAgain = (await req(`/booking/bookings/${bTeam.id}`, { token: tA })).data.booking;
  ok('删队后 team_id 置空但参与人快照保留', bTeamAgain.team_id === null && bTeamAgain.participants.length === 3);

  // ---------- 10. timeline 契约 ----------
  await api(`/booking/resources/${roomArch.id}/archive`, { method: 'POST', token: tA });
  let tl = await req(`/booking/projects/${P.id}/timeline?from=${dateOf(2)}&days=2`, { token: tB });
  ok('timeline 契约字段齐', tl.status === 200 && tl.data.slot_minutes === 30 &&
    tl.data.slots_per_day === 30 && tl.data.open === '07:00' && tl.data.close === '22:00' &&
    Array.isArray(tl.data.resources) && Array.isArray(tl.data.bookings), tl.data);
  ok('跨天块出现在相交窗口', tl.data.bookings.some((x) => x.start_time === slot(2, 20) && x.end_time === slot(3, 8)));
  ok('甘特默认不含驳回/取消单', tl.data.bookings.every((x) => x.status === 'pending' || x.status === 'confirmed'));
  ok('甘特默认不含已归档资源', !tl.data.resources.some((x) => x.id === roomArch.id));
  tl = await req(`/booking/projects/${P.id}/timeline?from=${dateOf(7)}&days=2&all=1`, { token: tA });
  ok('all=1 时含驳回单（b4）', tl.data.bookings.some((x) => x.id === b4.id && x.status === 'rejected'));
  ok('all=1 时含已归档资源', tl.data.resources.some((x) => x.id === roomArch.id));

  // 项目预约列表筛选
  g = await req(`/booking/projects/${P.id}/bookings?mine=1`, { token: tC });
  ok('项目内预约列表 mine=1 只回自己相关', g.data.bookings.every((x) => x.mine) && g.data.bookings.length > 0);

  // ---------- 11. 通知 ----------
  const nA = await req('/notifications/personal', { token: tA });
  ok('提交审批后负责人收到 bk_submit 通知且 link 带 bid/date',
    nA.data.rows.some((x) => x.type === `bk_submit_${b1.id}` && x.link.includes(`bid=${b1.id}`) && x.link.includes('date=')),
    nA.data.rows.slice(0, 3));
  const nAApprove = await req('/notifications/personal', { token: tA });
  ok('审批者不会收到自己动作的 bk_approve 通知',
    !nAApprove.data.rows.some((x) => x.type === `bk_approve_${b5id}`));
  const nC = await req('/notifications/personal', { token: tC });
  ok('参与人收到通过通知', nC.data.rows.some((x) => x.type === `bk_approve_${b5id}`));
  const uc = await req('/notifications/unread-count', { token: tA });
  ok('unread-count 含 notices 计数', uc.status === 200 && uc.data.notices >= 1 && uc.data.total >= uc.data.notices);

  // ---------- 12. 外键级联 ----------
  let fkBlocked = false;
  try { db.prepare('DELETE FROM booking_project WHERE id = ?').run(P.id); } catch { fkBlocked = true; }
  ok('有资源/预约引用时删项目被 RESTRICT 挡住', fkBlocked);
  ok('项目仍在（挡删后无副作用）', !!db.prepare('SELECT 1 FROM booking_project WHERE id=?').get(P.id));
  db.prepare('DELETE FROM user WHERE id = ?').run(B.id);
  ok('删用户 CASCADE 其预约（b1 行消失）', !db.prepare('SELECT 1 FROM booking WHERE id=?').get(b1.id));
  ok('被删用户项目的档案保留（created_by SET NULL）',
    !!db.prepare('SELECT 1 FROM booking_project WHERE id=?').get(PB.id));
} catch (e) {
  fail++;
  console.error('💥 冒烟异常：', e.message);
  console.error(serverLog.slice(-30).join('\n'));
} finally {
  try { db?.close(); } catch { /* 已关 */ }
  if (server) {
    try {
      process.platform === 'win32'
        ? spawnSync('taskkill', ['/F', '/T', '/PID', String(server.pid)])
        : server.kill('SIGKILL');
    } catch { /* 已退出 */ }
  }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* 沙盒清理尽力而为 */ }
}

console.log(`\n资源预约冒烟：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
