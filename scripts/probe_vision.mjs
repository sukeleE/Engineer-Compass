// 视觉识别探针（Playwright 渲染真图 + 打应用真端点）：断言「识别内容」而非「响应形状」——
// 2026-09-10 新增。起因：冒烟的「配键真测」只断言 fields 是对象 + extra 是数组，
//   空对象也满足 ⇒ 解析整段失效时冒烟照样全绿（假阳性）。本探针渲染一张内容已知的火车票图片，
//   断言识别回来的 车次/金额/日期/出发到达/座位等级 必须真的对得上 —— 解析链路一坏就转红。
//
// 前置：后端 :3000 在跑（frontend 不需要）
//   运行：node scripts/probe_vision.mjs
// 免费模型限流：glm-4.6v-flash 是免费档，上游常回 429「该模型当前访问量过大」（code 1305）。
//   本探针遇 429 自动退避重试；重试耗尽则判 SKIP（退出 0，打印跳过原因）而不是假失败 ——
//   限流是上游容量问题，不是代码缺陷，不该污染回归结果。
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import { extractModelText } from '../backend/lib/vision.js';

const API = 'http://localhost:3000/api';
const DB_PATH = 'D:\\desktop\\竞赛指导\\backend\\data\\compass.db';
const CATEGORY = 'train';

let pass = 0, fail = 0, skipped = '';
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

const stamp = Date.now().toString().slice(-8);
const EMAIL = `probe_vision_${stamp}@test.dev`;
let P = 0, ta = '', uid = 0;

// ---- §0 离线锚点（不触网，上游限流时也照跑）：钉死「拿整个响应体去解析」这个具体 bug ----
// 信封按 glm-4.6v-flash 实测响应结构复刻：答案在 choices[0].message.content，
// 思考过程在同级 reasoning_content（glm-4.6v-flash 是思考型模型，两者都计入 max_tokens）
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
ok('§0 离线：extractModelText 从信封取到正文（思考型模型 content≠reasoning_content）',
  got0.text.includes('"车次":"G1234"') && got0.finish === 'stop' && got0.reasoningLen > 0);
// 负向锚点：复刻旧实现（整个响应体 → 贪心 /\{[\s\S]*\}/ → JSON.parse）——必须复现「解析成功但 fields 为 undefined」
const oldWay = JSON.parse(CANNED_ENVELOPE.match(/\{[\s\S]*\}/)[0]);
ok('§0 离线：旧解析路径确实恒得 fields=undefined（即本探针所防的失效模式）',
  oldWay.fields === undefined && extractModelText(CANNED_ENVELOPE).text !== CANNED_ENVELOPE);

try {
  // 前置：后端在跑
  try {
    const h = await (await fetch(API + '/health')).json();
    if (!h.vision) throw new Error('服务端未配置 VISION_API_KEY（/api/health 的 vision=false）');
  } catch (e) {
    throw new Error(e.message.includes('VISION') ? e.message : '后端 :3000 未启动 —— 先跑 cd backend && npm start');
  }

  // ---- 夹具 ----
  const ra = await api('/auth/register', { method: 'POST', body: { email: EMAIL, password: 'pass123456', nickname: '视觉探针' } });
  ta = ra.token; uid = Number(ra.user.id);
  const proj = await api('/expense', { method: 'POST', token: ta, body: { name: '视觉识别探针', event: '电子设计大赛' } });
  P = Number(proj.id);
  const C = proj.code;

  // ---- 渲染样本票据 ----
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 820, height: 470 } });
  await page.setContent(TICKET_HTML);
  const shot = await page.locator('div').first().screenshot();
  await browser.close();
  ok(`渲染样本票据图（${Math.round(shot.length / 1024)}KB）`, shot.length > 5000);

  const post = async () => {
    const fd = new FormData();
    fd.append('category', CATEGORY);
    fd.append('file', new Blob([shot], { type: 'image/png' }), '探针火车票.png');
    const res = await fetch(`${API}/expense/o/${C}/vision/upload`, { method: 'POST', headers: { Authorization: `Bearer ${ta}` }, body: fd });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  // ---- 带退避的真实识别（免费档 429 属预期，不判失败）----
  let r = null;
  for (let i = 1; i <= 6; i++) {
    r = await post();
    if (r.status === 200) break;
    if (r.status === 502 && /429|访问量过大|繁忙/.test(String(r.data.error || ''))) {
      const wait = i * 10;
      console.log(`   ⏳ 上游限流（第 ${i}/6 次），退避 ${wait}s 后重试…`);
      await new Promise((res) => setTimeout(res, wait * 1000));
      continue;
    }
    break;
  }

  if (!r || r.status !== 200) {
    skipped = `上游持续限流/不可用（最后一次 ${r ? r.status : '?'}：${r?.data?.error || ''}）—— 本次跳过内容断言`;
    console.log(`⏭️  ${skipped}`);
  } else {
    const f = r.data.fields || {}, ex = r.data.extra || [];
    ok('识别返回 200 且含 fields/extra', typeof r.data.fields === 'object' && Array.isArray(ex));

    // ★ 内容断言：这些正是「解析链路失效」时会全部落空的项
    ok(`★ 车次 = ${TRUTH.车次}（实际 ${JSON.stringify(f.车次)}）`, f.车次 === TRUTH.车次);
    ok(`★ 金额 = ${TRUTH.金额}（实际 ${JSON.stringify(f.金额)}，须为数字）`, f.金额 === TRUTH.金额);
    ok(`★ 出发时间 = ${TRUTH.出发时间}（实际 ${JSON.stringify(f.出发时间)}）`, f.出发时间 === TRUTH.出发时间);
    ok(`出发地含「北京」（实际 ${JSON.stringify(f.出发地)}）`, String(f.出发地 || '').includes('北京'));
    ok(`到达地含「上海」（实际 ${JSON.stringify(f.到达地)}）`, String(f.到达地 || '').includes('上海'));
    ok(`座位等级含「二等座」（实际 ${JSON.stringify(f.座位等级)}）`, String(f.座位等级 || '').includes('二等座'));
    ok(`★ 回填字段数 ≥6（实际 ${Object.keys(f).length}）—— 空对象即解析失效`, Object.keys(f).length >= 6);
    // extra 断言「代码保证的性质」而非「模型这次恰选了哪几项」（模型对参考信息有自选权，
    // 拿某项内容当断言会因模型口味假红）：白名单内、非空、无重复、≤6 条
    const EXTRA_WHITE = ['乘车人', '座位号', '发票号码', '发票代码', '开票日期', '销售方名称', '购方名称', '证件号'];
    ok(`extra 非空且每项都在白名单内（实际 ${JSON.stringify(ex)}）`,
      ex.length > 0 && ex.every((x) => EXTRA_WHITE.includes(x.k) && String(x.v).trim() !== ''));
    ok('extra 无重复键且 ≤6 条', new Set(ex.map((x) => x.k)).size === ex.length && ex.length <= 6);
    ok('安全边界：锚点字段未被自动写回（无 购买人/备注/统一支付范围）', !('购买人' in f) && !('备注' in f) && !('统一支付范围' in f));
    if (r.data.warnings?.length) console.log(`   ℹ️ warnings: ${JSON.stringify(r.data.warnings)}`);
  }

  // ---- 清理 ----
  await api(`/expense/${P}`, { method: 'DELETE', token: ta });
  const db = new DatabaseSync(DB_PATH);
  db.prepare('DELETE FROM user WHERE id = ?').run(uid);
  db.close();
  ok('自清理：探针项目与测试用户已删除', true);
} catch (e) {
  fail++;
  console.log(`❌ 异常中断: ${e.message}`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败${skipped ? ' / 内容断言已跳过（上游限流）' : ''}`);
process.exit(fail ? 1 : 0);
