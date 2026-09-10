<script setup>
// 资源分享（GitHub 仓库页形态）：仓库头 + 标签页 + 文件表 + About 侧栏
// 一条帖子 = 文件表里的一行；**点行 → 跳 /share/:id 独立详情页**（不再在下方展开 README）
// tabs：资源(全部) / 我的帖子 / 我的收藏 —— 复用后端已有的 scope=mine|favs
// 幽灵页（/ghost-share）：只留「资源」一个静态标签 + 排序，不发 scope（scope 会绕过幽灵隔离）
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';
import auth from '../auth.js';
import ShareFileTable from './share/ShareFileTable.vue';
import SharePostDialog from './share/SharePostDialog.vue';
import GhIcon from './share/GhIcon.vue';
import { shareKeep } from '../utils/shareKeep.js';

const router = useRouter();
const route = useRoute();
// ghost 模式（/ghost-share 秘密分享页）：只显示幽灵帖、发帖恒为幽灵帖；普通分享页幽灵用户发帖默认也发幽灵帖
const props = defineProps({ ghost: { type: Boolean, default: false } });

// —— 视图：标签页 + 排序 + 标签子板块 + 分页 ——
const TABS = [
  { key: 'all', full: '📄 资源', short: '资源' },
  { key: 'mine', full: '📝 我的帖子', short: '帖子' },
  { key: 'favs', full: '⭐ 我的收藏', short: '收藏' },
];
const SORTS = [
  { key: 'hot', full: '🔥 最热门', short: '最热' },
  { key: 'new', full: '🕐 最新', short: '最新' },
  { key: 'fav', full: '⭐ 收藏最高', short: '收藏' },
];

// 详情页返回时的列表状态缓存：/share → /share/:id 是两个不同组件，后退时列表重挂载、
// rows 若为空则文档高度塌陷 → router 还原滚动位置会被钳回顶部。用缓存同步初始化即可避免。
// **桶住在 utils/shareKeep.js**（真模块级）—— 写在本文件顶层是 per-instance 的，见该文件注释。
const keep = shareKeep(props.ghost);
const tab = ref(keep.tab);
const sort = ref(keep.sort);
const tag = ref(keep.tag);
const page = ref(keep.page);
const rows = ref(keep.rows);
const total = ref(keep.total);
const size = 10;
const stats = ref(keep.stats || { posts: 0, likes: 0, favs: 0, comments: 0 }); // 仓库头徽标；首屏 load 前即可安全渲染
const loading = ref(false);
const tagList = ref([]);
const filterText = ref(''); // 文件表筛选框（只筛当前页，后端无搜索接口）
const scope = computed(() => (props.ghost || tab.value === 'all' ? '' : tab.value)); // 幽灵页恒不发 scope

// matchMedia 监听用具名函数 + onBeforeUnmount 移除（旧实现传匿名函数，切路由会累积监听器）
const mqNarrow = window.matchMedia('(max-width: 768px)');
const isNarrow = ref(mqNarrow.matches);
const onMq = (e) => { isNarrow.value = e.matches; };
onMounted(() => mqNarrow.addEventListener('change', onMq));
onBeforeUnmount(() => mqNarrow.removeEventListener('change', onMq));
const tabLabel = (t) => (isNarrow.value ? t.short : t.full);
const sortLabel = (s) => (isNarrow.value ? s.short : s.full);

async function load() {
  loading.value = true;
  try {
    const data = await api.sharePosts({
      sort: sort.value, tag: tag.value, page: page.value, size,
      ...(scope.value ? { scope: scope.value } : {}),
      ...(props.ghost ? { ghost: 1 } : {}),
    });
    rows.value = data.rows;
    total.value = data.total;
    if (data.stats) stats.value = data.stats;
    Object.assign(keep, {
      rows: rows.value, total: total.value, stats: stats.value,
      tab: tab.value, sort: sort.value, tag: tag.value, page: page.value,
    });
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}
async function loadTags() {
  try { tagList.value = await api.shareTags(); } catch { /* 标签加载失败不阻塞列表 */ }
}

// 切「我的帖子/我的收藏」：未登录后端必 401 → 提前拦截并引导，且**不切 tab**（否决式）
function changeTab(k) {
  if (k === tab.value) return;
  if (k !== 'all' && needLogin()) return;
  tab.value = k;
  page.value = 1;
  load();
}
function changeSort(v) { sort.value = v; page.value = 1; load(); }
function pickTag(t) { tag.value = t; page.value = 1; load(); }
function onPage(v) { page.value = v; load(); }

const needLogin = () => {
  if (auth.token) return false;
  ElMessage.warning('请先登录');
  router.push(`/login?redirect=${encodeURIComponent(route.fullPath)}`);
  return true;
};

// 点行 → 独立详情子路由。URL 才是选中态的载体，列表自己不再持有「当前帖」这份数据副本。
function pickRow(id) {
  router.push(`${props.ghost ? '/ghost-share' : '/share'}/${id}`);
}

// 老链接兼容：?post=ID（消息通知、我的帖子/收藏、历史书签、以及改版前存下的 URL）一律改写成详情子路由。
// 不在这里拉详情 —— 详情页有自己的加载链路，重定向过去就是唯一入口。
watch(() => route.query.post, (v) => {
  const n = Number(v);
  if (n) router.replace(`${props.ghost ? '/ghost-share' : '/share'}/${n}`);
}, { immediate: true });

// —— 点赞 / 收藏（toggle）——
// 详情页里那份计数由详情页自己维护；这里只写本页的行 + 头部徽标，
// 返回列表时 load() 会自愈（两处各自成立，不再需要 applyActs 同时写两份副本）
async function toggleLike(p, ev) {
  if (ev?.stopPropagation) ev.stopPropagation();
  if (needLogin()) return;
  try {
    const r = await api.shareLike(p.id);
    Object.assign(p, { is_liked: r.liked ? 1 : 0, like_count: r.count });
    stats.value.likes += r.liked ? 1 : -1; // 头部徽标同步
  } catch (e) { ElMessage.error(e.message); }
}
async function toggleFav(p, ev) {
  if (ev?.stopPropagation) ev.stopPropagation();
  if (needLogin()) return;
  try {
    const r = await api.shareFav(p.id);
    Object.assign(p, { is_faved: r.faved ? 1 : 0, fav_count: r.count });
    stats.value.favs += r.faved ? 1 : -1;
  } catch (e) { ElMessage.error(e.message); }
}

// —— 发帖 / 编辑弹窗（表单与飞书链路全在 SharePostDialog 里，本页只管开关与刷新）——
const postDlg = ref(false);
const editing = ref(null);
function openNew() {
  if (needLogin()) return;
  editing.value = null;
  postDlg.value = true;
}
// 弹窗里发生的后端变更（提交/飞书编辑/飞书同步/从飞书导入）→ 刷新列表与标签；stats 由 load() 覆盖
// 弹窗里发生的变更（提交/飞书编辑/飞书同步/从飞书导入）→ 刷新列表。
// 新建的帖子直接落到它自己的页：刚建好的项目，用户要看的就是它（详情页同一处逻辑也是这么做的）
async function onDialogChanged({ id: pid, isNew } = {}) {
  if (isNew && pid) return router.push(`${props.ghost ? '/ghost-share' : '/share'}/${pid}`);
  await load(); await loadTags();
}

const emptyText = computed(() => (tag.value
  ? `「${tag.value}」子板块还没有帖子，来开第一楼`
  : (props.ghost ? '还没有秘密帖子，来开第一座幽灵楼' : '还没有帖子，点「开楼发帖」分享第一个资源')));

onMounted(() => { load(); loadTags(); });
</script>

<template>
  <main class="share-page">
    <!-- 仓库头：面包屑 + 标题 + 描述 + 徽标 + 主按钮 -->
    <header class="gh-repohead">
      <div class="gh-crumb">
        <GhIcon name="book" :size="16" />
        <span class="gh-owner">Engineer-Compass</span>
        <span class="gh-sep">/</span>
        <b>{{ props.ghost ? '秘密分享' : '资源分享' }}</b>
        <span class="gh-vis">{{ props.ghost ? '🔒 仅怪奇可见' : '公开' }}</span>
      </div>
      <p class="gh-desc">{{ props.ghost ? '怪奇小队专属领地：幽灵帖仅幽灵可见，普通世界完全无痕' : '贴吧式交流区：分享资料/经验/作品，图文视频音频文件' }}</p>
      <div class="gh-headrow">
        <div class="gh-badges">
          <span class="gh-badge"><GhIcon name="file" :size="14" /> {{ stats.posts }} 个资源</span>
          <span class="gh-badge"><GhIcon name="thumbsup" :size="14" /> {{ stats.likes }}</span>
          <span class="gh-badge"><GhIcon name="star" :size="14" /> {{ stats.favs }}</span>
          <span class="gh-badge"><GhIcon name="comment" :size="14" /> {{ stats.comments }}</span>
          <span class="gh-badge"><GhIcon name="tag" :size="14" /> {{ tagList.length }} 个标签</span>
        </div>
        <el-button type="primary" @click="openNew">{{ props.ghost ? '👻 开幽灵帖' : '📝 开楼发帖' }}</el-button>
      </div>
    </header>

    <!-- 标签页条（幽灵页只留一个静态标签：scope 非空会绕过幽灵隔离，混进普通帖） -->
    <div class="gh-tabbar">
      <nav class="gh-tabs" role="tablist">
        <template v-if="props.ghost">
          <span class="gh-tab on static" role="tab" aria-selected="true">👻 秘密帖子</span>
        </template>
        <template v-else>
          <button
            v-for="t in TABS" :key="t.key" class="gh-tab" :class="{ on: tab === t.key }"
            role="tab" :aria-selected="tab === t.key" @click="changeTab(t.key)"
          >{{ tabLabel(t) }}</button>
        </template>
      </nav>
      <el-dropdown trigger="click" @command="changeSort">
        <button class="gh-sortbtn">{{ sortLabel(SORTS.find((s) => s.key === sort)) }} <GhIcon name="chevron-down" :size="14" /></button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="s in SORTS" :key="s.key" :command="s.key" :disabled="s.key === sort">{{ sortLabel(s) }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <!-- 两栏主体：左 = 文件表；右 = About -->
    <div class="gh-body">
      <div class="gh-main">
        <!-- 标签过滤条（选中标签时出现，可一键清除） -->
        <div v-if="tag" class="gh-filterbar">
          正在筛选子板块 <b>#{{ tag }}</b>
          <button class="gh-filterx" @click="pickTag('')">清除 ×</button>
        </div>

        <ShareFileTable
          v-model:filter="filterText" :rows="rows" :loading="loading"
          :empty-text="emptyText"
          @select="pickRow" @like="toggleLike" @fav="toggleFav"
        />

        <el-pagination v-if="total > size" class="gh-pager" background layout="prev, pager, next" :total="total"
          :page-size="size" :current-page="page" @current-change="onPage" />
      </div>

      <!-- About 侧栏：说明 + Topics（标签过滤的唯一入口） -->
      <aside class="gh-aside">
        <div class="gh-abox">
          <div class="gh-ahead">About</div>
          <p class="gh-atext">{{ props.ghost ? '幽灵帖仅幽灵账号可见，普通用户完全看不到这里的内容。' : '分享备赛资料、经验与作品。一条帖子就是一行资源，点行进入该资源的详情页（正文 / 附件 / 讨论）。' }}</p>
        </div>
        <div class="gh-abox">
          <div class="gh-ahead">Topics</div>
          <div class="gh-topics">
            <button class="gh-topic" :class="{ on: tag === '' }" @click="pickTag('')">全部</button>
            <button v-for="t in tagList" :key="t.name" class="gh-topic" :class="{ on: tag === t.name }" @click="pickTag(t.name)">
              {{ t.name }} <i>{{ t.count }}</i>
            </button>
          </div>
          <p v-if="!tagList.length" class="gh-atext dim">还没有标签，发帖时填一个即成为子板块</p>
        </div>
      </aside>
    </div>

    <SharePostDialog v-model="postDlg" :editing="editing" :tag-list="tagList" :ghost="ghost" @changed="onDialogChanged" />
  </main>
</template>

<style lang="scss" scoped>
.share-page { padding: 20px 24px 60px; max-width: 1180px; margin: 0 auto; }

// —— 仓库头 ——
.gh-repohead { margin-bottom: 14px; }
.gh-crumb {
  display: flex; align-items: center; gap: 7px; font-size: 18px; color: var(--text-2);
  .gh-owner { color: var(--primary); cursor: default; }
  .gh-sep { color: var(--text-3); }
  b { color: var(--primary); font-weight: 600; }
  .gh-vis {
    margin-left: 6px; font-size: 11.5px; color: var(--text-2);
    border: 1px solid var(--border-2); border-radius: 999px; padding: 1px 9px;
  }
}
.gh-desc { margin: 6px 0 10px; color: var(--text-2); font-size: 13px; }
.gh-headrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.gh-badges { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.gh-badge {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12.5px; color: var(--text-2);
  b { color: var(--text); }
}

// —— 标签页条：底边线通栏，页签压在线上（GitHub 的 repo 导航形态） ——
.gh-tabbar {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 10px;
  border-bottom: 1px solid var(--border-2); margin-bottom: 16px;
}
.gh-tabs { display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none;
  &::-webkit-scrollbar { display: none; }
}
.gh-tab {
  border: 0; background: transparent; cursor: pointer; font-family: inherit;
  padding: 8px 12px; font-size: 13.5px; color: var(--text-2); white-space: nowrap;
  border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color .15s;
  &:hover { color: var(--text); }
  &.on { color: var(--text); font-weight: 600; border-bottom-color: var(--primary); }
  &.static { cursor: default; }
}
.gh-sortbtn {
  display: inline-flex; align-items: center; gap: 5px; flex: none;
  border: 1px solid var(--border-2); background: var(--card-bg); color: var(--text-2);
  border-radius: 6px; padding: 4px 10px; font-size: 12.5px; cursor: pointer; font-family: inherit;
  margin-bottom: 8px;
  &:hover { border-color: var(--primary); color: var(--primary); }
}

// —— 两栏主体 ——
.gh-body { display: grid; grid-template-columns: minmax(0, 1fr) 288px; gap: 20px; align-items: start; }
.gh-main { min-width: 0; }

.gh-filterbar {
  display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
  font-size: 12.5px; color: var(--text-2);
  b { color: var(--primary); }
  .gh-filterx {
    margin-left: auto; border: 1px solid var(--border-2); background: var(--card-bg);
    color: var(--text-2); border-radius: 6px; padding: 3px 9px; font-size: 12px;
    cursor: pointer; font-family: inherit;
    &:hover { border-color: var(--primary); color: var(--primary); }
  }
}
.gh-pager { margin-top: 14px; justify-content: center; }

// —— About 侧栏 ——
.gh-aside { display: flex; flex-direction: column; gap: 14px; }
.gh-abox {
  border: 1px solid var(--border-2); border-radius: 6px; background: var(--card-bg);
  padding: 12px 14px;
}
.gh-ahead { font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
.gh-atext { margin: 0; font-size: 12.5px; line-height: 1.7; color: var(--text-2);
  &.dim { color: var(--text-3); margin-top: 8px; }
}
.gh-topics { display: flex; flex-wrap: wrap; gap: 6px; }
.gh-topic {
  border: 1px solid var(--border-2); background: var(--card-bg); color: var(--primary);
  border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer; font-family: inherit;
  transition: all .15s;
  i { font-style: normal; color: var(--text-3); margin-left: 3px; font-size: 11px; }
  &:hover { background: var(--primary-tint); border-color: var(--primary); }
  &.on { background: var(--primary); border-color: var(--primary); color: #fff;
    i { color: color-mix(in srgb, #fff 75%, transparent); } }
}

// 窄屏：两栏折单栏，About 提到表格上方（保证标签过滤仍可达）
@media (max-width: 900px) {
  .gh-body { grid-template-columns: minmax(0, 1fr); }
  .gh-aside { order: -1; }
}
@media (max-width: 768px) {
  .share-page { padding: 14px 12px 60px; }
  .gh-crumb { font-size: 16px; }
  .gh-badge:nth-child(n + 4) { display: none; } /* 徽标瘦身，留资源数/赞/藏 */
}
</style>
