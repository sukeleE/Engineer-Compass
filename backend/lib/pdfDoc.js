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
// 与 pdf-parse 内部同一条 pdfjs 路径（legacy build：Node 无 DOMMatrix 等浏览器 API）
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

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

// ---- 字体未嵌入检测（2026-09-14）----
// 真实事故：Foxit KP Creator（铁路制票/第三方抢票工具）导出的电子客票 PDF，中文字体
//   （SimSun/SimHei/KaiTi/DengXian）只写名字不嵌入字体程序、且无 ToUnicode ——
//   手机/电脑上靠系统字体顶替看着完好，服务端光栅化却画不出任何文字（背景/红章/二维码正常），
//   视觉模型对着无字图只能返回空 fields，用户只得到含糊的「未识别到字段」。
// 判据来自 pdf.js 字体对象的**命名**（hasData/missingFile 实测都不可靠：子集嵌入字体 hasData 也为 false）：
//   ① 子集嵌入字体按 PDF 规范必带 6 大写字母前缀（AAAAAA+MicrosoftYaHei）→ 可用
//   ② 标准 14 字体（Helvetica/Times/Courier/Symbol/ZapfDingbats）由阅读器内置 → 可用
//   ③ name 为空（cid 字体翻译失败时对象无名）或其他裸名（SimSun…）→ 不可用
// 「页面有大量文本绘制算子、却零个可用字体」即判残缺；扫描件整页位图无 setFont 算子，天然不命中。
const EMBEDDED_SUBSET_RE = /^[A-Z]{6}\+/;
const STANDARD14_RE = /^(Helvetica|Times(?:-Roman|-Bold|-Italic|-BoldItalic)?|Courier(?:-Bold|-Oblique|-BoldOblique)?|Symbol|ZapfDingbats)$/i;
const MIN_TEXT_OPS = 10;     // showText/showSpaced 算子数下限（真实残票 47，合成夹具 20；防纯符号页误报）
const MIN_TEXT_UNITS = 40;   // 或参数字符量下限（Kerning 文本可能只有 1 个 TJ 却含整段文字）

export function fontNameUsable(name) {
  const n = String(name || '');
  return EMBEDDED_SUBSET_RE.test(n) || STANDARD14_RE.test(n);
}

// 纯函数（离线可测）：一页的算子列表 + 该页实际使用字体的名字数组 → 是否「有文字但字体全缺」
export function pageLacksEmbeddedFonts(operatorList, fontNames = []) {
  const fn = operatorList?.fnArray || [];
  const args = operatorList?.argsArray || [];
  const fontKeys = new Set();
  let textOps = 0;
  let textUnits = 0;
  const argLen = (x) => (typeof x === 'string' ? x.length
    : ArrayBuffer.isView(x) ? x.length
      : Array.isArray(x) ? x.reduce((n, y) => n + (typeof y === 'string' ? y.length : ArrayBuffer.isView(y) ? y.length : 0), 0)
        : 0);
  fn.forEach((op, i) => {
    if (op === pdfjs.OPS.setFont) fontKeys.add(args[i]?.[0]);
    else if (op === pdfjs.OPS.showText || op === pdfjs.OPS.showSpaced) {
      textOps++;
      textUnits += argLen(args[i]?.[0]);
    }
  });
  if (!fontKeys.size) return false; // 整页位图（扫描件）——交给视觉模型正常识别
  if (textOps < MIN_TEXT_OPS && textUnits < MIN_TEXT_UNITS) return false;
  return fontNames.length > 0 && fontNames.every((n) => !fontNameUsable(n));
}

// 集成层：检查前 N 页（与光栅化页范围一致），任一页命中即返回 {page}，否则 null
async function detectUnembeddedText(doc, maxPages) {
  const total = Math.min(Number(doc?.numPages) || maxPages, maxPages);
  for (let no = 1; no <= total; no++) {
    let page;
    try { page = await doc.getPage(no); } catch { break; }
    let ops;
    try { ops = await page.getOperatorList(); } catch { continue; }
    const keys = new Set();
    ops.fnArray.forEach((op, i) => { if (op === pdfjs.OPS.setFont) keys.add(ops.argsArray[i]?.[0]); });
    const names = [];
    for (const k of keys) {
      try {
        const f = page.commonObjs.has(k) ? await page.commonObjs.get(k) : null;
        names.push(f?.name || '');
      } catch { names.push(''); }
    }
    if (pageLacksEmbeddedFonts(ops, names)) return { page: no, fonts: names };
  }
  return null;
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

    // 无文字层先排查「字体未嵌入」残缺 PDF（必须在光栅化之前 —— 渲染出的无字图会白白烧掉一次视觉调用，
    //   且模型只能回空字段）。parser.doc 在 getText 后已就绪（PDFParse 公共字段）
    if (parser.doc) {
      const missing = await detectUnembeddedText(parser.doc, maxPages);
      if (missing) {
        throw new PdfInputError('这份 PDF 的文字字体未嵌入，服务器无法渲染票面文字（制票/抢票软件导出的票据常见此问题）',
          '在电脑或手机上打开这份 PDF 后截图，直接用截图识别；或用「打印 → 另存为 PDF」重新导出一份再上传');
      }
    }

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
