<script setup>
// 项目文件夹的目录树（一条帖子 = 一个项目）
//
// 为什么是「扁平化 + 一个 v-for」而不是 ElTree，也不递归组件：
// 全站同类组件（ShareFileTable/ShareReadme）都是手写 CSS + v-for，缩进靠 padding-left；
// ElTree 要自带主题、在幽灵暗色下得二次调色，递归组件又要额外传 depth/expanded 上下文。
// 服务端不存目录行 —— 目录全部由 path 前缀推导（buildTree），空目录不可能存在
// （webkitdirectory 本就拿不到空目录），如实接受。
import { computed, ref, watch } from 'vue';
import { buildTree, flattenVisible, allDirPaths, fmtSize, fileKind, KIND_ICON, isTextLike } from '../../utils/share.js';
import GhIcon from './GhIcon.vue';

const props = defineProps({
  files: { type: Array, default: () => [] },
  selectedId: { type: [Number, String], default: null },
});
const emit = defineEmits(['select']);

const tree = computed(() => buildTree(props.files));
const expanded = ref(new Set());

const expandAll = () => { expanded.value = new Set(allDirPaths(tree.value)); };
// 树一变（换帖/换项目）就默认全展开 —— 用户要的是「一眼看到内部结构」
watch(tree, expandAll, { immediate: true });

const flat = computed(() => flattenVisible(tree.value, expanded.value));
const toggle = (node) => {
  const s = new Set(expanded.value);
  s.has(node.path) ? s.delete(node.path) : s.add(node.path);
  expanded.value = s;
};
const allOpen = computed(() => flat.value.every((r) => !r.node.dir || expanded.value.has(r.node.path)));

const totalSize = computed(() => props.files.reduce((s, f) => s + (Number(f.size) || 0), 0));
const dirCount = computed(() => allDirPaths(tree.value).length);
const isSel = (n) => !n.dir && String(n.file?.id) === String(props.selectedId);
// 右侧副信息：目录显示条目数，文件显示体积（+ 可在页内预览的标记）
const sub = (n) => {
  if (n.dir) return `${n.children.length} 项`;
  const f = n.file || {};
  const canPrev = isTextLike(f.mime, f.name) || /^(image\/(?!svg)|application\/pdf|audio\/|video\/)/.test(String(f.mime || ''));
  return [fmtSize(f.size), canPrev ? '可预览' : '', f.source === 'gitee' ? 'Gitee' : ''].filter(Boolean).join(' · ');
};
</script>

<template>
  <div class="ft-wrap">
    <div class="ft-head">
      <span class="ft-title">
        <GhIcon name="file-directory-fill" :size="15" />
        项目文件
        <span class="ft-meta">{{ files.length }} 个文件 · {{ dirCount }} 个文件夹 · {{ fmtSize(totalSize) }}</span>
      </span>
      <button class="ft-toggle" :title="allOpen ? '全部收起' : '全部展开'" @click="allOpen ? (expanded = new Set()) : expandAll()">
        {{ allOpen ? '全部收起' : '全部展开' }}
      </button>
    </div>

    <div class="ft-body">
      <div
        v-for="({ node, depth }) in flat" :key="node.path"
        class="ft-row" :class="{ dir: node.dir, sel: isSel(node) }"
        :style="{ paddingLeft: (10 + depth * 14) + 'px' }"
        role="button" :tabindex="0"
        @click="node.dir ? toggle(node) : emit('select', node.file)"
        @keyup.enter="node.dir ? toggle(node) : emit('select', node.file)"
      >
        <span class="ft-caret" :class="{ open: node.dir && expanded.has(node.path), hide: !node.dir }">
          <GhIcon name="chevron-right" :size="12" />
        </span>
        <GhIcon
          v-if="node.dir" :name="expanded.has(node.path) ? 'file-directory-fill' : 'file-directory'" :size="16" class="ft-icon dir"
        />
        <!-- Gitee 条目用仓库图标，一眼区分「本站上传的文件」与「仓库里拉来的文件」 -->
        <GhIcon
          v-else :name="node.file.source === 'gitee' ? 'repo' : KIND_ICON[fileKind(node.file)]" :size="16"
          class="ft-icon" :class="{ gitee: node.file.source === 'gitee' }"
        />
        <span class="ft-name" :title="node.path">{{ node.name }}</span>
        <span class="ft-sub">{{ sub(node) }}</span>
      </div>

      <p v-if="!flat.length" class="ft-empty">这个项目还没有文件</p>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.ft-wrap {
  border: 1px solid var(--border-2);
  border-radius: 6px;
  background: var(--card-bg);
  overflow: hidden;
}
.ft-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 8px 12px; background: var(--surface-1); border-bottom: 1px solid var(--border);
  font-size: 12px; color: var(--text-2);
}
.ft-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ft-meta { color: var(--text-3); }
.ft-toggle {
  flex: none; border: 1px solid var(--border-2); background: var(--card-bg); color: var(--text-2);
  border-radius: 6px; padding: 2px 8px; font-size: 12px; cursor: pointer; font-family: inherit;
  &:hover { color: var(--text); border-color: var(--text-3); }
}
.ft-body { max-height: 460px; overflow: auto; }

.ft-row {
  display: flex; align-items: center; gap: 6px;
  height: 32px; padding-right: 12px; font-size: 13px; color: var(--text-2);
  cursor: pointer; outline: none;
  &:hover { background: var(--surface-1); }
  &:focus-visible { box-shadow: inset 0 0 0 2px var(--primary); }
  &.sel { background: var(--surface-3); color: var(--text); }
  &.dir .ft-name { color: var(--text); font-weight: 500; }
  &.dir:hover { background: var(--surface-2); }
}
.ft-caret {
  flex: none; width: 12px; display: inline-flex; color: var(--text-3);
  transition: transform .12s ease;
  &.open { transform: rotate(90deg); }
  &.hide { visibility: hidden; }
}
.ft-icon { flex: none; color: var(--text-3); &.dir { color: var(--badge-fg, #d29922); } &.gitee { color: var(--primary); } }
.ft-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ft-sub { flex: none; font-size: 11px; color: var(--text-3); }
.ft-kind { flex: none; font-size: 11px; color: var(--text-3); min-width: 24px; text-align: right; }
.ft-empty { padding: 20px; text-align: center; font-size: 13px; color: var(--text-3); }

@media (max-width: 640px) {
  .ft-sub { display: none; }
}
</style>
