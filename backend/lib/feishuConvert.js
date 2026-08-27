// Markdown ↔ 飞书 docx Block 转换层（方案三核心）
// blocksToMarkdown：docx/v1 blocks 拍平列表 → Markdown（heading/paragraph/bullet/ordered/todo/code/quote/divider/table/附件占位）
// mdToBlocks：Markdown → docx children block 数组（表格转 code 块保留语法——Block 建表结构复杂，零丢失优先）
// 复杂格式（图片/文件）在 md 中输出占位与 token 便于下载，不做二进制转换

// 新版 docx v1 块枚举：1=page 2=text 3~11=heading1~9 12=bullet 13=ordered 14=code 15=quote 17=todo 19=callout
export const BT = { page: 1, text: 2, bullet: 12, ordered: 13, code: 14, quote: 15, todo: 17, callout: 19 };
const HEADING_KEYS = {};
for (let n = 1; n <= 9; n++) { HEADING_KEYS['heading' + n] = 2 + n; }

// block 对象的 payload 键（一个块只有一个）：优先键名，兼容未知类型
const KNOWN_KEYS = [
  ...Object.keys(HEADING_KEYS), 'paragraph', 'text', 'bullet', 'ordered', 'code', 'quote', 'todo',
  'table', 'table_cell', 'divider', 'image', 'file', 'callout', 'page', 'view',
  'grid', 'grid_column', 'sheet', 'bitable', 'mindnote', 'iframe', 'isv', 'chat_card',
];
export function blockKey(b) { return KNOWN_KEYS.find((k) => b && b[k]) || null; }

// 元素数组 → 纯文本（text_run 内容 + 链接 [text](url) + 文档/用户提及占位）
function elementsText(payload) {
  const els = payload?.elements || [];
  return els.map((el) => {
    if (el.text_run?.content) {
      const t = el.text_run.content;
      const url = el.text_run.text_element_style?.link?.url;
      return url && !/^https?:/.test(url) ? t : (url ? `[${t}](${url})` : t);
    }
    if (el.mention_doc) return `[文档:${el.mention_doc.title || ''}]`;
    if (el.mention_user) return `@${el.mention_user.user_name || '用户'}`;
    return '';
  }).join('');
}

function blockText(b) {
  const key = blockKey(b);
  return key ? elementsText(b[key]) : '';
}

// 表格块 → md 表格行（cells 按行排列；表头分隔行省略，可读性优先）
function tableToMd(tb, map) {
  const prop = tb.table?.property || {};
  const cells = tb.table?.cells || [];
  const col = prop.column_size || 1;
  const row = Math.max(prop.row_size || 0, Math.ceil(cells.length / col));
  const rows = [];
  for (let r = 0; r < row; r++) {
    const line = [];
    for (let c = 0; c < col; c++) {
      const cell = cells[r * col + c];
      const b = cell && map.get(cell);
      // cell 的文本来自其子块（paragraph）拼合
      const text = b ? (b.table_cell?.children || []).map((id) => blockText(map.get(id))).join(' ') : '';
      line.push(text.replace(/\|/g, '\\|').trim());
    }
    rows.push(`| ${line.join(' | ')} |`);
  }
  return rows.length ? rows.join('\n') : '';
}

// blocks 拍平列表（docx/v1 documents/:id/blocks 的 items）→ Markdown
export function blocksToMarkdown(items) {
  const map = new Map((items || []).map((b) => [b.block_id, b]));
  const out = [];
  for (const b of items || []) {
    const key = blockKey(b);
    if (!key || ['page', 'view', 'table_cell', 'grid', 'grid_column', 'sheet', 'bitable', 'mindnote', 'iframe', 'isv', 'chat_card'].includes(key)) continue;
    if (key === 'table') { out.push(tableToMd(b, map)); continue; }
    const text = blockText(b);
    if (key === 'divider') { out.push('---'); continue; }
    // 附件占位（file_token 供 file/download 接口下载）
    if (key === 'image' || key === 'file') {
      const tok = b[key]?.file_token || b[key]?.token || '';
      out.push(`> 📎 [${b[key]?.name || key}] file_token: ${tok}`);
      continue;
    }
    if (HEADING_KEYS[key]) { out.push(`${'#'.repeat(HEADING_KEYS[key] - 2)} ${text}`); continue; }
    if (key === 'bullet') { out.push(`- ${text}`); continue; }
    if (key === 'ordered') { out.push(`1. ${text}`); continue; }
    if (key === 'todo') { out.push(`- [${b.todo?.style?.done ? 'x' : ' '}] ${text}`); continue; }
    if (key === 'code') { out.push(`\`\`\`\n${text}\n\`\`\``); continue; }
    if (key === 'quote') { out.push(`> ${text}`); continue; }
    if (key === 'callout') { out.push(`> 💬 ${text}`); continue; }
    out.push(text); // paragraph/text 统一当段落
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ---------- Markdown → blocks ----------
const mdText = (s) => ({ elements: [{ text_run: { content: s } }] });

export function mdToBlocks(md) {
  const blocks = [];
  const lines = String(md ?? '').split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    // 代码围栏
    if (/^```/.test(line.trim())) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      i++; // 跳过收尾 ```
      blocks.push({ block_type: BT.code, code: mdText(buf.join('\n')) });
      continue;
    }
    // 标题（3~11 = heading1~9）
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const n = h[1].length;
      blocks.push({ block_type: 2 + n, ['heading' + n]: mdText(h[2]) });
      i++;
      continue;
    }
    // 任务列表
    const t = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (t) {
      blocks.push({ block_type: BT.todo, todo: { ...mdText(t[2]), style: { done: t[1].toLowerCase() === 'x' } } });
      i++;
      continue;
    }
    // 无序列表
    const b = line.match(/^[-*+]\s+(.*)$/);
    if (b) { blocks.push({ block_type: BT.bullet, bullet: mdText(b[1]) }); i++; continue; }
    // 有序列表
    const o = line.match(/^(\d+)[.)]\s+(.*)$/);
    if (o) { blocks.push({ block_type: BT.ordered, ordered: { ...mdText(o[2]), numbering: 1 } }); i++; continue; }
    // 引用
    const q = line.match(/^>\s?(.*)$/);
    if (q) { blocks.push({ block_type: BT.quote, quote: mdText(q[1]) }); i++; continue; }
    // 表格 → 保留语法为 code 块（零丢失；docx 建表块结构复杂，风险清单已声明格式损耗）
    if (/^\|.*\|\s*$/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { buf.push(lines[i].trim()); i++; }
      blocks.push({ block_type: BT.code, code: mdText(buf.join('\n')) });
      continue;
    }
    // 普通段落（text 块）：合并到下一个结构性行
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim()
      && !/^```/.test(lines[i].trim()) && !/^(#{1,6})\s/.test(lines[i])
      && !/^[-*+]\s/.test(lines[i]) && !/^(\d+)[.)]\s/.test(lines[i])
      && !/^>\s?/.test(lines[i]) && !/^\|.*\|\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
    blocks.push({ block_type: BT.text, text: mdText(buf.join('\n')) });
  }
  return blocks;
}
