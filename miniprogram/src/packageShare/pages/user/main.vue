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
      <view v-if="!isMe" class="friend-actions">
        <view v-if="friendState === 'none'" class="mini-btn primary" @click="addFriend">加好友</view>
        <text v-else-if="friendState === 'outgoing'" class="state-pill">申请已发送</text>
        <template v-else-if="friendState === 'incoming'">
          <view class="mini-btn primary" @click="acceptFriend">同意</view>
          <view class="mini-btn danger" @click="rejectFriend">拒绝</view>
        </template>
        <template v-else-if="friendState === 'friend'">
          <text class="state-pill">已是好友</text>
          <view class="mini-btn" @click="openDm">私信</view>
        </template>
      </view>
    </view>

    <view class="section-title">主页评论（{{ comments.length }}）</view>
    <view v-if="!isMe" class="card comment-form">
      <textarea
        v-model="commentText"
        class="comment-input"
        maxlength="500"
        placeholder="友善评论，例如交流竞赛方向、合作意向……"
      />
      <view class="form-foot">
        <text class="text-small text-muted">{{ commentText.length }}/500</text>
        <button class="btn btn-primary submit-btn" :disabled="commentSaving" @click="submitComment">发布评论</button>
      </view>
    </view>
    <view v-else class="card muted-tip">不能给自己的主页评论，你可以在其他同学主页评论。</view>

    <EmptyState v-if="!comments.length" icon="💬" text="还没有评论，来打个招呼吧" />
    <view v-for="c in comments" :key="c.id" class="card comment-item">
      <image v-if="c.avatar" :src="c.avatar" class="comment-avatar" mode="aspectFill" @click="openUser(c.user_id)" />
      <view v-else class="comment-avatar no-avatar" @click="openUser(c.user_id)">{{ commenterName(c).slice(0, 1) }}</view>
      <view class="comment-main">
        <view class="comment-head">
          <text class="comment-name" @click="openUser(c.user_id)">{{ commenterName(c) }}</text>
          <text class="text-small text-muted">{{ fmtTime(c.create_time) }}</text>
        </view>
        <text class="comment-content">{{ c.content }}</text>
      </view>
      <view v-if="canDeleteComment(c)" class="mini-btn danger delete-btn" @click="deleteComment(c)">删除</view>
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
import { toast, ensureLogin, confirm } from '../../../utils/guard.js';
import auth from '../../../utils/auth.js';
import EmptyState from '../../../components/EmptyState.vue';

const id = ref(null);
const data = ref(null);
const comments = ref([]);
const commentText = ref('');
const commentSaving = ref(false);
const friends = ref([]);
const friendRequests = ref({ incoming: [], outgoing: [] });
const friendSaving = ref(false);

const isMe = computed(() => Number(auth.user?.id) === Number(id.value));
const avatarText = computed(() => ((data.value.user.nickname || data.value.user.username || '?').slice(0, 1).toUpperCase()));
const incomingRequest = computed(() => friendRequests.value.incoming.find((x) => Number(x.user_id) === Number(id.value)) || null);
const friendState = computed(() => {
  if (isMe.value) return 'me';
  if (friends.value.some((f) => Number(f.id) === Number(id.value))) return 'friend';
  if (friendRequests.value.outgoing.some((x) => Number(x.user_id) === Number(id.value))) return 'outgoing';
  if (incomingRequest.value) return 'incoming';
  return 'none';
});

function percent(done, total) { return total ? Math.round((done / total) * 100) : 0; }
function commenterName(c) { return c.nickname || c.username || `用户${c.user_id}`; }
function fmtTime(t) { return t ? String(t).slice(5, 16) : ''; }
function canDeleteComment(c) {
  return Number(c.user_id) === Number(auth.user?.id)
    || isMe.value
    || (auth.user?.is_admin && (auth.user.perms || []).some((p) => p === 'content:comment' || p === 'content'));
}

async function loadComments() {
  try { comments.value = await api.profileComments(id.value); }
  catch { comments.value = []; }
}
async function loadSocial() {
  if (isMe.value) {
    friends.value = [];
    friendRequests.value = { incoming: [], outgoing: [] };
    return;
  }
  try {
    const [friendRows, requestRows] = await Promise.all([api.friends(), api.friendRequests()]);
    friends.value = friendRows || [];
    friendRequests.value = requestRows || { incoming: [], outgoing: [] };
  } catch {
    friends.value = [];
    friendRequests.value = { incoming: [], outgoing: [] };
  }
}
async function load() {
  data.value = null;
  try {
    data.value = await api.userPublic(id.value);
    await Promise.all([loadComments(), loadSocial()]);
  } catch {
    data.value = null;
  }
}
function openTeam(t) { uni.navigateTo({ url: '/packageTeam/pages/detail/main?id=' + t.id }); }
function openUser(uid) {
  if (Number(uid) === Number(auth.user?.id)) return uni.switchTab({ url: '/pages/me/main' });
  uni.navigateTo({ url: '/packageShare/pages/user/main?id=' + uid });
}
async function addFriend() {
  if (!ensureLogin()) return;
  if (friendState.value !== 'none') return;
  friendSaving.value = true;
  try {
    const r = await api.friendRequest(id.value);
    toast(r.message || '好友申请已发送', 'success');
    await loadSocial();
  } finally {
    friendSaving.value = false;
  }
}
async function acceptFriend() {
  if (!incomingRequest.value) return;
  friendSaving.value = true;
  try {
    await api.friendAccept(incomingRequest.value.id);
    toast('已添加为好友', 'success');
    await loadSocial();
  } finally {
    friendSaving.value = false;
  }
}
async function rejectFriend() {
  if (!incomingRequest.value) return;
  friendSaving.value = true;
  try {
    await api.friendReject(incomingRequest.value.id);
    toast('已拒绝申请', 'success');
    await loadSocial();
  } finally {
    friendSaving.value = false;
  }
}
function openDm() {
  const name = encodeURIComponent(data.value.user.nickname || data.value.user.username || '用户');
  uni.navigateTo({ url: `/packageSocial/pages/dm/main?uid=${id.value}&name=${name}` });
}
async function submitComment() {
  if (!ensureLogin()) return;
  const content = commentText.value.trim();
  if (!content) return toast('请输入评论内容');
  if (content.length > 500) return toast('评论不能超过 500 字');
  commentSaving.value = true;
  try {
    const c = await api.profileCommentAdd(id.value, content);
    comments.value = [c, ...comments.value];
    commentText.value = '';
    toast('评论已发布', 'success');
  } finally {
    commentSaving.value = false;
  }
}
async function deleteComment(c) {
  const ok = await confirm('确定删除这条主页评论？');
  if (!ok) return;
  await api.profileCommentDelete(id.value, c.id);
  comments.value = comments.value.filter((x) => Number(x.id) !== Number(c.id));
  toast('已删除', 'success');
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
.friend-actions { display: flex; align-items: center; gap: 10rpx; flex-wrap: wrap; justify-content: flex-end; flex-shrink: 0; }
.mini-btn { background: #eff6ff; color: #2563eb; font-size: 24rpx; border-radius: 26rpx; padding: 10rpx 24rpx; }
.mini-btn.primary { background: #2563eb; color: #fff; }
.mini-btn.danger { background: #fee2e2; color: #ef4444; }
.state-pill { background: #f1f5f9; color: #64748b; border-radius: 999rpx; padding: 10rpx 20rpx; font-size: 23rpx; }
.comment-form { display: flex; flex-direction: column; gap: 16rpx; }
.comment-input { width: 100%; min-height: 150rpx; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 16rpx; padding: 18rpx; box-sizing: border-box; font-size: 26rpx; }
.form-foot { display: flex; align-items: center; justify-content: space-between; gap: 16rpx; }
.submit-btn { width: 180rpx; height: 68rpx; font-size: 25rpx; margin: 0; }
.muted-tip { color: #64748b; font-size: 25rpx; line-height: 1.6; }
.comment-item { display: flex; align-items: flex-start; gap: 16rpx; }
.comment-avatar { width: 68rpx; height: 68rpx; border-radius: 50%; flex-shrink: 0; }
.no-avatar { background: #2563eb; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; }
.comment-main { flex: 1; min-width: 0; }
.comment-head { display: flex; align-items: center; justify-content: space-between; gap: 12rpx; }
.comment-name { font-size: 26rpx; font-weight: 700; color: #1e293b; }
.comment-content { display: block; margin-top: 8rpx; font-size: 26rpx; color: #334155; line-height: 1.6; word-break: break-all; white-space: pre-wrap; }
.delete-btn { flex-shrink: 0; }
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
