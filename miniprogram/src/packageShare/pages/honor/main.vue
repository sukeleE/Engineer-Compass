<template>
  <view class="page-wrap">
    <scroll-view scroll-x class="chips" :show-scrollbar="false">
      <view class="chip" :class="{ on: !tag }" @click="tag = ''">全部</view>
      <view v-for="t in tagList" :key="t.name" class="chip" :class="{ on: tag === t.name }" @click="tag = t.name">{{ t.name }}</view>
    </scroll-view>

    <EmptyState v-if="!loading && !filtered.length" icon="🏆" text="暂无荣誉记录" />

    <view v-for="h in filtered" :key="h.id" class="card honor" @click="openDetail(h)">
      <image v-if="h.image_url" :src="absoluteUrl(h.image_url)" class="h-img" mode="aspectFill" @click.stop="previewHonor(h)" />
      <view v-else class="h-placeholder">🏆</view>
      <view class="h-body">
        <view class="h-title">{{ h.title }}</view>
        <view v-if="h.winner" class="h-line">获奖人：{{ h.winner }}</view>
        <view class="h-tags">
          <text v-if="h.prize_rank" class="tag tag-amber">{{ h.prize_rank }}</text>
          <text v-if="h.award_level" class="tag tag-blue">{{ h.award_level }}</text>
          <text v-for="c in h.class_tags" :key="c" class="tag tag-gray">{{ c }}</text>
        </view>
        <view v-if="h.event_name" class="h-line">赛项：{{ h.event_name }}</view>
        <view v-if="h.award_date" class="h-time">{{ h.award_date }}</view>
      </view>
    </view>

    <view v-if="current" class="modal-mask" @click="current = null">
      <view class="modal" @click.stop>
        <view class="modal-title">{{ current.title }}</view>
        <scroll-view scroll-y class="modal-scroll">
          <image v-if="current.image_url" :src="absoluteUrl(current.image_url)" class="modal-img" mode="widthFix" @click="previewHonor(current)" />
          <view v-if="current.winner" class="m-line">获奖人：{{ current.winner }}</view>
          <view v-if="current.event_name" class="m-line">赛项：{{ current.event_name }}</view>
          <view v-if="current.award_level" class="m-line">授予级别：{{ current.award_level }}</view>
          <view v-if="current.prize_rank" class="m-line">奖等：{{ current.prize_rank }}</view>
          <view v-if="current.award_date" class="m-line">获奖日期：{{ current.award_date }}</view>
          <view v-if="current.class_tags.length" class="m-line">班级：{{ current.class_tags.join('、') }}</view>
          <view v-if="current.description" class="m-desc">{{ current.description }}</view>
        </scroll-view>
        <button class="btn btn-primary modal-btn" @click="current = null">关闭</button>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { absoluteUrl, previewImages } from '../../../utils/preview.js';
import EmptyState from '../../../components/EmptyState.vue';

const list = ref([]);
const tagList = ref([]);
const tag = ref('');
const current = ref(null);
const loading = ref(true);

const filtered = computed(() => {
  if (!tag.value) return list.value;
  return list.value.filter((h) => (h.class_tags || []).indexOf(tag.value) >= 0);
});

async function load() {
  loading.value = true;
  try {
    const [r, t] = await Promise.all([api.honors(), api.honorTags()]);
    list.value = r.list || [];
    tagList.value = t || [];
  } finally {
    loading.value = false;
  }
}
function openDetail(h) { current.value = h; }
function previewHonor(h) { previewImages([absoluteUrl(h.image_url)]); }

onShow(load);
</script>

<style lang="scss" scoped>
.chips { white-space: nowrap; margin-bottom: 16rpx; }
.chip { display: inline-block; background: #fff; border: 1rpx solid #e2e8f0; color: #475569; font-size: 24rpx; border-radius: 28rpx; padding: 10rpx 24rpx; margin-right: 12rpx; }
.chip.on { background: #eff6ff; border-color: #2563eb; color: #2563eb; font-weight: 700; }
.honor { display: flex; gap: 20rpx; }
.h-img { width: 180rpx; height: 180rpx; border-radius: 14rpx; flex-shrink: 0; background: #f1f5f9; }
.h-placeholder { width: 180rpx; height: 180rpx; border-radius: 14rpx; background: #fef3c7; display: flex; align-items: center; justify-content: center; font-size: 72rpx; flex-shrink: 0; }
.h-body { flex: 1; min-width: 0; }
.h-title { font-size: 29rpx; font-weight: 800; color: #1e293b; line-height: 1.4; }
.h-line { font-size: 24rpx; color: #64748b; margin-top: 8rpx; }
.h-tags { display: flex; flex-wrap: wrap; gap: 8rpx; margin-top: 10rpx; }
.h-time { font-size: 22rpx; color: #94a3b8; margin-top: 8rpx; }
.modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,0.45); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 48rpx; }
.modal { width: 100%; background: #fff; border-radius: 24rpx; padding: 32rpx; max-height: 80vh; display: flex; flex-direction: column; }
.modal-title { font-size: 32rpx; font-weight: 800; text-align: center; margin-bottom: 18rpx; }
.modal-scroll { max-height: 56vh; }
.modal-img { width: 100%; border-radius: 14rpx; margin-bottom: 18rpx; }
.m-line { font-size: 26rpx; color: #334155; margin-bottom: 10rpx; }
.m-desc { font-size: 25rpx; color: #64748b; line-height: 1.7; background: #f8fafc; border-radius: 12rpx; padding: 18rpx; }
.modal-btn { margin-top: 18rpx; }
</style>
