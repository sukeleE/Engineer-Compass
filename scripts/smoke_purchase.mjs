// 物料采购模块冒烟：建档（重复名 409/创建者自动 leader）→ 审批人加减（移除创建者 400/最后 leader 400/
//   老师·负责人双角色/非负责人不可设置但可加人）→ 用户搜索（排除自己/已在档）→
// 申请（服务端重算金额/空明细 400/坏链接 400/closed 403）→ 越权矩阵（他人详情 404、跨事件审批人 403、
//   不能审批自己）→ 驳回→改→重提（回 pending、轨迹保留、旧裁决清空）→ 通过后锁定改/撤 →
// 附件（购买截图每一行一张替换、发票多份、非本人/错状态 403/400、外人下载 404、删光发票退回 approved）→
// BOM 识别（真 .xlsx 表头启发式/UTF-8 BOM csv/GBK csv/假 PDF 400/无 key 图片 502/.docx 400）→
// 统计口径（approved+invoiced 合计、按事件/个人/状态分组、mine=1、学生整体 403、事件级隔离）→
// 导出（4 sheet 名/金额列 =SUM 公式/公式注入转义/mine 只含自己/filename*）→
// 撤回级联清盘（items/files/logs 归零、目录消失）→ 删除（档案权限矩阵 403/404/409/200、超管强删 invoiced 申请并清盘）
//   → 事件有申请时库级 RESTRICT 兜底 → 清理测试用户与冒烟档案。
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { DEFAULT_API, openProbeDb } from './lib/probeDb.mjs';

// xlsx/iconv-lite 只装在 backend：从脚本 URL 定基的 createRequire 跨目录取（根工具链不新增依赖）
const require = createRequire(import.meta.url);
const XLSX = require('../backend/node_modules/xlsx');
const iconv = require('../backend/node_modules/iconv-lite');

const __dirname = dirname(fileURLToPath(import.meta.url));
// 默认指向真实开发目录；服务端以 PURCHASE_UPLOAD_DIR 隔离运行时，冒烟侧用 SMK_PURCHASE_DIR 对齐
const PURCHASE_UP = process.env.SMK_PURCHASE_DIR
  ? join(process.env.SMK_PURCHASE_DIR)
  : join(__dirname, '..', 'backend', 'uploads', 'purchase');

const BASE = process.env.PROBE_API || DEFAULT_API;

const jsonReq = async (path, opts = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers || {}) };
  const res = await fetch(BASE + path, {
    headers, method: opts.method || 'GET',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
};
const rawReq = async (path, opts = {}) => {
  const headers = { ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers || {}) };
  if (opts.ct) headers['Content-Type'] = opts.ct;
  return fetch(BASE + path, { headers, method: opts.method || 'GET', body: opts.body });
};
const api = async (path, opts = {}) => {
  const { res, data } = await jsonReq(path, opts);
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
};
const expect = async (path, status, opts = {}) => {
  const { res, data } = await jsonReq(path, opts);
  return { ok: res.status === status, got: res.status, data };
};
// multipart 上传：绝不手设 Content-Type（fetch 自动带 boundary）
const upload = async (path, buf, filename, token) => {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), filename);
  return rawReq(path, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: fd });
};

// xlsx zip 解包（EOCD→中央目录，同 smoke_expense）：断言 sheet 名/公式/文本落位
const unzipAll = (buf) => {
  const out = {};
  let i = buf.length - 22;
  for (; i > 0 && buf.slice(i, i + 4).toString('latin1') !== 'PK\x05\x06'; i--) { /* 找 EOCD */ }
  if (buf.slice(i, i + 4).toString('latin1') !== 'PK\x05\x06') return out;
  let cdOff = buf.readUInt32LE(i + 16);
  while (buf.slice(cdOff, cdOff + 4).toString('latin1') === 'PK\x01\x02') {
    const method = buf.readUInt16LE(cdOff + 10);
    const csize = buf.readUInt32LE(cdOff + 20);
    const nLen = buf.readUInt16LE(cdOff + 28);
    const xLen = buf.readUInt16LE(cdOff + 30);
    const lho = buf.readUInt32LE(cdOff + 42);
    const name = buf.slice(cdOff + 46, cdOff + 46 + nLen).toString('utf8');
    const lnLen = buf.readUInt16LE(lho + 26);
    const lxLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lnLen + lxLen;
    const data = buf.slice(dataStart, dataStart + csize);
    out[name] = method === 8 ? inflateRawSync(data) : data;
    cdOff += 46 + nLen + xLen;
  }
  return out;
};

const stamp = Date.now().toString().slice(-8);
const mkEmail = (k) => `pc_${k}_${stamp}@test.dev`;
let pass = 0, fail = 0, skip = 0;
const ok = (name, cond) => { cond ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}`)); };

// ===== 跨阶段实体 id =====
let eid1 = 0, eid2 = 0, eid3 = 0, eid4 = 0;
let ridA = 0, ridB = 0;
const createdRids = [];
let fidShot = 0;
let db = null;

try {
  const health = await (await rawReq('/health')).json();
  const visionOn = health.vision === true;

  // ---------- 0. 登录闸门 + 注册 5 人 ----------
  let got = await expect('/purchase/events', 401);
  ok('未登录不能访问档案列表(401)', got.ok);
  // 业务夹具：注册后立即实名（三模块硬门禁）
  const reg = async (k, nick, real) => {
    const r = await api('/auth/register', { method: 'POST', body: { email: mkEmail(k), password: 'pass123456', nickname: nick } });
    await api('/auth/real-name', { method: 'PUT', token: r.token, body: { real_name: real } });
    return r;
  };
  const rL = await reg('l', '采购队长', '陈领队');
  const rT = await reg('t', `采购老师${stamp}`, '张老师');
  const rA = await reg('a', '采购学生甲', '李甲');
  const rB = await reg('b', '采购学生乙', '李乙');
  const rC = await reg('c', '采购路人', '赵路');
  ok('注册 5 用户并完成实名', !!(rL.token && rT.token && rA.token && rB.token && rC.token));
  const tL = rL.token, tT = rT.token, tA = rA.token, tB = rB.token, tC = rC.token;
  const uidT = Number(rT.user.id);
  // 第 6 人故意不实名：门禁断言
  const rU = await api('/auth/register', { method: 'POST', body: { email: mkEmail('u'), password: 'pass123456', nickname: '采购未实名' } });
  const tU = rU.token;
  got = await expect('/purchase/events', 403, { token: tU });
  ok('未实名 GET 档案列表 403 need_real_name', got.ok && got.data.code === 'need_real_name', got.data);
  got = await expect('/purchase/events', 403, { method: 'POST', token: tU, body: { name: '未实名偷建档', kind: '比赛' } });
  ok('未实名建档 403 need_real_name', got.ok && got.data.code === 'need_real_name', got.data);
  await api('/auth/real-name', { method: 'PUT', token: tU, body: { real_name: '周六' } });
  ok('实名后采购模块立即可用', (await expect('/purchase/events', 200, { token: tU })).ok);

  // ---------- 1. 建档：重复名 409、创建者自动 leader、任何登录用户可建档 ----------
  const evName1 = `采购冒烟赛${stamp}`;
  const c1 = await api('/purchase/events', { method: 'POST', token: tL, body: { name: evName1, kind: '比赛', description: '冒烟主档案' } });
  eid1 = Number(c1.event.id);
  ok('建档 201 且创建者自动 leader(canManage/canSettings)', c1.event.myRole === 'leader' && c1.event.status === 'open'
    && c1.event.canManage === true && c1.event.canSettings === true);
  got = await expect('/purchase/events', 409, { method: 'POST', token: tA, body: { name: evName1 } });
  ok('重复档案名 409', got.ok);
  got = await expect('/purchase/events', 400, { method: 'POST', token: tA, body: { name: '' } });
  ok('空名称 400', got.ok);
  // 学生也能建档（决策：任何登录用户可建比赛/项目档案）
  const c4 = await api('/purchase/events', { method: 'POST', token: tB, body: { name: `采购冒烟项目${stamp}`, kind: '项目' } });
  eid4 = Number(c4.event.id);
  ok('学生可建档且 kind=项目、自动 leader', c4.event.kind === '项目' && c4.event.myRole === 'leader');
  const listC = await api('/purchase/events', { token: tC });
  const e1RowC = listC.events.find((e) => Number(e.id) === eid1);
  ok('open 档案对路人可见但无任何权限位', !!e1RowC && e1RowC.myRole === null && e1RowC.canApprove === false && e1RowC.canManage === false);

  // ---------- 2. 审批人：查看/添加/角色切换/移除守卫 ----------
  got = await expect(`/purchase/events/${eid1}/approvers`, 403, { token: tC });
  ok('路人无权查看审批人 403', got.ok);
  const ap0 = await api(`/purchase/events/${eid1}/approvers`, { token: tL });
  ok('初始审批人仅创建者本人(is_creator/leader)', ap0.approvers.length === 1
    && ap0.approvers[0].is_creator === true && ap0.approvers[0].role === 'leader');
  got = await expect(`/purchase/events/${eid1}/approvers`, 403, {
    method: 'POST', token: tA, body: { user_id: uidT, role: 'teacher' },
  });
  ok('学生不可加审批人 403', got.ok);
  // 用户搜索：找到老师、不含自己；加为审批人后按 event_id 排除
  const sr1 = await api(`/purchase/users/search?q=${encodeURIComponent('采购老师')}`, { token: tL });
  ok('用户搜索按昵称找到老师且排除自己', sr1.users.some((u) => Number(u.id) === uidT) && !sr1.users.some((u) => Number(u.id) === Number(rL.user.id)));
  const srEmpty = await api('/purchase/users/search?q=', { token: tL });
  ok('空查询返回空数组', Array.isArray(srEmpty.users) && srEmpty.users.length === 0);
  await api(`/purchase/events/${eid1}/approvers`, { method: 'POST', token: tL, body: { user_id: uidT, role: 'teacher' } });
  const sr2 = await api(`/purchase/users/search?q=${encodeURIComponent('采购老师')}&event_id=${eid1}`, { token: tL });
  ok('已在档用户被 event_id 搜索排除', !sr2.users.some((u) => Number(u.id) === uidT));
  // 幂等：同身份再加 200 不重复
  await api(`/purchase/events/${eid1}/approvers`, { method: 'POST', token: tL, body: { user_id: uidT, role: 'teacher' } });
  // 角色切换 teacher → leader → teacher
  await api(`/purchase/events/${eid1}/approvers`, { method: 'POST', token: tL, body: { user_id: uidT, role: 'leader' } });
  const apSw = await api(`/purchase/events/${eid1}/approvers`, { token: tL });
  ok('审批人角色可切换为 leader', apSw.approvers.find((x) => Number(x.user_id) === uidT)?.role === 'leader');
  await api(`/purchase/events/${eid1}/approvers`, { method: 'POST', token: tL, body: { user_id: uidT, role: 'teacher' } });
  // 移除创建者 400
  got = await expect(`/purchase/events/${eid1}/approvers/${Number(rL.user.id)}`, 400, { method: 'DELETE', token: tL });
  ok('移除建档者 400', got.ok && String(got.data.error).includes('建档者'));
  // 封禁/不存在用户
  got = await expect(`/purchase/events/${eid1}/approvers`, 404, { method: 'POST', token: tL, body: { user_id: 99999999, role: 'teacher' } });
  ok('加不存在用户 404', got.ok);

  // ---------- 3. 第二档案：最后 leader 守卫、非创建者 leader 可加人但不可改设置 ----------
  const c2 = await api('/purchase/events', { method: 'POST', token: tT, body: { name: `采购冒烟二场${stamp}`, kind: '比赛' } });
  eid2 = Number(c2.event.id);
  await api(`/purchase/events/${eid2}/approvers`, { method: 'POST', token: tT, body: { user_id: Number(rA.user.id), role: 'leader' } });
  got = await expect(`/purchase/events/${eid2}`, 403, { method: 'PUT', token: tA, body: { name: `采购冒烟二场改名${stamp}` } });
  ok('非创建者 leader 不能改档案设置 403(可加人但不可设置)', got.ok);
  // leader（非创建者）可以加审批人：把队长加为老师
  got = await expect(`/purchase/events/${eid2}/approvers`, 200, { method: 'POST', token: tA, body: { user_id: Number(rL.user.id), role: 'teacher' } });
  ok('非创建者 leader 可添加审批人 200', got.ok);
  // 直接把创建者 T 的桥表行拿掉（仅冒烟库；经 openProbeDb 同源闸门），制造「仅剩 1 名 leader」
  db = openProbeDb(BASE);
  db.prepare('DELETE FROM purchase_event_approver WHERE event_id = ? AND user_id = ?').run(eid2, Number(rT.user.id));
  got = await expect(`/purchase/events/${eid2}/approvers/${Number(rA.user.id)}`, 400, { method: 'DELETE', token: tT });
  ok('只剩一名 leader 时移除 400', got.ok && String(got.data.error).includes('至少保留'));
  const leadersLeft = db.prepare("SELECT COUNT(*) AS n FROM purchase_event_approver WHERE event_id = ? AND role = 'leader'").get(eid2).n;
  ok('400 后 leader 行未被删除', leadersLeft === 1);

  // ---------- 4. 申请单入参校验 / 关闭档案 ----------
  got = await expect('/purchase/requests', 404, { method: 'POST', token: tA, body: { event_id: 99999999, items: [{ name: 'x', qty: 1, unit_price: 1 }] } });
  ok('不存在的档案 404', got.ok);
  got = await expect('/purchase/requests', 400, { method: 'POST', token: tA, body: { event_id: eid1, items: [] } });
  ok('空明细 400', got.ok);
  got = await expect('/purchase/requests', 400, { method: 'POST', token: tA, body: { event_id: eid1, items: [{ name: 'x', qty: 0, unit_price: 1 }] } });
  ok('数量 0 400', got.ok);
  got = await expect('/purchase/requests', 400, { method: 'POST', token: tA, body: { event_id: eid1, items: [{ name: 'x', qty: 1, unit_price: 1, link: 'ftp://x' }] } });
  ok('非 http 链接 400', got.ok);
  const c3 = await api('/purchase/events', { method: 'POST', token: tL, body: { name: `采购冒烟已关闭${stamp}`, kind: '比赛' } });
  eid3 = Number(c3.event.id);
  const cl = await api(`/purchase/events/${eid3}`, { method: 'PUT', token: tL, body: { status: 'closed' } });
  ok('建档者可关闭档案(close_time 落值)', cl.event.status === 'closed' && !!cl.event.close_time);
  got = await expect('/purchase/requests', 403, { method: 'POST', token: tA, body: { event_id: eid3, items: [{ name: 'x', qty: 1, unit_price: 1 }] } });
  ok('已关闭档案不能申请 403', got.ok);

  // ---------- 5. 提申请：金额服务端重算 ----------
  const itemsA = [
    { name: 'Arduino 主控板', spec: 'UNO R3', qty: 2, unit_price: 35.5, link: 'https://item.taobao.com/example/a' },
    { name: '杜邦线', spec: '公对母 20cm', qty: 10, unit_price: 1.5 },
  ];
  const ca = await api('/purchase/requests', { method: 'POST', token: tA, body: { event_id: eid1, items: itemsA, remark: '冒烟申请 A' } });
  ridA = Number(ca.detail.id); createdRids.push(ridA);
  ok('A 提申请 201：金额服务端重算 71+15=86 + 申请人快照「真名（昵称）」（不再附 applicant_real_name）', ca.detail.status === 'pending' && ca.detail.amount === 86
    && ca.detail.applicant_name === '李甲（采购学生甲）' && !('applicant_real_name' in ca.detail)
    && ca.detail.perm.canEdit === true && ca.detail.items.length === 2);
  // B 的申请含公式注入样本（导出转义断言用）
  const itemsB0 = [{ name: '=cmd', qty: 1, unit_price: 9.9 }];
  const cb0 = await api('/purchase/requests', { method: 'POST', token: tB, body: { event_id: eid1, items: itemsB0 } });
  ridB = Number(cb0.detail.id); createdRids.push(ridB);
  ok('B 提申请(注入样本物料名) 201 金额 9.9', cb0.detail.amount === 9.9);

  // ---------- 6. 可见性矩阵 ----------
  got = await expect(`/purchase/requests/${ridA}`, 404, { token: tC });
  ok('路人看他人申请 404(不泄露存在)', got.ok);
  // A 此时已是二场 leader，默认列表走「我审批的档案」域；看自己必须 mine=1
  const lsA = await api('/purchase/requests?mine=1', { token: tA });
  ok('mine=1 列表只含自己且含本单', lsA.requests.every((x) => Number(x.user_id) === Number(rA.user.id)) && lsA.requests.some((x) => Number(x.id) === ridA));
  const lsC = await api('/purchase/requests', { token: tC });
  ok('路人列表为空', lsC.requests.length === 0);
  got = await expect('/purchase/requests?event_id=' + eid1, 403, { token: tA });
  ok('他事件审批人(A 仅属二场)筛本事件 403', got.ok);
  const lsT = await api('/purchase/requests', { token: tT });
  ok('老师看本档案全部申请(2 条)', lsT.requests.length === 2 && lsT.requests.every((x) => Number(x.event_id) === eid1));
  const lsBScope = await api('/purchase/requests', { token: tB });
  ok('B(另档案 leader)列表只见自己档案域: 不含 A 的申请', !lsBScope.requests.some((x) => Number(x.id) === ridA));

  // ---------- 7. 附件闸门（pending 态：发票 400、非本人 403、坏类型 400、截图替换） ----------
  let up = await upload(`/purchase/requests/${ridA}/invoices`, Buffer.from('pdf-bytes'), '发票.pdf', tB);
  ok('非本人传发票 403(且不落库)', up.status === 403);
  up = await upload(`/purchase/requests/${ridA}/invoices`, Buffer.from('pdf-bytes'), '发票.pdf', tA);
  ok('pending 态传发票 400', up.status === 400);
  const iidA1 = Number(ca.detail.items[0].id);
  up = await upload(`/purchase/requests/${ridA}/items/99999999/shot`, Buffer.from('png'), 'x.png', tA);
  ok('截图挂不存在物料行 404', up.status === 404);
  up = await upload(`/purchase/requests/${ridA}/items/${iidA1}/shot`, Buffer.from('text-only'), '说明.txt', tA);
  ok('截图传 .txt 400', up.status === 400);
  const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  up = await upload(`/purchase/requests/${ridA}/items/${iidA1}/shot`, PNG_1x1, '购买截图.png', tA);
  const upShot = await up.json();
  fidShot = Number(upShot.file.id);
  ok('截图上传 201', up.status === 201 && fidShot > 0);
  const dShot1 = await api(`/purchase/requests/${ridA}`, { token: tA });
  ok('详情带出截图', dShot1.detail.items[0].shot && Number(dShot1.detail.items[0].shot.id) === fidShot);
  up = await upload(`/purchase/requests/${ridA}/items/${iidA1}/shot`, PNG_1x1, '购买截图_v2.png', tA);
  const upShot2 = await up.json();
  ok('同行重传截图=替换(新 fid)', up.status === 201 && Number(upShot2.file.id) !== fidShot);
  fidShot = Number(upShot2.file.id);
  got = await expect(`/purchase/files/${Number(upShot.file.id)}`, 404, { token: tA });
  ok('被替换旧截图 404', got.ok);

  // ---------- 8. 审批：不能自审/路人 403/驳回必填 → 驳回 → 修改重提 → 通过/锁定 ----------
  got = await expect(`/purchase/requests/${ridA}/approve`, 403, { method: 'POST', token: tC });
  ok('路人审批 403', got.ok);
  got = await expect(`/purchase/requests/${ridA}/approve`, 403, { method: 'POST', token: tA });
  ok('不能审批自己的申请 403', got.ok);
  got = await expect(`/purchase/requests/${ridB}/reject`, 400, { method: 'POST', token: tT, body: {} });
  ok('驳回不填理由 400', got.ok);
  const rj = await api(`/purchase/requests/${ridB}/reject`, { method: 'POST', token: tT, body: { reason: '规格不全，请补充型号' } });
  ok('老师驳回 200：rejected + 轨迹 role=teacher', rj.detail.status === 'rejected' && rj.detail.logs.length === 1
    && rj.detail.logs[0].role === 'teacher' && rj.detail.logs[0].result === 'rejected' && rj.detail.reject_reason === '规格不全，请补充型号');
  // 驳回后本人修改重新提交（金额/明细变化；轨迹保留；旧裁决清空）
  const itemsB1 = [
    { name: '=cmd', spec: '新版', qty: 2, unit_price: 9.9 },
    { name: '5号电池', spec: 'AA 1.5V', qty: 4, unit_price: 5 },
    { name: '胶带', spec: '', qty: 1, unit_price: 3 },
  ];
  const ed = await api(`/purchase/requests/${ridB}`, { method: 'PUT', token: tB, body: { event_id: eid1, items: itemsB1, remark: '已补规格' } });
  ok('驳回后修改重提：回 pending/金额 19.8+20+3=42.8/轨迹保留 1 条/旧裁决清空',
    ed.detail.status === 'pending' && ed.detail.amount === 42.8 && ed.detail.logs.length === 1
    && !ed.detail.approver_name && !ed.detail.reject_reason);
  // pending 本人可改（带旧行 id → 行被更新而非替换，截图随旧行保留）
  const iidA2 = Number(ca.detail.items[1].id);
  const itemsAKeep = itemsA.map((x, i) => ({ ...x, id: [iidA1, iidA2][i] }));
  const edA = await api(`/purchase/requests/${ridA}`, { method: 'PUT', token: tA, body: { event_id: eid1, items: itemsAKeep } });
  ok('pending 本人可改(带 id 的旧行截图保留)', edA.detail.status === 'pending' && edA.detail.items[0].shot && Number(edA.detail.items[0].shot.id) === fidShot);
  const apB = await api(`/purchase/requests/${ridB}/approve`, { method: 'POST', token: tL, body: { comment: '同意采购' } });
  ok('负责人通过 B：approved + 轨迹 2 条(leader)', apB.detail.status === 'approved' && apB.detail.logs.length === 2
    && apB.detail.logs[1].role === 'leader' && apB.detail.logs[1].result === 'approved');
  await api(`/purchase/requests/${ridA}/approve`, { method: 'POST', token: tT });
  ok('老师通过 A 200', true);
  got = await expect(`/purchase/requests/${ridA}/approve`, 400, { method: 'POST', token: tT });
  ok('重复审批 400', got.ok);
  got = await expect(`/purchase/requests/${ridA}`, 400, { method: 'PUT', token: tA, body: { event_id: eid1, items: itemsA } });
  ok('通过后本人不可改 400', got.ok);
  got = await expect(`/purchase/requests/${ridA}`, 400, { method: 'DELETE', token: tA });
  ok('通过后不可撤回 400', got.ok);
  got = await expect(`/purchase/requests/${ridA}`, 403, { method: 'DELETE', token: tB });
  ok('非本人撤回 403', got.ok);
  got = await expect(`/purchase/files/${fidShot}`, 400, { method: 'DELETE', token: tA });
  ok('通过后截图锁定不可删 400', got.ok);

  // ---------- 9. 发票：多份/状态翻转/鉴权下载/删光退回 approved ----------
  const pdf1 = Buffer.from('%PDF-1.4\nsmoke invoice one\n');
  up = await upload(`/purchase/requests/${ridA}/invoices`, pdf1, '发票1.pdf', tA);
  const inv1 = await up.json();
  const fidInv1 = Number(inv1.file.id);
  ok('首张发票 201：approved → invoiced', up.status === 201 && inv1.status === 'invoiced' && fidInv1 > 0);
  up = await upload(`/purchase/requests/${ridA}/invoices`, PNG_1x1, '发票2.png', tA);
  const inv2 = await up.json();
  const fidInv2 = Number(inv2.file.id);
  ok('第二张发票 201(多张只增)', up.status === 201 && fidInv2 !== fidInv1);
  const dInv = await api(`/purchase/requests/${ridA}`, { token: tA });
  ok('详情发票两份 + invoice_count=2', dInv.detail.invoices.length === 2 && dInv.detail.invoice_count === 2);
  up = await upload(`/purchase/requests/${ridA}/invoices`, Buffer.from('txt'), '发票.txt', tA);
  ok('发票传 .txt 400(PDF/图片白名单)', up.status === 400);
  got = await expect(`/purchase/files/${fidInv1}`, 404, { token: tC });
  ok('路人下载发票 404', got.ok);
  const gf = await rawReq(`/purchase/files/${fidInv1}`, { token: tT });
  ok('审批人内联下载 PDF：200 + application/pdf + 字节一致', gf.status === 200
    && (gf.headers.get('content-type') || '').startsWith('application/pdf')
    && Buffer.from(await gf.arrayBuffer()).equals(pdf1));
  const gfDl = await rawReq(`/purchase/files/${fidInv1}?dl=1`, { token: tT });
  ok('?dl=1 强制 attachment', (gfDl.headers.get('content-disposition') || '').startsWith('attachment'));
  let del = await rawReq(`/purchase/files/${fidInv2}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tA}` } });
  ok('删第二张发票 200(仍 invoiced)', del.status === 200 && (await del.json()).status === 'invoiced');
  del = await rawReq(`/purchase/files/${fidInv1}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tA}` } });
  const delJson = await del.json();
  ok('删光发票：200 且状态退回 approved(待传发票)', del.status === 200 && delJson.status === 'approved');
  const dBack = await api(`/purchase/requests/${ridA}`, { token: tA });
  ok('退回后 invoice_count=0', dBack.detail.status === 'approved' && dBack.detail.invoice_count === 0);
  // 补传一张 → invoiced（最终统计口径：A=invoiced 86；B=approved 42.8）
  up = await upload(`/purchase/requests/${ridA}/invoices`, PNG_1x1, '补传发票.jpg', tA);
  ok('补传发票 → invoiced', up.status === 201 && (await up.json()).status === 'invoiced');

  // ---------- 10. 撤回级联：盘 + 库全清 ----------
  const ct = await api('/purchase/requests', { method: 'POST', token: tA, body: { event_id: eid1, items: [{ name: '级联夹具行', qty: 1, unit_price: 7 }] } });
  const ridTmp = Number(ct.detail.id); createdRids.push(ridTmp);
  const iidTmp = Number(ct.detail.items[0].id);
  await upload(`/purchase/requests/${ridTmp}/items/${iidTmp}/shot`, PNG_1x1, 'tmp.png', tA);
  ok('级联夹具申请目录已落盘', existsSync(join(PURCHASE_UP, String(ridTmp))));
  const dw = await api(`/purchase/requests/${ridTmp}`, { method: 'DELETE', token: tA });
  ok('本人撤回 pending 申请 200', !!dw.message);
  ok('撤回后申请整目录清盘', !existsSync(join(PURCHASE_UP, String(ridTmp))));
  got = await expect(`/purchase/requests/${ridTmp}`, 404, { token: tA });
  ok('撤回后详情 404', got.ok);
  const zero = db.prepare(
    `SELECT (SELECT COUNT(*) FROM purchase_request WHERE id=?) AS rq,
            (SELECT COUNT(*) FROM purchase_item WHERE request_id=?) AS it,
            (SELECT COUNT(*) FROM purchase_file WHERE request_id=?) AS f,
            (SELECT COUNT(*) FROM purchase_approval_log WHERE request_id=?) AS lg`
  ).get(ridTmp, ridTmp, ridTmp, ridTmp);
  ok('DB 级联：申请/明细/附件/轨迹全 0', zero.rq === 0 && zero.it === 0 && zero.f === 0 && zero.lg === 0);

  // ---------- 11. BOM 识别（不落库） ----------
  // 11.1 真 .xlsx：带标题行 + 表头启发式 + 合计行跳过
  const bomAoa = [
    ['机器人队 BOM 采购清单'],
    ['序号', '物料名称', '规格型号', '数量', '单价（元）', '备注'],
    [1, 'Arduino Uno 控制板', 'R3 原装', 2, 35.5, ''],
    [2, '杜邦线', '公对母 20cm', 10, 1.5, ''],
    [3, '合计', '', 12, '', ''],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(bomAoa), 'BOM');
  const xlsxBytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  let bom = await upload('/purchase/recognize-bom', xlsxBytes, 'BOM表.xlsx', tC);
  let bomJson = await bom.json();
  ok('BOM xlsx：200 + 识别 2 行(标题/合计行跳过) + 名称/规格/数量/单价对位',
    bom.status === 200 && bomJson.source === 'xlsx' && bomJson.items.length === 2
    && bomJson.items[0].name === 'Arduino Uno 控制板' && bomJson.items[0].spec === 'R3 原装'
    && bomJson.items[0].qty === 2 && bomJson.items[0].unit_price === 35.5
    && bomJson.items[1].name === '杜邦线' && bomJson.items[1].qty === 10
    && bomJson.warnings.some((w) => w.includes('已按表头识别')));
  // 11.2 UTF-8 BOM csv：￥ 金额清洗
  const csvUtf = '﻿物料名称,规格,数量,单价\n电阻 10k,0805封装,100,￥0.05\n电容 10uF,0805,50,0.1\n合计,,150,\n';
  bom = await upload('/purchase/recognize-bom', Buffer.from(csvUtf, 'utf8'), 'bom.csv', tC);
  bomJson = await bom.json();
  ok('BOM csv(UTF-8 BOM)：2 行 + ￥0.05 清洗为 0.05', bom.status === 200 && bomJson.source === 'csv'
    && bomJson.items.length === 2 && bomJson.items[0].name === '电阻 10k' && bomJson.items[0].unit_price === 0.05
    && bomJson.items[0].qty === 100 && bomJson.items[1].unit_price === 0.1);
  // 11.3 GBK csv（Excel 中文 Windows 默认导出）
  const csvGbkText = '物料名称,数量,单价\n焊锡丝,1,￥18.5\n导线 0.5平方,20,0.8\n';
  const gbkBytes = iconv.encode(csvGbkText, 'gbk');
  bom = await upload('/purchase/recognize-bom', gbkBytes, 'bom_gbk.csv', tC);
  bomJson = await bom.json();
  ok('BOM csv(GBK)：正确解码 + 2 行 + 焊锡丝 18.5', bom.status === 200 && bomJson.items.length === 2
    && bomJson.items[0].name === '焊锡丝' && bomJson.items[0].qty === 1 && bomJson.items[0].unit_price === 18.5
    && bomJson.items[1].name === '导线 0.5平方' && bomJson.items[1].qty === 20);
  // 11.4 假字节 PDF → 400 + hint（离线确定，不触网）
  bom = await upload('/purchase/recognize-bom', PNG_1x1, '清单.pdf', tC);
  bomJson = await bom.json();
  ok('BOM 假 PDF(PNG 改名) 400 + 可读 hint', bom.status === 400 && String(bomJson.error).includes('PDF') && String(bomJson.hint || '').length > 4);
  // 11.5 图片通道：无 key 502 指向配置；配 key 只验契约/上游不可用则跳过
  bom = await upload('/purchase/recognize-bom', PNG_1x1, '清单.png', tC);
  bomJson = await bom.json();
  if (visionOn) {
    if (bom.status === 200) {
      ok('配键：BOM 图片识别 200 契约(items 数组/source=image)', bomJson.source === 'image' && Array.isArray(bomJson.items)
        && bomJson.items.every((x) => x.name && Number.isFinite(x.qty) && Number.isFinite(x.unit_price)));
    } else {
      skip++;
      console.log(`⏭️ 配键：BOM 图片识别（上游不可用 ${bom.status}: ${String(bomJson.error || '').slice(0, 80)}）—— 跳过，非代码缺陷`);
    }
  } else {
    ok('未配键：BOM 图片识别 502 指向 VISION_API_KEY', bom.status === 502
      && String(bomJson.error).includes('VISION_API_KEY') && String(bomJson.hint || '').includes('VISION'));
  }
  // 11.6 不支持的类型 / 不带文件 / 未登录
  bom = await upload('/purchase/recognize-bom', Buffer.from('docx'), '清单.docx', tC);
  ok('BOM .docx 400', bom.status === 400);
  const noFile = await rawReq('/purchase/recognize-bom', { method: 'POST', headers: { Authorization: `Bearer ${tC}` }, body: new FormData() });
  ok('BOM 不带文件 400', noFile.status === 400);
  const noAuth = await rawReq('/purchase/recognize-bom', { method: 'POST', body: new FormData() });
  ok('BOM 未登录 401', noAuth.status === 401);

  // ---------- 12. 统计口径 ----------
  got = await expect('/purchase/stats', 403, { token: tC });
  ok('纯学生看整体统计 403', got.ok);
  const stMineC = await api('/purchase/stats?mine=1', { token: tC });
  ok('学生 mine=1 个人统计=0', stMineC.total === 0);
  const stB = await api('/purchase/stats', { token: tB });
  ok('B(仅自己项目档案的 leader)整体统计事件级隔离=0', stB.total === 0 && stB.total_amount === 0);
  const stA = await api('/purchase/stats', { token: tA });
  ok('A(仅二场 leader)整体统计不含主档案=0', stA.total === 0);
  const stT = await api('/purchase/stats', { token: tT });
  ok('老师统计：2 单 / 通过口径金额 86+42.8=128.8', stT.total === 2 && Math.abs(stT.total_amount - 128.8) < 1e-6);
  const gE1 = stT.by_event.find((x) => Number(x.event_id) === eid1);
  ok('按事件：2 单/通过金额 128.8/待传发票 1(B)', !!gE1 && gE1.count === 2
    && Math.abs(gE1.approved_amount - 128.8) < 1e-6 && gE1.invoice_pending === 1 && gE1.pending_amount === 0 && gE1.rejected_amount === 0);
  const gA = stT.by_user.find((x) => x.name === '李甲（采购学生甲）');
  const gB = stT.by_user.find((x) => x.name === '李乙（采购学生乙）');
  ok('按个人：A=86 已传发票(待传 0)；B=42.8 待传发票 1（name 为申请时快照，不附 real_name）',
    !!gA && Math.abs(gA.approved_amount - 86) < 1e-6 && gA.invoice_pending === 0 && !('real_name' in gA)
    && !!gB && Math.abs(gB.approved_amount - 42.8) < 1e-6 && gB.invoice_pending === 1 && !('real_name' in gB));
  ok('按状态：invoiced 1×86 / approved 1×42.8 / pending·rejected=0',
    stT.by_status.invoiced.count === 1 && stT.by_status.invoiced.amount === 86
    && stT.by_status.approved.count === 1 && Math.abs(stT.by_status.approved.amount - 42.8) < 1e-6
    && stT.by_status.pending.count === 0 && stT.by_status.rejected.count === 0);
  const stInv = await api('/purchase/stats?status=invoiced', { token: tT });
  ok('状态筛选 invoiced：1 单 86', stInv.total === 1 && stInv.total_amount === 86);
  const stMineA = await api('/purchase/stats?mine=1', { token: tA });
  ok('A mine=1：1 单 86', stMineA.total === 1 && stMineA.total_amount === 86);
  const stFuture = await api('/purchase/stats?from=2099-01-01', { token: tT });
  const stPast = await api('/purchase/stats?from=2000-01-01', { token: tT });
  ok('日期区间过滤：未来 0 单 / 2000 年起 2 单', stFuture.total === 0 && stPast.total === 2);
  got = await expect('/purchase/stats?from=01-01', 400, { token: tT });
  ok('坏日期格式 400', got.ok);

  // ---------- 13. 导出 xlsx ----------
  const xRes = await rawReq('/purchase/export.xlsx', { token: tT });
  const xbuf = Buffer.from(await xRes.arrayBuffer());
  ok('导出 200 + zip 容器 + filename* 中文名', xRes.status === 200 && xbuf.slice(0, 2).toString('latin1') === 'PK'
    && (xRes.headers.get('content-disposition') || '').includes("filename*=UTF-8''")
    && (xRes.headers.get('content-disposition') || '').includes(encodeURIComponent('物料采购')));
  const parts = unzipAll(xbuf);
  const wbXml = parts['xl/workbook.xml']?.toString('utf8') || '';
  ok('4 个 sheet：物料明细/按比赛项目汇总/个人汇总/审批轨迹',
    ['物料明细', '按比赛项目汇总', '个人汇总', '审批轨迹'].every((n) => wbXml.includes(`name="${n}"`)));
  const sheetXml = Object.entries(parts).filter(([n]) => n.startsWith('xl/worksheets/')).map(([, v]) => v.toString('utf8')).join('\n');
  // 5 条物料行（A 2 + B 3）：数据区 I2:I6
  ok('明细 sheet 金额列 I 合计公式 =SUM(I2:I6)', sheetXml.includes('<f>=SUM(I2:I6)</f>'));
  // 文本可能落在 sharedStrings：全部件一起搜
  const allText = Object.values(parts).map((v) => v.toString('utf8')).join('\n');
  // SheetJS 把防护用单引号 XML 转义成 &apos;（同 smoke_expense 的 &apos;=1+1 断言）
  ok('公式注入物料名 =cmd 被前置单引号转义', allText.includes('&apos;=cmd'));
  ok('审批轨迹含 驳回/通过 与中文理由/老师身份', allText.includes('驳回') && allText.includes('通过')
    && allText.includes('规格不全，请补充型号') && allText.includes('老师') && allText.includes('负责人'));
  const xMine = await rawReq('/purchase/export.xlsx?mine=1', { token: tA });
  const mineParts = unzipAll(Buffer.from(await xMine.arrayBuffer()));
  const mineText = Object.values(mineParts).map((v) => v.toString('utf8')).join('\n');
  ok('mine=1 导出只含自己(Arduino/杜邦线 在；电池/胶带 不在)', mineText.includes('Arduino 主控板') && mineText.includes('杜邦线')
    && !mineText.includes('5号电池') && !mineText.includes('胶带'));
  const xC = await rawReq('/purchase/export.xlsx', { token: tC });
  ok('纯学生导出被限到自己域(200 空表也出簿)', xC.status === 200 && Buffer.from(await xC.arrayBuffer()).slice(0, 2).toString('latin1') === 'PK');

  // ---------- 14. 关闭档案的可见性 + 库级 RESTRICT ----------
  await api(`/purchase/events/${eid1}`, { method: 'PUT', token: tL, body: { status: 'closed' } });
  const listCClosed = await api('/purchase/events', { token: tC });
  const listAClosed = await api('/purchase/events', { token: tA });
  ok('关闭后：路人列表不可见；有申请的学生仍可见',
    !listCClosed.events.some((e) => Number(e.id) === eid1) && listAClosed.events.some((e) => Number(e.id) === eid1));
  await api(`/purchase/events/${eid1}`, { method: 'PUT', token: tL, body: { status: 'open' } });
  // 库层兜底：即使绕过 API，有申请时 DELETE 也必须被外键 RESTRICT 挡住
  let restrictBlocked = false;
  try { db.prepare('DELETE FROM purchase_event WHERE id = ?').run(eid1); }
  catch (e) { restrictBlocked = /constraint/i.test(String(e.message)); }
  ok('有申请的档案库级删除被 RESTRICT 挡住', restrictBlocked);
  ok('RESTRICT 后档案仍在', !!db.prepare('SELECT id FROM purchase_event WHERE id = ?').get(eid1));

  // ---------- 14.5 删除：档案删除权限矩阵 + 超管强删任意状态申请 ----------
  // 14.5.1 档案删除：路人/非建档 leader 403；有申请 409（带数量）；建档者删空档案 200，重复删 404
  got = await expect(`/purchase/events/${eid4}`, 403, { method: 'DELETE', token: tC });
  ok('路人删除档案 403', got.ok);
  got = await expect(`/purchase/events/${eid2}`, 403, { method: 'DELETE', token: tA });
  ok('非建档者的负责人不能删档案 403', got.ok);
  got = await expect(`/purchase/events/${eid1}`, 409, { method: 'DELETE', token: tL });
  ok('建档者删有申请的档案 409 + 提示申请数量', got.ok && /2\s*条/.test(got.data.error || ''), got.data);
  const dev = await api(`/purchase/events/${eid4}`, { method: 'DELETE', token: tB });
  ok('建档者删除空档案 200', !!dev.message);
  got = await expect(`/purchase/events/${eid4}`, 404, { method: 'DELETE', token: tB });
  ok('重复删除档案 404', got.ok);
  ok('档案删除后审批人配置随级联清空',
    db.prepare('SELECT COUNT(*) AS n FROM purchase_event_approver WHERE event_id = ?').get(eid4).n === 0);

  // 14.5.2 超管（DB 直改提权；session 每请求重查用户行，旧 token 即时生效）强删他人「已传发票」申请
  const uidC = Number(rC.user.id);
  db.prepare('UPDATE user SET is_admin=1, admin_perms=NULL WHERE id=?').run(uidC);
  ok('ridA 删除前附件目录存在（购买截图+补传发票）', existsSync(join(PURCHASE_UP, String(ridA))));
  const da = await api(`/purchase/requests/${ridA}`, { method: 'DELETE', token: tC });
  ok('超管强删他人已传发票申请 200', /删除/.test(da.message || ''), da);
  ok('强删后申请整目录清盘', !existsSync(join(PURCHASE_UP, String(ridA))));
  const zeroA = db.prepare(
    `SELECT (SELECT COUNT(*) FROM purchase_request WHERE id=?) AS rq,
            (SELECT COUNT(*) FROM purchase_item WHERE request_id=?) AS it,
            (SELECT COUNT(*) FROM purchase_file WHERE request_id=?) AS f,
            (SELECT COUNT(*) FROM purchase_approval_log WHERE request_id=?) AS lg`
  ).get(ridA, ridA, ridA, ridA);
  ok('强删 DB 级联：申请/明细/附件/轨迹全 0', zeroA.rq === 0 && zeroA.it === 0 && zeroA.f === 0 && zeroA.lg === 0);
  await api(`/purchase/events/${eid2}`, { method: 'DELETE', token: tC });
  ok('超管删除空档案 200', !db.prepare('SELECT id FROM purchase_event WHERE id=?').get(eid2));
  db.prepare('UPDATE user SET is_admin=0, admin_perms=NULL WHERE id=?').run(uidC);

  // ---------- 15. 清理：盘 → 人(级联) → 剩余冒烟档案（带申请的 eid1 与空的 eid3 仍需库清） ----------
  for (const rid of createdRids) rmSync(join(PURCHASE_UP, String(rid)), { recursive: true, force: true });
  const emails = ['l', 't', 'a', 'b', 'c', 'u'].map(mkEmail);
  const users = db.prepare('SELECT id FROM user WHERE email IN (?,?,?,?,?,?)').all(...emails);
  for (const u of users) db.prepare('DELETE FROM user WHERE id = ?').run(u.id);
  const evDel = db.prepare("DELETE FROM purchase_event WHERE name LIKE '采购冒烟%'").run();
  db.close();
  ok(`清理测试用户 ×${users.length} 与冒烟档案 ×${evDel.changes}`, users.length === 6 && evDel.changes >= 2);
} catch (e) {
  fail++;
  console.log(`❌ 异常中断: ${e.stack || e.message}`);
} finally {
  try { db?.close(); } catch {}
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过（上游限流，非代码缺陷）` : ''}`);
process.exit(fail ? 1 : 0);
