<template>
  <view class="page-wrap">
    <view class="seg">
      <view v-for="s in sorts" :key="s.key" class="seg-item" :class="{ on: sort === s.key }" @click="changeSort(s.key)">{{ s.label }}</view>
    </view>

    <scroll-view scroll-x class="chips" :show-scrollbar="false">
      <view class="chip" :class="{ on: !tag }" @click="changeTag('')">全部</view>
      <view v-for="t in tags" :key="t.name" class="chip" :class="{ on: tag === t.name }" @click="changeTag(t.name)">
        {{ t.name }}<text class="chip-n">{{ t.count }}</text>
      </view>
    </scroll-view>

    <EmptyState v-if="!loading && !rows.length" icon="📦" text="还没有分享内容，来发布第一个吧" btnText="发布分享" @action="goPublish" />

    <view v-for="p in rows" :key="p.id" class="card post" @click="goDetail(p)">
      <view class="p-title ellipsis-2">{{ p.title }}</view>
      <view v-if="p.content" class="p-excerpt ellipsis-2">{{ stripMd(p.content) }}</view>
      <view v-if="p.tags && p.tags.length" class="p-tags">
        <text v-for="t in p.tags" :key="t" class="tag tag-blue">#{{ t }}</text>
      </view>
      <view class="p-meta">
        <text class="p-author">{{ p.nickname || p.username }}</text>
        <text class="p-time">{{ fmt(p.create_time) }}</text>
      </view>
      <view class="p-stats">
        <text>👍 {{ p.like_count }}</text>
        <text>⭐ {{ p.fav_count }}</text>
        <text>💬 {{ p.comment_count }}</text>
        <text v-if="p.file_count">📎 {{ p.file_count }}</text>
      </view>
    </view>

    <LoadMore :loading="loading" :finished="finished" @more="loadMore" />

    <view class="fab" @click="goPublish">＋</view>
  </view>
</template>

<script setup>
import { ref } from 'vue';
import { onShow, onPullDownRefresh } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { ensureLogin } from '../../../utils/guard.js';
import EmptyState from '../../../components/EmptyState.vue';
import LoadMore from '../../../components/LoadMore.vue';

const sorts = [{ key: 'fav', label: '收藏榜' }, { key: 'hot', label: '热门' }, { key: 'new', label: '最新' }];
const sort = ref('fav');
const tag = ref('');
const tags = ref([]);
const rows = ref([]);
const page = ref(1);
const loading = ref(false);
const finished = ref(false);
const size = 10;
let firstShow = true;

function fmt(t) { return t ? String(t).slice(5, 16) : ''; }
function stripMd(s) { return String(s || '').replace(/[#*>`-]/g, '').replace(/\r?\n/g, ' ').slice(0, 120); }

async function loadTags() {
  try { tags.value = await api.shareTags(); } catch (e) { tags.value = []; }
}
async function load(reset) {
  if (loading.value) return;
  if (reset) { page.value = 1; finished.value = false; rows.value = []; }
  if (finished.value) return;
  loading.value = true;
  try {
    const r = await api.sharePosts({ sort: sort.value, tag: tag.value, page: page.value, size });
    rows.value = page.value === 1 ? r.rows : rows.value.concat(r.rows);
    finished.value = rows.value.length >= r.total;
    page.value += 1;
  } finally {
    loading.value = false;
  }
}
function loadMore() { load(false); }
function changeSort(k) {
  if (sort.value === k) return;
  sort.value = k;
  load(true);
}
function changeTag(t) {
  if (tag.value === t) return;
  tag.value = t;
  load(true);
}
function goDetail(p) { uni.navigateTo({ url: '/packageShare/pages/post/detail?id=' + p.id }); }
function goPublish() {
  if (!ensureLogin('登录后才能发布分享')) return;
  uni.navigateTo({ url: '/packageShare/pages/post/publish' });
}

onShow(() => {
  loadTags();
  // 首次由下拉/分页驱动；从发布页返回时刷新首屏
  if (firstShow) { firstShow = false; load(true); } else load(true);
});
onPullDownRefresh(async () => {
  await load(true);
  uni.stopPullDownRefresh();
});
</script>

<style lang="scss" scoped>
.seg { display: flex; background: #fff; border-radius: 16rpx; padding: 8rpx; margin-bottom: 16rpx; border: 1rpx solid #e2e8f0; }
.seg-item { flex: 1; text-align: center; font-size: 26rpx; color: #64748b; padding: 14rpx 0; border-radius: 12rpx; }
.seg-item.on { background: #2563eb; color: #fff; font-weight: 700; }
.chips { white-space: nowrap; margin-bottom: 16rpx; }
.chip { display: inline-flex; align-items: center; gap: 6rpx; background: #fff; border: 1rpx solid #e2e8f0; color: #475569; font-size: 24rpx; border-radius: 28rpx; padding: 10rpx 24rpx; margin-right: 12rpx; }
.chip.on { background: #eff6ff; border-color: #2563eb; color: #2563eb; font-weight: 700; }
.chip-n { font-size: 20rpx; color: #94a3b8; }
.post { padding: 24rpx 26rpx; }
.p-title { font-size: 30rpx; font-weight: 700; color: #1e293b; }
.p-excerpt { font-size: 25rpx; color: #64748b; margin-top: 10rpx; line-height: 1.6; }
.p-tags { display: flex; flex-wrap: wrap; gap: 8rpx; margin-top: 12rpx; }
.p-meta { display: flex; justify-content: space-between; font-size: 23rpx; color: #94a3b8; margin-top: 14rpx; }
.p-author { color: #2563eb; font-weight: 600; }
.p-stats { display: flex; gap: 26rpx; font-size: 23rpx; color: #64748b; margin-top: 10rpx; }
.fab { position: fixed; right: 36rpx; bottom: calc(60rpx + env(safe-area-inset-bottom)); width: 96rpx; height: 96rpx; border-radius: 50%; background: #2563eb; color: #fff; font-size: 56rpx; display: flex; align-items: center; justify-content: center; box-shadow: 0 8rpx 24rpx rgba(37, 99, 235, 0.4); z-index: 40; }
</style>
