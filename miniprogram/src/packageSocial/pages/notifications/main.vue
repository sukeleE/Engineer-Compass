<template>
  <view class="page-wrap">
    <Tabs v-model="tab" :tabs="tabList" />

    <!-- 个人/系统通知 -->
    <block v-if="tab === 'personal'">
      <view v-if="personal.length" class="read-all" @click="readAllPersonal">全部标为已读</view>
      <EmptyState v-if="!personal.length" icon="🔔" text="暂无系统通知" />
      <view v-for="n in personal" :key="n.id" class="card notice" :class="{ unread: !n.is_read }" @click="openPersonal(n)">
        <view class="n-head">
          <text class="n-title">{{ n.title }}</text>
          <text v-if="!n.is_read" class="dot"></text>
        </view>
        <view class="n-content">{{ n.content }}</view>
        <view class="n-time">{{ fmt(n.create_time) }}</view>
      </view>
    </block>

    <!-- 互动通知 -->
    <block v-else>
      <view v-if="currentList.length" class="read-all" @click="readGroup(tab)">本组全部已读</view>
      <EmptyState v-if="!currentList.length" :icon="emptyIcon" :text="emptyText" />
      <view v-for="n in currentList" :key="n.id" class="card notice" :class="{ unread: !n.is_read }" @click="openPost(n)">
        <view class="n-head">
          <text class="n-title">{{ interactTitle(n) }}</text>
          <text v-if="!n.is_read" class="dot"></text>
        </view>
        <view class="n-content">{{ n.post.title }}</view>
        <view v-if="n.content" class="n-quote">“{{ n.content }}”</view>
        <view class="n-time">{{ n.actor.nickname || n.actor.id }} · {{ fmt(n.create_time) }}</view>
      </view>
    </block>
  </view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onShow, onPullDownRefresh } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { toast } from '../../../utils/guard.js';
import Tabs from '../../../components/Tabs.vue';
import EmptyState from '../../../components/EmptyState.vue';

const tab = ref('personal');
const personal = ref([]);
const groups = ref({ comment: [], like: [], favs: [] });
const unread = ref({ comments: 0, likes: 0, favs: 0, notices: 0 });

const tabList = computed(() => [
  { key: 'personal', label: '系统', badge: unread.value.notices || '' },
  { key: 'comment', label: '评论', badge: unread.value.comments || '' },
  { key: 'like', label: '点赞', badge: unread.value.likes || '' },
  { key: 'favs', label: '收藏', badge: unread.value.favs || '' },
]);
const currentList = computed(() => groups.value[tab.value] || []);
const emptyIcon = computed(() => ({ comment: '💬', like: '👍', favs: '⭐' }[tab.value]));
const emptyText = computed(() => ({ comment: '还没有评论通知', like: '还没有点赞通知', favs: '还没有收藏通知' }[tab.value]));

function fmt(t) { return t ? String(t).slice(5, 16) : ''; }
function interactTitle(n) {
  const name = n.actor.nickname || '用户';
  if (n.type === 'comment') return name + ' 评论了帖子';
  if (n.type === 'like') return name + ' 点赞了帖子';
  return name + ' 收藏了帖子';
}

async function load() {
  const [cnt, list, notices] = await Promise.all([
    api.unreadCount(),
    api.notifications(),
    api.personalNotices(),
  ]);
  unread.value = cnt;
  groups.value = { comment: list.comments || [], like: list.likes || [], favs: list.favs || [] };
  personal.value = notices.rows || [];
}
async function openPersonal(n) {
  if (!n.is_read) {
    await api.personalRead(n.id);
    n.is_read = 1;
  }
  const m = /team=(d+)/.exec(n.link || '');
  if (m) uni.navigateTo({ url: '/packageTeam/pages/detail/main?id=' + m[1] });
}
async function openPost(n) {
  uni.navigateTo({ url: '/packageShare/pages/post/detail?id=' + n.post.id });
  if (!n.is_read) api.notificationsRead({ types: [n.type] }).then(() => load());
}
async function readAllPersonal() {
  await api.personalReadAll();
  toast('已全部已读', 'success');
  load();
}
async function readGroup(type) {
  await api.notificationsRead({ types: [type] });
  toast('已全部已读', 'success');
  load();
}

onShow(load);
onPullDownRefresh(async () => {
  await load();
  uni.stopPullDownRefresh();
});
</script>

<style lang="scss" scoped>
.read-all { text-align: right; font-size: 24rpx; color: #2563eb; padding: 8rpx 10rpx 14rpx; }
.notice { position: relative; }
.notice.unread { border-left: 6rpx solid #2563eb; }
.n-head { display: flex; justify-content: space-between; align-items: center; gap: 14rpx; }
.n-title { font-size: 28rpx; font-weight: 700; color: #1e293b; flex: 1; }
.dot { width: 16rpx; height: 16rpx; border-radius: 50%; background: #ef4444; flex-shrink: 0; }
.n-content { font-size: 26rpx; color: #334155; margin-top: 10rpx; }
.n-quote { font-size: 24rpx; color: #64748b; background: #f8fafc; border-radius: 10rpx; padding: 12rpx 16rpx; margin-top: 10rpx; }
.n-time { font-size: 22rpx; color: #94a3b8; margin-top: 12rpx; }
</style>
