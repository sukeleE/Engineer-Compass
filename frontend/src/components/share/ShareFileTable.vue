<script setup>
// 资源分享页的「文件列表」表格（GitHub 仓库页的文件表形态）
// 一行 = 一条帖子；行点击 = 选中并在下方 README 区展开（不再弹详情弹窗）
// 点赞/收藏按钮保留内联可点（@click.stop 阻止冒泡到行选中），行为与旧卡片流一致
import { computed } from 'vue';
import { cnt, postKind, KIND_ICON } from '../../utils/share.js';
import { fmtDateTime, fmtRelative } from '../../utils/time.js';
import GhIcon from './GhIcon.vue';

const props = defineProps({
  rows: { type: Array, default: () => [] },
  selectedId: { type: [Number, String, null], default: null },
  loading: { type: Boolean, default: false },
  emptyText: { type: String, default: '' }, // 由父层按 标签/幽灵页 分支算好传入
});
const emit = defineEmits(['select', 'like', 'fav']);

// 筛选框双向绑定（纯前端筛当前页，无后端搜索接口）
const filter = defineModel('filter', { type: String, default: '' });

// 只筛当前页 —— 后端无搜索接口，文案里也如实写「本页」
const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return props.rows;
  return props.rows.filter((p) =>
    String(p.title || '').toLowerCase().includes(q) ||
    String(p.nickname || '').toLowerCase().includes(q) ||
    (p.tags || []).some((t) => String(t).toLowerCase().includes(q)));
});

const stamp = (p) => p.update_time || p.create_time;
</script>

<template>
  <div class="gh-filebox">
    <!-- 筛选条（GitHub 的「Go to file」位置：我们只筛本页，故如实标注） -->
    <div class="gh-fhead">
      <span class="gh-search">
        <GhIcon name="search" :size="14" />
        <input v-model="filter" type="text" placeholder="筛选本页资源…" aria-label="筛选本页资源" />
        <button v-if="filter" class="gh-clear" title="清除筛选" @click="filter = ''">×</button>
      </span>
    </div>

    <!-- 表头 -->
    <div class="gh-thead" aria-hidden="true">
      <span class="c-name">名称</span>
      <span class="c-author">作者</span>
      <span class="c-acts">互动</span>
      <span class="c-time">更新时间</span>
    </div>

    <div v-loading="loading" class="gh-tbody">
      <div
        v-for="p in filtered" :key="p.id" class="gh-row"
        :class="{ sel: String(p.id) === String(selectedId) }"
        role="button" tabindex="0"
        @click="emit('select', p.id)" @keyup.enter="emit('select', p.id)"
      >
        <span class="c-name">
          <GhIcon :name="KIND_ICON[postKind(p)]" :size="16" class="gh-ficon" />
          <span class="gh-fname" :title="p.title">{{ p.title }}</span>
        </span>
        <span class="c-author" :title="p.nickname">{{ p.nickname }}</span>
        <span class="c-acts">
          <button class="gh-act" :class="{ on: p.is_liked }" title="点赞" @click.stop="emit('like', p)">👍 {{ cnt(p.like_count) }}</button>
          <button class="gh-act" :class="{ on: p.is_faved }" title="收藏" @click.stop="emit('fav', p)">⭐ {{ cnt(p.fav_count) }}</button>
          <span class="gh-act plain" title="评论">💬 {{ cnt(p.comment_count) }}</span>
        </span>
        <span class="c-time" :title="fmtDateTime(stamp(p))">{{ fmtRelative(stamp(p)) }}</span>
      </div>

      <!-- 空态：区分「本页无数据」与「筛选无命中」——后者给清除入口 -->
      <div v-if="!loading && !filtered.length" class="gh-empty">
        <template v-if="filter">
          <p>本页没有匹配「{{ filter }}」的资源</p>
          <button class="gh-empty-btn" @click="filter = ''">清除筛选</button>
        </template>
        <p v-else class="gh-empty-hint">{{ emptyText || '这一页还没有资源' }}</p>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.gh-filebox {
  border: 1px solid var(--border-2);
  border-radius: 6px;
  background: var(--card-bg);
  overflow: hidden;
}

.gh-fhead { padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--surface-1); }
.gh-search {
  display: flex; align-items: center; gap: 6px;
  border: 1px solid var(--border-2); border-radius: 6px; background: var(--card-bg);
  padding: 4px 10px; color: var(--text-3);
  input {
    flex: 1; min-width: 0; border: 0; outline: none; background: transparent;
    color: var(--text); font-size: 13px; font-family: inherit;
    &::placeholder { color: var(--text-3); }
  }
  .gh-clear {
    border: 0; background: transparent; cursor: pointer; color: var(--text-3);
    font-size: 16px; line-height: 1; padding: 0 2px;
    &:hover { color: var(--text); }
  }
}

.gh-thead, .gh-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 110px 150px 100px;
  gap: 10px; align-items: center; padding: 0 14px;
}
.gh-thead {
  height: 36px; font-size: 12px; color: var(--text-2);
  background: var(--surface-1); border-bottom: 1px solid var(--border);
}
.gh-tbody { min-height: 120px; }

.gh-row {
  height: 44px; font-size: 13px; color: var(--text-2);
  border-bottom: 1px solid var(--border); cursor: pointer;
  &:last-of-type { border-bottom: 0; }
  &:hover { background: var(--surface-1); }
  &:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
  &.sel { background: var(--primary-tint); box-shadow: inset 3px 0 0 var(--primary); }
  .c-name { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--text); }
  .gh-ficon { color: var(--text-3); }
  &.sel .gh-ficon { color: var(--primary); }
  .gh-fname {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    &:hover { color: var(--primary); text-decoration: underline; }
  }
  &.sel .gh-fname { font-weight: 600; color: var(--primary); }
  .c-author { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .c-time { text-align: right; color: var(--text-3); font-size: 12.5px; white-space: nowrap; }
  .c-acts { display: flex; gap: 8px; align-items: center; }
}

.gh-act {
  border: 0; background: transparent; padding: 0; cursor: default;
  font-size: 12.5px; color: var(--text-3); font-family: inherit;
  &.on { color: var(--primary); font-weight: 600; }
  &:not(.plain) { cursor: pointer; &:hover { color: var(--primary); } }
}

.gh-empty {
  padding: 30px 16px; text-align: center; color: var(--text-3); font-size: 13px;
  p { margin: 0 0 10px; }
  .gh-empty-hint { margin: 0; }
  .gh-empty-btn {
    border: 1px solid var(--border-2); background: var(--card-bg); color: var(--text);
    border-radius: 6px; padding: 5px 12px; font-size: 12.5px; cursor: pointer;
    &:hover { border-color: var(--primary); color: var(--primary); }
  }
}

// 窄屏：藏掉作者与互动列，名称独占（两栏布局也在此时折叠）
@media (max-width: 768px) {
  .gh-thead .c-author, .gh-thead .c-acts,
  .gh-row .c-author, .gh-row .c-acts { display: none; }
  .gh-thead, .gh-row { grid-template-columns: minmax(0, 1fr) 78px; }
}
</style>
