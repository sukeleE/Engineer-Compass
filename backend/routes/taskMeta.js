// 任务元数据清洗工具：评星 stars + 暂存链接 links（schedule.js / team.js 共用，防白名单漂移）
// 约定：任务对象恒带 stars（null=未评）与 links（[]=无链接）两键，形状稳定

// 评星：仅接受 0-5 整数或 null；其余一律 null（未评）
export function sanitizeStars(v) {
  return v === null || v === undefined ? null : (Number.isInteger(v) && v >= 0 && v <= 5 ? v : null);
}

// 链接：仅接受非空 http(s) URL 的 {title, url}，最多 20 条；title 空 → null
// URL 强制 http(s) 协议是安全要求：javascript: 等协议放行会导致 <a href> 点击执行脚本（前端同时校验，双保险）
export function sanitizeLinks(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((l) => (l && typeof l.url === 'string' ? { title: String(l.title ?? '').trim() || null, url: l.url.trim() } : null))
    .filter((l) => l && /^https?:\/\//i.test(l.url))
    .slice(0, 20);
}

// 多次任务目标次数：1-100 整数，否则 null（multi 模式缺失时调用方兜底默认 3）
export function sanitizeTarget(v) {
  return Number.isInteger(v) && v >= 1 && v <= 100 ? v : null;
}

// 多次任务完成记录：[{by, at, uid}]；at 须为 YYYY-MM-DD（月历按完成日聚合），by 非空，uid 数字或 null；最多 100 条
export function sanitizeCompletions(v) {
  if (!Array.isArray(v)) return [];
  return v
    .map((c) => {
      if (!c || typeof c !== 'object') return null;
      const at = String(c.at ?? '').match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
      const by = String(c.by ?? '').trim();
      if (!at || !by) return null;
      return { by, at, uid: Number.isInteger(c.uid) ? c.uid : null };
    })
    .filter(Boolean)
    .slice(0, 100);
}

// 多次任务达标派生：done = 完成记录数 >= 目标次数（后端 complete 端点写库、前端个人视图 save 前调用）
export function deriveMultiDone(t) {
  if (t.mode !== 'multi') return;
  t.done = (t.completions || []).length >= (t.target || 3);
}
