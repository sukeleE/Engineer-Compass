// 报销整理模块冒烟：owner 建项目/队伍/名单 → 匿名只读 → 认领矩阵(404/409/403) →
// 成员只能建自己名下(服务端注入/跨队403/prop购买人403) → 附件 上传替换/内联PDF/强制附件.html/越权403 →
// 改名同步 owner_name+prop购买人 → 重置认领旧token失效 → 统一支付(范围三态/项目级行仅负责人·范围放开子集留空)
// 帮付三字段已删(旧键被白名单丢弃) + ⑥零散票据仅项目级区(队行400) → 统一支付行附件每槽可多份(单人行仍替换) → 截止 403 →
// zip(含 team_id=0 全项目/06零散票据)/xlsx(=SUM 六列/注入转义/全项目统一支付独立 sheet) → 四级删除级联清盘
// → 清理测试用户（DatabaseSync + fs.rmSync 自清理，process.exit(fail?1:0)）
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const BASE = 'http://localhost:3000/api';
const UP = 'D:\\desktop\\竞赛指导\\backend\\uploads\\expense';
const DB_PATH = 'D:\\desktop\\竞赛指导\\backend\\data\\compass.db';

const jsonReq = async (path, opts = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers || {}) };
  const res = await fetch(BASE + path, {
    headers, method: opts.method || 'GET',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
};
// 直接拿 Response（下载/字节对比用）
const rawReq = async (path, opts = {}) => {
  const headers = { ...(opts.headers || {}) };
  if (opts.ct) headers['Content-Type'] = opts.ct;
  const res = await fetch(BASE + path, { headers, method: opts.method || 'GET', body: opts.body });
  return res;
};
// 期望 ok 的调用：非 2xx 直接抛错（fail+1）
const api = async (path, opts = {}) => {
  const { res, data } = await jsonReq(path, opts);
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
};
const expect = async (path, status, opts = {}) => {
  const { res, data } = await jsonReq(path, opts);
  return { ok: res.status === status, got: res.status, data };
};

const stamp = Date.now().toString().slice(-8);
const EA = `exp_a_${stamp}@test.dev`, EB = `exp_b_${stamp}@test.dev`;
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}`)); };

// ===== 实体 id 变量（跨阶段引用） =====
let P = 0, C = '', t1 = 0, t2 = 0, midWang = 0, midLi = 0, midZhao = 0, mSelfId = 0;
let M1 = '', M2 = '';                 // 王小明 / 李小华2 的认领 token
let ridTrain = 0, ridHotel = 0, ridMail = 0, ridPropLi = 0;
let ridProj = 0; // 全项目统一支付（项目级行）
let fidPdf = 0, fidPdf2 = 0, fidHtml = 0;

try {
  // ---------- 0. 注册：owner A + 无关用户 B ----------
  const ra = await api('/auth/register', { method: 'POST', body: { email: EA, password: 'pass123456', nickname: '报销负责人' } });
  const rb = await api('/auth/register', { method: 'POST', body: { email: EB, password: 'pass123456', nickname: '无关用户' } });
  ok('注册两用户', ra.token && rb.token);
  const ta = ra.token, tb = rb.token;
  const uidA = Number(ra.user.id), uidB = Number(rb.user.id);

  // ---------- 1. owner 建项目 / 列表 ----------
  let got = await expect('/expense', 401, { method: 'POST', body: { name: '冒烟报销' } });
  ok('未登录不能建项目(401)', got.ok);
  const proj = await api('/expense', { method: 'POST', token: ta, body: { name: '报销冒烟', event: '电子设计大赛' } });
  P = Number(proj.id); C = proj.code;
  ok('建项目返回 8 位邀请码', /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(C) && proj.status === 'open');
  const list = await api('/expense', { token: ta });
  const mine = list.find((x) => Number(x.id) === P);
  ok('项目列表含概览计数=0', mine && mine.team_count === 0 && mine.row_count === 0 && mine.member_count === 0);

  // ---------- 2. 匿名只读 / 假码 ----------
  got = await expect(`/expense/o/${C}`, 200);
  ok('匿名可只读项目', got.ok && got.data.me.role === 'guest' && got.data.project.name === '报销冒烟' && got.data.rows.length === 0);
  got = await expect(`/expense/o/ZZZZZZZZ`, 404);
  ok('假邀请码 404', got.ok);

  // ---------- 3. 队伍 / 名单 ----------
  const tm1 = await api(`/expense/${P}/team`, { method: 'POST', token: ta, body: { name: '先锋队' } });
  const tm2 = await api(`/expense/${P}/team`, { method: 'POST', token: ta, body: { name: '凌云队' } });
  t1 = Number(tm1.id); t2 = Number(tm2.id);
  got = await expect(`/expense/${P}/team`, 409, { method: 'POST', token: ta, body: { name: '先锋队' } });
  ok('同名队伍 409', got.ok);
  const m1 = await api(`/expense/${P}/team/${t1}/member`, { method: 'POST', token: ta, body: { name: '王小明' } });
  const m2 = await api(`/expense/${P}/team/${t1}/member`, { method: 'POST', token: ta, body: { name: '李小华' } });
  const m3 = await api(`/expense/${P}/team/${t2}/member`, { method: 'POST', token: ta, body: { name: '赵大强' } });
  midWang = Number(m1.id); midLi = Number(m2.id); midZhao = Number(m3.id);
  got = await expect(`/expense/${P}/team/${t1}/member`, 409, { method: 'POST', token: ta, body: { name: '王小明' } });
  ok('项目内同名成员 409', got.ok);

  // ---------- 4. 他人无权操作 ----------
  for (const [m, pth] of [['GET', `/expense/${P}`], ['PATCH', `/expense/${P}`], ['DELETE', `/expense/${P}`]]) {
    got = await expect(pth, 403, { method: m, token: tb });
    ok(`无关用户 ${m} 项目被拒 403`, got.ok);
  }

  // ---------- 5. owner 建各类行 ----------
  // 起止日期 = 日历精确到日（YYYY-MM-DD）：车票出发/到达、住宿入住/退房
  // 是否已付款=已删的帮付三件套之一：样本故意携带旧键，断言服务端白名单丢弃不落库
  const dTrain = { 出发时间: '2026-07-15', 到达时间: '2026-07-16', 出发地: '北京', 到达地: '上海', 座位等级: '二等座', 金额: 553.5, 是否已付款: '是', 备注: '' };
  const row1 = await api(`/expense/o/${C}/row`, { method: 'POST', token: ta, body: { team_id: t1, category: 'train', owner_name: '王小明', data: dTrain } });
  ridTrain = Number(row1.row.id);
  ok('owner 建车票行(出发/到达日期往返；是否已付款键被丢弃)', row1.row.owner_name === '王小明' && row1.row.data.金额 === 553.5 && !row1.row.atts.length
    && row1.row.data.出发时间 === '2026-07-15' && row1.row.data.到达时间 === '2026-07-16' && row1.row.data.是否已付款 === undefined);
  const row2 = await api(`/expense/o/${C}/row`, { method: 'POST', token: ta, body: { team_id: t1, category: 'hotel', owner_name: '李小华', data: { 酒店名称: '如家', 房号: '801', 入住日期: '2026-07-20', 退房日期: '2026-07-22', 实付金额: 320, 是否帮付: '是', 帮付人: '王小明', 备注: '' } } });
  ridHotel = Number(row2.row.id);
  ok('owner 建住宿行(帮付键已删不落库；入住/退房日期往返)', row2.warnings.length === 0 && row2.row.data.入住日期 === '2026-07-20' && row2.row.data.退房日期 === '2026-07-22' && row2.row.data.帮付人 === undefined);
  const rowWarn = await api(`/expense/o/${C}/row`, { method: 'POST', token: ta, body: { team_id: t1, category: 'reg', owner_name: '王小明', data: { 金额: 200, 是否帮付: '是', 帮付人: '', 备注: '' } } });
  ok('携带旧帮付键提交 → 无软警告(规则随字段删除)', rowWarn.warnings.length === 0 && rowWarn.row.data.是否帮付 === undefined);
  const rowMail = await api(`/expense/o/${C}/row`, { method: 'POST', token: ta, body: { team_id: t1, category: 'mail', owner_name: '王小明', data: { 金额: 12, 备注: '=1+1' } } });
  ridMail = Number(rowMail.row.id);
  ok('mail 行(备注含 =1+1 注入样本)', rowMail.row.data.备注 === '=1+1');
  const rowPT = await api(`/expense/o/${C}/row`, { method: 'POST', token: ta, body: { team_id: t1, category: 'prop', owner_name: '队伍', data: { 购买人: '队伍', 物品名称: '胶带', 金额: 45.6, 是否日常家用: '否', 备注: '' } } });
  ok('owner 建公用耗材行(队伍)', rowPT.row.owner_name === '队伍' && rowPT.row.data.购买人 === '队伍');
  const rowPL = await api(`/expense/o/${C}/row`, { method: 'POST', token: ta, body: { team_id: t1, category: 'prop', owner_name: '李小华', data: { 购买人: '李小华', 物品名称: '剪刀', 金额: 8.8, 是否日常家用: '否', 备注: '' } } });
  ridPropLi = Number(rowPL.row.id);
  ok('owner 建李小华耗材行', rowPL.row.data.购买人 === '李小华');
  got = await expect(`/expense/o/${C}/row`, 400, { method: 'POST', token: ta, body: { team_id: t1, category: 'prop', owner_name: '不存在的人', data: { 购买人: '不存在的人', 物品名称: 'x', 金额: 1 } } });
  ok('归属非名单成员 400', got.ok);
  got = await expect(`/expense/o/${C}/row`, 400, { method: 'POST', token: ta, body: { team_id: t1, category: 'nope', data: {} } });
  ok('非法类别 400', got.ok);
  const pay = await api(`/expense/${P}`, { token: ta });
  ok('owner payload: me=owner 名单未认领', pay.me.role === 'owner' && pay.members.every((m) => !m.claimed));

  // ---------- 6. 认领矩阵 ----------
  got = await expect(`/expense/o/${C}/claim`, 404, { method: 'POST', body: { name: '路人甲' } });
  ok('名单外认领 404', got.ok);
  got = await expect(`/expense/o/${C}/claim`, 400, { method: 'POST', body: { name: '' } });
  ok('空姓名认领 400', got.ok);
  const cl1 = await api(`/expense/o/${C}/claim`, { method: 'POST', body: { name: '王小明' } });
  M1 = cl1.token;
  ok('王小明认领得 token', /^[0-9a-f]{32}$/.test(M1) && cl1.member.name === '王小明');
  got = await expect(`/expense/o/${C}/claim`, 409, { method: 'POST', body: { name: '王小明' } });
  ok('重复认领 409', got.ok);
  const cl2 = await api(`/expense/o/${C}/claim`, { method: 'POST', body: { name: '李小华' } });
  M2 = cl2.token;
  const me1 = await api(`/expense/o/${C}`, { headers: { 'X-Claim-Token': M1 } });
  ok('带 token 读取 me=member', me1.me.role === 'member' && me1.me.member.name === '王小明');
  const wm = me1.members.find((m) => m.name === '王小明');
  ok('名单 chips: claimed/rowCount=3/me', wm.claimed === true && wm.rowCount === 3 && wm.me === true);
  const li = me1.members.find((m) => m.name === '李小华');
  ok('他人认领态只读可见', li.claimed === true && li.rowCount === 2 && li.me === false);

  // ---------- 7. member 写权限矩阵 ----------
  got = await expect(`/expense/o/${C}/row`, 403, { method: 'POST', body: { team_id: t1, category: 'reg', data: { 金额: 1 } } });
  ok('匿名建行 403(先认领)', got.ok);
  const fakeOwn = await api(`/expense/o/${C}/row`, { method: 'POST', headers: { 'X-Claim-Token': M1 }, body: { team_id: t1, category: 'reg', owner_name: '赵大强', data: { 金额: 66.6, 是否帮付: '否', 帮付人: '', 备注: '' } } });
  ok('成员建行归属被服务端注入本人(伪冒无效)', fakeOwn.row.owner_name === '王小明' && fakeOwn.row.data.金额 === 66.6);
  const ridOwn = Number(fakeOwn.row.id);
  got = await expect(`/expense/o/${C}/row`, 403, { method: 'POST', headers: { 'X-Claim-Token': M1 }, body: { team_id: t2, category: 'reg', data: { 金额: 1 } } });
  ok('跨队建行 403', got.ok);
  got = await expect(`/expense/o/${C}/row`, 403, { method: 'POST', headers: { 'X-Claim-Token': M1 }, body: { team_id: t1, category: 'prop', data: { 购买人: '队伍', 物品名称: '公用', 金额: 1 } } });
  ok('成员建 prop 公用行(购买人=队伍) 403', got.ok);
  got = await expect(`/expense/o/${C}/row`, 403, { method: 'POST', headers: { 'X-Claim-Token': M1 }, body: { team_id: t1, category: 'prop', data: { 购买人: '李小华', 物品名称: '替买', 金额: 1 } } });
  ok('成员 prop 购买人≠本人 403', got.ok);
  const ownProp = await api(`/expense/o/${C}/row`, { method: 'POST', headers: { 'X-Claim-Token': M1 }, body: { team_id: t1, category: 'prop', data: { 购买人: '王小明', 物品名称: '电池', 金额: 12, 是否日常家用: '否', 备注: '' } } });
  ok('成员建自己 prop 行 201', ownProp.row.data.购买人 === '王小明');
  got = await expect(`/expense/o/${C}/row/${ridHotel}`, 403, { method: 'PUT', headers: { 'X-Claim-Token': M1 }, body: { data: { 酒店名称: 'x', 房号: '1', 实付金额: 1, 是否帮付: '', 帮付人: '', 备注: '' } } });
  ok('改他人(李小华)行 403', got.ok);
  got = await expect(`/expense/o/${C}/row/${ridHotel}`, 403, { method: 'DELETE', headers: { 'X-Claim-Token': M1 } });
  ok('删他人行 403', got.ok);
  const upd = await api(`/expense/o/${C}/row/${ridTrain}`, { method: 'PUT', headers: { 'X-Claim-Token': M1 }, body: { data: { ...dTrain, 到达地: '杭州' } } });
  ok('成员改自己名下行 200(类别/归属不变)', upd.row.owner_name === '王小明' && upd.row.data.到达地 === '杭州');
  const delOwn = await api(`/expense/o/${C}/row/${ridOwn}`, { method: 'DELETE', headers: { 'X-Claim-Token': M1 } });
  ok('成员删自己刚建的行', delOwn.message.includes('删除'));

  // ---------- 8. 附件：上传 / 替换 / 内联 / 强制附件 / 越权 ----------
  const pdfBytes = Buffer.from('PDF-X1-发票样本\n');
  const upload = async (rid, slot, name, buf, token) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf]), name);
    return rawReq(`/expense/o/${C}/row/${rid}/file?slot=${slot}`, { method: 'POST', headers: token ? { 'X-Claim-Token': token } : {}, ct: undefined, body: fd });
  };
  got = await expect(`/expense/o/${C}/row/${ridTrain}/file?slot=invoice`, 403, { method: 'POST' });
  ok('匿名上传 403(不落盘)', got.ok);
  got = await expect(`/expense/o/${C}/row/${ridTrain}/file?slot=nope`, 400, { method: 'POST', headers: { 'X-Claim-Token': M1 } });
  ok('非法槽位 400(身份校验通过后)', got.got === 400);
  const u1 = await upload(ridTrain, 'invoice', '火车发票.pdf', pdfBytes, M1);
  ok('成员上传发票 PDF 201', u1.status === 201);
  const att1 = await u1.json(); fidPdf = Number(att1.att.id);
  const uHtml = await upload(ridTrain, 'payProof', '截图.html', Buffer.from('<html>x</html>'), M1);
  const attHtml = await uHtml.json(); fidHtml = Number(attHtml.att.id);
  ok('.html 上传成功(存为 octet-stream)', attHtml.att.mime === 'application/octet-stream');
  // 替换同槽位
  const pdfBytes2 = Buffer.from('PDF-X2-发票新版本\n');
  const u2 = await upload(ridTrain, 'invoice', '火车发票.pdf', pdfBytes2, M1);
  const att2 = await u2.json(); fidPdf2 = Number(att2.att.id);
  ok('同槽位重传=替换(新 fid)', u2.status === 201 && fidPdf2 !== fidPdf);
  // 下载：内联 PDF 字节一致；旧 fid 404；?dl=1 强制附件；.html 一律附件
  const g1 = await rawReq(`/expense/o/${C}/file/${fidPdf2}/download`);
  const g1b = Buffer.from(await g1.arrayBuffer());
  ok('PDF 内联下载字节一致', g1.status === 200 && (g1.headers.get('content-type') || '').startsWith('application/pdf') && g1b.equals(pdfBytes2));
  got = await expect(`/expense/o/${C}/file/${fidPdf}/download`, 404);
  ok('被替换的旧附件 404', got.ok);
  const g2 = await rawReq(`/expense/o/${C}/file/${fidPdf2}/download?dl=1`);
  ok('?dl=1 强转 attachment', (g2.headers.get('content-disposition') || '').startsWith('attachment'));
  const g3 = await rawReq(`/expense/o/${C}/file/${fidHtml}/download`);
  const g3b = Buffer.from(await g3.arrayBuffer());
  ok('.html 非白名单 → 强制 attachment 下载(字节一致)', (g3.headers.get('content-disposition') || '').startsWith('attachment') && g3b.equals(Buffer.from('<html>x</html>')));
  got = await expect(`/expense/o/${C}/row/${ridTrain}/file?slot=invoice`, 403, { method: 'POST', headers: { 'X-Claim-Token': M2 } });
  ok('他人在自己行上上传 403', got.ok);

  // ---------- 9. 改名同步 owner_name + prop 购买人 ----------
  const rn = await api(`/expense/member/${midLi}`, { method: 'PATCH', token: ta, body: { name: '李小华2' } });
  ok('成员改名 200', rn.name === '李小华2');
  const after = await api(`/expense/o/${C}`, { headers: { 'X-Claim-Token': M2 } });
  const hR = after.rows.find((x) => x.id === ridHotel);
  const pR = after.rows.find((x) => x.id === ridPropLi);
  ok('改名同步住宿行 owner_name', hR.owner_name === '李小华2');
  ok('改名同步 prop 行 owner_name+购买人', pR.owner_name === '李小华2' && pR.data.购买人 === '李小华2');
  const tR = after.rows.find((x) => x.id === ridTrain);
  ok('他人行不受改名影响', tR.owner_name === '王小明');
  ok('旧 token 认领身份跟随改名', after.me.role === 'member' && after.me.member.name === '李小华2');
  got = await expect(`/expense/o/${C}/claim`, 409, { method: 'POST', body: { name: '李小华' } });
  ok('改名后旧姓名不可再认领(项目内无此名 → 404 才对)', got.got === 404);

  // ---------- 10. 重置认领：旧 token 立即失效 ----------
  await api(`/expense/member/${midLi}/reset-claim`, { method: 'POST', token: ta });
  got = await expect(`/expense/o/${C}/row`, 403, { method: 'POST', headers: { 'X-Claim-Token': M2 }, body: { team_id: t1, category: 'reg', data: { 金额: 5 } } });
  ok('重置认领后旧 token 建行 403', got.ok);
  const cl3 = await api(`/expense/o/${C}/claim`, { method: 'POST', body: { name: '李小华2' } });
  M2 = cl3.token;
  ok('重置后可重新认领', /^[0-9a-f]{32}$/.test(M2));

  // ---------- 11. ZIP（按队）+ 空队 404 ----------
  const zipRes = await rawReq(`/expense/o/${C}/export/zip?team_id=${t1}`);
  const zip = Buffer.from(await zipRes.arrayBuffer());
  ok('ZIP 下载(store) 头部 PK\\x03\\x04', zipRes.status === 200 && zip.slice(0, 4).toString('latin1') === 'PK\x03\x04');
  ok('ZIP 含队伍中文条目名与原件名', zip.includes(Buffer.from('02车票')) && zip.includes(Buffer.from('火车发票.pdf')));
  ok('ZIP Content-Disposition filename* 中文', (zipRes.headers.get('content-disposition') || '').includes("filename*=UTF-8''"));
  got = await expect(`/expense/o/${C}/export/zip?team_id=${t2}`, 404);
  ok('无附件队伍 ZIP 404', got.ok);

  // ---------- 11.5 统一支付（一人垫付多人/全部；行仍记出钱人名下） ----------
  const payRow = await api(`/expense/o/${C}/row`, { method: 'POST', token: ta, body: { team_id: t1, category: 'reg', owner_name: '王小明', data: { 金额: 400, 是否帮付: '否', 帮付人: '', 备注: '全队报名费统一缴纳', 统一支付范围: '全部成员' } } });
  ok('owner 建统一支付行(全部成员)', payRow.row.owner_name === '王小明' && payRow.row.data['统一支付范围'] === '全部成员' && payRow.row.data.金额 === 400);
  const payNamed = await api(`/expense/o/${C}/row`, { method: 'POST', token: ta, body: { team_id: t1, category: 'reg', owner_name: '李小华2', data: { 金额: 88, 是否帮付: '否', 帮付人: '', 备注: '', 统一支付范围: '李小华2、王小明' } } });
  ok('统一支付范围=分隔名单(覆盖多选)', payNamed.row.data['统一支付范围'] === '李小华2、王小明' && payNamed.row.owner_name === '李小华2');
  const payProj = await api(`/expense/o/${C}/row`, { method: 'POST', token: ta, body: { team_id: t1, category: 'reg', owner_name: '王小明', data: { 金额: 999, 是否帮付: '否', 帮付人: '', 备注: '全项目报名费一人统一缴纳', 统一支付范围: '全体成员' } } });
  ok('统一支付可覆盖整个项目(全体成员)', payProj.row.data['统一支付范围'] === '全体成员' && payProj.row.data.金额 === 999);
  const payCross = await api(`/expense/o/${C}/row`, { method: 'POST', token: ta, body: { team_id: t1, category: 'reg', owner_name: '李小华2', data: { 金额: 55, 是否帮付: '否', 帮付人: '', 备注: '', 统一支付范围: '赵大强、王小明' } } });
  ok('统一支付范围可跨队(他队成员也须在本项目名单)', payCross.row.data['统一支付范围'] === '赵大强、王小明' && payCross.row.data.金额 === 55);
  got = await expect(`/expense/o/${C}/row`, 400, { method: 'POST', token: ta, body: { team_id: t1, category: 'reg', owner_name: '王小明', data: { 金额: 1, 统一支付范围: '路人甲' } } });
  ok('统一支付含非名单成员 400', got.ok);

  // ---------- 11.6 全项目统一支付（项目级行 team_id=空：独立区块、仅负责人；2026-09-03 范围放开：
  // 不再强制'全体成员' —— 可勾选子集(跨队)或留空；本队语义'全部成员' 400 拒绝） ----------
  got = await expect(`/expense/o/${C}/row`, 400, { method: 'POST', token: ta, body: { project_pay: true, category: 'reg', owner_name: '王小明', data: { 金额: 1, 统一支付范围: '全部成员' } } });
  ok('项目级行拒绝本队语义"全部成员" 400', got.ok);
  const pproj1 = await api(`/expense/o/${C}/row`, { method: 'POST', token: ta, body: { project_pay: true, category: 'reg', owner_name: '王小明', data: { 金额: 1234.56, 备注: '全员报名费一人缴纳', 统一支付范围: '王小明、赵大强' } } });
  ridProj = Number(pproj1.row.id);
  ok('负责人建项目级行：勾选子集原样保存(跨队，不强制全体)', pproj1.row.team_id === null && pproj1.row.data['统一支付范围'] === '王小明、赵大强' && Number(pproj1.row.data.金额) === 1234.56 && pproj1.row.owner_name === '王小明');
  const pproj2 = await api(`/expense/o/${C}/row`, { method: 'POST', token: ta, body: { project_pay: true, category: 'reg', owner_name: '赵大强', data: { 金额: 66.6, 备注: '项目级出钱人可跨队' } } });
  ok('项目级行范围可留空保存 + 出钱人可跨队', pproj2.row.team_id === null && pproj2.row.owner_name === '赵大强' && pproj2.row.data['统一支付范围'] === '');
  got = await expect(`/expense/o/${C}/row`, 400, { method: 'POST', token: ta, body: { project_pay: true, category: 'reg', owner_name: '路人甲', data: { 金额: 1 } } });
  ok('项目级行出钱人非名单成员/非负责人本人 400', got.ok);
  got = await expect(`/expense/o/${C}/row`, 403, { method: 'POST', headers: { 'X-Claim-Token': M1 }, body: { project_pay: true, category: 'reg', owner_name: '王小明', data: { 金额: 1 } } });
  ok('成员建项目级行 403(仅负责人可录入)', got.ok);
  got = await expect(`/expense/o/${C}/row`, 403, { method: 'POST', body: { project_pay: true, category: 'reg', owner_name: '王小明', data: { 金额: 1 } } });
  ok('访客建项目级行 403', got.ok);
  got = await expect(`/expense/o/${C}/row/${ridProj}`, 403, { method: 'PUT', headers: { 'X-Claim-Token': M1 }, body: { data: { 金额: 1 } } });
  ok('成员改项目级行 403(哪怕行挂自己名下)', got.ok);
  const pUpd = await api(`/expense/o/${C}/row/${ridProj}`, { method: 'PUT', token: ta, body: { data: { 金额: 2000, 备注: '改后', 统一支付范围: '赵大强、王小明' } } });
  ok('负责人改项目级行：范围子集原样保存(不被改成全体成员)', pUpd.row.data['统一支付范围'] === '赵大强、王小明' && Number(pUpd.row.data.金额) === 2000 && pUpd.row.team_id === null);
  // 项目级附件 + 全项目 ZIP(team_id=0)（owner 上传走 Authorization，member 用的 X-Claim-Token 会 403）
  const fdP = new FormData();
  fdP.append('file', new Blob([pdfBytes]), '全员报名费发票.pdf');
  const uProjRes = await rawReq(`/expense/o/${C}/row/${ridProj}/file?slot=invoice`, { method: 'POST', headers: { Authorization: `Bearer ${ta}` }, body: fdP });
  ok('项目级行上传附件(负责人) 201', uProjRes.status === 201);
  const pZipRes = await rawReq(`/expense/o/${C}/export/zip?team_id=0`);
  const pZip = Buffer.from(await pZipRes.arrayBuffer());
  ok('全项目 ZIP(team_id=0) 200 且含项目级条目', pZipRes.status === 200 && pZip.slice(0, 4).toString('latin1') === 'PK\x03\x04'
    && pZip.includes(Buffer.from('01报名费')) && pZip.includes(Buffer.from('全员报名费发票.pdf')));

  // ---------- 11.7 ⑥零散票据（仅全项目统一支付区；票据名称+金额选填+涵盖的人快照；附件=票据文件本身） ----------
  got = await expect(`/expense/o/${C}/row`, 400, { method: 'POST', token: ta, body: { team_id: t1, category: 'misc', owner_name: '王小明', data: { 票据名称: 'x', 金额: 1 } } });
  ok('队伍行建 ⑥零散票据 400(仅项目级区可录)', got.ok);
  const misc1 = await api(`/expense/o/${C}/row`, { method: 'POST', token: ta, body: { project_pay: true, category: 'misc', owner_name: '赵大强', data: { 票据名称: '7-20 打车发票×3', 金额: 45.5, 备注: '三张打车票，含跨队', 统一支付范围: '赵大强、王小明' } } });
  ok('项目级建 ⑥零散票据(票据名称/金额/涵盖名单快照)', misc1.row.team_id === null && misc1.row.data.票据名称 === '7-20 打车发票×3' && Number(misc1.row.data.金额) === 45.5 && misc1.row.data['统一支付范围'] === '赵大强、王小明');
  const misc2 = await api(`/expense/o/${C}/row`, { method: 'POST', token: ta, body: { project_pay: true, category: 'misc', owner_name: '赵大强', data: { 票据名称: '报名缴费凭证存根', 金额: '', 统一支付范围: '' } } });
  ok('零散票据可空金额+空范围保存(纯存档)', misc2.row.data.金额 === '' && misc2.row.data['统一支付范围'] === '');
  const fdM = new FormData();
  fdM.append('file', new Blob([pdfBytes]), '打车票据截图.png');
  const uMiscRes = await rawReq(`/expense/o/${C}/row/${Number(misc1.row.id)}/file?slot=ticket`, { method: 'POST', headers: { Authorization: `Bearer ${ta}` }, body: fdM });
  ok('零散票据行传附件(票据/凭证槽) 201', uMiscRes.status === 201);
  const fidMisc1 = Number((await uMiscRes.json()).att.id);
  const pZip2 = await rawReq(`/expense/o/${C}/export/zip?team_id=0`);
  const pZip2b = Buffer.from(await pZip2.arrayBuffer());
  ok('全项目 ZIP 含 06零散票据 目录与票据文件', pZip2b.includes(Buffer.from('06零散票据')) && pZip2b.includes(Buffer.from('打车票据截图.png')));

  // ---------- 12. XLSX：sheet 名 / =SUM 公式 / 注入转义 ----------
  await api(`/expense/o/${C}/row`, { method: 'POST', token: ta, body: { team_id: t2, category: 'reg', owner_name: '赵大强', data: { 金额: 10, 是否帮付: '否', 帮付人: '', 备注: '' } } });
  const xRes = await rawReq(`/expense/o/${C}/export/xlsx`);
  const xbuf = Buffer.from(await xRes.arrayBuffer());
  ok('XLSX 下载 200 且为 zip 容器', xRes.status === 200 && xbuf.slice(0, 2).toString('latin1') === 'PK');
  // 解 zip（走 EOCD→中央目录，稳过 bit3 descriptor 与任意目录偏移）：读出各 XML 部件
  const unzipAll = (buf) => {
    const out = {};
    let i = buf.length - 22;
    for (; i > 0 && buf.slice(i, i + 4).toString('latin1') !== 'PK\x05\x06'; i--) { /* 找 EOCD */ }
    if (buf.slice(i, i + 4).toString('latin1') !== 'PK\x05\x06') return out;
    let cdOff = buf.readUInt32LE(i + 16);
    while (buf.slice(cdOff, cdOff + 4).toString('latin1') === 'PK\x01\x02') {
      const flags = buf.readUInt16LE(cdOff + 8);
      const method = buf.readUInt16LE(cdOff + 10);
      const csize = buf.readUInt32LE(cdOff + 20);
      const nLen = buf.readUInt16LE(cdOff + 28);
      const xLen = buf.readUInt16LE(cdOff + 30);
      const lho = buf.readUInt32LE(cdOff + 42);
      const name = buf.slice(cdOff + 46, cdOff + 46 + nLen).toString('utf8');
      // 本地头给出文件名/extra 实际长度，正文紧随其后
      const lnLen = buf.readUInt16LE(lho + 26);
      const lxLen = buf.readUInt16LE(lho + 28);
      const dataStart = lho + 30 + lnLen + lxLen;
      const data = buf.slice(dataStart, dataStart + csize);
      out[name] = method === 8 ? inflateRawSync(data) : data;
      cdOff += 46 + nLen + xLen;
      if (flags & 0x08) { /* descriptor 会紧贴压缩数据，但 dataStart 由 LFH 头定位，天然跳过 */ }
    }
    return out;
  };
  const parts = unzipAll(xbuf);
  const wbXml = parts['xl/workbook.xml']?.toString('utf8') || '';
  ok('sheet 名含 汇总/队伍/全项目统一支付/附件清单', ['汇总', '先锋队', '凌云队', '全项目统一支付', '附件清单'].every((n) => wbXml.includes(`name="${n}"`)));
  const allXml = Object.entries(parts).filter(([n]) => n.startsWith('xl/worksheets/')).map(([, v]) => v.toString('utf8')).join('\n');
  ok('工作表含 =SUM 公式', allXml.includes('<f>=SUM('));
  ok('注入值转义为 &apos;=1+1', allXml.includes("&apos;=1+1"));
  // 新布局断言：汇总 sheet = 队伍→成员 两级（标题含"垫付合计"；六类金额列 C..H、个人合计 I =SUM(C:H 本行)）
  const sumXml = Object.entries(parts).filter(([n]) => n.startsWith('xl/worksheets/'))
    .map(([, v]) => v.toString('utf8')).find((s) => s.includes('垫付合计')) || '';
  ok('汇总 sheet 两级展开(成员行×六类+个人合计公式)', /<f>=SUM\(C\d+:H\d+\)<\/f>/.test(sumXml) && sumXml.includes('<v>个人合计</v>') && sumXml.includes('<v>⑥零散票据</v>'));
  ok('汇总首队首个成员行 I3=SUM(C3:H3)', sumXml.includes('<f>=SUM(C3:H3)</f>'));
  ok('汇总含公用耗材行"队伍（公用耗材）"', sumXml.includes('队伍（公用耗材）'));
  ok('汇总含队小计/总计(队伍小计＋全项目统一支付小计)/注脚(涵盖的人见范围列)', sumXml.includes('<v>小计</v>') && sumXml.includes('总计（各队伍小计＋全项目统一支付小计）') && sumXml.includes('涵盖的人写在明细的'));
  ok('汇总含全项目统一支付独立块', sumXml.includes('全项目统一支付'));
  // detXml 命中首个以"统一支付范围"为独立表头的明细 sheet（先锋队报名费块）—— 汇总注脚虽含同词但非独立单元格
  const detXml = Object.entries(parts).filter(([n]) => n.startsWith('xl/worksheets/')).map(([, v]) => v.toString('utf8')).find((s) => s.includes('<v>统一支付范围</v>')) || '';
  ok('队明细统一支付列含 全部成员/全体成员/跨队名单 四种值', detXml.includes('<v>全部成员</v>') && detXml.includes('<v>全体成员</v>') && detXml.includes('<v>赵大强、王小明</v>') && detXml.includes('<v>李小华2、王小明</v>'));
  // 项目级行（§11.6+11.7）在导出中的呈现：独立 sheet（明细：范围子集原样 + ⑥零散票据块）+ 附件清单标"全项目统一支付"
  const projXml = Object.entries(parts).filter(([n]) => n.startsWith('xl/worksheets/')).map(([, v]) => v.toString('utf8')).find((s) => s.includes('全项目统一支付总计')) || '';
  ok('全项目统一支付 sheet：范围子集原样/⑥零散票据明细/总计公式', !!projXml && projXml.includes('<v>统一支付范围</v>') && projXml.includes('<v>赵大强、王小明</v>') && projXml.includes('<v>票据名称</v>') && projXml.includes('<v>7-20 打车发票×3</v>') && projXml.includes('<f>=SUM('));
  const attSheetXml = Object.entries(parts).filter(([n]) => n.startsWith('xl/worksheets/')).map(([, v]) => v.toString('utf8')).find((s) => s.includes('附件槽位')) || '';
  ok('附件清单标全项目统一支付行(含原件名/⑥目录类)', attSheetXml.includes('全项目统一支付') && attSheetXml.includes('全员报名费发票.pdf') && attSheetXml.includes('⑥零散票据'));

  // ---------- 11.8 统一支付行附件：每槽可多份（追加不替换；单人常规记录仍每槽一份=替换，见 §8） ----------
  // ⑥零散票据行（项目级）同槽加传第二份
  const fdM2 = new FormData();
  fdM2.append('file', new Blob([Buffer.from('PNG-打车票据2号\n')]), '打车票据2号.png');
  const uM2Res = await rawReq(`/expense/o/${C}/row/${Number(misc1.row.id)}/file?slot=ticket`, { method: 'POST', headers: { Authorization: `Bearer ${ta}` }, body: fdM2 });
  const m2a = await uM2Res.json();
  ok('⑥零散票据槽再传 = 追加(新 fid 独立)', uM2Res.status === 201 && Number(m2a.att.id) !== fidMisc1);
  const gM1 = await rawReq(`/expense/o/${C}/file/${fidMisc1}/download`);
  const gM2 = await rawReq(`/expense/o/${C}/file/${Number(m2a.att.id)}/download`);
  ok('同槽两份独立可下载(字节一致)', gM1.status === 200 && gM2.status === 200
    && Buffer.from(await gM1.arrayBuffer()).equals(pdfBytes)
    && Buffer.from(await gM2.arrayBuffer()).equals(Buffer.from('PNG-打车票据2号\n')));
  ok('槽位目录两份并存(不互替)', readdirSync(`${UP}\\${C}\\${Number(misc1.row.id)}\\ticket`).length === 2);
  // 队伍内统一支付行（范围=全体成员）：发票槽连传三份全保留（覆盖"统一支付也能传多件所需附件"）
  let fdN = 0;
  for (const nm of ['报名费发票-第一批.pdf', '报名费发票-第二批.pdf', '报名费发票-第三批.pdf']) {
    const fdX = new FormData();
    fdX.append('file', new Blob([pdfBytes]), nm);
    const ux = await rawReq(`/expense/o/${C}/row/${Number(payProj.row.id)}/file?slot=invoice`, { method: 'POST', headers: { Authorization: `Bearer ${ta}` }, body: fdX });
    fdN += ux.status === 201 ? 1 : 0;
  }
  ok('统一支付行(全体成员)发票槽连传三份全保留', fdN === 3 && readdirSync(`${UP}\\${C}\\${Number(payProj.row.id)}\\invoice`).length === 3);
  // 逐份删除：删 ⑥ 第一份，同槽另一份不受影响
  const dM = await rawReq(`/expense/o/${C}/row/${Number(misc1.row.id)}/file/${fidMisc1}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ta}` } });
  ok('多份中删其一 200', dM.status === 200);
  got = await expect(`/expense/o/${C}/file/${fidMisc1}/download`, 404);
  ok('被删那份 404(同槽其他份仍在)', got.ok);
  const gM2b = await rawReq(`/expense/o/${C}/file/${Number(m2a.att.id)}/download`);
  ok('同槽剩余那份仍可下载', gM2b.status === 200);
  ok('删除后槽位目录剩 1 份', readdirSync(`${UP}\\${C}\\${Number(misc1.row.id)}\\ticket`).length === 1);

  // ---------- 12.6 负责人同时是队员（is_owner 条目）：登录占用、他人不可认领、防伪冒 ----------
  // owner A 昵称='报销负责人'：自加名单同名 → 自动标 is_owner（项目内互斥）
  const mSelf = await api(`/expense/${P}/team/${t1}/member`, { method: 'POST', token: ta, body: { name: '报销负责人' } });
  mSelfId = Number(mSelf.id);
  ok('负责人自加名单(姓名=本人昵称) → 自动标 is_owner', mSelf.is_owner === 1);
  let ownP = await api(`/expense/${P}`, { token: ta });
  let selfM = ownP.members.find((m) => m.name === '报销负责人');
  ok('payload: is_owner 条目 claimed+me+isOwner；owner me.member=本人', !!selfM && selfM.isOwner === true && selfM.claimed === true && selfM.me === true
    && ownP.me.role === 'owner' && ownP.me.member?.name === '报销负责人');
  got = await expect(`/expense/o/${C}/claim`, 403, { method: 'POST', body: { name: '报销负责人' } });
  ok('匿名认领负责人名 403(登录占用)', got.ok);
  got = await expect(`/expense/o/${C}/claim`, 403, { method: 'POST', headers: { 'X-Claim-Token': M1 }, body: { name: '报销负责人' } });
  ok('已认领队员代领负责人名 403(防伪冒)', got.ok);
  // 防伪冒实证：成员(王小明)改/删负责人名下个人行 → 403
  const rSelf = await api(`/expense/o/${C}/row`, { method: 'POST', token: ta, body: { team_id: t1, category: 'train', owner_name: '报销负责人', data: { ...dTrain, 出发地: '广州' } } });
  ok('负责人录入自己的个人行(归属本人 is_owner 名)', rSelf.row.owner_name === '报销负责人' && Number(rSelf.row.data.金额) === 553.5);
  got = await expect(`/expense/o/${C}/row/${Number(rSelf.row.id)}`, 403, { method: 'PUT', headers: { 'X-Claim-Token': M1 }, body: { data: { ...dTrain } } });
  ok('队员改负责人名下个人行 403(防伪冒)', got.ok);
  got = await expect(`/expense/o/${C}/row/${Number(rSelf.row.id)}`, 403, { method: 'DELETE', headers: { 'X-Claim-Token': M1 } });
  ok('队员删负责人名下个人行 403(防伪冒)', got.ok);
  got = await expect(`/expense/member/${mSelfId}/reset-claim`, 400, { method: 'POST', token: ta });
  ok('负责人条目 reset-claim 400(登录占用无 token 可重置)', got.ok);
  // 取消标记 → 回到可认领池（他人可认领 201）；重新标记 → 收回 token（旧 token 立即失效、认领再 403）
  await api(`/expense/member/${mSelfId}`, { method: 'PATCH', token: ta, body: { is_owner: false } });
  ownP = await api(`/expense/${P}`, { token: ta });
  ok('取消标记后条目回到未认领(普通队员)', ownP.members.find((m) => m.name === '报销负责人').isOwner === false
    && ownP.members.find((m) => m.name === '报销负责人').claimed === false);
  const claimSelf = await api(`/expense/o/${C}/claim`, { method: 'POST', body: { name: '报销负责人' } });
  ok('取消标记后他人可认领该名 201', /^[0-9a-f]{32}$/.test(claimSelf.token));
  await api(`/expense/member/${mSelfId}`, { method: 'PATCH', token: ta, body: { is_owner: true } });
  ownP = await api(`/expense/${P}`, { token: ta });
  selfM = ownP.members.find((m) => m.name === '报销负责人');
  ok('重新标记 → 占用并收回已被认领的 token', selfM.isOwner === true && selfM.claimed === true);
  got = await expect(`/expense/o/${C}`, 200, { headers: { 'X-Claim-Token': claimSelf.token } });
  ok('被收回 token 立即失效(回落 guest)', got.ok && got.data.me.role === 'guest');
  got = await expect(`/expense/o/${C}/claim`, 403, { method: 'POST', body: { name: '报销负责人' } });
  ok('重新标记后认领再次 403', got.ok);

  // ---------- 13. 截止：成员禁写、owner 可改、读/下载开放 ----------
  await api(`/expense/${P}`, { method: 'PATCH', token: ta, body: { status: 'closed' } });
  got = await expect(`/expense/o/${C}/row`, 403, { method: 'POST', headers: { 'X-Claim-Token': M1 }, body: { team_id: t1, category: 'reg', data: { 金额: 5 } } });
  ok('截止后成员建行 403', got.ok);
  got = await expect(`/expense/o/${C}/row/${ridTrain}`, 403, { method: 'PUT', headers: { 'X-Claim-Token': M1 }, body: { data: { ...dTrain } } });
  ok('截止后成员改行 403', got.ok);
  const ownerUpd = await api(`/expense/o/${C}/row/${ridTrain}`, { method: 'PUT', token: ta, body: { data: { ...dTrain, 到达地: '上海' } } });
  ok('截止后 owner 仍可改(纠错通道)', ownerUpd.row.data.到达地 === '上海');
  got = await expect(`/expense/o/${C}`, 200);
  ok('截止后只读仍开放(状态可见)', got.data.project.status === 'closed');
  const zip2 = await rawReq(`/expense/o/${C}/export/zip?team_id=${t1}`);
  ok('截止后附件下载仍开放', zip2.status === 200);
  await api(`/expense/${P}`, { method: 'PATCH', token: ta, body: { status: 'open' } });
  const again = await api(`/expense/o/${C}/row`, { method: 'POST', headers: { 'X-Claim-Token': M1 }, body: { team_id: t1, category: 'reg', data: { 金额: 3.14, 是否帮付: '否', 帮付人: '', 备注: '' } } });
  ok('重开后成员可建行', Number(again.row.data.金额) === 3.14);
  const disk1 = readdirSync(`${UP}\\${C}\\${ridTrain}\\invoice`);
  ok('上传目录只剩新文件(替换清旧)', disk1.length === 1);

  // ---------- 14. 四级删除级联（先盘后库） ----------
  const d1 = await api(`/expense/o/${C}/row/${ridTrain}/file/${fidPdf2}`, { method: 'DELETE', headers: { 'X-Claim-Token': M1 } });
  ok('删附件 200', !!d1.message);
  ok('附件删除后槽位目录清空', existsSync(`${UP}\\${C}\\${ridTrain}\\invoice`) && readdirSync(`${UP}\\${C}\\${ridTrain}\\invoice`).length === 0);
  const d2 = await api(`/expense/member/${midWang}`, { method: 'DELETE', token: ta });
  ok('删成员王小明：级联删其 8 行(车票/报名/邮件/prop/重开reg/统一支付x2/项目级x1)', d2.rows === 8);
  ok('成员删除后其行目录已清盘', !existsSync(`${UP}\\${C}\\${ridTrain}`));
  const d3 = await api(`/expense/member/${midLi}`, { method: 'DELETE', token: ta });
  ok('删成员李小华2：级联删其 4 行(住宿/剪刀/统一支付x2)', d3.rows === 4);
  const d4 = await api(`/expense/team/${t2}`, { method: 'DELETE', token: ta });
  ok('删队伍级联删其行(含赵大强) OK', d4.rows === 1);
  await api(`/expense/${P}`, { method: 'DELETE', token: ta });
  ok('删项目后上传目录整夹清除', !existsSync(`${UP}\\${C}`));

  // DB 级联断言（项目下五表清空）
  const db = new DatabaseSync(DB_PATH);
  const zero = db.prepare(
    `SELECT (SELECT COUNT(*) FROM expense_project ep WHERE ep.code = ?) AS p,
            (SELECT COUNT(*) FROM expense_team et JOIN expense_project ep2 ON ep2.id = et.project_id WHERE ep2.code = ?) AS t,
            (SELECT COUNT(*) FROM expense_member em JOIN expense_project ep3 ON ep3.id = em.project_id WHERE ep3.code = ?) AS m,
            (SELECT COUNT(*) FROM expense_row er JOIN expense_project ep4 ON ep4.id = er.project_id WHERE ep4.code = ?) AS r,
            (SELECT COUNT(*) FROM expense_attach ea JOIN expense_project ep5 ON ep5.id = ea.project_id WHERE ep5.code = ?) AS a`
  ).get(C, C, C, C, C);
  ok('DB 级联：项目/队伍/成员/行/附件全清', zero.p === 0 && zero.t === 0 && zero.m === 0 && zero.r === 0 && zero.a === 0);
  const info = db.prepare('SELECT id FROM user WHERE email IN (?, ?)').all(EA, EB);
  for (const u of info) db.prepare('DELETE FROM user WHERE id = ?').run(u.id);
  db.close();
  ok(`清理测试用户 ×${info.length}`, info.length === 2);
} catch (e) {
  fail++;
  console.log(`❌ 异常中断: ${e.message}`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
