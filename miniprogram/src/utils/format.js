// 展示层工具：赛道配色 / 难度星级 / 树组装（纯逻辑，与 H5 共用同一套数据契约）

// 与 H5 --c-* 赛道主题色一致
const TYPE_COLORS = {
  电子机器人: '#3b82f6',
  机械: '#f59e0b',
  综合: '#10b981',
  数学基础: '#8b5cf6',
  设计艺术: '#ec4899',
  经管商科: '#14b8a6',
  医学技能: '#ef4444',
};

export function typeColor(type) {
  return TYPE_COLORS[type] || '#64748b';
}

export function typeTagClass(type) {
  // 兜底浅色 tag class（未知赛道用灰色）
  if (TYPE_COLORS[type]) return 'tag-blue';
  return 'tag-gray';
}

export function difficultyStars(d) {
  const n = Math.max(0, Math.min(5, Number(d) || 0));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

export const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

// tech_stack 扁平行（parent_id 指向父节点，根=0）→ 递归树，默认展开第一层由视图控制
export function buildTree(rows) {
  const map = new Map();
  (rows || []).forEach((r) => map.set(r.id, { ...r, children: [] }));
  const roots = [];
  (rows || []).forEach((r) => {
    const node = map.get(r.id);
    if (r.parent_id && map.has(r.parent_id)) map.get(r.parent_id).children.push(node);
    else roots.push(node);
  });
  return roots;
}

// 备赛计划完成度：{ done, total }
export function planProgress(plan) {
  let done = 0;
  let total = 0;
  for (const ph of plan?.phases || []) {
    for (const t of ph.tasks || []) {
      total += 1;
      if (t.done) done += 1;
    }
  }
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}