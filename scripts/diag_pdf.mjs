// PDF 识别逐层诊断（2026-09-14）：线上「数字版电子发票识别为空」时定位卡在哪一层。
// 用法：node scripts/diag_pdf.mjs <pdf文件路径> [类别 reg|train|hotel|mail|prop|misc，默认 misc]
// 逐层打印：①文字层原文（暴露空/乱码/CID 无 ToUnicode）②textUsable 判定 ③光栅化组件是否可用
//          ④完整模型链路（文字→DeepSeek / 转图→视觉模型）的原始返回与归一结果、耗时
// 只读文件、只打模型调用，不写库不碰后端进程；需 backend/.env 配好 DEEPSEEK_API_KEY / VISION_API_KEY
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const here = fileURLToPath(new URL('.', import.meta.url));
try { process.loadEnvFile(resolve(here, '../backend/.env')); } catch { /* 服务器上可由外部注入 env */ }

const { PDFParse } = await import(new URL('../backend/node_modules/pdf-parse/dist/pdf-parse/esm/index.js', import.meta.url));
const { pdfToRecognizeInput, textUsable } = await import('../backend/lib/pdfDoc.js');
const { callVision, callVisionText, visionFieldList } = await import('../backend/lib/vision.js');

const file = process.argv[2];
const cat = process.argv[3] || 'misc';
if (!file) { console.error('用法: node scripts/diag_pdf.mjs <pdf路径> [类别]'); process.exit(1); }

const buf = readFileSync(resolve(file));
console.log(`文件: ${file}  (${(buf.length / 1024).toFixed(1)} KB)  类别=${cat}`);
console.log(`该类别可回填字段: ${visionFieldList(cat).map((f) => f.key).join('、') || '（无！）'}`);

// 与 routes/ai.js callDeepSeek 同契约（json 模式 + 可选超时），内联以避免 import routes 触发连库
async function callDeepSeek(messages, { json = true, timeoutMs = 90000 } = {}) {
  const key = process.env.DEEPSEEK_API_KEY || '';
  if (!key) throw new Error('DEEPSEEK_API_KEY 未配置');
  const body = { model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', messages, temperature: 0.7 };
  if (json) body.response_format = { type: 'json_object' };
  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (!resp.ok) throw new Error(`DeepSeek ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

// ---- 第 1 层：文字层原文 ----
const parser = new PDFParse({ data: buf });
let rawText = '';
try {
  rawText = String((await parser.getText())?.text || '');
} catch (e) {
  console.log('❌ getText 抛错:', e.message);
}
const compact = rawText.replace(/\s/g, '');
console.log(`\n── ① 文字层：总 ${rawText.length} 字符 / 去空白 ${compact.length} 字符 / 含数字: ${/\d/.test(compact)}`);
console.log('textUsable 判定:', textUsable(rawText) ? '✅ 可用 → 走 DeepSeek 文字通道' : '❌ 不可用 → 应回落光栅化走视觉模型');
console.log('前 600 字符（JSON 转义，乱码/控制符会显形）:');
console.log(JSON.stringify(rawText.slice(0, 600)));

// ---- 第 2 层：按生产代码同口径分派 ----
const input = await pdfToRecognizeInput(buf).catch((e) => ({ __error: e }));
await parser.destroy().catch(() => {});
if (input.__error) {
  console.log('\n❌ pdfToRecognizeInput 抛错（路由会把它返成 400）:', input.__error.message);
  console.log('hint:', input.__error.hint || '');
  process.exit(0);
}
console.log(`\n── ② 分派结果: kind=${input.kind}` + (input.kind === 'images' ? `，光栅化 ${input.images.length} 页，每页约 ${(input.images[0]?.b64.length * 3 / 4 / 1024 || 0).toFixed(0)} KB` : ''));

// ---- 第 3 层：完整模型链路 ----
const t0 = Date.now();
try {
  const result = input.kind === 'text'
    ? await callVisionText(cat, input.text, { callModel: callDeepSeek })
    : await callVision(cat, input.images, { source: 'pdf-image' });
  console.log(`\n── ③ 模型链路（${Date.now() - t0}ms）source=${result.source}`);
  console.log('fields:', JSON.stringify(result.fields));
  console.log('extra:', JSON.stringify(result.extra));
  console.log('warnings:', JSON.stringify(result.warnings));
  console.log(Object.keys(result.fields).length ? '✅ 识别到字段' : '⚠️  fields 为空 —— 这就是线上症状，看①的文字层是否乱码、字段白名单是否匹配');
} catch (e) {
  console.log(`\n❌ 模型链路失败（${Date.now() - t0}ms）:`, e.message);
  if (e.hint) console.log('hint:', e.hint);
}
