<template>
  <view class="page-wrap detail">
    <view v-if="loading" class="empty"><view class="empty-text">加载中…</view></view>
    <block v-else-if="comp">
      <!-- 待核实提示（AI/用户收录未转正）-->
      <view v-if="comp.status === 'pending'" class="verify-banner">
        ⚠️ 该竞赛为 AI/用户收录，信息待管理员核实，请以官网为准
      </view>

      <!-- 基础信息 -->
      <view class="card">
        <view class="comp-title">{{ comp.name }}</view>
        <view class="meta-row">
          <text class="tag" :style="{ background: typeColor(comp.type) + '1a', color: typeColor(comp.type) }">{{ comp.type || '未分类' }}</text>
          <text class="stars">{{ difficultyStars(comp.difficulty) }}</text>
          <text v-if="comp.cycle" class="text-muted text-small">{{ comp.cycle }}</text>
        </view>
        <view v-if="comp.intro" class="intro">{{ comp.intro }}</view>

        <view class="info-grid">
          <view v-if="comp.suitable_major" class="info-item">
            <text class="info-label">适合专业</text><text class="info-value">{{ comp.suitable_major }}</text>
          </view>
          <view v-if="comp.sign_start || comp.sign_end" class="info-item">
            <text class="info-label">报名时间</text><text class="info-value">{{ comp.sign_start || '?' }} ~ {{ comp.sign_end || '?' }}</text>
          </view>
          <view v-if="comp.province_time" class="info-item">
            <text class="info-label">省赛时间</text><text class="info-value">{{ comp.province_time }}</text>
          </view>
          <view v-if="comp.national_time" class="info-item">
            <text class="info-label">国赛时间</text><text class="info-value">{{ comp.national_time }}</text>
          </view>
        </view>

        <view v-if="comp.source_url" class="source" @click="copyLink(comp.source_url)">
          <text class="text-small text-muted">信息来源（点击复制）：</text>
          <text class="source-url ellipsis">{{ comp.source_url }}</text>
        </view>
      </view>

      <!-- 分段切换 -->
      <view class="seg">
        <view v-for="t in tabs" :key="t.key" class="seg-item" :class="{ active: tab === t.key }" @click="tab = t.key">{{ t.label }}</view>
      </view>

      <!-- 备赛流程 -->
      <block v-if="tab === 'process'">
        <view v-for="(p, i) in comp.process" :key="p.id" class="card phase-card">
          <view class="phase-head">
            <text class="phase-index">{{ i + 1 }}</text>
            <text class="phase-name">{{ p.phase_name }}</text>
            <text v-if="p.suggest_month" class="tag tag-gray">{{ p.suggest_month }}月启动</text>
          </view>
          <view v-if="p.phase_desc" class="phase-desc">{{ p.phase_desc }}</view>
          <view v-if="p.check_standard" class="standard">
            <text class="standard-label">达标要求</text>
            <text class="standard-text">{{ p.check_standard }}</text>
          </view>
        </view>
        <EmptyState v-if="!comp.process?.length" icon="📋" text="暂无备赛流程数据" />
      </block>

      <!-- 技术栈树 -->
      <block v-else-if="tab === 'tree'">
        <view class="card">
          <TechTree v-if="tree.length" :nodes="tree" :default-expand-level="1" />
          <EmptyState v-else icon="🌳" text="暂无技术栈数据" />
        </view>
      </block>

      <!-- 学习资源 -->
      <block v-else>
        <view v-for="g in mediaGroups" :key="g.category" class="media-group">
          <view class="section-title">{{ g.label }}（{{ g.items.length }}）</view>
          <view v-for="m in g.items" :key="m.id" class="card media-item" @click="copyLink(m.url)">
            <view class="media-title ellipsis">{{ m.title || m.keyword || '学习资源' }}</view>
            <view class="media-meta">
              <text class="tag tag-blue">{{ platformName(m.platform) }}</text>
              <text v-if="m.tech_node" class="text-small text-muted ellipsis">{{ m.tech_node }}</text>
            </view>
          </view>
        </view>
        <EmptyState v-if="!mediaGroups.length" icon="📚" text="暂无学习资源" />
      </block>
    </block>

    <!-- 底部操作栏 -->
    <view v-if="comp" class="action-bar">
      <button class="btn btn-ghost" @click="openChat">AI 问答</button>
      <button class="btn btn-primary" :disabled="adding" @click="addSchedule">{{ adding ? '生成中…' : '加入备赛日程' }}</button>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { buildTree, typeColor, difficultyStars } from '../../../utils/format.js';
import { isLoggedIn } from '../../../utils/auth.js';
import TechTree from '../../../components/TechTree.vue';
import EmptyState from '../../../components/EmptyState.vue';

const compId = ref(null);
const comp = ref(null);
const loading = ref(true);
const adding = ref(false);
const tab = ref('process');
const tabs = [
  { key: 'process', label: '备赛流程' },
  { key: 'tree', label: '技术栈' },
  { key: 'media', label: '学习资源' },
];

const tree = computed(() => {
  const rows = (comp.value?.process || []).flatMap((p) => p.tech_stack || []);
  return buildTree(rows);
});

const MEDIA_CATEGORY = { intro: '竞赛介绍', process: '备赛流程', knowledge: '知识点' };
const mediaGroups = computed(() => {
  const map = new Map();
  for (const m of comp.value?.media || []) {
    if (!map.has(m.category)) map.set(m.category, { category: m.category, label: MEDIA_CATEGORY[m.category] || m.category, items: [] });
    map.get(m.category).items.push(m);
  }
  return [...map.values()];
});

function platformName(p) {
  const names = { bilibili: 'B站', zhihu: '知乎', csdn: 'CSDN', wechat: '公众号', douyin: '抖音', cnki: '知网', github: 'GitHub', tencent: '腾讯', robomaster: 'RoboMaster' };
  return names[p] || p || '网络';
}

function copyLink(url) {
  if (!url) return;
  uni.setClipboardData({
    data: url,
    success: () => uni.showToast({ title: '链接已复制，到浏览器打开', icon: 'none' }),
  });
}

function openChat() {
  const compName = comp.value?.name || '';
  const url = `/packageCompetition/pages/chat/main?id=${compId.value}&name=${encodeURIComponent(compName)}`;
  uni.navigateTo({ url });
}

async function addSchedule() {
  if (!isLoggedIn()) {
    uni.showModal({
      title: '需要登录',
      content: '备赛日程需登录后保存到你的账号，是否前往登录？',
      confirmText: '去登录',
      success: (m) => { if (m.confirm) uni.navigateTo({ url: '/pages/login/main' }); },
    });
    return;
  }
  adding.value = true;
  uni.showLoading({ title: 'AI 生成计划中…', mask: true });
  try {
    await api.scheduleAdd(compId.value);
    uni.hideLoading();
    uni.showModal({
      title: '已加入日程',
      content: 'AI 备赛计划已生成，是否立即查看？',
      confirmText: '去查看',
      success: (m) => { if (m.confirm) uni.switchTab({ url: '/pages/schedule/main' }); },
    });
  } catch (e) {
    uni.hideLoading();
    // request 层已统一 toast
  } finally {
    adding.value = false;
  }
}

onLoad((options) => {
  compId.value = Number(options.id);
  api.competition(compId.value)
    .then((data) => { comp.value = data; })
    .finally(() => { loading.value = false; });
});
</script>

<style lang="scss" scoped>
.verify-banner {
  background: #fef3c7;
  color: #b45309;
  font-size: 25rpx;
  border-radius: 14rpx;
  padding: 18rpx 24rpx;
  margin-bottom: 20rpx;
}
.comp-title { font-size: 38rpx; font-weight: 800; color: #1e293b; line-height: 1.35; }
.meta-row { display: flex; align-items: center; gap: 16rpx; margin-top: 18rpx; flex-wrap: wrap; }
.tag { display: inline-flex; padding: 4rpx 14rpx; border-radius: 8rpx; font-size: 22rpx; }
.stars { color: #f59e0b; font-size: 24rpx; letter-spacing: 2rpx; }
.intro { margin-top: 20rpx; color: #475569; font-size: 27rpx; line-height: 1.7; }
.info-grid { margin-top: 20rpx; border-top: 1rpx solid #f1f5f9; padding-top: 16rpx; }
.info-item { display: flex; padding: 10rpx 0; gap: 20rpx; }
.info-label { color: #94a3b8; font-size: 25rpx; width: 130rpx; flex-shrink: 0; }
.info-value { color: #334155; font-size: 25rpx; flex: 1; }
.source { display: flex; align-items: center; margin-top: 14rpx; gap: 8rpx; }
.source-url { color: #2563eb; font-size: 24rpx; flex: 1; }

.seg {
  display: flex;
  background: #fff;
  border-radius: 16rpx;
  padding: 8rpx;
  margin-bottom: 20rpx;
  border: 1rpx solid #e2e8f0;
}
.seg-item {
  flex: 1;
  text-align: center;
  height: 68rpx;
  line-height: 68rpx;
  font-size: 27rpx;
  color: #64748b;
  border-radius: 12rpx;
}
.seg-item.active { background: #2563eb; color: #fff; font-weight: 600; }

.phase-head { display: flex; align-items: center; gap: 14rpx; }
.phase-index {
  width: 44rpx;
  height: 44rpx;
  border-radius: 50%;
  background: #2563eb;
  color: #fff;
  text-align: center;
  line-height: 44rpx;
  font-size: 25rpx;
  font-weight: 700;
  flex-shrink: 0;
}
.phase-name { font-size: 30rpx; font-weight: 700; color: #1e293b; flex: 1; }
.phase-desc { margin-top: 16rpx; color: #475569; font-size: 26rpx; line-height: 1.7; }
.standard { margin-top: 16rpx; background: #f0fdf4; border-radius: 12rpx; padding: 16rpx 20rpx; }
.standard-label { color: #166534; font-size: 24rpx; font-weight: 700; display: block; margin-bottom: 6rpx; }
.standard-text { color: #15803d; font-size: 25rpx; line-height: 1.6; }

.media-group { margin-bottom: 10rpx; }
.media-item { margin-bottom: 14rpx; }
.media-title { font-size: 28rpx; font-weight: 600; color: #1e293b; }
.media-meta { display: flex; align-items: center; gap: 12rpx; margin-top: 12rpx; }
.tag-blue { background: #eff6ff; color: #2563eb; }
.tag-gray { background: #f1f5f9; color: #64748b; }
</style>
