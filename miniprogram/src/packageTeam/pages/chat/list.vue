<template>
  <view class="page">
    <!-- 入群邀请 -->
    <view v-for="iv in invites" :key="iv.id" class="invite-card">
      <view class="invite-text">
        <text class="iv-title">{{ iv.visibility === 'private' ? '🔒' : '👥' }} {{ iv.group_name }}</text>
        <text class="iv-sub">{{ iv.inviter_name }} 邀请你入群</text>
      </view>
      <view class="invite-ops">
        <button size="mini" type="primary" @click="accept(iv)">接受</button>
        <button size="mini" @click="reject(iv)">拒绝</button>
      </view>
    </view>

    <view class="head">
      <text class="title">群聊（{{ groups.length }}/10）</text>
      <button size="mini" type="primary" @click="create">创建群聊</button>
    </view>

    <view v-if="!groups.length" class="empty"><text>还没有群聊，点「创建群聊」发起第一个吧</text></view>

    <view v-for="g in groups" :key="g.id" class="g-card" @click="open(g)">
      <view class="g-avatar" :style="g.avatar ? '' : 'background:' + colorOf(g.id)">
        <image v-if="g.avatar" :src="g.avatar" mode="aspectFill" class="g-avatar-img" />
        <text v-else class="g-avatar-text">{{ initial(g.name) }}</text>
      </view>
      <view class="g-main">
        <view class="g-row1">
          <text class="g-name">{{ g.name }}</text>
          <text v-if="g.visibility === 'private'" class="g-tag">🔒 私有</text>
          <text v-else-if="!g.joined" class="g-tag blue">未加入</text>
          <text v-if="g.joined && g.member_count != null" class="g-count">{{ g.member_count }}人</text>
          <text class="g-time">{{ shortTime(g) }}</text>
        </view>
        <text class="g-preview">{{ preview(g) }}</text>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { toast, confirm } from '../../../utils/guard.js';
import auth from '../../../utils/auth.js';
import { teamDisplayName } from '../../../utils/displayName.js';

const teamId = ref(null);
const groups = ref([]);
const invites = ref([]);
const members = ref([]);

const COLORS = ['#2563eb', '#7c3aed', '#0891b2', '#059669', '#d97706', '#dc2626', '#db2777', '#4f46e5'];
function colorOf(id) { return COLORS[Math.abs(Number(id)) % COLORS.length]; }
function initial(name) { return String(name || '群').trim().charAt(0).toUpperCase(); }
function shortTime(g) {
  const t = g.last_message && g.last_message.create_time;
  if (!t) return '';
  // 2026-11-07 12:00:00 → 11-07 12:00
  return String(t).slice(5, 16);
}
function memberName(uid) {
  const m = members.value.find((x) => Number(x.id) === Number(uid));
  if (m) return teamDisplayName(m, members.value);
  return '成员';
}
function preview(g) {
  if (!g.joined && g.visibility === 'private') return '私有群聊，仅群成员可查看';
  const lm = g.last_message;
  if (!lm) return '还没有消息，来发第一条吧';
  const who = Number(lm.user_id) === Number(auth.user && auth.user.id) ? '我' : memberName(lm.user_id);
  const body = lm.has_image ? (lm.content ? lm.content + ' [图片]' : '[图片]') : (lm.content || '');
  return who + '：' + body;
}

async function load() {
  try {
    const [gs, iv, detail] = await Promise.all([
      api.chatGroups(teamId.value),
      api.chatInvites(),
      api.teamDetail(teamId.value),
    ]);
    groups.value = gs || [];
    members.value = detail.members || [];
    invites.value = (iv || []).filter((x) => Number(x.team_id) === Number(teamId.value));
  } catch (e) { toast(e.message); }
}

async function open(g) {
  if (g.joined) {
    uni.navigateTo({ url: '/packageTeam/pages/chat/room?gid=' + g.id + '&id=' + teamId.value });
    return;
  }
  if (g.visibility === 'private') {
    toast('私有群聊，仅群成员可查看，请让群成员邀请你入群');
    return;
  }
  const ok = await confirm('是否加入群聊「' + g.name + '」？', '加入群聊');
  if (!ok) return;
  try {
    await api.chatGroupJoin(g.id);
    toast('已加入', 'success');
    uni.navigateTo({ url: '/packageTeam/pages/chat/room?gid=' + g.id + '&id=' + teamId.value });
  } catch (e) { toast(e.message); }
}

async function create() {
  if (groups.value.length >= 10) return toast('每个小组最多 10 个群聊');
  const nameRes = await new Promise((resolve) => {
    uni.showModal({
      title: '创建群聊', editable: true, placeholderText: '群名称（≤20字）',
      success: (m) => resolve(m.confirm ? (m.content || '').trim() : ''),
      fail: () => resolve(''),
    });
  });
  if (!nameRes) return;
  if (nameRes.length > 20) return toast('群名称最多 20 字');
  const visRes = await new Promise((resolve) => {
    uni.showActionSheet({
      itemList: ['👥 公开群（全组可自由加入）', '🔒 私有群（仅受邀成员可进）'],
      success: (r) => resolve(r.tapIndex),
      fail: () => resolve(-1),
    });
  });
  if (visRes < 0) return;
  const visibility = visRes === 1 ? 'private' : 'public';
  try {
    const r = await api.chatGroupCreate(teamId.value, { name: nameRes, visibility });
    toast('群聊已创建', 'success');
    uni.navigateTo({ url: '/packageTeam/pages/chat/room?gid=' + r.id + '&id=' + teamId.value });
  } catch (e) { toast(e.message); }
}

async function accept(iv) {
  try {
    await api.chatInviteAccept(iv.group_id, iv.id);
    toast('已加入群聊', 'success');
    await load();
    uni.navigateTo({ url: '/packageTeam/pages/chat/room?gid=' + iv.group_id + '&id=' + teamId.value });
  } catch (e) { toast(e.message); }
}
async function reject(iv) {
  try { await api.chatInviteReject(iv.group_id, iv.id); await load(); } catch (e) { toast(e.message); }
}

onLoad((o) => { teamId.value = Number(o.id); });
onShow(() => { if (teamId.value) load(); });
</script>

<style lang="scss" scoped>
.page { padding: 20rpx; }
.invite-card { display: flex; align-items: center; gap: 16rpx; background: #eff6ff; border: 1rpx solid #bfdbfe; border-radius: 16rpx; padding: 20rpx 24rpx; margin-bottom: 16rpx; }
.invite-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6rpx; }
.iv-title { font-size: 28rpx; font-weight: 700; color: #1e3a8a; }
.iv-sub { font-size: 23rpx; color: #64748b; }
.invite-ops { display: flex; gap: 12rpx; }
.head { display: flex; align-items: center; justify-content: space-between; padding: 10rpx 8rpx 18rpx; }
.title { font-size: 30rpx; font-weight: 800; color: #1e293b; }
.empty { text-align: center; color: #94a3b8; font-size: 26rpx; padding: 80rpx 0; }
.g-card { display: flex; gap: 20rpx; background: #fff; border-radius: 18rpx; padding: 22rpx; margin-bottom: 16rpx; box-shadow: 0 2rpx 10rpx rgba(15, 23, 42, 0.05); }
.g-avatar { width: 88rpx; height: 88rpx; border-radius: 20rpx; flex: none; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.g-avatar-img { width: 100%; height: 100%; }
.g-avatar-text { color: #fff; font-size: 38rpx; font-weight: 800; }
.g-main { flex: 1; min-width: 0; }
.g-row1 { display: flex; align-items: center; gap: 10rpx; }
.g-name { font-size: 29rpx; font-weight: 700; color: #1e293b; max-width: 260rpx; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.g-tag { font-size: 20rpx; color: #b45309; background: #fef3c7; border-radius: 6rpx; padding: 2rpx 10rpx; }
.g-tag.blue { color: #1d4ed8; background: #dbeafe; }
.g-count { font-size: 22rpx; color: #64748b; }
.g-time { margin-left: auto; font-size: 21rpx; color: #94a3b8; flex: none; }
.g-preview { display: block; margin-top: 10rpx; font-size: 25rpx; color: #64748b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>