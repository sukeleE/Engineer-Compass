<template>
  <view class="page-wrap" v-if="data">
    <view class="card profile">
      <image v-if="data.user.avatar" :src="data.user.avatar" class="avatar-img" mode="aspectFill" />
      <view v-else class="avatar">{{ avatarText }}</view>
      <view class="p-main">
        <text class="p-name">{{ data.user.nickname || data.user.username }}</text>
        <text class="p-sub">登录名：{{ data.user.username }}</text>
        <text class="p-sub">加入：{{ String(data.user.create_time).slice(0, 10) }}</text>
      </view>
      <view v-if="!isMe" class="mini-btn" @click="addFriend">加好友</view>
    </view>

    <view class="section-title">参与小组（{{ data.teams.length }}）</view>
    <EmptyState v-if="!data.teams.length" icon="👥" text="暂未公开小组信息" />
    <view v-for="t in data.teams" :key="t.id" class="card team" @click="openTeam(t)">
      <view class="t-head">
        <text class="t-name">{{ t.name }}</text>
        <text v-if="t.is_owner" class="tag tag-amber">组长</text>
      </view>
      <view v-if="t.role_names && t.role_names.length" class="t-line">角色：{{ t.role_names.join('、') }}</view>
      <view class="t-line">成员 {{ t.member_count }} 人</view>
    </view>

    <view class="section-title">备赛计划（{{ data.schedules.length }}）</view>
    <view v-for="s in data.schedules" :key="'s' + s.id" class="card plan">
      <view class="pl-head">
        <text class="pl-name ellipsis">{{ s.comp_name }}</text>
        <text class="pl-num">{{ s.done }}/{{ s.total }}</text>
      </view>
      <view class="bar"><view class="bar-in" :style="{ width: percent(s.done, s.total) + '%' }"></view></view>
      <view class="pl-meta">{{ s.phaseCount }} 个阶段 · 完成 {{ percent(s.done, s.total) }}%</view>
    </view>

    <view class="section-title">学习计划（{{ data.studies.length }}）</view>
    <EmptyState v-if="!data.studies.length" icon="📚" text="暂无学习计划" />
    <view v-for="s in data.studies" :key="'u' + s.id" class="card plan">
      <view class="pl-head">
        <text class="pl-name ellipsis">{{ s.topic }}<text v-if="s.level" class="pl-level">（{{ s.level }}）</text></text>
        <text class="pl-num">{{ s.done }}/{{ s.total }}</text>
      </view>
      <view class="bar"><view class="bar-in green" :style="{ width: percent(s.done, s.total) + '%' }"></view></view>
      <view class="pl-meta">{{ s.phaseCount }} 个阶段 · 完成 {{ percent(s.done, s.total) }}%</view>
    </view>
  </view>
  <view v-else class="empty"><view class="empty-text">加载中…</view></view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { toast, ensureLogin } from '../../../utils/guard.js';
import auth from '../../../utils/auth.js';
import EmptyState from '../../../components/EmptyState.vue';

const id = ref(null);
const data = ref(null);
const isMe = computed(() => auth.user && auth.user.id === id.value);
const avatarText = computed(() => ((data.value.user.nickname || data.value.user.username || '?').slice(0, 1).toUpperCase()));
function percent(done, total) { return total ? Math.round((done / total) * 100) : 0; }

async function load() { data.value = await api.userPublic(id.value); }
function openTeam(t) { uni.navigateTo({ url: '/packageTeam/pages/detail/main?id=' + t.id }); }
async function addFriend() {
  if (!ensureLogin()) return;
  const r = await api.friendRequest(id.value);
  toast(r.message || '好友申请已发送', 'success');
}

onLoad((o) => { id.value = Number(o.id); load(); });
</script>

<style lang="scss" scoped>
.profile { display: flex; align-items: center; gap: 20rpx; }
.avatar-img, .avatar { width: 110rpx; height: 110rpx; border-radius: 50%; flex-shrink: 0; }
.avatar { background: #2563eb; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 44rpx; font-weight: 700; }
.p-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6rpx; }
.p-name { font-size: 34rpx; font-weight: 800; color: #1e293b; }
.p-sub { font-size: 23rpx; color: #94a3b8; }
.mini-btn { background: #eff6ff; color: #2563eb; font-size: 24rpx; border-radius: 26rpx; padding: 12rpx 26rpx; flex-shrink: 0; }
.team .t-head { display: flex; justify-content: space-between; align-items: center; }
.t-name { font-size: 29rpx; font-weight: 700; color: #1e293b; }
.t-line { font-size: 24rpx; color: #64748b; margin-top: 8rpx; }
.plan .pl-head { display: flex; justify-content: space-between; align-items: center; gap: 14rpx; }
.pl-name { font-size: 28rpx; font-weight: 700; color: #1e293b; flex: 1; }
.pl-level { font-weight: 400; color: #94a3b8; font-size: 24rpx; }
.pl-num { font-size: 24rpx; color: #2563eb; font-weight: 700; }
.bar { height: 14rpx; background: #f1f5f9; border-radius: 8rpx; margin-top: 14rpx; overflow: hidden; }
.bar-in { height: 100%; background: #2563eb; border-radius: 8rpx; transition: width 0.3s; }
.bar-in.green { background: #10b981; }
.pl-meta { font-size: 22rpx; color: #94a3b8; margin-top: 10rpx; }
</style>
