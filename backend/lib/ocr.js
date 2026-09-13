// 智谱 GLM-OCR 文档解析（2026-09-14）：layout_parsing 端点，0.9B 专用 OCR 模型
//   —— 与 vision.js 的对话式视觉模型互补，专解一类问题：**字体未嵌入/无文字层的 PDF**。
// 真实事故：Foxit KP Creator 电子客票中文字体只写名不嵌入，pdf.js 光栅化整页无字
//   （视觉模型对着无字图只能回空 fields）；GLM-OCR 服务端渲染环境完整，同一份 PDF
//   2 秒出全文（含 HTML 表格结构），约 0.001 元/次。
// 入参必须是 data URI（实测纯 base64 报 1214「仅支持 PDF/JPG/PNG」）；
// 与视觉模型共用 VISION_API_KEY（同一智谱账号），OCR_MODEL 默认 glm-ocr，OCR_BASE_URL 可换网关。
const OCR_URL = () => process.env.OCR_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4/layout_parsing';
const OCR_MODEL = () => process.env.OCR_MODEL || 'glm-ocr';
const TIMEOUT_MS = 60_000; // 实测单页 ~2s，给足余量
const MAX_TEXT = 6000;     // 喂给文本模型的字符上限（与 pdfDoc 数字版路径同口径，票据文本很短）

export class OcrError extends Error {
  constructor(message, hint = '') {
    super(message);
    this.name = 'OcrError';
    this.hint = hint;
  }
}

// GLM-OCR 的 md_results 是 markdown + HTML 表格混合：保留表格行列（td→空格、tr→换行），
// 剥掉装饰标签，让后续文本模型按行读。&nbsp; 等常见实体转回原文
function htmlToText(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[hd]>/gi, ' ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// buf(Buffer) + mime → {text, pages, tokens}
//   失败统一抛 OcrError —— 调用方（routes/expense.js）把它当「OCR 通道不可用」回落到光栅化视觉通道，
//   所以这里的错误不应直接变成用户的 502（还有兜底通道）
export async function callGlmOcr(buf, { mime = 'application/pdf', timeoutMs = TIMEOUT_MS } = {}) {
  const key = String(process.env.VISION_API_KEY || '').trim();
  if (!key) throw new OcrError('未配置 VISION_API_KEY');
  if (!buf || !buf.length) throw new OcrError('OCR 输入为空');

  let resp;
  try {
    resp = await fetch(OCR_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: OCR_MODEL(),
        file: `data:${mime};base64,${buf.toString('base64')}`, // data URI 前缀不能省
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // 网络层故障（断网/DNS/拒连/超时）—— 统一成 OcrError，让调用方静默回落视觉通道而非 500
    throw new OcrError(`OCR 网络请求失败：${e?.name === 'TimeoutError' ? '超时' : e?.message || e}`);
  }
  if (resp.status === 429) throw new OcrError('OCR 服务限流（429）');
  if (resp.status === 401 || resp.status === 403) throw new OcrError(`OCR 鉴权失败（${resp.status}）`);
  if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
    throw new OcrError(`OCR 服务暂不可用（${resp.status}）`);
  }
  const j = await resp.json().catch(() => null);
  if (!resp.ok || !j) {
    const msg = String(j?.error?.message || j?.message || `HTTP ${resp.status}`).slice(0, 160);
    throw new OcrError(`OCR 返回异常：${msg}`);
  }
  // md_results 为主（全文）；空时用 layout_details 各块 content 兜底拼接
  let text = htmlToText(j.md_results || '');
  if (!text && Array.isArray(j.layout_details?.[0])) {
    text = j.layout_details[0].map((b) => htmlToText(b?.content || '')).filter(Boolean).join('\n');
  }
  return {
    text: text.slice(0, MAX_TEXT),
    pages: Number(j.data_info?.num_pages) || 0,
    tokens: Number(j.usage?.total_tokens) || 0,
  };
}
