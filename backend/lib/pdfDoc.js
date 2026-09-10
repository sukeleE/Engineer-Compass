// PDF 票据 → 识别输入（2026-09-10）：电子发票/铁路电子客票的标准交付形式就是 PDF，
// 本模块把 PDF 统一转成「视觉/文本识别」能吃的两种形态之一，让 PDF 与图片走同一条识别链路：
//   kind='text'   → 票面有可用文字层（数字版电子发票的常态）→ 交给文本模型（快、省 token、更准）
//   kind='images' → 无文字层或文字层乱码（扫描件/拍照转的 PDF）→ 光栅化前 N 页 → 交给视觉模型
// 判别由 textUsable 自动完成，用户不需要知道自己传的是哪一种 PDF。
//
// 依赖：pdf-parse（已是后端依赖，importPlan.js 在用）—— 它自带 getText() 与 getScreenshot()，
//   后者内部用其依赖 @napi-rs/canvas + pdfjs-dist 渲染，故本功能零新增依赖。
// ⚠️ destroy() 必须在 finally 调用：它释放 pdfjs 文档对象，长驻服务里漏调会按请求泄漏。
import { PDFParse } from 'pdf-parse';

const MAX_PAGES = 3;          // 光栅化页数上限：发票以单页为主，多页行程单取前 3 页足够
const DESIRED_WIDTH = 1600;   // 渲染宽度：够清晰且 PNG 体积可控（实测 ~90KB/页）
const MIN_TEXT_CHARS = 40;    // 文字层可用阈值：真实发票去空白后远超此值，扫描件只剩页码连接符（~8 字符）
const MAX_TEXT = 6000;        // 喂给文本模型的字符上限（票据文本很短，防超大 PDF 撑爆 token）

// 解析失败（损坏/加密/非 PDF 字节）统一抛本错误，路由层转 400（区别于 502 的上游服务错误）
export class PdfInputError extends Error {
  constructor(message, hint = '') {
    super(message);
    this.name = 'PdfInputError';
    this.hint = hint;
  }
}

// 文字层是否「可用」：字符数够 且 含数字。
// 一条规则同时排除三种情况：① 空白文本 ② 扫描件（只有页码连接符）③ 有文字层但字体无 ToUnicode
// 映射的乱码 PDF（提出来是乱码）—— 后两种都应回落光栅化，让视觉模型去看图。
export function textUsable(text) {
  const compact = String(text || '').replace(/\s/g, '');
  return compact.length >= MIN_TEXT_CHARS && /\d/.test(compact);
}

// PDF buffer → {kind:'text', text} 或 {kind:'images', images:[{mime,b64}], pageCount, truncated}
export async function pdfToRecognizeInput(buf, { maxPages = MAX_PAGES, desiredWidth = DESIRED_WIDTH } = {}) {
  if (!buf || !buf.length) throw new PdfInputError('PDF 内容为空');
  const parser = new PDFParse({ data: buf });
  try {
    let text = '';
    try {
      text = String((await parser.getText())?.text || '');
    } catch (e) {
      throw new PdfInputError('PDF 无法解析（文件可能已损坏，或不是真正的 PDF）',
        '文件可能下载不完整或后缀名与实际格式不符 —— 重新下载/导出一次，或改用截图识别');
    }
    if (textUsable(text)) return { kind: 'text', text: text.slice(0, MAX_TEXT) };

    // 无可用文字层 → 光栅化（扫描件/拍照转的 PDF）
    let pages = [];
    let total = 0;
    try {
      const shot = await parser.getScreenshot({ first: 1, last: maxPages, desiredWidth, imageBuffer: true });
      pages = Array.isArray(shot?.pages) ? shot.pages : [];
      total = Number(shot?.total) || pages.length;
    } catch (e) {
      throw new PdfInputError('PDF 转图失败（该文件可能是加密的，或服务器缺少图像渲染组件）',
        '加密 PDF 请先解除密码；若是服务器组件缺失请联系负责人（详见服务端日志）');
    }
    const images = pages
      .map((pg) => ({ mime: 'image/png', b64: Buffer.from(pg?.data || []).toString('base64') }))
      .filter((im) => im.b64);
    if (!images.length) {
      throw new PdfInputError('PDF 中未能取到可识别的页面（文件可能已损坏）',
        '换一份文件重试，或直接用截图识别');
    }
    return { kind: 'images', images, pageCount: total, truncated: total > images.length };
  } finally {
    await parser.destroy().catch(() => {}); // 释放 pdfjs 文档对象（勿删：漏调按请求泄漏）
  }
}
