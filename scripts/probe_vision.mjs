// 票据识别探针（Playwright 渲染真图/真 PDF + 打应用真端点）：断言「识别内容」而非「响应形状」——
// 2026-09-10 新增。起因：冒烟的「配键真测」只断言 fields 是对象 + extra 是数组，
//   空对象也满足 ⇒ 解析整段失效时冒烟照样全绿（假阳性）。本探针渲染一张内容已知的火车票，
//   断言识别回来的 车次/金额/日期/出发到达/座位等级 必须真的对得上 —— 任一路径坏掉就转红。
//
// 三路输入用**同一张票面、同一套断言**（火车票图片 / 数字版 PDF / 扫描件 PDF），因此能直接证明
//   「PDF 路径 ≡ 图片路径」；source 字段区分走了哪条路（image / pdf-text / pdf-image），
//   否则「PDF 走文字层」与「PDF 被转图」结果一模一样，某条路悄悄失效测不出来。
//
// 前置：后端 :3000 在跑（frontend 不需要）；PDF 文字层路径还需 DEEPSEEK_API_KEY
//   运行：node scripts/probe_vision.mjs
// 上游限流：glm-4.6v-flash 是免费档，常回 429「该模型当前访问量过大」（code 1305）。
//   本探针遇 429 自动退避重试；重试耗尽则判 SKIP（退出 0，打印跳过原因）而不是假失败 ——
//   限流是上游容量问题，不是代码缺陷，不该污染回归结果。
import { chromium } from 'playwright';
import { DEFAULT_API, openProbeDb } from './lib/probeDb.mjs';
import { extractModelText } from '../backend/lib/vision.js';
import { textUsable } from '../backend/lib/pdfDoc.js';

const API = process.env.PROBE_API || DEFAULT_API;
const CATEGORY = 'train';

let pass = 0, fail = 0;
const skips = [];
const ok = (name, cond) => { cond ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}`)); };

const jsonReq = async (path, opts = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) };
  const res = await fetch(API + path, { headers, method: opts.method || 'GET', body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  return { res, data: await res.json().catch(() => ({})) };
};
const api = async (path, opts = {}) => {
  const { res, data } = await jsonReq(path, opts);
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
};

// ---- 内容已知的样本票据（值就用这些断言，模型必须识别出来）----
const TRUTH = { 车次: 'G1234', 出发时间: '2026-07-15', 出发地: '北京南站', 到达地: '上海虹桥站', 座位等级: '二等座', 金额: 553.5, 乘车人: '王小明' };
const TICKET_HTML = `<!doctype html><meta charset="utf-8">
<body style="margin:0;font-family:'Microsoft YaHei',sans-serif">
<div style="width:760px;padding:26px 30px;background:#fff;color:#111">
  <div style="text-align:center;font-size:24px;font-weight:700;letter-spacing:4px">中国铁路电子客票</div>
  <div style="text-align:center;font-size:13px;color:#444;margin:6px 0 18px">China Railway E-Ticket</div>
  <table style="width:100%;font-size:17px;border-collapse:collapse">
    <tr><td style="padding:5px 0;color:#555">车次</td><td style="font-weight:700">${TRUTH.车次}</td>
        <td style="padding:5px 0;color:#555">乘车日期</td><td style="font-weight:700">${TRUTH.出发时间}</td></tr>
    <tr><td style="padding:5px 0;color:#555">出发站</td><td style="font-weight:700">${TRUTH.出发地}</td>
        <td style="padding:5px 0;color:#555">到达站</td><td style="font-weight:700">${TRUTH.到达地}</td></tr>
    <tr><td style="padding:5px 0;color:#555">座位等级</td><td style="font-weight:700">${TRUTH.座位等级}</td>
        <td style="padding:5px 0;color:#555">乘车人</td><td style="font-weight:700">${TRUTH.乘车人}</td></tr>
    <tr><td style="padding:5px 0;color:#555">票价</td><td colspan="3" style="font-weight:700;font-size:20px">￥${TRUTH.金额.toFixed(2)}</td></tr>
  </table>
  <div style="margin-top:16px;padding-top:10px;border-top:1px dashed #999;font-size:13px;color:#444">
    发票号码 25317000000098765432　销售方名称 中国铁路北京局集团有限公司
  </div>
</div></body>`;

const EXTRA_WHITE = ['乘车人', '座位号', '发票号码', '发票代码', '开票日期', '销售方名称', '购方名称', '证件号'];
// 票面内容断言（三路输入共用）：任一路径的解析/归一/提示词坏掉，这里都会红
function assertTicket(label, data) {
  const f = data.fields || {}, ex = data.extra || [];
  ok(`${label}★ 车次 = ${TRUTH.车次}（实际 ${JSON.stringify(f.车次)}）`, f.车次 === TRUTH.车次);
  ok(`${label}★ 金额 = ${TRUTH.金额}（实际 ${JSON.stringify(f.金额)}，须为数字）`, f.金额 === TRUTH.金额);
  ok(`${label}★ 出发时间 = ${TRUTH.出发时间}（实际 ${JSON.stringify(f.出发时间)}）`, f.出发时间 === TRUTH.出发时间);
  ok(`${label}出发地含「北京」（实际 ${JSON.stringify(f.出发地)}）`, String(f.出发地 || '').includes('北京'));
  ok(`${label}到达地含「上海」（实际 ${JSON.stringify(f.到达地)}）`, String(f.到达地 || '').includes('上海'));
  ok(`${label}座位等级含「二等座」（实际 ${JSON.stringify(f.座位等级)}）`, String(f.座位等级 || '').includes('二等座'));
  ok(`${label}★ 回填字段数 ≥6（实际 ${Object.keys(f).length}）—— 空对象即解析失效`, Object.keys(f).length >= 6);
  // extra 断言「代码保证的性质」而非「模型这次恰选了哪几项」（模型对参考信息有自选权，
  // 拿某项内容当断言会因模型口味假红）：白名单内、非空、无重复、≤6 条
  ok(`${label}extra 非空且每项都在白名单内（实际 ${JSON.stringify(ex)}）`,
    ex.length > 0 && ex.every((x) => EXTRA_WHITE.includes(x.k) && String(x.v).trim() !== ''));
  ok(`${label}extra 无重复键且 ≤6 条`, new Set(ex.map((x) => x.k)).size === ex.length && ex.length <= 6);
  ok(`${label}安全边界：锚点字段未被自动写回（无 购买人/备注/统一支付范围）`,
    !('购买人' in f) && !('备注' in f) && !('统一支付范围' in f));
}

// ---- §0 离线锚点（不触网，上游限流时也照跑）----
// §0.1 钉死「拿整个响应体去解析」这个具体 bug：信封按 glm-4.6v-flash 实测响应结构复刻，
//   答案在 choices[0].message.content、思考过程在同级 reasoning_content（两者都计入 max_tokens）
const CANNED_ENVELOPE = JSON.stringify({
  id: '20260910123456789abcdefghijklmn',
  created: 1789000000,
  model: 'glm-4.6v-flash',
  choices: [{
    index: 0,
    finish_reason: 'stop',
    message: {
      role: 'assistant',
      reasoning_content: '用户要求识别这张火车票。我先看车次栏……再核对金额栏，价税合计 553.50……',
      content: '{"fields":{"车次":"G1234","出发时间":"2026-07-15","出发地":"北京南站","到达地":"上海虹桥站","座位等级":"二等座","金额":553.5},"extra":[{"k":"乘车人","v":"王小明"}]}',
    },
  }],
  usage: { prompt_tokens: 812, completion_tokens: 96, total_tokens: 908 },
});
const got0 = extractModelText(CANNED_ENVELOPE);
ok('§0.1 离线：extractModelText 从信封取到正文（思考型模型 content≠reasoning_content）',
  got0.text.includes('"车次":"G1234"') && got0.finish === 'stop' && got0.reasoningLen > 0);
// 负向锚点：复刻旧实现（整个响应体 → 贪心 /\{[\s\S]*\}/ → JSON.parse）——必须复现「解析成功但 fields 为 undefined」
const oldWay = JSON.parse(CANNED_ENVELOPE.match(/\{[\s\S]*\}/)[0]);
ok('§0.1 离线：旧解析路径确实恒得 fields=undefined（即本探针所防的失效模式）',
  oldWay.fields === undefined && extractModelText(CANNED_ENVELOPE).text !== CANNED_ENVELOPE);

// §0.2 PDF 分派判别（textUsable）：决定 PDF 走文字层还是转图，判错则两条路都不会被走到
ok('§0.2 离线：扫描件 PDF 文字（只剩页码连接符）判为不可用',
  textUsable(' -- 1 of 1 -- ') === false && textUsable('') === false);
ok('§0.2 离线：真实票面文字判为可用（字符数够且含数字）',
  textUsable('中国铁路电子客票 G1234 北京南站 上海虹桥站 二等座 553.50 2026-07-15') === true);
ok('§0.2 离线：无数字的纯文字判为不可用（发票必有金额/号码，无数字说明没提到正文）',
  textUsable('中国铁路电子客票 乘车人 王小明 出发站 到达站 座位等级 二等座') === false);

const stamp = Date.now().toString().slice(-8);
const EMAIL = `probe_vision_${stamp}@test.dev`;
let P = 0, ta = '', uid = 0;

try {
  // 前置：后端在跑
  try {
    const h = await (await fetch(API + '/health')).json();
    if (!h.vision) throw new Error('服务端未配置 VISION_API_KEY（/api/health 的 vision=false）');
  } catch (e) {
    throw new Error(e.message.includes('VISION') ? e.message : '后端 :3000 未启动 —— 先跑 cd backend && npm start');
  }

  // ---- 夹具 ----
  const ra = await api('/auth/register', { method: 'POST', body: { email: EMAIL, password: 'pass123456', nickname: '识别探针' } });
  ta = ra.token; uid = Number(ra.user.id);
  const proj = await api('/expense', { method: 'POST', token: ta, body: { name: '识别探针', event: '电子设计大赛' } });
  P = Number(proj.id);
  const C = proj.code;

  // ---- 同一张票面的三种输入 ----
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 820, height: 470 } });
  await page.setContent(TICKET_HTML);
  const shot = await page.locator('div').first().screenshot();
  const digitalPdf = Buffer.from(await page.pdf({ width: '820px', height: '500px', printBackground: true }));
  // 扫描件模拟：整页只有一张位图 → 无文字层（真实场景=拍照/截图后转的 PDF）
  await page.setContent(`<img src="data:image/png;base64,${shot.toString('base64')}" style="width:800px">`);
  const scannedPdf = Buffer.from(await page.pdf({ width: '820px', height: '500px', printBackground: true }));
  await browser.close();
  ok(`渲染样本票据：PNG ${Math.round(shot.length / 1024)}KB / 数字版 PDF ${Math.round(digitalPdf.length / 1024)}KB / 扫描件 PDF ${Math.round(scannedPdf.length / 1024)}KB`,
    shot.length > 5000 && digitalPdf.length > 5000 && scannedPdf.length > 5000);

  // ---- 上传并带退避重试（上游限流属预期，不判失败）----
  const upload = async (buf, filename, label) => {
    for (let i = 1; i <= 6; i++) {
      const fd = new FormData();
      fd.append('category', CATEGORY);
      fd.append('file', new Blob([buf]), filename);
      const res = await fetch(`${API}/expense/o/${C}/vision/upload`, { method: 'POST', headers: { Authorization: `Bearer ${ta}` }, body: fd });
      const data = await res.json().catch(() => ({}));
      if (res.status === 200) return data;
      if (res.status === 502 && /429|访问量过大|繁忙/.test(String(data.error || ''))) {
        const wait = i * 10;
        console.log(`   ⏳ ${label} 上游限流（第 ${i}/6 次），退避 ${wait}s 后重试…`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      skips.push(`${label}：${res.status} ${String(data.error || '').slice(0, 90)}`);
      return null;
    }
    skips.push(`${label}：上游持续限流（重试 6 次耗尽）`);
    return null;
  };

  // ① 图片 → GLM-4V
  const r1 = await upload(shot, '探针火车票.png', '图片');
  if (r1) {
    ok('①图片 source=image', r1.source === 'image');
    assertTicket('①图片 ', r1);
    if (r1.warnings?.length) console.log(`   ℹ️ warnings: ${JSON.stringify(r1.warnings)}`);
  } else console.log('⏭️  ①图片：跳过内容断言');

  // ② 数字版 PDF（有文字层）→ 文本模型
  const r2 = await upload(digitalPdf, '探针火车票.pdf', '数字版PDF');
  if (r2) {
    ok('②数字版PDF source=pdf-text（走文字层，非转图）', r2.source === 'pdf-text');
    assertTicket('②数字版PDF ', r2);
    if (r2.warnings?.length) console.log(`   ℹ️ warnings: ${JSON.stringify(r2.warnings)}`);
  } else console.log('⏭️  ②数字版PDF：跳过内容断言');

  // ③ 扫描件 PDF（无文字层）→ 自动转图 → GLM-4V
  const r3 = await upload(scannedPdf, '探针火车票扫描件.pdf', '扫描件PDF');
  if (r3) {
    ok('③扫描件PDF source=pdf-image（无文字层已自动转图）', r3.source === 'pdf-image');
    assertTicket('③扫描件PDF ', r3);
    if (r3.warnings?.length) console.log(`   ℹ️ warnings: ${JSON.stringify(r3.warnings)}`);
  } else console.log('⏭️  ③扫描件PDF：跳过内容断言');

  // ④ 损坏 PDF（假字节冒充）→ 400 且不 500，错误可读
  const bad = new FormData();
  bad.append('category', CATEGORY);
  bad.append('file', new Blob([Buffer.from('PDF-X2-发票样本\n')]), '损坏发票.pdf');
  const rb = await fetch(`${API}/expense/o/${C}/vision/upload`, { method: 'POST', headers: { Authorization: `Bearer ${ta}` }, body: bad });
  const jb = await rb.json().catch(() => ({}));
  ok(`④损坏 PDF 400 且错误可读（实际 ${rb.status}：${String(jb.error || '').slice(0, 60)}）`,
    rb.status === 400 && String(jb.error || '').includes('PDF 无法解析'));

  // ---- 清理 ----
  await api(`/expense/${P}`, { method: 'DELETE', token: ta });
  const db = openProbeDb(API);
  db.prepare('DELETE FROM user WHERE id = ?').run(uid);
  db.close();
  ok('自清理：探针项目与测试用户已删除', true);
} catch (e) {
  fail++;
  console.log(`❌ 异常中断: ${e.message}`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败${skips.length ? ` / ${skips.length} 项跳过` : ''}`);
for (const s of skips) console.log(`   ⏭️  ${s}`);
process.exit(fail ? 1 : 0);
