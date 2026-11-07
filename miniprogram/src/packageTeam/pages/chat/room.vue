<template>
  <view class="chat-page">
    <view class="room-head" @click="goInfo">
      <view class="rh-main">
        <text class="rh-name">{{ groupName || '群聊' }}</text>
        <text class="rh-count" v-if="detail">{{ detail.member_count }} 人 · {{ detail.visibility === 'private' ? '私有群' : '公开群' }}</text>
      </view>
      <text class="rh-arrow">群信息 ›</text>
    </view>

    <scroll-view class="msg-list" scroll-y :scroll-into-view="anchor" :scroll-with-animation="true" refresher-enabled @refresherrefresh="loadEarlier">
      <view v-if="!messages.length" class="empty"><view class="empty-text">还没有消息，来发第一条吧</view></view>
      <view v-for="m in messages" :key="m.id" :id="'m' + m.id" class="msg-row" :class="{ mine: m.user_id === myId }" @longpress="onLongPress(m)">
        <view class="msg-avatar">
          <image v-if="avatarOf(m.user_id)" :src="avatarOf(m.user_id)" mode="aspectFill" class="avatar-img" />
          <text v-else class="avatar-text">{{ (senderName(m) || '?').charAt(0) }}</text>
        </view>
        <view class="bubble-wrap">
          <view class="sender">{{ senderName(m) }}</view>
          <view class="bubble">
            <Markdown v-if="m.content" :content="m.content" />
            <view v-if="m.attachments && m.attachments.length" class="att">
              <image
                v-for="(a, i) in m.attachments"
                v-show="isImage(a)"
                :key="i"
                :src="attUrl(a)"
                class="att-img"
                mode="widthFix"
                @click="previewAtt(m.attachments, i)"
              />
              <AttachmentList :attachments="m.attachments" hide-images />
            </view>
          </view>
          <view class="time">{{ m.create_time }}</view>
        </view>
      </view>
      <view id="bottom" style="height:20rpx"></view>
    </scroll-view>

    <view class="input-bar">
      <view class="img-btn" @click="addImage">📷</view>
      <input v-model="draft" class="msg-input" placeholder="发消息…" confirm-type="send" @confirm="send" />
      <button class="btn btn-primary send-btn" :disabled="sending || !canSend" @click="send">发送</button>
    </view>
  </view>
</template>

<script setup>
import { ref, computed, nextTick } from 'vue';
import { onLoad, onShow, onHide, onUnload } from '@dcloudio/uni-app';
import { api } from '../../../utils/api.js';
import { chooseImageAsBase64, isImage } from '../../../utils/fileBase64.js';
import Markdown from '../../../components/Markdown.vue';
import AttachmentList from '../../../components/AttachmentList.vue';
import auth from '../../../utils/auth.js';
import { teamDisplayName } from '../../../utils/displayName.js';
import { toast, confirm } from '../../../utils/guard.js';

const teamId = ref(null);
const gid = ref(null);
const groupName = ref('');
const detail = ref(null);
const myId = computed(() => auth.user && auth.user.id);
const messages = ref([]);
const draft = ref('');
const sending = ref(false);
const image = ref(null);
const anchor = ref('');
const members = ref([]);
let timer = null;

function senderName(m) { return teamDisplayName(m, members.value) || m.nickname || '成员'; }
function avatarOf(uid) {
  const m = detail.value && detail.value.members && detail.value.members.find((x) => Number(x.user_id) === Number(uid));
  return m && m.avatar ? m.avatar : '';
}
const canSend = computed(() => draft.value.trim() || image.value);

function attUrl(a) {
  if (a.data) return 'data:' + (a.mime || 'image/jpeg') + ';base64,' + a.data;
  return a.url || '';
}
function previewAtt(atts, idx) {
  const urls = atts.filter(isImage).map(attUrl);
  uni.previewImage({ urls: urls, current: urls[idx] || urls[0] });
}

async function loadDetail() {
  try {
    detail.value = await api.chatGroupDetail(gid.value);
    groupName.value = detail.value.name || groupName.value;
    members.value = detail.value.members || [];
    uni.setNavigationBarTitle({ title: groupName.value });
  } catch (e) { toast(e.message); }
}

async function load(scroll) {
  const rows = await api.chatGroupMessages(gid.value);
  messages.value = (rows || []).slice();
  if (scroll !== false) {
    await nextTick();
    anchor.value = 'bottom';
  }
}

async function loadEarlier() {
  if (!messages.value.length) return uni.stopPullDownRefresh && uni.stopPullDownRefresh();
  const oldest = messages.value[0].id;
  try {
    const rows = await api.chatGroupMessages(gid.value, oldest);
    if (rows && rows.length) messages.value = rows.concat(messages.value);
    else toast('没有更早的消息了');
  } catch (e) { toast(e.message); }
  uni.stopPullDownRefresh && uni.stopPullDownRefresh();
}

async function addImage() {
  try { image.value = await chooseImageAsBase64(7); } catch (e) { /* cancel */ }
}
async function send() {
  if (sending.value || !canSend.value) return;
  sending.value = true;
  try {
    const payload = { content: draft.value };
    if (image.value) payload.attachments = [image.value];
    await api.chatGroupSend(gid.value, payload);
    draft.value = '';
    image.value = null;
    await load();
  } catch (e) { toast(e.message); } finally { sending.value = false; }
}

async function onLongPress(m) {
  if (m.user_id !== myId.value) return;
  const ok = await confirm('确定删除这条消息？', '删除消息');
  if (!ok) return;
  try {
    await api.chatGroupMessageDelete(gid.value, m.id);
    toast('已删除', 'success');
    load(false);
  } catch (e) { toast(e.message); }
}

function goInfo() {
  uni.navigateTo({ url: '/packageTeam/pages/chat/info?gid=' + gid.value + '&id=' + teamId.value });
}

function startPoll() {
  stopPoll();
  timer = setInterval(() => { load(false).catch(() => {}); }, 12000);
}
function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }

onLoad((o) => {
  gid.value = Number(o.gid);
  teamId.value = Number(o.id);
  if (o.name) groupName.value = decodeURIComponent(o.name);
  loadDetail();
  load();
  startPoll();
});
onShow(() => { if (gid.value) { loadDetail(); load(false); startPoll(); } });
onHide(stopPoll);
onUnload(stopPoll);
</script>

<style lang="scss" scoped>
.chat-page { display: flex; flex-direction: column; height: 100vh; background: #f8fafc; }
.room-head { display: flex; align-items: center; justify-content: space-between; padding: 16rpx 24rpx; background: #fff; border-bottom: 1rpx solid #e2e8f0; }
.rh-main { display: flex; flex-direction: column; gap: 4rpx; }
.rh-name { font-size: 30rpx; font-weight: 800; color: #1e293b; }
.rh-count { font-size: 22rpx; color: #94a3b8; }
.rh-arrow { font-size: 24rpx; color: #2563eb; }
.msg-list { flex: 1; height: 0; padding: 24rpx; box-sizing: border-box; }
.msg-row { display: flex; gap: 16rpx; margin-bottom: 28rpx; }
.msg-row.mine { flex-direction: row-reverse; }
.msg-avatar { width: 72rpx; height: 72rpx; border-radius: 50%; overflow: hidden; background: #2563eb; flex: none; display: flex; align-items: center; justify-content: center; }
.avatar-img { width: 100%; height: 100%; }
.avatar-text { color: #fff; font-size: 30rpx; font-weight: 700; }
.bubble-wrap { max-width: 72%; }
.msg-row.mine .bubble-wrap { display: flex; flex-direction: column; align-items: flex-end; }
.sender { font-size: 22rpx; color: #94a3b8; margin-bottom: 6rpx; }
.bubble { background: #fff; border: 1rpx solid #e2e8f0; border-radius: 18rpx; border-top-left-radius: 6rpx; padding: 18rpx 22rpx; font-size: 27rpx; line-height: 1.6; }
.msg-row.mine .bubble { background: #2563eb; color: #fff; border-color: #2563eb; border-top-left-radius: 18rpx; border-top-right-radius: 6rpx; }
.time { font-size: 20rpx; color: #94a3b8; margin-top: 6rpx; }
.att-img { width: 300rpx; border-radius: 10rpx; margin-top: 10rpx; }
.input-bar { display: flex; align-items: center; gap: 14rpx; padding: 14rpx 20rpx calc(14rpx + env(safe-area-inset-bottom)); background: #fff; border-top: 1rpx solid #e2e8f0; }
.img-btn { font-size: 44rpx; padding: 0 10rpx; }
.msg-input { flex: 1; height: 76rpx; background: #f1f5f9; border-radius: 38rpx; padding: 0 28rpx; font-size: 27rpx; }
.send-btn { width: 140rpx; height: 76rpx; font-size: 27rpx; padding: 0; }
</style>