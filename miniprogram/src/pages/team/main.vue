<template>
  <view class="page-wrap">
    <view class="top-actions">
      <button class="btn btn-primary flex1" @click="goCreate">＋ 创建小组</button>
      <button class="btn btn-outline flex1" @click="openJoin">邀请码加入</button>
    </view>

    <view v-if="loading" class="empty"><view class="empty-text">加载中…</view></view>
    <EmptyState v-else-if="!teams.length" icon="👥" text="还没有加入任何小组" btn-text="创建第一个小组" @action="goCreate" />

    <view v-for="t in teams" :key="t.id" class="card team-card" @click="open(t.id)">
      <view class="row1">
        <text class="name ellipsis">{{ t.name }}</text>
        <text v-if="t.is_owner" class="tag tag-amber">组长</text>
      </view>
      <view v-if="t.desc" class="desc ellipsis-2">{{ t.desc }}</view>
      <view class="meta">
        <text class="tag tag-blue">{{ t.role_name || '成员' }}</text>
        <text>{{ t.member_count }} 人</text>
        <text class="code">邀请码 {{ t.invite_code }}</text>
      </view>
    </view>

    <!-- 加入小组弹窗 -->
    <view v-if="joinOpen" class="modal-mask" @click="joinOpen = false">
      <view class="modal" @click.stop>
        <view class="modal-title">邀请码加入</view>
        <input v-model="code" class="modal-input" placeholder="输入 8 位邀请码" maxlength="12" />
        <button v-if="!peek" class="btn btn-ghost btn-block peek-btn" @click="doPeek">预览小组</button>
        <view v-if="peek" class="peek card-inner">
          <view class="peek-name">{{ peek.name }}</view>
          <view class="text-small text-muted">组长：{{ peek.owner_name }} · {{ peek.member_count }} 人</view>
          <view v-if="peek.desc" class="peek-desc ellipsis-2">{{ peek.desc }}</view>
          <view v-if="peek.is_member" class="tag tag-green">你已在该小组</view>
        </view>
        <view class="modal-actions">
          <button class="btn btn-ghost modal-btn" @click="joinOpen = false">取消</button>
          <button class="btn btn-primary modal-btn" :disabled="joining" @click="doJoin">{{ joining ? '加入中…' : '确认加入' }}</button>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { api } from '../../utils/api.js';
import { ensureLogin, toast } from '../../utils/guard.js';
import EmptyState from '../../components/EmptyState.vue';

const teams = ref([]);
const loading = ref(true);
const joinOpen = ref(false);
const code = ref('');
const peek = ref(null);
const joining = ref(false);

async function load() {
  if (!ensureLogin()) { loading.value = false; return; }
  try {
    const res = await api.me();
    teams.value = res.teams || [];
  } finally {
    loading.value = false;
  }
}
function goCreate() { if (ensureLogin()) uni.navigateTo({ url: '/packageTeam/pages/create/main' }); }
function open(id) { uni.navigateTo({ url: '/packageTeam/pages/detail/main?id=' + id }); }
function openJoin() {
  if (!ensureLogin()) return;
  joinOpen.value = true;
  code.value = '';
  peek.value = null;
}
async function doPeek() {
  if (!code.value.trim()) return toast('请输入邀请码');
  peek.value = await api.teamPeek(code.value.trim());
}
async function doJoin() {
  if (!code.value.trim()) return toast('请输入邀请码');
  joining.value = true;
  try {
    await api.teamJoin(code.value.trim());
    toast('已加入小组', 'success');
    joinOpen.value = false;
    load();
  } finally {
    joining.value = false;
  }
}
onShow(load);
</script>

<style lang="scss" scoped>
.top-actions { display: flex; gap: 18rpx; margin-bottom: 22rpx; }
.flex1 { flex: 1; }
.team-card { padding: 26rpx 28rpx; }
.row1 { display: flex; align-items: center; justify-content: space-between; gap: 16rpx; }
.name { font-size: 31rpx; font-weight: 700; color: #1e293b; flex: 1; }
.desc { font-size: 25rpx; color: #64748b; margin-top: 10rpx; }
.meta { display: flex; align-items: center; gap: 14rpx; margin-top: 16rpx; font-size: 23rpx; color: #94a3b8; }
.code { margin-left: auto; }
.modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,.45); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { width: 640rpx; background: #fff; border-radius: 24rpx; padding: 36rpx; }
.modal-title { font-size: 32rpx; font-weight: 700; margin-bottom: 22rpx; }
.modal-input { height: 88rpx; background: #f8fafc; border: 1rpx solid #e2e8f0; border-radius: 14rpx; padding: 0 24rpx; font-size: 27rpx; margin-bottom: 18rpx; }
.card-inner { background: #f8fafc; border-radius: 14rpx; padding: 20rpx; margin-bottom: 18rpx; }
.peek-name { font-size: 29rpx; font-weight: 700; margin-bottom: 8rpx; }
.peek-desc { font-size: 24rpx; color: #64748b; margin: 10rpx 0; }
.modal-actions { display: flex; gap: 20rpx; margin-top: 12rpx; }
.peek-btn { margin-bottom: 18rpx; }
.modal-btn { flex: 1; height: 80rpx; font-size: 28rpx; }
</style>