<template>
  <view v-if="visible" class="picker-mask" @click="emit('close')">
    <view class="picker-panel" @click.stop>
      <view class="picker-head">
        <view class="picker-heading">
          <text class="picker-title">{{ title || '选择竞赛' }}</text>
          <text class="picker-sub">选择一个竞赛后继续使用 AI 功能</text>
        </view>
        <text class="picker-close" @click="emit('close')">×</text>
      </view>

      <input
        v-model="keyword"
        class="picker-search"
        placeholder="搜索竞赛名称或类型"
        confirm-type="search"
      />

      <scroll-view scroll-y class="picker-list">
        <view v-if="loading" class="picker-state">正在加载竞赛...</view>
        <view v-else-if="!filtered.length" class="picker-state">没有匹配的竞赛</view>
        <view v-for="comp in filtered" :key="comp.id" class="picker-item" @click="choose(comp)">
          <view class="picker-item-main">
            <text class="picker-item-name">{{ comp.name }}</text>
            <text class="picker-item-meta">{{ comp.short_name || comp.type || '竞赛' }}</text>
          </view>
          <text class="picker-item-action">选择</text>
        </view>
      </scroll-view>
    </view>
  </view>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { api } from '../utils/api.js';

const props = defineProps({
  visible: { type: Boolean, default: false },
  title: { type: String, default: '选择竞赛' },
});
const emit = defineEmits(['close', 'select']);

const competitions = ref([]);
const keyword = ref('');
const loading = ref(false);

const filtered = computed(() => {
  const text = keyword.value.trim().toLowerCase();
  if (!text) return competitions.value;
  return competitions.value.filter((comp) => {
    const haystack = `${comp.name || ''} ${comp.short_name || ''} ${comp.type || ''}`.toLowerCase();
    return haystack.includes(text);
  });
});

async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    const rows = await api.competitions();
    competitions.value = Array.isArray(rows) ? rows : [];
  } finally {
    loading.value = false;
  }
}

function choose(comp) {
  emit('select', comp);
}

watch(() => props.visible, (visible) => {
  if (!visible) return;
  keyword.value = '';
  if (!competitions.value.length) load();
});
</script>

<style lang="scss" scoped>
.picker-mask {
  position: fixed;
  inset: 0;
  z-index: 220;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 32rpx 24rpx calc(32rpx + env(safe-area-inset-bottom));
  background: rgba(15, 23, 42, .48);
}
.picker-panel {
  width: 100%;
  max-height: 82vh;
  box-sizing: border-box;
  padding: 28rpx 24rpx 24rpx;
  border-radius: 20rpx;
  background: #fff;
  display: flex;
  flex-direction: column;
}
.picker-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20rpx; }
.picker-heading { flex: 1; min-width: 0; }
.picker-title { display: block; color: #0f172a; font-size: 32rpx; font-weight: 800; }
.picker-sub { display: block; margin-top: 6rpx; color: #64748b; font-size: 22rpx; }
.picker-close { width: 54rpx; height: 54rpx; color: #94a3b8; font-size: 42rpx; line-height: 50rpx; text-align: center; }
.picker-search {
  height: 76rpx;
  box-sizing: border-box;
  margin: 22rpx 0 14rpx;
  padding: 0 20rpx;
  border: 1rpx solid #e2e8f0;
  border-radius: 12rpx;
  background: #f8fafc;
  color: #334155;
  font-size: 25rpx;
}
.picker-list { flex: 1; min-height: 260rpx; max-height: 58vh; }
.picker-state { padding: 100rpx 20rpx; text-align: center; color: #94a3b8; font-size: 24rpx; }
.picker-item {
  display: flex;
  align-items: center;
  gap: 18rpx;
  padding: 20rpx 4rpx;
  border-bottom: 1rpx solid #f1f5f9;
}
.picker-item-main { flex: 1; min-width: 0; }
.picker-item-name { display: block; color: #1e293b; font-size: 26rpx; font-weight: 700; line-height: 1.45; }
.picker-item-meta { display: block; margin-top: 6rpx; color: #94a3b8; font-size: 21rpx; }
.picker-item-action { color: #2563eb; font-size: 23rpx; font-weight: 700; flex-shrink: 0; }
</style>
