// 计划文件导入（挂载 /api/import）：上传 .docx/.pdf/.xls/.xlsx/.md 文档 → 提取文本 → AI 转成固定格式计划 JSON
// 转换结果不落库：前端预览确认后走 scheduleManual / studyManual 保存（与 planChat「先对话后成稿」确认环节一致）
import { Router } from 'express';
import multer from 'multer';
import { basename, extname } from 'node:path';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import * as XLSX from 'xlsx';
import { authRequired, mutedGuard, logAudit } from './middleware.js';
import { callDeepSeek } from './ai.js';

export const MAX_IMPORT = 20 * 1024 * 1024; // 单文件 ≤20MB（文档类，比个人资源小）
const MAX_CHARS = 80000;                    // 喂给 AI 的文本上限（防 token 爆炸）

// memoryStorage：解析后无落盘无残留（区别于 resource.js 的 diskStorage）
// limit +1 同 resource.js：busboy 在 fileSize===limit 即触发 LIMIT_FILE_SIZE
// defParamCharset 'utf8'：busboy 默认 latin1 → 中文文件名乱码
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMPORT + 1 }, defParamCharset: 'utf8' });
const ALLOWED = new Set(['.docx', '.pdf', '.xls', '.xlsx', '.md', '.txt']);

const r = Router();
r.use(authRequired);

// 按扩展名提取纯文本（buffer → string；解析异常由调用方 catch 转 400）
async function extractText(file) {
  const buf = file.buffer;
  switch (extname(basename(String(file.originalname || ''))).toLowerCase()) {
    case '.docx': {
      const res = await mammoth.extractRawText({ buffer: buf });
      return res.value;
    }
    case '.pdf': {
      const parser = new PDFParse({ data: buf });
      const res = await parser.getText();
      return res.text;
    }
    case '.xls':
    case '.xlsx': {
      // 逐工作表拼文本（值 + 表头行，竖线分隔），让 AI 能理解表格结构
      const wb = XLSX.read(buf, { type: 'buffer' });
      const parts = [];
      for (const name of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });
        parts.push(`【工作表：${name}】\n` + rows.map((row) => row.join(' | ')).join('\n'));
      }
      return parts.join('\n\n');
    }
    default: // .md / .txt
      return buf.toString('utf-8');
  }
}

// POST /api/import/plan  multipart { file, mode: 'schedule' | 'study' }
r.post('/plan', mutedGuard, (req, res, next) => {
  // 手动包裹 multer：LIMIT_FILE_SIZE 文案区分于资源上传（全局分支写死 128MB）
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文档过大（单文件 ≤20MB）' });
      return res.status(400).json({ error: `上传失败：${err.message}` });
    }
    if (err) return next(err);
    next();
  });
}, async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: '未收到文件，请以 multipart/form-data 上传（字段名 file）' });
  const mode = String(req.body?.mode || '');
  if (!['schedule', 'study', 'team'].includes(mode)) return res.status(400).json({ error: 'mode 仅支持 schedule（竞赛日程）/ study（学习日程）/ team（小组计划）' });
  const ext = extname(basename(String(file.originalname || ''))).toLowerCase();
  if (!ALLOWED.has(ext)) return res.status(400).json({ error: '暂不支持该格式（支持 Word .docx / PDF / Excel .xls/.xlsx / Markdown / 纯文本）' });
  if (file.size === 0) return res.status(400).json({ error: '文件为空' });

  // 1) 提取文本
  let text;
  try {
    text = await extractText(file);
  } catch {
    return res.status(400).json({ error: '文件解析失败（文档可能已损坏）' });
  }
  text = String(text || '');
  // 阈值 20：过滤纯图片/扫描版（空文本），同时不误伤只有几行的真实小表格
  if (text.replace(/\s/g, '').length < 20) {
    return res.status(400).json({ error: '未能从文档中提取到有效文本（扫描版 PDF 或纯图片文档暂不支持）' });
  }
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '\n…（内容过长已截断）';

  // 2) AI 转换：固定格式 JSON（json:true 由 callDeepSeek 强制）
  const system = mode === 'study'
    ? '你是学习规划顾问。把用户提供的文档内容整理成一份学习计划，输出严格 JSON（不要 Markdown 代码块），格式：{"topic":"学习主题（≤30字）","summary":"学习目标与整体安排（2-3句话）","phases":[{"phase":"阶段名称","date":"约第x-y周","tasks":["具体任务描述"],"check_standard":"达标要求","week_hours":10}],"resource_keywords":["学习资源关键词","..."]}。'
    : '你是工科竞赛备赛规划顾问。把用户提供的文档内容整理成一份竞赛备赛计划，输出严格 JSON（不要 Markdown 代码块），格式：{"title":"计划标题（从文档提炼，≤30字）","phases":[{"phase":"阶段名称","date":"起止日期或周期","tasks":["具体任务描述，每条一句、可执行"],"check_standard":"本阶段达标要求","week_hours":10}]}。';
  const prompt = `请阅读以下文档内容，整理成${mode === 'study' ? '学习计划' : '竞赛备赛计划'}。保留文档中的关键任务、时间安排、目标要求，任务要具体可执行，一般 3-6 个阶段。\n\n【文档内容开始】\n${text}\n【文档内容结束】`;
  let raw;
  try {
    raw = await callDeepSeek([{ role: 'system', content: system }, { role: 'user', content: prompt }], { json: true, timeoutMs: 120000 });
  } catch (e) {
    return res.status(502).json({ error: `AI 转换失败：${e.message}` });
  }
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/); // 容错：剥 ```json 包裹 / 截取首个 { 到末个 }
    if (!m) return res.status(502).json({ error: 'AI 转换结果解析失败，请重试' });
    try { plan = JSON.parse(m[0]); } catch { return res.status(502).json({ error: 'AI 转换结果解析失败，请重试' }); }
  }

  // 3) 校验 + 清洗（结构对齐 manual 端点的 phases）
  const phases = [];
  for (const ph of Array.isArray(plan.phases) ? plan.phases : []) {
    const tasks = Array.isArray(ph.tasks) ? ph.tasks.map((t) => {
      const text2 = String(typeof t === 'string' ? t : t?.text || '').trim();
      return text2 ? { text: text2, done: false, stars: null, links: [], mode: 'once', target: null, completions: [] } : null;
    }).filter(Boolean) : [];
    if (!tasks.length) continue;
    phases.push({
      phase: String(ph.phase || '').trim() || `阶段 ${phases.length + 1}`,
      date: String(ph.date || '').trim(),
      tasks,
      check_standard: String(ph.check_standard || '').trim(),
      week_hours: Math.max(1, Math.min(80, Number(ph.week_hours) || 10)),
    });
  }
  if (!phases.length) return res.status(502).json({ error: 'AI 未能从文档中提炼出计划结构，请换一个文件或重试' });

  const out = { phases };
  if (mode === 'schedule') {
    out.title = String(plan.title || '').trim().slice(0, 30) || '导入计划';
  } else {
    out.topic = String(plan.topic || '').trim().slice(0, 30) || '导入学习计划';
    out.summary = String(plan.summary || '').trim();
    out.resource_keywords = Array.isArray(plan.resource_keywords)
      ? plan.resource_keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 10) : [];
  }
  logAudit(req, 'plan-import', mode === 'schedule' ? out.title : out.topic, { mode, file_name: file.originalname, chars: text.length });
  res.json({ plan: out });
});

export default r;
