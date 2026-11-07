<template>
  <view class="page-wrap">
    <Tabs v-model="tab" :tabs="tabs" />

    <!-- 好友 -->
    <block v-if="tab === 'friends'">
      <EmptyState v-if="!friends.length" icon="👥" text="还没有好友，去「找朋友」添加" />
      <view v-for="f in friends" :key="f.id" class="card friend" @click="openDm(f)">
        <image v-if="f.avatar" :src="f.avatar" class="avatar-img" mode="aspectFill" />
        <view v-else class="avatar">{{ avatarText(f) }}</view>
        <view class="f-main">
          <view class="f-name">
            <text class="ellipsis">{{ f.nickname || f.username }}</text>
            <text v-if="f.unread" class="badge">{{ f.unread > 99 ? '99+' : f.unread }}</text>
          </view>
          <view class="f-last ellipsis">{{ f.last_msg || '开始聊天吧' }}</view>
        </view>
        <view class="mini-btn danger" @click.stop="remove(f)">删除</view>
      </view>
    </block>

    <!-- 申请 -->
    <block v-else-if="tab === 'requests'">
      <view v-if="req.incoming.length" class="section-title">收到的申请</view>
      <EmptyState v-if="!req.incoming.length && !req.outgoing.length" icon="📨" text="暂无好友申请" />
      <view v-for="r in req.incoming" :key="'in' + r.id" class="card friend">
        <image v-if="r.avatar" :src="r.avatar" class="avatar-img" mode="aspectFill" />
        <view v-else class="avatar">{{ avatarText(r) }}</view>
        <view class="f-main">
          <view class="f-name">{{ r.nickname || r.username }}</view>
          <view class="f-last">申请加你为好友 · {{ fmt(r.create_time) }}</view>
        </view>
        <view class="req-ops">
          <view class="mini-btn" @click="accept(r)">接受</view>
          <view class="mini-btn danger" @click="reject(r)">拒绝</view>
        </view>
      </view>

      <view v-if="req.outgoing.length" class="section-title">发出的申请</view>
      <view v-for="r in req.outgoing" :key="'out' + r.id" class="card friend">
        <image v-if="r.avatar" :src="r.avatar" class="avatar-img" mode="aspectFill" />
        <view v-else class="avatar">{{ avatarText(r) }}</view>
        <view class="f-main">
          <view class="f-name">{{ r.nickname || r.username }}</view>
          <view class="f-last">等待对方验证…</view>
        </view>
        <text class="tag tag-gray">待处理</text>
      </view>
    </block>

    <!-- 找朋友 -->
    <block v-else>
      <view class="search-bar">
        <input v-model="keyword" class="search-input" placeholder="搜索用户名 / 昵称" confirm-type="search" @confirm="doSearch" />
        <button class="btn btn-primary search-btn" @click="doSearch">搜索</button>
      </view>
      <EmptyState v-if="searched && !results.length" icon="🔎" text="没有找到匹配的用户" />
      <view v-for="u in results" :key="u.id" class="card friend">
        <image v-if="u.avatar" :src="u.avatar" class="avatar-img" mode="aspectFill" />
        <view v-else class="avatar">{{ avatarText(u) }}</view>
        <view class="f-main">
          <view class="f-name">{{ u.nickname || u.username }}</view>
          <view class="f-last">登录名：{{ u.username }}</view>
        </view>
        <view class="mini-btn" @click="addFriend(u)">加好友</view>
      </view>
    </block>
  </view>
</template>

<script setup>
import { ref, reactive, computed } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { confirm, toast } from '../../../utils/guard.js';
import Tabs from '../../../components/Tabs.vue';
import EmptyState from '../../../components/EmptyState.vue';

const tab = ref('friends');
const friends = ref([]);
const req = reactive({ incoming: [], outgoing: [] });
const keyword = ref('');
const results = ref([]);
const searched = ref(false);

const tabs = computed(() => [
  { key: 'friends', label: '好友', badge: friends.value.length || '' },
  { key: 'requests', label: '申请', badge: req.incoming.length || '' },
  { key: 'search', label: '找朋友' },
]);

function avatarText(u) {
  const s = u.nickname || u.username || '?';
  return s.slice(0, 1).toUpperCase();
}
function fmt(t) { return t ? String(t).slice(5, 16) : ''; }

async function loadFriends() { friends.value = await api.friends(); }
async function loadRequests() {
  const r = await api.friendRequests();
  req.incoming = r.incoming || [];
  req.outgoing = r.outgoing || [];
}
async function doSearch() {
  const q = keyword.value.trim();
  if (!q) return toast('请输入搜索关键词');
  results.value = await api.friendSearch(q);
  searched.value = true;
}
async function addFriend(u) {
  const r = await api.friendRequest(u.id);
  toast(r.message || '好友申请已发送', 'success');
  doSearch();
}
async function accept(r) {
  await api.friendAccept(r.id);
  toast('已添加好友', 'success');
  loadRequests();
  loadFriends();
}
async function reject(r) {
  await api.friendReject(r.id);
  loadRequests();
}
async function remove(f) {
  if (!(await confirm('删除好友 ' + (f.nickname || f.username) + '？'))) return;
  await api.friendRemove(f.id);
  toast('已删除', 'success');
  loadFriends();
}
function openDm(f) {
  const name = encodeURIComponent(f.nickname || f.username);
  uni.navigateTo({ url: '/packageSocial/pages/dm/main?uid=' + f.id + '&name=' + name });
}

onShow(() => { loadFriends(); loadRequests(); });
</script>

<style lang="scss" scoped>
.friend { display: flex; align-items: center; gap: 18rpx; }
.avatar-img, .avatar { width: 84rpx; height: 84rpx; border-radius: 50%; flex-shrink: 0; }
.avatar { background: #2563eb; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 34rpx; font-weight: 700; }
.f-main { flex: 1; min-width: 0; }
.f-name { display: flex; align-items: center; gap: 10rpx; font-size: 29rpx; font-weight: 700; color: #1e293b; }
.badge { background: #ef4444; color: #fff; font-size: 20rpx; border-radius: 18rpx; padding: 0 10rpx; line-height: 1.7; }
.f-last { font-size: 24rpx; color: #94a3b8; margin-top: 6rpx; }
.mini-btn { background: #eff6ff; color: #2563eb; font-size: 24rpx; border-radius: 26rpx; padding: 10rpx 26rpx; flex-shrink: 0; }
.mini-btn.danger { background: #fee2e2; color: #ef4444; }
.req-ops { display: flex; gap: 12rpx; flex-shrink: 0; }
.search-bar { display: flex; gap: 14rpx; margin-bottom: 18rpx; }
.search-input { flex: 1; background: #fff; border: 1rpx solid #e2e8f0; border-radius: 44rpx; padding: 0 28rpx; height: 80rpx; font-size: 27rpx; }
.search-btn { width: 150rpx; height: 80rpx; font-size: 27rpx; padding: 0; }
</style>
