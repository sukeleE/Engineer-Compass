// 计划文件导入冒烟测试（node 内联 fetch + FormData/Blob；真实调用 DeepSeek 转换 4 次）
// 覆盖：401 / 坏扩展名 / 坏 mode / 空文档 400 / md→schedule 200 / md→study 200 / xlsx 解析 200 /
//      最小 PDF 200 / 20MB+1 → 413 / 审计 plan-import
// 运行前提：后端已启动在 :3000（npm start），.env 已配 DEEPSEEK_API_KEY
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from '../routes/middleware.js';
import * as XLSX from 'xlsx';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB = join(__dirname, '..', 'data', 'compass.db');
const BASE = 'http://localhost:3000/api';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

async function upload(blob, name, mode, token) {
  const fd = new FormData();
  fd.append('file', blob, name);
  fd.append('mode', mode);
  const res = await fetch(BASE + '/import/plan', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const blobOf = (s) => new Blob([Buffer.from(s)]);

// 构造最小合法 PDF（含一行文本，xref 偏移正确）
function makeMinPdf(text = 'National College Electronic Design Competition Plan 2026 Spring') {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  ];
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  objs.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xrefPos = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

// 构造最小 xlsx（两行表头+数据的真实工作簿）
function makeMinXlsx() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['阶段', '任务', '周数'],
    ['入门', '搭环境', 1],
    ['进阶', '写示例', 2],
  ]), '阶段表');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ---- 准备 ----
const db = new DatabaseSync(DB);
const MAIL = 'smoke_import@x.com';
db.prepare('DELETE FROM user WHERE email = ?').run(MAIL);
const uid = Number(db.prepare("INSERT INTO user (username, nickname, password_hash, email) VALUES (?,?,?,?)")
  .run('smoke_import', '导入冒烟', hashPassword('test123456'), MAIL).lastInsertRowid);
console.log(`— 测试账号 uid=${uid}`);
const login = await fetch(BASE + '/auth/login', { method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: MAIL, password: 'test123456' }) });
const tok = (await login.json()).token;
ok('登录 → 200', login.status === 200);

const MD_PLAN = `# 全国大学生电子设计竞赛备赛计划（2026年3月-8月）
## 总体安排
组队 3 人，分工硬件/软件/报告。每周例会同步进度，预留 10 小时/周。
## 第一阶段：基础入门（3月）
任务：掌握单片机开发环境搭建；完成 LED 流水灯与按键中断实验；学习 AD 电路图绘制。
达标要求：能独立完成最小系统板焊接与调试。
## 第二阶段：核心模块（4月）
任务：完成传感器数据采集（温度/光敏）；实现串口与上位机通信；制作电源模块。
达标要求：核心模块全部跑通并留档。
## 第三阶段：系统联调（5-6月）
任务：整合各模块完成整机联调；编写报告初稿；进行两轮全流程模拟测试。
达标要求：整机连续运行 8 小时无故障。
## 第四阶段：冲刺与文档（7-8月）
任务：优化系统性能与稳定性；完善报告与答辩 PPT；赛前全要素演练。
达标要求：完成最终提交与答辩演练。`;
const MD_STUDY = `# 机器学习入门学习计划
主题：机器学习基础，目标 3 个月掌握 sklearn 常用模型并完成 2 个实战项目。
第一阶段（第1-4周）：Python 基础与 numpy/pandas 练习，完成线性回归小实验。
第二阶段（第5-8周）：分类模型（逻辑回归/决策树/随机森林），完成鸢尾花分类项目。
第三阶段（第9-12周）：聚类与降维（KMeans/PCA），完成用户分群项目。
资源关键词：sklearn 官方文档、吴恩达机器学习、Kaggle 入门赛、bilibili 机器学习速成课。`;

// ---- 1) 鉴权 ----
console.log('— 鉴权');
let r = await upload(blobOf(MD_PLAN), 'plan.md', 'schedule');
ok('无 token 上传 → 401', r.status === 401, `got ${r.status}`);

// ---- 2) 非法输入 ----
console.log('— 非法输入');
r = await upload(blobOf('x'.repeat(200)), 'evil.exe', 'schedule', tok);
ok('坏扩展名 .exe → 400', r.status === 400 && r.data.error.includes('暂不支持'), `got ${r.status} ${r.data.error}`);
r = await upload(blobOf(MD_PLAN), 'plan.md', 'bogus', tok);
ok('坏 mode → 400', r.status === 400 && r.data.error.includes('mode'), `got ${r.status} ${r.data.error}`);
r = await upload(blobOf('不足五十个有效字符啊'), 'empty.md', 'schedule', tok);
ok('文本过少 → 400', r.status === 400 && r.data.error.includes('有效文本'), `got ${r.status} ${r.data.error}`);

// ---- 3) md → schedule（真实 AI 转换）----
console.log('— AI 转换（DeepSeek）');
r = await upload(blobOf(MD_PLAN), '备赛计划.md', 'schedule', tok);
ok('md → schedule 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
const sp = r.data.plan;
ok('schedule 结构：title + phases（每阶段有任务）', sp && sp.title && Array.isArray(sp.phases) && sp.phases.length >= 2
  && sp.phases.every((p) => p.phase && Array.isArray(p.tasks) && p.tasks.length && p.tasks[0].text),
  JSON.stringify(sp).slice(0, 160));

// ---- 4) md → study（真实 AI 转换）----
r = await upload(blobOf(MD_STUDY), '学习计划.md', 'study', tok);
ok('md → study 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
const st = r.data.plan;
ok('study 结构：topic + summary + phases', st && st.topic && st.summary && Array.isArray(st.phases) && st.phases.length >= 2,
  JSON.stringify(st).slice(0, 160));

// ---- 5) xlsx / pdf 解析链路（同样走真实 AI 转换）----
r = await upload(new Blob([makeMinXlsx()]), '任务表.xlsx', 'schedule', tok);
ok('xlsx → 200（含工作表文本）', r.status === 200 && Array.isArray(r.data.plan?.phases), `got ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
r = await upload(new Blob([makeMinPdf()]), 'doc.pdf', 'schedule', tok);
ok('最小 PDF → 200（文本层提取）', r.status === 200 && Array.isArray(r.data.plan?.phases), `got ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);

// ---- 6) 大小限制 ----
console.log('— 大小限制');
const big = new Uint8Array(20 * 1024 * 1024 + 1);
r = await upload(new Blob([big]), 'big.pdf', 'schedule', tok);
ok('20MB+1 字节 → 413', r.status === 413 && r.data.error.includes('20MB'), `got ${r.status} ${r.data.error}`);

// ---- 7) 审计 ----
console.log('— 审计');
const cnt = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ? AND action = 'plan-import'").get(uid).n;
ok('plan-import 审计 ≥4 条（4 次成功转换）', cnt >= 4, `n=${cnt}`);

// ---- 清理 ----
console.log('— 清理测试数据');
db.prepare("DELETE FROM audit_log WHERE user_id = ?").run(uid);
db.prepare('DELETE FROM session WHERE user_id = ?').run(uid);
db.prepare('DELETE FROM user WHERE id = ?').run(uid);
db.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
