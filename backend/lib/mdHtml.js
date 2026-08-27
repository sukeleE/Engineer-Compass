// wangEditor HTML ↔ Markdown 转换层（P1：飞书编辑页替代富文本编辑器）
// htmlToMd：wangEditor 5 产出子集 → Markdown（首次点「飞书编辑」时惰性迁移存量数据，零依赖手写解析）
// mdToHtml：服务端渲染 Markdown → HTML 片段（安全转义；前端 v-html 回显零依赖，站内展示层不变）
// 已知边界：base64 图片无法上传飞书 → htmlToMd 转占位提示；飞书附件 → mdToHtml 输出不可下载占位（飞书内可看）

// ---------- HTML → Markdown ----------

// tokenize：扫描 HTML 为 [{text} | {tag, close, attrs}]（attrs 为原始字符串）
function tokenize(html) {
  const tokens = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m, i = 0;
  while ((m = re.exec(html))) {
    if (m.index > i) tokens.push({ text: html.slice(i, m.index) });
    tokens.push({ tag: m[2].toLowerCase(), close: !!m[1], attrs: m[3] || '' });
    i = m.index + m[0].length;
  }
  if (i < html.length) tokens.push({ text: html.slice(i) });
  return tokens;
}

function attr(attrs, name) {
  const m = String(attrs).match(new RegExp(name + '=["\']([^"\']*)["\']', 'i'));
  return m ? m[1] : '';
}

const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'meta', 'link']);
const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'pre', 'hr', 'section', 'figure', 'aside']);

// 行内标签 → markdown 标记
const INLINE_MARK = { strong: '**', b: '**', em: '*', i: '*', s: '~~', del: '~~', code: '`', mark: '==' };

// 收集直到闭合标签的纯文本（跳过中间标签），返回 {text, next}
function collectText(tokens, i, untilTag) {
  let out = '', depth = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.text !== undefined) { out += t.text; i++; continue; }
    if (t.close) {
      if (t.tag === untilTag) { if (depth === 0) return { text: out, next: i + 1 }; depth--; }
    } else if (!VOID_TAGS.has(t.tag)) {
      if (t.tag === untilTag && depth === 0) return { text: out, next: i + 1 };
      if (t.tag === untilTag) depth++;
      else if (BLOCK_TAGS.has(t.tag) || t.tag === 'br') out += ' ';
    }
    i++;
  }
  return { text: out, next: i };
}

// 行内 tokens → markdown 字符串（处理标记包裹 / 链接 / 图片）
// untilTag：遇到该标签闭合返回（消费）；stopTags：遇到该标签（非闭合）即返回（不消费，交外层处理）
function inlineToMd(tokens, i, untilTag, stopTags = []) {
  let out = '';
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.text !== undefined) { out += t.text; i++; continue; }
    if (t.close && t.tag === untilTag) return { text: out, next: i + 1 };
    if (untilTag === null && t.close) return { text: out, next: i }; // 不限终止标签：任何闭合都停
    if (!t.close && stopTags.includes(t.tag)) return { text: out, next: i };
    if (t.tag === 'br') { out += '\n'; i++; continue; }
    if (t.tag === 'img') {
      const src = attr(t.attrs, 'src');
      const alt = attr(t.attrs, 'alt');
      // base64 图片无法上传飞书 → 占位提示，不丢信息
      if (/^data:/i.test(src)) out += `[图片${alt ? `：${alt}` : ''}（base64 图片无法上传飞书，请删除后重新插入）]`;
      else out += `![${alt || ''}](${src})`;
      i++; continue;
    }
    if (t.tag === 'a' && !t.close) {
      const r = inlineToMd(tokens, i + 1, 'a');
      const href = attr(t.attrs, 'href');
      out += href && r.text.trim() ? `[${r.text.trim()}](${href})` : r.text;
      i = r.next; continue;
    }
    if (INLINE_MARK[t.tag] && !t.close) {
      const r = inlineToMd(tokens, i + 1, t.tag);
      const inner = r.text.trim();
      out += inner ? INLINE_MARK[t.tag] + inner + INLINE_MARK[t.tag] : '';
      i = r.next; continue;
    }
    if (t.close && INLINE_MARK[t.tag]) { i++; continue; } // 空闭合忽略
    // 其余标签（span/font/p 等）：跳过标签本身，内容继续
    i++;
  }
  return { text: out, next: i };
}

// 列表项：li 内容（可能含嵌套 ul/ol）→ md
function liToMd(tokens, i, depth) {
  let out = '';
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.close && t.tag === 'li') return { text: out, next: i + 1 };
    if (t.close) { i++; continue; } // 行内包装的闭合（</strong> 等）跳过
    if (t.tag === 'ul' || t.tag === 'ol') {
      const r = listToMd(tokens, i, depth + 1);
      out += (out && !out.endsWith('\n') ? '\n' : '') + r.text;
      i = r.next; continue;
    }
    // 行内区段：吞到 li 结束 / 嵌套列表（空输出也要推进，避免死循环）
    const r = inlineToMd(tokens, i, null, ['li', 'ul', 'ol']);
    if (r.next === i) { i++; continue; }
    out += r.text;
    i = r.next;
  }
  return { text: out, next: i };
}

// 列表（ul/ol）→ md（嵌套缩进 2 空格）
function listToMd(tokens, i, depth) {
  const isOl = tokens[i]?.tag === 'ol';
  const pad = '  '.repeat(depth);
  let out = '', n = 1;
  i++;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.close && (t.tag === 'ul' || t.tag === 'ol')) return { text: out, next: i + 1 };
    if (t.tag === 'li' && !t.close) {
      const r = liToMd(tokens, i + 1, depth);
      const prefix = isOl ? `${n}. ` : '- ';
      out += pad + prefix + r.text.trim().replace(/\n/g, '\n' + pad) + '\n';
      n++;
      i = r.next; continue;
    }
    i++;
  }
  return { text: out, next: i };
}

// 表格 → md 表格（首行作表头）
function tableToMd(tokens, i) {
  const rows = []; // 每行 cell 数组
  let cur = null;
  i++;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.close && t.tag === 'table') break;
    if (t.tag === 'tr' && !t.close) { cur = []; rows.push(cur); i++; continue; }
    if (t.close && t.tag === 'tr') { i++; continue; }
    if ((t.tag === 'td' || t.tag === 'th') && !t.close) {
      const r = inlineToMd(tokens, i + 1, t.tag);
      cur && cur.push(r.text.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim());
      i = r.next; continue;
    }
    i++;
  }
  if (!rows.length) return { text: '', next: i };
  const w = Math.max(...rows.map((r) => r.length));
  const cells = (r) => Array.from({ length: w }, (_, c) => r[c] || '').join(' | ');
  const lines = rows.map((r) => `| ${cells(r)} |`);
  if (lines.length >= 1) lines.splice(1, 0, `| ${Array(w).fill('---').join(' | ')} |`);
  return { text: lines.join('\n'), next: i + 1 };
}

// 预格式（pre/code 块）→ ```fence
function preToMd(tokens, i) {
  let out = '';
  i++;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.close && (t.tag === 'pre' || t.tag === 'code')) return { text: out, next: i + 1 };
    if (t.text !== undefined) { out += t.text; i++; continue; }
    i++; // 块内其他标签（span 等）忽略
  }
  return { text: out, next: i };
}

export function htmlToMd(html) {
  const tokens = tokenize(String(html ?? ''));
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.text !== undefined) {
      const txt = t.text.trim();
      if (txt) out.push(txt);
      i++; continue;
    }
    if (t.close || VOID_TAGS.has(t.tag)) { i++; continue; }
    switch (t.tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const r = inlineToMd(tokens, i + 1, t.tag);
        const txt = r.text.trim();
        if (txt) out.push('#'.repeat(Number(t.tag[1])) + ' ' + txt);
        i = r.next; break;
      }
      case 'p': case 'div': case 'section': case 'figure': case 'aside': {
        const r = inlineToMd(tokens, i + 1, t.tag);
        const txt = r.text.trim();
        if (txt) out.push(txt);
        i = r.next; break;
      }
      case 'ul': case 'ol': {
        const r = listToMd(tokens, i, 0);
        const txt = r.text.trimEnd();
        if (txt) out.push(txt);
        i = r.next; break;
      }
      case 'blockquote': {
        const r = inlineToMd(tokens, i + 1, 'blockquote');
        const txt = r.text.trim();
        if (txt) out.push('> ' + txt.replace(/\n/g, '\n> '));
        i = r.next; break;
      }
      case 'pre': {
        const r = preToMd(tokens, i);
        if (r.text.trim()) out.push('```\n' + r.text.trimEnd() + '\n```');
        i = r.next; break;
      }
      case 'table': {
        const r = tableToMd(tokens, i);
        if (r.text) out.push(r.text);
        i = r.next; break;
      }
      case 'hr': { out.push('---'); i++; break; }
      default: i++; // 未知块标签：跳过标签，内容由后续文本 token 处理
    }
  }
  return out.join('\n\n').replace(/\n{4,}/g, '\n\n\n');
}

// ---------- Markdown → HTML（服务端渲染，安全转义） ----------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inlineMdToHtml(s) {
  let t = esc(s);
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, src) => `<img src="${src}" alt="${esc(alt)}" style="max-width:100%" loading="lazy">`);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => `<a href="${url}" target="_blank" rel="noopener">${text}</a>`);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return t;
}

export function mdToHtml(md) {
  const lines = String(md ?? '').split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    // 代码围栏
    if (/^```/.test(line.trim())) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${inlineMdToHtml(h[2])}</h${h[1].length}>`); i++; continue; }
    // 任务列表
    const todo = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (todo) {
      const done = todo[1].toLowerCase() === 'x';
      out.push(`<div style="margin:4px 0">${done ? '☑️' : '⬜'} ${inlineMdToHtml(todo[2])}</div>`);
      i++; continue;
    }
    // 无序列表（连续聚合）
    if (/^[-*+]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) { buf.push(lines[i].replace(/^[-*+]\s+/, '')); i++; }
      out.push(`<ul>${buf.map((x) => `<li>${inlineMdToHtml(x)}</li>`).join('')}</ul>`);
      continue;
    }
    // 有序列表
    if (/^\d+[.)]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i])) { buf.push(lines[i].replace(/^\d+[.)]\s+/, '')); i++; }
      out.push(`<ol>${buf.map((x) => `<li>${inlineMdToHtml(x)}</li>`).join('')}</ol>`);
      continue;
    }
    // 引用（含飞书附件占位）
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      const body = buf.map((x) => inlineMdToHtml(x)).join('<br>');
      // blocksToMarkdown 的附件占位 `📎 [name] file_token: xxx` → 提示用户到飞书查看（无权限保证的下载不承诺）
      const fileM = buf[0]?.match(/^📎\s*\[?([^\]]*)\]?\s*file_token:/);
      if (buf.length === 1 && fileM) {
        out.push(`<div class="feishu-file" style="padding:8px 10px;background:#f0f7ff;border:1px solid #bcd9ff;border-radius:8px;color:#2563eb;margin:6px 0">📎 ${esc(fileM[1] || '附件')}（位于飞书文档内，请到飞书查看）</div>`);
      } else out.push(`<blockquote style="margin:6px 0;padding-left:10px;border-left:3px solid #ddd;color:#666">${body}</blockquote>`);
      continue;
    }
    // 表格（连续聚合 + 分隔行跳过）
    if (/^\|.*\|\s*$/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { buf.push(lines[i].trim()); i++; }
      const rows = buf.filter((r) => !/^\|[\s:|-]+\|$/.test(r));
      if (rows.length) {
        const trs = rows.map((r, idx) => {
          const cells = r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
          const tag = idx === 0 ? 'th' : 'td';
          return `<tr>${cells.map((c) => `<${tag}>${inlineMdToHtml(c)}</${tag}>`).join('')}</tr>`;
        });
        out.push(`<table style="border-collapse:collapse;margin:6px 0"><thead>${trs[0]}</thead><tbody>${trs.slice(1).join('')}</tbody></table>`);
      }
      continue;
    }
    if (/^---+\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    // 普通段落（连续聚合）
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim()
      && !/^```/.test(lines[i].trim()) && !/^(#{1,6})\s/.test(lines[i])
      && !/^[-*+]\s/.test(lines[i]) && !/^\d+[.)]\s/.test(lines[i])
      && !/^>\s?/.test(lines[i]) && !/^\|.*\|\s*$/.test(lines[i])
      && !/^---+\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
    // 先逐行转义再以 <br> 连接：<br> 是结构标记，不能传入 inlineMdToHtml（会被 esc 成 &lt;br&gt;）
    out.push(`<p>${buf.map((x) => inlineMdToHtml(x)).join('<br>')}</p>`);
  }
  return out.join('\n');
}
