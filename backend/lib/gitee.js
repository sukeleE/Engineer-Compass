// Gitee 仓库文件树（资源分享·项目制：把公开仓库的文件清单拉进帖子的目录树）
//
// 与 lib/vision.js 同风格：GiteeError(message, hint) + **惰性读 process.env** ——
// ESM 的静态 import 早于 server.js 里的 process.loadEnvFile('.env')，模块顶层读环境变量必得 undefined。
//
// ⚠️ SSRF 闸门（本文件存在的首要理由）：**永远不接受客户端给完整 URL**。
//   只接 owner / repo / ref 三段，各自正则校验后由本文件拼进 gitee.com 的固定路径。
//   否则任何人可以让服务器去请求内网地址（http://127.0.0.1:3000/api/admin/... 之类），
//   拿响应内容当"仓库文件"读回来 —— 这就是标准 SSRF。
//
// 匿名配额约 60 次/小时/IP，所以：① 只在「预览」与「保存/同步」时拉，浏览页面零请求；
// ② 10 分钟内存缓存把同一仓库的重复拉取吃掉。配 GITEE_ACCESS_TOKEN 可提高配额（可选）。
//
// GITEE_BASE_URL 可覆盖是为**探针**留的口子（同 VISION_BASE_URL 的先例）：
// 探针起一个本地假 Gitee 返回固定树，离线、确定性、不消耗真实配额。
const BASE = () => process.env.GITEE_BASE_URL || 'https://gitee.com/api/v5';
const TOKEN = () => process.env.GITEE_ACCESS_TOKEN || '';
const TIMEOUT_MS = 15_000;
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 50;

export class GiteeError extends Error {
  constructor(message, hint = '') {
    super(message);
    this.name = 'GiteeError';
    this.hint = hint;
  }
}

// 裸文件域（/files/:fid/raw 代理用）：与 API 基址不是同一个（API 是 /api/v5，raw 是站点路径）。
// 同样可覆盖 —— 探针的假 Gitee 用同一个服务同时扮 API 与 raw。
export const giteeRawBase = () => process.env.GITEE_RAW_BASE || process.env.GITEE_BASE_URL?.replace(/\/api\/v\d+\/?$/, '') || 'https://gitee.com';

// owner/repo：字母数字开头，允许 . _ -，≤100 字（Gitee 本身也这么限）
const RE_OWNER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
// 分支/标签/sha：额外允许 / 与 .（如 feature/x、v1.0.0）
const RE_REF = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/;

export const isValidOwner = (s) => RE_OWNER.test(String(s || ''));
export function isValidRef(s) {
  const v = String(s || '');
  return RE_REF.test(v) && !v.includes('..') && !v.includes('//') && !v.endsWith('/');
}

// 解析用户输入 → {owner, repo}。接：
//   owner/repo · https://gitee.com/owner/repo · https://gitee.com/owner/repo.git
//   https://gitee.com/owner/repo/tree/<branch> · git@gitee.com:owner/repo.git
// 解析不出来返回 null（路由层转 400，不抛）
export function parseRepo(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  s = s.replace(/^git@gitee\.com:/i, '');               // git@gitee.com:owner/repo.git
  s = s.replace(/^https?:\/\/(www\.)?gitee\.com\//i, ''); // 完整 URL → 只剩路径
  s = s.replace(/\.git$/i, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo] = parts;
  if (!isValidOwner(owner) || !isValidOwner(repo)) return null;
  return { owner, repo };
}

// 从 URL 里顺带解析出 ref（.../tree/<branch>），解析不出返回 ''
export function parseRefFromUrl(input) {
  const m = String(input || '').match(/\/tree\/([^/?#]+(?:\/[^/?#]+)*)/i);
  return m && isValidRef(m[1]) ? m[1] : '';
}

// 缓存：键 owner/repo@ref → {at, tree}。上限 50 条，满了清最旧（树本身也占内存，别无限涨）
const cache = new Map();
export const cacheSize = () => cache.size;
export function clearCache() { cache.clear(); }

// GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1 → 扁平条目数组
// 返回 [{path, type:'blob'|'tree', size}]（只留 blob，tree 由 path 前缀推导，同上传路径的口径）
export async function fetchTree(owner, repo, ref) {
  if (!isValidOwner(owner) || !isValidOwner(repo)) throw new GiteeError('仓库地址不合法', '格式应为 owner/repo');
  const r = ref ? String(ref) : '';
  if (r && !isValidRef(r)) throw new GiteeError('分支/标签名不合法', '只允许字母数字与 _ . / -');

  const key = `${owner}/${repo}@${r || 'HEAD'}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.tree;

  const url = `${BASE()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(r || 'HEAD')}?recursive=1`;
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json', ...(TOKEN() ? { Authorization: `Bearer ${TOKEN()}` } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new GiteeError(
      e.name === 'TimeoutError' ? 'Gitee 响应超时' : `无法连接 Gitee：${e.message}`,
      '检查服务器出网；或在 .env 配 GITEE_BASE_URL 走代理'
    );
  }
  if (res.status === 404) throw new GiteeError('仓库或分支不存在（私有仓库需要 token）', '确认仓库是公开的，或换一个分支名');
  if (res.status === 403 || res.status === 429) {
    throw new GiteeError('Gitee 限流了（匿名约 60 次/小时/IP）', '稍后再试；或在服务器 .env 配 GITEE_ACCESS_TOKEN 提高配额');
  }
  if (!res.ok) throw new GiteeError(`Gitee 返回 ${res.status}`, '稍后重试');

  let body;
  try { body = await res.json(); } catch { throw new GiteeError('Gitee 返回了非 JSON 响应', '稍后重试'); }
  if (body?.truncated) {
    // 单仓库 >10 万文件才会 truncated；如实提示而不是静默给半棵树
    throw new GiteeError('仓库文件数超出 Gitee 接口上限（truncated）', '这个仓库太大了，建议改用上传方式分享');
  }
  const tree = (Array.isArray(body?.tree) ? body.tree : [])
    .filter((e) => e && e.type === 'blob' && typeof e.path === 'string')
    .map((e) => ({ path: e.path, type: 'blob', size: Number(e.size) || 0 }));

  // 入库前的路径消毒与上传同一口径（复用 shareFiles.sanitizeRelPath 的规则，
  // 但这里不能 import shareFiles —— 那会绕一圈回到 db；规则简单，重写一份并注明同源）
  const safe = tree.filter((e) => {
    const p = e.path;
    if (!p || p.length > 400 || p.includes('\0') || p.startsWith('/')) return false;
    const parts = p.split('/');
    return parts.length <= 20 && parts.every((x) => x && x !== '..' && x !== '.' && x.length <= 100);
  });

  cache.set(key, { at: Date.now(), tree: safe });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); // Map 保序 → 删最旧
  return safe;
}
