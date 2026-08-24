<script setup>
// 全屏图片预览：滚轮/按钮缩放、旋转、下载、Esc/点击背景关闭
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { viewer, closeImage } from '../utils/imageViewer.js';

const scale = ref(1);
const rot = ref(0);
const PAD = 0.3; // 页面空白边距，用于滚轮缩放下限

function reset() {
  scale.value = 1;
  rot.value = 0;
}
watch(() => viewer.visible, (v) => v && reset());

function zoomBy(f) {
  scale.value = Math.min(8, Math.max(0.2, scale.value * f));
}
function onWheel(e) {
  zoomBy(e.deltaY < 0 ? 1.12 : 0.9);
}
function onKey(e) {
  if (!viewer.visible) return;
  if (e.key === 'Escape') closeImage();
  if (e.key === '+' || e.key === '=') zoomBy(1.2);
  if (e.key === '-') zoomBy(0.85);
  if (e.key === 'r' || e.key === 'R') rot.value = (rot.value + 90) % 360;
}
function onBackdrop(e) {
  if (e.target === e.currentTarget) closeImage();
}

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <div v-if="viewer.visible" class="iv-overlay" @click="onBackdrop" @wheel.prevent="onWheel">
      <img class="iv-img" :src="viewer.src" :alt="viewer.name"
        :style="{ transform: `scale(${scale}) rotate(${rot}deg)` }" />
      <div class="iv-tip">{{ viewer.name }}</div>
      <div class="iv-bar">
        <button title="缩小 (-)" @click.stop="zoomBy(0.85)">➖</button>
        <span class="iv-zoom">{{ Math.round(scale * 100) }}%</span>
        <button title="放大 (+)" @click.stop="zoomBy(1.2)">➕</button>
        <button title="旋转 (R)" @click.stop="rot = (rot + 90) % 360">⟲</button>
        <button title="1:1" @click.stop="scale = 1">1:1</button>
        <a class="iv-dl" :href="viewer.src" :download="viewer.name" title="下载">⬇ 下载</a>
        <button class="iv-close" title="关闭 (Esc)" @click.stop="closeImage">✕</button>
      </div>
    </div>
  </Teleport>
</template>

<style lang="scss" scoped>
.iv-overlay {
  position: fixed; inset: 0; z-index: 3000; background: rgba(10, 12, 18, 0.9);
  display: flex; align-items: center; justify-content: center; cursor: zoom-out;
  .iv-img {
    max-width: 90vw; max-height: 84vh; border-radius: 6px; box-shadow: 0 10px 60px rgba(0, 0, 0, 0.6);
    transition: transform 0.15s ease; user-select: none; cursor: grab;
  }
  .iv-tip {
    position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
    color: #e2e8f0; font-size: 13px; background: rgba(0, 0, 0, 0.5);
    padding: 5px 14px; border-radius: 999px; max-width: 60vw;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .iv-bar {
    position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%);
    display: flex; align-items: center; gap: 8px; background: rgba(15, 20, 30, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 12px; padding: 8px 14px;
    button, .iv-dl {
      width: 34px; height: 34px; display: flex; align-items: center; justify-content: center;
      background: rgba(255, 255, 255, 0.08); color: #e2e8f0; border: none; border-radius: 8px;
      font-size: 15px; cursor: pointer; text-decoration: none;
      &:hover { background: rgba(255, 255, 255, 0.2); }
    }
    .iv-zoom { color: #94a3b8; font-size: 12.5px; min-width: 44px; text-align: center; }
    .iv-dl { width: auto; padding: 0 12px; color: #93c5fd; font-size: 13px; }
    .iv-close { background: #dc2626; &:hover { background: #ef4444; } }
  }
}
</style>
