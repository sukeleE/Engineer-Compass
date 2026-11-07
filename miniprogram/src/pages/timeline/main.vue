<template>
  <view class="page-wrap">
    <!-- 搜索框 -->
    <view class="search-bar">
      <input
        v-model="keyword"
        class="search-input"
        placeholder="搜索竞赛名称 / 简称"
        confirm-type="search"
        @confirm="doSearch"
      />
      <text v-if="searchMode" class="search-cancel" @click="exitSearch">取消</text>
    </view>

    <!-- 搜索结果模式 -->
    <block v-if="searchMode">
      <view v-if="searching" class="empty"><view class="empty-text">搜索中…</view></view>
      <block v-else>
        <view v-if="searchResults.length" class="card comp-card" v-for="c in searchResults" :key="c.id" @click="openDetail(c.id)">
          <comp-card-row :c="c" />
        </view>
        <view v-else class="empty">
          <view class="empty-icon">🔍</view>
          <view class="empty-text">未收录「{{ keyword }}」</view>
          <view class="text-muted" style="margin-bottom: 24rpx">可在 H5 版走 AI 收录流程提交官方资料，审核通过后小程序同步可见</view>
        </view>
      </block>
    </block>

    <!-- 常规浏览模式 -->
    <block v-else>
      <!-- 筛选条 -->
      <scroll-view scroll-x class="chip-row" :show-scrollbar="false">
        <view class="chip" :class="{ active: filterType === '全部' }" @click="filterType = '全部'">全部赛道</view>
        <view v-for="t in types" :key="t" class="chip" :class="{ active: filterType === t }" @click="filterType = t">{{ t }}</view>
      </scroll-view>
      <scroll-view scroll-x class="chip-row" :show-scrollbar="false">
        <view class="chip diff" :class="{ active: filterDiff === 0 }" @click="filterDiff = 0">全部难度</view>
        <view v-for="d in 5" :key="d" class="chip diff" :class="{ active: filterDiff === d }" @click="filterDiff = d">{{ d }} 星</view>
      </scroll-view>

      <!-- 月份切换 -->
      <scroll-view scroll-x class="month-row" :show-scrollbar="false">
        <view class="month-chip" :class="{ active: activeMonth === 0 }" @click="activeMonth = 0">全年</view>
        <view v-for="m in 12" :key="m" class="month-chip" :class="{ active: activeMonth === m }" @click="activeMonth = m">{{ m }}月</view>
        <view class="month-chip" :class="{ active: activeMonth === -1 }" @click="activeMonth = -1">待定</view>
      </scroll-view>

      <view v-if="loading" class="empty"><view class="empty-text">加载中…</view></view>
      <block v-else>
        <view v-for="g in groups" :key="g.label" class="month-group">
          <view class="group-title">{{ g.label }}</view>
          <view v-for="c in g.items" :key="c.id" class="card comp-card" @click="openDetail(c.id)">
            <comp-card-row :c="c" />
          </view>
        </view>
        <EmptyState v-if="!groups.length" icon="🏁" text="该筛选条件下暂无竞赛" />
      </block>
    </block>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onLoad, onPullDownRefresh } from '@dcloudio/uni-app';
import { api } from '../../utils/api.js';
import { MONTHS } from '../../utils/format.js';
import EmptyState from '../../components/EmptyState.vue';
import CompCardRow from './CompCardRow.vue';

const list = ref([]);
const loading = ref(true);
const keyword = ref('');
const searchMode = ref(false);
const searching = ref(false);
const searchResults = ref([]);

const filterType = ref('全部');
const filterDiff = ref(0);
const activeMonth = ref(0); // 0=全年, 1-12=指定月, -1=时间待定

const types = computed(() => [...new Set(list.value.map((c) => c.type).filter(Boolean))]);

const filtered = computed(() =>
  list.value.filter((c) => {
    if (filterType.value !== '全部' && c.type !== filterType.value) return false;
    if (filterDiff.value && Number(c.difficulty) !== filterDiff.value) return false;
    return true;
  })
);

const groups = computed(() => {
  const f = filtered.value;
  const withMonth = f.filter((c) => c.start_month);
  const pending = f.filter((c) => !c.start_month);
  if (activeMonth.value === -1) return pending.length ? [{ label: '⏳ 时间待定', items: pending }] : [];
  if (activeMonth.value === 0) {
    const gs = MONTHS.map((label, i) => {
      const items = withMonth.filter((c) => Number(c.start_month) === i + 1);
      return { label: `${label} · ${items.length} 项`, items };
    }).filter((g) => g.items.length);
    if (pending.length) gs.push({ label: `⏳ 时间待定 · ${pending.length} 项`, items: pending });
    return gs;
  }
  const items = withMonth.filter((c) => Number(c.start_month) === activeMonth.value);
  return items.length ? [{ label: `${activeMonth.value}月 · ${items.length} 项`, items }] : [];
});

async function loadList() {
  loading.value = true;
  try {
    list.value = await api.competitions();
  } finally {
    loading.value = false;
  }
}

async function doSearch() {
  const q = keyword.value.trim();
  if (!q) return;
  searchMode.value = true;
  searching.value = true;
  try {
    const res = await api.search(q);
    searchResults.value = res.results || [];
  } catch {
    searchResults.value = [];
  } finally {
    searching.value = false;
  }
}

function exitSearch() {
  searchMode.value = false;
  keyword.value = '';
  searchResults.value = [];
}

function openDetail(id) {
  uni.navigateTo({ url: `/packageCompetition/pages/detail/main?id=${id}` });
}

onLoad(loadList);
onPullDownRefresh(async () => {
  await loadList();
  uni.stopPullDownRefresh();
});
</script>

<style lang="scss" scoped>
.search-bar {
  display: flex;
  align-items: center;
  gap: 16rpx;
  margin-bottom: 20rpx;
}
.search-input {
  flex: 1;
  height: 76rpx;
  background: #fff;
  border: 1rpx solid #e2e8f0;
  border-radius: 38rpx;
  padding: 0 30rpx;
  font-size: 27rpx;
}
.search-cancel { color: #2563eb; font-size: 27rpx; padding: 0 8rpx; }

.chip-row, .month-row { white-space: nowrap; margin-bottom: 14rpx; }
.chip, .month-chip {
  display: inline-flex;
  align-items: center;
  height: 60rpx;
  padding: 0 26rpx;
  margin-right: 14rpx;
  border-radius: 30rpx;
  background: #fff;
  border: 1rpx solid #e2e8f0;
  color: #475569;
  font-size: 25rpx;
}
.chip.active, .month-chip.active { background: #2563eb; border-color: #2563eb; color: #fff; }
.chip.diff.active { background: #1d4ed8; border-color: #1d4ed8; }

.month-chip { background: #f1f5f9; border-color: transparent; }
.group-title {
  font-size: 26rpx;
  font-weight: 700;
  color: #64748b;
  margin: 26rpx 8rpx 14rpx;
}
.comp-card { margin-bottom: 16rpx; }
</style>