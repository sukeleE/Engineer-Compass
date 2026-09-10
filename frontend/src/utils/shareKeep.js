// 资源分享列表的跨页状态缓存（真·模块级单例）
//
// 为什么单独一个文件：`<script setup>` 的**全部顶层代码会被编译进 setup()**，
// 每次组件实例化都重跑一遍 —— 写在 .vue 里的「模块级常量」其实是 per-instance 的。
// 从 /share 点进 /share/:id 再后退，列表是重新挂载的，那里存的状态必然拿不到，
// 于是 rows 为空 → 文档高度塌陷 → router 还原滚动位置时被钳回顶部。
// 放进普通 .js 模块，import 进来的才是全页面唯一的那一份。
//
// 首屏用缓存同步初始化即可立刻画出满高页面（滚动还原才落得回去），随后 load() 静默刷新覆盖。
// 幽灵页与普通页各存一份——共用同一个桶会把幽灵帖漏进普通列表。
export const newKeep = () => ({ rows: [], total: 0, stats: null, tab: 'all', sort: 'hot', tag: '', page: 1 });

const BUCKETS = { normal: newKeep(), ghost: newKeep() };

export const shareKeep = (ghost) => (ghost ? BUCKETS.ghost : BUCKETS.normal);
