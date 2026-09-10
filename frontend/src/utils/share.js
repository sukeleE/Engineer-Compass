// 资源分享帖子工具：计数 / HTML 摘要 / 附件解析 / 首图提取
// 分享页与「我的/收藏」列表共用，避免两处重复实现

export const cnt = (n) => n ?? 0;

export const excerpt = (html, n = 90) => {
  const text = String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > n ? text.slice(0, n) + '…' : text;
};

// 解析 attachments 字段（字符串 JSON 或已解析数组），解析失败返回 []
export const atts = (p) => {
  try {
    const a = typeof p.attachments === 'string' ? JSON.parse(p.attachments) : p.attachments;
    return Array.isArray(a) ? a : [];
  } catch { return []; }
};

// 帖子的第一张图片附件（列表缩略图用），无图返回 null
export const firstImage = (p) => atts(p).find((a) => String(a.mime || '').startsWith('image/')) || null;

// 附件展示 URL：base64 内嵌（data）或引用型公开分享链接（url，我的资源引用）
export const attDataURL = (a) => (a?.data ? `data:${a.mime};base64,${a.data}` : a?.url || '');

// 文件「类型」→ 决定首列图标（GitHub 文件列表风）。入参是附件或 share_file 行（都含 mime/name）：
// 图片/视频/音频/压缩包/外链各归一档，其余（含纯文字帖、文档类附件）都是 file。
// 依据优先级：mime > 引用型 url（我的资源引用 / 飞书云盘）> 扩展名兜底（历史数据 mime 可能为空）。
const ARCHIVE_EXT = /\.(zip|rar|7z|tar|gz|bz2|xz)$/i;
export function fileKind(a) {
  if (!a) return 'file';
  const mime = String(a.mime || '');
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (a.url) return 'link'; // 引用型附件（我的资源分享链接 / 飞书文档）——点开是页面不是文件
  const name = String(a.name || '');
  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(name)) return 'image';
  if (/\.(mp4|mov|webm|avi|mkv)$/i.test(name)) return 'video';
  if (/\.(mp3|wav|flac|aac|m4a|ogg)$/i.test(name)) return 'audio';
  if (ARCHIVE_EXT.test(name)) return 'archive';
  return 'file';
}

// 帖子类型 = 首个附件的类型（无附件 → file）。薄封装，避免两套判定漂移
export const postKind = (p) => fileKind(atts(p)[0]);

// fileKind → GhIcon 的图标名
export const KIND_ICON = {
  image: 'file-media', video: 'video', audio: 'audio',
  archive: 'file-zip', link: 'link', file: 'file',
};

// ---- 项目文件夹（share_file）条目类型判定：只按 mime + 扩展名，端点不走 url 白名单 ----

// 能当纯文本读出来看的（走后端 /text 端点 + <pre> 渲染）。**不含 html/svg** ——
// 它们内联渲染等于在本站源下执行脚本，一律按二进制走下载。
const TEXT_EXT = /\.(txt|md|markdown|csv|log|ini|cfg|conf|json|xml|yml|yaml|toml|env|gitignore|js|mjs|cjs|ts|tsx|jsx|vue|css|scss|less|py|java|c|h|cpp|hpp|cs|go|rs|sql|sh|bash|bat|ps1|m|r|rb|php|pl|kt|swift|lua|gradle|properties)$/i;
export function isTextLike(mime, name) {
  const m = String(mime || '');
  if (/^(text\/(plain|markdown|csv|x-yaml|yaml)|application\/(json|xml|x-yaml))/.test(m)) return true;
  if (/^text\/(html|css|javascript|x-python|x-java|x-c|x-c\+\+|x-sh)$/.test(m)) return true;
  // mime 兜不住的历史/未知文件按后缀判（后端 EXT_MIME 未覆盖的也走这里）
  return TEXT_EXT.test(String(name || ''));
}

export const isImageLike = (mime) => /^image\//.test(String(mime || '')) && !/svg/.test(String(mime || ''));

export function fmtSize(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// 扁平 files[] → 目录树。
// 目录由 path 前缀推导（服务端不存目录行）；同层目录排前、各自按名排序，与 GitHub 一致。
// 返回 [{name, path, dir:true, children:[...]}, {..., dir:false, file}, ...]
export function buildTree(files) {
  const root = { children: [] };
  const dirs = new Map([['', root]]);
  const sorted = [...(files || [])].sort((a, b) => String(a.path).localeCompare(String(b.path), 'zh'));
  for (const f of sorted) {
    const parts = String(f.path || '').split('/').filter(Boolean);
    if (!parts.length) continue;
    let cur = root;
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : parts[i];
      let d = dirs.get(acc);
      if (!d) {
        d = { name: parts[i], path: acc, dir: true, children: [] };
        dirs.set(acc, d);
        cur.children.push(d);
      }
      cur = d;
    }
    cur.children.push({ name: parts[parts.length - 1], path: f.path, dir: false, file: f });
  }
  const order = (nodes) => {
    nodes.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh') : a.dir ? -1 : 1));
    for (const n of nodes) if (n.dir) order(n.children);
  };
  order(root.children);
  return root.children;
}

// 树 + 展开集 → 扁平行 [{node, depth}]（不递归渲染：组件里一个 v-for 铺完，缩进靠 padding-left）
export function flattenVisible(nodes, expanded, depth = 0, out = []) {
  for (const n of nodes || []) {
    out.push({ node: n, depth });
    if (n.dir && expanded.has(n.path)) flattenVisible(n.children, expanded, depth + 1, out);
  }
  return out;
}

// 树的全部目录路径（默认全展开用）
export function allDirPaths(nodes, out = []) {
  for (const n of nodes || []) {
    if (n.dir) { out.push(n.path); allDirPaths(n.children, out); }
  }
  return out;
}
