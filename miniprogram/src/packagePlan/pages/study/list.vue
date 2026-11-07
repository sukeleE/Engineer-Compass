<template>
  <view class="page-wrap">
    <button class="btn btn-primary btn-block" @click="goCreate">＋ 新建学习计划</button>
    <view v-if="loading" class="empty"><view class="empty-text">加载中…</view></view>
    <EmptyState v-else-if="!list.length" icon="📚" text="还没有学习计划，告诉 AI 你想学什么" btn-text="立即创建" @action="goCreate" />
    <view v-else>
      <view v-for="s in list" :key="s.id" class="card study-card" @click="open(s.id)">
        <view class="row1">
          <text class="topic ellipsis">{{ s.topic }}</text>
          <text v-if="s.level" class="tag tag-blue">{{ s.level }}</text>
        </view>
        <view v-if="s.goal" class="goal ellipsis-2">目标：{{ s.goal }}</view>
        <view class="meta">
          <text>{{ s.phaseCount }} 个阶段 · {{ s.done }}/{{ s.total }} 任务</text>
          <text>{{ s.create_time }}</text>
        </view>
        <view class="progress-track"><view class="progress-fill" :style="{ width: percent(s) + '%' }"></view></view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { ensureLogin } from '../../../utils/guard.js';
import EmptyState from '../../../components/EmptyState.vue';

const list = ref([]);
const loading = ref(true);

function percent(s) { return s.total ? Math.round((s.done / s.total) * 100) : 0; }
function goCreate() { if (ensureLogin()) uni.navigateTo({ url: '/packagePlan/pages/study/create' }); }
function open(id) { uni.navigateTo({ url: '/packagePlan/pages/study/detail?id=' + id }); }

onShow(async () => {
  if (!ensureLogin()) { loading.value = false; return; }
  try { list.value = await api.studyList(); } finally { loading.value = false; }
});
</script>

<style lang="scss" scoped>
.study-card { margin-top: 18rpx; }
.row1 { display: flex; align-items: center; justify-content: space-between; gap: 16rpx; }
.topic { font-size: 31rpx; font-weight: 700; color: #1e293b; flex: 1; }
.goal { font-size: 25rpx; color: #64748b; margin-top: 10rpx; }
.meta { display: flex; justify-content: space-between; font-size: 23rpx; color: #94a3b8; margin: 14rpx 0 10rpx; }
.progress-track { height: 12rpx; background: #f1f5f9; border-radius: 6rpx; overflow: hidden; }
.progress-fill { height: 100%; background: linear-gradient(90deg, #2563eb, #60a5fa); }
</style>