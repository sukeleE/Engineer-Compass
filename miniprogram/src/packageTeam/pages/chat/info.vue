<template>
  <view class="page" v-if="detail">
    <view class="card">
      <view class="line"><text class="lbl">群名称</text><text class="val">{{ detail.name }}</text></view>
      <view class="line"><text class="lbl">群类型</text><text class="val">{{ detail.visibility === 'private' ? '🔒 私有群（仅群成员可见内容）' : '👥 公开群（全组可自由加入）' }}</text></view>
      <view class="line"><text class="lbl">群主</text><text class="val">{{ ownerName }}</text></view>
      <view class="line"><text class="lbl">成员数</text><text class="val">{{ detail.member_count }} 人</text></view>
    </view>

    <view class="card">
      <view class="section-title">群成员</view>
      <view class="member-grid">
        <view v-for="m in detail.members" :key="m.user_id" class="member-cell">
          <view class="member-avatar">
            <image v-if="m.avatar" :src="m.avatar" mode="aspectFill" class="ma-img" />
            <text v-else class="ma-text">{{ nameOf(m).charAt(0) }}</text>
          </view>
          <text class="member-name">{{ nameOf(m) }}<text v-if="m.is_owner"> 👑</text></text>
          <text v-if="isOwner && !m.is_owner" class="kick" @click="removeMember(m)">移出</text>
        </view>
      </view>
    </view>

    <view class="card">
      <view class="section-title">添加成员</view>
      <view v-if="!candidates.length" class="hint">本组成员都已在群内</view>
      <view v-else class="ops-row">
        <button v-if="isOwner" size="mini" type="primary" @click="openModal('add')">群主直接加人</button>
        <button size="mini" @click="openModal('invite')">邀请入群（对方确认）</button>
      </view>
    </view>

    <view class="card">
      <button class="leave-btn" @click="leave">退出群聊</button>
    </view>

    <!-- 选人弹层：遮罩点击关闭，内层阻止冒泡 -->
    <view v-if="modal.show" class="mask" @click="closeModal">
      <view class="modal" @click.stop>
        <view class="modal-title">{{ modal.mode === 'add' ? '选择要添加的成员（可多选）' : '选择要邀请的成员' }}</view>
        <scroll-view scroll-y class="modal-list">
          <view
            v-for="c in candidates"
            :key="c.id"
            class="pick-row"
            @click="togglePick(c)"
          >
            <text class="pick-check">{{ isPicked(c) ? '☑️' : '⬜' }}</text>
            <text class="pick-name">{{ nameOf(c) }}</text>
          </view>
        </scroll-view>
        <view class="modal-ops">
          <button size="mini" @click="closeModal">取消</button>
          <button size="mini" type="primary" @click="confirmPick">确定</button>
        </view>
      </view>
    </view>
  </view>
  <view v-else class="empty"><text>加载中…</text></view>
</template>

<script setup>
import { ref, computed } from 'vue';
import { onLoad, onShow } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { toast, confirm } from '../../../utils/guard.js';
import { displayName } from '../../../utils/displayName.js';
import auth from '../../../utils/auth.js';

const gid = ref(null);
const teamId = ref(null);
const detail = ref(null);
const teamMembers = ref([]);
const modal = ref({ show: false, mode: 'add', picks: [] });

const myId = computed(() => auth.user && auth.user.id);
const isOwner = computed(() => detail.value && detail.value.owner_id === myId.value);
const ownerName = computed(() => {
  const o = detail.value.members.find((m) => m.is_owner);
  return o ? nameOf(o) : '-';
});
const candidates = computed(() => {
  const inGroup = new Set((detail.value?.members || []).map((m) => Number(m.user_id)));
  return teamMembers.value.filter((m) => !inGroup.has(Number(m.id)));
});

function nameOf(u) { return displayName(u) || u.nickname || '成员'; }
function isPicked(c) { return modal.value.picks.indexOf(Number(c.id)) >= 0; }
function togglePick(c) {
  const id = Number(c.id);
  const picks = modal.value.picks.slice();
  const i = picks.indexOf(id);
  if (modal.value.mode === 'invite') {
    modal.value.picks = i >= 0 ? [] : [id];
    return;
  }
  if (i >= 0) picks.splice(i, 1); else picks.push(id);
  modal.value.picks = picks;
}
function openModal(mode) { modal.value = { show: true, mode, picks: [] }; }
function closeModal() { modal.value.show = false; }

async function load() {
  try {
    const [d, td] = await Promise.all([api.chatGroupDetail(gid.value), api.teamDetail(teamId.value)]);
    detail.value = d;
    teamMembers.value = td.members || [];
  } catch (e) { toast(e.message); }
}

async function confirmPick() {
  if (!modal.value.picks.length) return toast('请先选择成员');
  try {
    if (modal.value.mode === 'add') {
      await api.chatGroupMembersAdd(gid.value, modal.value.picks);
      toast('已添加成员', 'success');
    } else {
      await api.chatInviteCreate(gid.value, modal.value.picks[0]);
      toast('邀请已发出，等待对方确认', 'success');
    }
    closeModal();
    load();
  } catch (e) { toast(e.message); }
}

async function removeMember(m) {
  const ok = await confirm('确定将「' + nameOf(m) + '」移出群聊？', '移除成员');
  if (!ok) return;
  try {
    await api.chatGroupMemberRemove(gid.value, m.user_id);
    toast('已移出', 'success');
    load();
  } catch (e) { toast(e.message); }
}

async function leave() {
  const ok = await confirm(detail.value.member_count <= 1 ? '你是最后一位成员，退群后群聊将解散，确定吗？' : '确定退出该群聊？', '退出群聊');
  if (!ok) return;
  try {
    await api.chatGroupLeave(gid.value);
    toast('已退出群聊', 'success');
    uni.navigateBack();
  } catch (e) { toast(e.message); }
}

onLoad((o) => { gid.value = Number(o.gid); teamId.value = Number(o.id); });
onShow(() => { if (gid.value) load(); });
</script>

<style lang="scss" scoped>
.page { padding: 20rpx; }
.card { background: #fff; border-radius: 18rpx; padding: 26rpx; margin-bottom: 20rpx; }
.line { display: flex; padding: 12rpx 0; font-size: 27rpx; }
.lbl { width: 140rpx; color: #94a3b8; flex: none; }
.val { color: #1e293b; flex: 1; }
.section-title { font-size: 29rpx; font-weight: 800; color: #1e293b; margin-bottom: 18rpx; }
.member-grid { display: flex; flex-wrap: wrap; }
.member-cell { width: 25%; display: flex; flex-direction: column; align-items: center; gap: 8rpx; padding: 14rpx 0; }
.member-avatar { width: 88rpx; height: 88rpx; border-radius: 50%; overflow: hidden; background: #2563eb; display: flex; align-items: center; justify-content: center; }
.ma-img { width: 100%; height: 100%; }
.ma-text { color: #fff; font-size: 34rpx; font-weight: 700; }
.member-name { font-size: 23rpx; color: #334155; text-align: center; }
.kick { font-size: 21rpx; color: #ef4444; margin-top: 2rpx; }
.hint { font-size: 25rpx; color: #94a3b8; }
.ops-row { display: flex; gap: 18rpx; }
.leave-btn { color: #ef4444; font-size: 28rpx; }
.mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); z-index: 99; display: flex; align-items: center; justify-content: center; }
.modal { width: 82%; max-height: 70vh; background: #fff; border-radius: 20rpx; padding: 28rpx; display: flex; flex-direction: column; }
.modal-title { font-size: 30rpx; font-weight: 800; color: #1e293b; margin-bottom: 18rpx; }
.modal-list { max-height: 50vh; }
.pick-row { display: flex; align-items: center; gap: 16rpx; padding: 20rpx 8rpx; border-bottom: 1rpx solid #f1f5f9; }
.pick-check { font-size: 34rpx; }
.pick-name { font-size: 27rpx; color: #334155; }
.modal-ops { display: flex; justify-content: flex-end; gap: 16rpx; margin-top: 22rpx; }
</style>