<template>
  <view class="page-wrap">
    <view v-if="notice" class="card notice-bar" @click="noticeOpen = true">
      <text class="nb-icon">📢</text>
      <view class="nb-main">
        <text class="nb-title ellipsis">{{ notice.pinned ? '【置顶】' : '' }}{{ notice.title }}</text>
        <text class="nb-desc ellipsis">{{ notice.content }}</text>
      </view>
      <text class="nb-arrow">›</text>
    </view>

    <view class="section-title">学习与分享</view>
    <view class="card grid">
      <view v-for="e in shareEntries" :key="e.url" class="grid-item" @click="go(e)">
        <text class="gi-icon">{{ e.icon }}</text>
        <text class="gi-name">{{ e.name }}</text>
        <text class="gi-desc">{{ e.desc }}</text>
      </view>
    </view>

    <view class="section-title">协作与运营</view>
    <view class="card grid">
      <view v-for="e in opsEntries" :key="e.url" class="grid-item" @click="go(e)">
        <text class="gi-icon">{{ e.icon }}</text>
        <text class="gi-name">{{ e.name }}</text>
        <text class="gi-desc">{{ e.desc }}</text>
      </view>
    </view>

    <view class="section-title">消息与反馈</view>
    <view class="card grid">
      <view v-for="e in socialEntries" :key="e.url" class="grid-item" @click="go(e)">
        <text class="gi-icon">{{ e.icon }}</text>
        <text class="gi-name">{{ e.name }}</text>
        <text class="gi-desc">{{ e.desc }}</text>
      </view>
    </view>

    <view v-if="isAdmin" class="section-title">管理</view>
    <view v-if="isAdmin" class="card grid">
      <view class="grid-item" @click="go({ url: '/packageAdmin/pages/review/main' })">
        <text class="gi-icon">🛡</text>
        <text class="gi-name">轻量审核端</text>
        <text class="gi-desc">竞赛收录/公告</text>
      </view>
    </view>

    <view v-if="notice && noticeOpen" class="modal-mask" @click="noticeOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">{{ notice.title }}</view>
        <scroll-view scroll-y class="modal-scroll">
          <view class="notice-content">{{ notice.content }}</view>
        </scroll-view>
        <button class="btn btn-primary modal-btn" @click="noticeOpen = false">我知道了</button>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { api } from '../../utils/api.js';
import { ensureLogin } from '../../utils/guard.js';
import auth from '../../utils/auth.js';

const notice = ref(null);
const noticeOpen = ref(false);
const isAdmin = computed(() => !!(auth.user && auth.user.is_admin));

const shareEntries = [
  { name: '荣誉墙', icon: '🏆', desc: '获奖风采', url: '/packageShare/pages/honor/main' },
  { name: '资源分享', icon: '📤', desc: '开源大厅', url: '/packageShare/pages/posts/main' },
  { name: '资源库', icon: '🗄', desc: '我的文件', url: '/packageShare/pages/library/main' },
];
const opsEntries = [
  { name: '资源预约', icon: '📅', desc: '场地/物品', url: '/packageOps/pages/booking/projects' },
  { name: '物料采购', icon: '🛒', desc: '申请审批', url: '/packageOps/pages/purchase/list' },
  { name: '报销整理', icon: '🧾', desc: '票据归集', url: '/packageOps/pages/expense/list' },
];
const socialEntries = [
  { name: '消息通知', icon: '🔔', desc: '互动/系统', url: '/packageSocial/pages/notifications/main' },
  { name: '好友私信', icon: '👥', desc: '同学协作', url: '/packageSocial/pages/friends/main' },
  { name: '意见反馈', icon: '📮', desc: '建议反馈', url: '/packageSocial/pages/feedback/main' },
];

function go(e) {
  const needLogin = e.url.indexOf('packageOps') >= 0 || e.url.indexOf('notifications') >= 0 || e.url.indexOf('friends') >= 0 || e.url.indexOf('feedback') >= 0 || e.url.indexOf('packageAdmin') >= 0;
  if (needLogin && !ensureLogin('该功能需要登录后使用')) return;
  uni.navigateTo({ url: e.url });
}

onShow(async () => {
  try { notice.value = await api.latestAnnouncement(); } catch (e) { notice.value = null; }
});
</script>

<style lang="scss" scoped>
.notice-bar { display: flex; align-items: center; gap: 16rpx; background: linear-gradient(135deg, #eff6ff, #f0f9ff); }
.nb-icon { font-size: 44rpx; }
.nb-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6rpx; }
.nb-title { font-size: 27rpx; font-weight: 700; color: #1e40af; }
.nb-desc { font-size: 23rpx; color: #64748b; }
.nb-arrow { font-size: 40rpx; color: #94a3b8; }
.grid { display: flex; flex-wrap: wrap; padding: 12rpx; }
.grid-item { width: 33.33%; display: flex; flex-direction: column; align-items: center; gap: 8rpx; padding: 26rpx 0; }
.gi-icon { font-size: 52rpx; }
.gi-name { font-size: 26rpx; color: #1e293b; font-weight: 600; }
.gi-desc { font-size: 20rpx; color: #94a3b8; }
.modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,0.45); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 48rpx; }
.modal { width: 100%; background: #fff; border-radius: 24rpx; padding: 32rpx; max-height: 76vh; display: flex; flex-direction: column; }
.modal-title { font-size: 32rpx; font-weight: 800; text-align: center; margin-bottom: 18rpx; }
.modal-scroll { max-height: 50vh; }
.notice-content { font-size: 27rpx; color: #334155; line-height: 1.8; white-space: pre-wrap; }
.modal-btn { margin-top: 20rpx; }
</style>
