<script setup>
// 群聊聊天窗：QQ 风格气泡；文字+图片、评论、删除（不支持编辑）、群成员管理与邀请、退群
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../../api.js';
import AttachmentList from './AttachmentList.vue';
import CommentThread from './CommentThread.vue';
import ResourcePicker from '../ResourcePicker.vue';
import { teamDisplayName, displayName } from '../../utils/displayName.js';
import { fmtShort } from '../../utils/time.js';

const props = defineProps({ group: Object, teamId: Number, members: { type: Array, default: () => [] }, me: Object });
const emit = defineEmits(['back', 'changed']);

const detail = ref(null);
const msgs = ref([]);
const input = ref('');
const imgAtts = ref([]);
const imgInput = ref(null);
const sending = ref(false);
const loadingMore = ref(false);
const resPickDlg = ref(false);
const infoDlg = ref(false);
const addIds = ref([]);
const inviteUid = ref(null);
const stickBottom = ref(true);
const scrollEl = ref(null);
let timer = null;

const myId = computed(() => props.me?.user_id);
const groupMembers = computed(() => detail.value?.members || []);
const notInGroup = computed(() => {
  const ids = new Set(groupMembers.value.map((m) => m.user_id));
  return props.members.filter((m) => !ids.has(Number(m.id)));
});
const memberById = (uid) => groupMembers.value.find((m) => Number(m.user_id) === Number(uid));
const avatarOf = (uid) => memberById(uid)?.avatar || null;
const isOwner = computed(() => detail.value && detail.value.owner_id === myId.value);

async function loadDetail() {
  detail.value = await api.chatGroupDetail(props.group.id);
}

function scrollBottom() {
  const el = scrollEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}
function onScroll() {
  const el = scrollEl.value;
  if (!el) return;
  stickBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

async function load(scroll = true) {
  const rows = await api.chatGroupMessages(props.group.id);
  msgs.value = rows || [];
  if (scroll) await nextTick(), scrollBottom();
}

async function loadMore() {
  if (!msgs.value.length || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const oldest = msgs.value[0].id;
    const el = scrollEl.value;
    const prevH = el?.scrollHeight || 0;
    const rows = await api.chatGroupMessages(props.group.id, oldest);
    if (rows?.length) {
      msgs.value = [...rows, ...msgs.value];
      await nextTick();
      if (el) el.scrollTop = el.scrollHeight - prevH;
    } else {
      ElMessage.info('没有更早的消息了');
    }
  } catch (e) { ElMessage.error(e.message); } finally { loadingMore.value = false; }
}

// 静默轮询：不打断阅读位置，仅在贴底时自动滚动
async function silentPoll() {
  try {
    const rows = await api.chatGroupMessages(props.group.id);
    if (rows?.length) {
      msgs.value = rows;
      if (stickBottom.value) await nextTick(), scrollBottom();
    }
  } catch { /* 轮询静默 */ }
}

async function pickImgs(e) {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (imgAtts.value.length + files.length > 5) return ElMessage.warning('一次最多 5 张图');
  for (const f of files) {
    if (!f.type.startsWith('image/')) { ElMessage.warning(`「${f.name}」不是图片`); continue; }
    if (f.size > 10 * 1024 * 1024) { ElMessage.warning(`「${f.name}」超过 10MB`); continue; }
    const data = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(f);
    });
    imgAtts.value.push({ name: f.name, size: f.size, mime: f.type, data });
  }
}
const onResourcePick = (r) => {
  if (imgAtts.value.length >= 5) return ElMessage.warning('一次最多 5 张图');
  imgAtts.value.push({ name: r.name, size: r.size, mime: r.mime, url: r.url });
  ElMessage.success(`已引用「${r.name}」`);
};
const attSrc = (a) => (a.data ? `data:${a.mime};base64,${a.data}` : a.url || '');

async function send() {
  if (!input.value.trim() && !imgAtts.value.length) return;
  sending.value = true;
  try {
    await api.chatGroupSend(props.group.id, { content: input.value, attachments: imgAtts.value });
    input.value = '';
    imgAtts.value = [];
    stickBottom.value = true;
    await load();
  } catch (e) { ElMessage.error(e.message); } finally { sending.value = false; }
}

async function remove(m) {
  try {
    await ElMessageBox.confirm('确定删除这条消息？', '删除消息', { type: 'warning' });
  } catch { return; }
  try {
    await api.chatGroupMessageDelete(props.group.id, m.id);
    await load(false);
  } catch (e) { ElMessage.error(e.message); }
}
const canMod = (m) => detail.value && (detail.value.is_team_owner || detail.value.owner_id === myId.value || m.user_id === myId.value);
const senderName = (m) => teamDisplayName(m, props.members);

// —— 群信息/成员管理 ——
async function openInfo() {
  infoDlg.value = true;
  addIds.value = [];
  inviteUid.value = null;
  await loadDetail();
}
async function addMembers() {
  if (!addIds.value.length) return;
  try {
    await api.chatGroupMembersAdd(props.group.id, addIds.value);
    ElMessage.success('已添加成员');
    addIds.value = [];
    await Promise.all([loadDetail(), emitChanged()]);
  } catch (e) { ElMessage.error(e.message); }
}
async function removeMember(uid) {
  try {
    await ElMessageBox.confirm('确定将该成员移出群聊？', '移除成员', { type: 'warning' });
  } catch { return; }
  try {
    await api.chatGroupMemberRemove(props.group.id, uid);
    await Promise.all([loadDetail(), emitChanged()]);
  } catch (e) { ElMessage.error(e.message); }
}
async function sendInvite() {
  if (!inviteUid.value) return;
  try {
    await api.chatInviteCreate(props.group.id, inviteUid.value);
    ElMessage.success('邀请已发出，等待对方确认');
    inviteUid.value = null;
  } catch (e) { ElMessage.error(e.message); }
}
async function leave() {
  try {
    await ElMessageBox.confirm(detail.value?.member_count <= 1 ? '你是最后一位成员，退群后群聊将解散，确定吗？' : '确定退出该群聊？', '退出群聊', { type: 'warning' });
  } catch { return; }
  try {
    await api.chatGroupLeave(props.group.id);
    ElMessage.success('已退出群聊');
    emitChanged();
    emit('back');
  } catch (e) { ElMessage.error(e.message); }
}
function emitChanged() {
  emit('changed');
  return Promise.resolve();
}

onMounted(async () => {
  try {
    await Promise.all([loadDetail(), load()]);
    timer = setInterval(silentPoll, 12000);
  } catch (e) { ElMessage.error(e.message); }
});
onBeforeUnmount(() => timer && clearInterval(timer));
</script>

<template>
  <div class="chat-room">
    <div class="room-head">
      <el-button class="back-btn" text @click="emit('back')">← 返回</el-button>
      <div class="head-title">
        <b>{{ group.name }}</b>
        <span v-if="detail" class="head-count">{{ detail.member_count }} 人 · {{ group.visibility === 'private' ? '私有群' : '公开群' }}</span>
      </div>
      <el-button text @click="openInfo">群信息 ›</el-button>
    </div>

    <div ref="scrollEl" class="msg-scroll" @scroll="onScroll">
      <div class="load-more" @click="loadMore">加载更早的消息</div>
      <div v-if="!msgs.length" class="room-empty">还没有消息，来发第一条吧 💬</div>
      <div v-for="m in msgs" :key="m.id" class="msg-row" :class="{ mine: m.user_id === myId }">
        <div class="msg-avatar">
          <img v-if="avatarOf(m.user_id)" :src="avatarOf(m.user_id)" />
          <span v-else>{{ (senderName(m) || '?').charAt(0) }}</span>
        </div>
        <div class="msg-main">
          <div class="msg-meta">
            <span class="msg-sender">{{ senderName(m) }}</span>
            <span class="msg-time">{{ fmtShort(m.create_time) }}</span>
            <el-button v-if="canMod(m)" size="small" text type="danger" class="msg-del" @click="remove(m)">删除</el-button>
          </div>
          <div class="bubble">
            <div v-if="m.content" class="bubble-text">{{ m.content }}</div>
            <AttachmentList v-if="m.attachments?.length" :attachments="m.attachments" />
          </div>
          <CommentThread :team-id="teamId" type="message" :target="m" :members="members" />
        </div>
      </div>
    </div>

    <div class="input-bar">
      <input ref="imgInput" type="file" accept="image/*" multiple hidden @change="pickImgs" />
      <el-button title="附图片" @click="imgInput.click()">🖼️</el-button>
      <el-button title="从我的资源引用图片" @click="resPickDlg = true">📁</el-button>
      <ResourcePicker v-model="resPickDlg" only-image @pick="onResourcePick" />
      <div v-if="imgAtts.length" class="img-preview">
        <div v-for="(a, i) in imgAtts" :key="i" class="ip-item">
          <img :src="attSrc(a)" />
          <el-button size="small" text type="danger" @click="imgAtts.splice(i, 1)">×</el-button>
        </div>
      </div>
      <el-input v-model="input" placeholder="说点什么…（Enter 发送，可附图）" @keyup.enter="send" />
      <el-button type="primary" :loading="sending" @click="send">发送</el-button>
    </div>

    <!-- 群信息弹窗 -->
    <el-dialog v-model="infoDlg" :title="group.name" width="480px" append-to-body>
      <div v-if="detail" class="info-body">
        <div class="info-line"><span>群类型：</span>{{ detail.visibility === 'private' ? '🔒 私有群（仅群成员可见内容）' : '👥 公开群（全组可自由加入）' }}</div>
        <div class="info-line"><span>群主：</span>{{ detail.members.find((m) => m.is_owner) ? displayName(detail.members.find((m) => m.is_owner)) : '-' }}</div>
        <div v-if="detail.notice" class="info-line"><span>公告：</span>{{ detail.notice }}</div>

        <div class="member-head">群成员（{{ detail.member_count }}）</div>
        <div class="member-grid">
          <div v-for="m in detail.members" :key="m.user_id" class="member-cell">
            <div class="member-avatar">
              <img v-if="m.avatar" :src="m.avatar" />
              <span v-else>{{ (displayName(m) || '?').charAt(0) }}</span>
            </div>
            <div class="member-name">
              {{ displayName(m) }}<span v-if="m.is_owner" class="crown">👑</span>
            </div>
            <el-button v-if="isOwner && !m.is_owner" size="small" text type="danger" @click="removeMember(m.user_id)">移出</el-button>
          </div>
        </div>

        <div v-if="isOwner" class="manage-block">
          <div class="manage-title">群主直接加人</div>
          <div class="manage-row">
            <el-select v-model="addIds" multiple filterable collapse-tags collapse-tags-tooltip placeholder="选择本组成员" style="flex: 1">
              <el-option v-for="m in notInGroup" :key="m.id" :value="m.id" :label="displayName(m)" />
            </el-select>
            <el-button type="primary" :disabled="!addIds.length" @click="addMembers">添加</el-button>
          </div>
        </div>

        <div class="manage-block">
          <div class="manage-title">邀请队友（对方确认后入群）</div>
          <div class="manage-row">
            <el-select v-model="inviteUid" filterable clearable placeholder="选择本组成员" style="flex: 1">
              <el-option v-for="m in notInGroup" :key="m.id" :value="m.id" :label="displayName(m)" />
            </el-select>
            <el-button :disabled="!inviteUid" @click="sendInvite">发邀请</el-button>
          </div>
        </div>

        <div class="leave-row">
          <el-button type="danger" plain @click="leave">退出群聊</el-button>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<style lang="scss" scoped>
.chat-room { display: flex; flex-direction: column; height: 560px; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: var(--surface-2); }
.room-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--surface-3); border-bottom: 1px solid var(--border);
  .back-btn { display: none; }
  .head-title { flex: 1; display: flex; align-items: baseline; gap: 10px; min-width: 0;
    b { font-size: 15px; } .head-count { font-size: 12px; color: #94a3b8; } } }
.msg-scroll { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
.load-more { text-align: center; font-size: 12px; color: var(--primary); cursor: pointer; padding: 2px; }
.room-empty { text-align: center; color: #94a3b8; font-size: 13px; padding: 40px 0; }
.msg-row { display: flex; gap: 10px; &.mine { flex-direction: row-reverse; } }
.msg-avatar {
  width: 38px; height: 38px; border-radius: 50%; flex: none; overflow: hidden;
  background: var(--primary); color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700;
  img { width: 100%; height: 100%; object-fit: cover; }
}
.msg-main { max-width: 68%; display: flex; flex-direction: column; .mine & { align-items: flex-end; } }
.msg-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 4px;
  .msg-sender { font-size: 12.5px; color: #475569; font-weight: 600; }
  .msg-time { font-size: 11px; color: #94a3b8; }
  .msg-del { padding: 0; font-size: 11px; opacity: 0; transition: opacity 0.15s; } }
.msg-row:hover .msg-del { opacity: 1; }
.bubble {
  padding: 9px 13px; border-radius: 14px; background: var(--surface-3); border: 1px solid var(--border);
  border-top-left-radius: 4px; font-size: 13.5px; line-height: 1.7; word-break: break-word;
  .bubble-text { white-space: pre-wrap; }
}
.mine .bubble { background: var(--primary); color: #fff; border-color: var(--primary); border-top-left-radius: 14px; border-top-right-radius: 4px;
  :deep(.att-file) { background: rgba(255, 255, 255, 0.18); color: #fff; border-color: rgba(255, 255, 255, 0.35); } }
.input-bar { display: flex; gap: 8px; align-items: center; padding: 10px 12px; background: var(--surface-3); border-top: 1px solid var(--border); flex-wrap: wrap;
  .img-preview { display: flex; gap: 8px; width: 100%;
    .ip-item { position: relative; img { height: 56px; border-radius: 6px; border: 1px solid var(--border); }
      .el-button { position: absolute; top: -8px; right: -8px; padding: 2px 5px; } } } }
.info-body { .info-line { font-size: 13px; color: #475569; margin-bottom: 8px; span { color: #94a3b8; } } }
.member-head { font-weight: 700; font-size: 13.5px; margin: 12px 0 8px; }
.member-grid { display: flex; flex-wrap: wrap; gap: 10px; max-height: 220px; overflow-y: auto; }
.member-cell { width: 96px; display: flex; flex-direction: column; align-items: center; gap: 4px; position: relative;
  .member-avatar { width: 46px; height: 46px; border-radius: 50%; overflow: hidden; background: var(--primary); color: #fff;
    display: flex; align-items: center; justify-content: center; font-weight: 700;
    img { width: 100%; height: 100%; object-fit: cover; } }
  .member-name { font-size: 12px; color: #334155; text-align: center; word-break: break-all; .crown { margin-left: 2px; } } }
.manage-block { margin-top: 16px; .manage-title { font-size: 12.5px; color: #64748b; margin-bottom: 6px; } }
.manage-row { display: flex; gap: 8px; }
.leave-row { margin-top: 20px; text-align: center; }
@media (max-width: 768px) {
  .chat-room { height: calc(100vh - 150px); }
  .room-head .back-btn { display: inline-flex; }
  .msg-main { max-width: 82%; }
}
</style>