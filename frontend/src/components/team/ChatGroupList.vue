<script setup>
// 群聊列表：公开群自由加入，私有群仅显示名字+锁；顶部处理入群邀请与建群
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import { displayName } from '../../utils/displayName.js';
import { fmtShort } from '../../utils/time.js';

const props = defineProps({ teamId: Number, members: { type: Array, default: () => [] }, me: Object });
const emit = defineEmits(['open']);

const groups = ref([]);
const invites = ref([]);
const loading = ref(false);
const showCreate = ref(false);
const creating = ref(false);
const form = ref({ name: '', visibility: 'public', avatar_user_id: null, member_ids: [] });
let timer = null;

const AVATAR_COLORS = ['#2563eb', '#7c3aed', '#0891b2', '#059669', '#d97706', '#dc2626', '#db2777', '#4f46e5'];
const colorOf = (id) => AVATAR_COLORS[Math.abs(Number(id)) % AVATAR_COLORS.length];
const initialOf = (name) => String(name || '群').trim().charAt(0).toUpperCase();

const memberById = (uid) => props.members.find((x) => Number(x.id) === Number(uid));
const memberName = (uid) => {
  const m = memberById(uid);
  return m ? displayName(m) : '成员';
};
// 可选头像成员：只有上传过头像的成员才能作为群头像来源（引用 user.avatar，零冗余）
const avatarOptions = computed(() => props.members.filter((m) => m.avatar));
const privateMemberOptions = computed(() => props.members.filter((m) => Number(m.id) !== Number(props.me?.user_id)));

async function load() {
  loading.value = true;
  try {
    const [gs, iv] = await Promise.all([api.chatGroups(props.teamId), api.chatInvites()]);
    groups.value = gs || [];
    invites.value = (iv || []).filter((x) => Number(x.team_id) === Number(props.teamId));
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

function previewText(g) {
  const lm = g.last_message;
  if (!lm) return '还没有消息，来发第一条吧';
  const who = Number(lm.user_id) === Number(props.me?.user_id) ? '我' : memberName(lm.user_id);
  const body = lm.has_image ? (lm.content ? `${lm.content} [图片]` : '[图片]') : (lm.content || '');
  return `${who}：${body}`;
}

async function onClickGroup(g) {
  if (g.joined) return emit('open', g);
  if (g.visibility === 'private') {
    return ElMessage.warning('私有群聊，仅群成员可查看，请让群成员邀请你入群');
  }
  try {
    await api.chatGroupJoin(g.id);
    ElMessage.success(`已加入「${g.name}」`);
    await load();
    const ng = groups.value.find((x) => x.id === g.id);
    if (ng) emit('open', ng);
  } catch (e) { ElMessage.error(e.message); }
}

function openCreate() {
  if (groups.value.length >= 10) return ElMessage.warning('每个小组最多 10 个群聊');
  form.value = { name: '', visibility: 'public', avatar_user_id: null, member_ids: [] };
  showCreate.value = true;
}

async function submitCreate() {
  const name = form.value.name.trim();
  if (!name) return ElMessage.warning('请填写群名称');
  if (name.length > 20) return ElMessage.warning('群名称最多 20 字');
  creating.value = true;
  try {
    const card = {
      name,
      visibility: form.value.visibility,
      avatar_user_id: form.value.avatar_user_id || null,
    };
    if (form.value.visibility === 'private') card.member_ids = form.value.member_ids;
    const r = await api.chatGroupCreate(props.teamId, card);
    showCreate.value = false;
    await load();
    const ng = groups.value.find((x) => x.id === r.id);
    if (ng) emit('open', ng);
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    creating.value = false;
  }
}

async function acceptInvite(i) {
  try {
    await api.chatInviteAccept(i.group_id, i.id);
    ElMessage.success('已加入群聊');
    await load();
    const g = groups.value.find((x) => x.id === i.group_id);
    if (g?.joined) emit('open', g);
  } catch (e) { ElMessage.error(e.message); }
}
async function rejectInvite(i) {
  try {
    await api.chatInviteReject(i.group_id, i.id);
    await load();
  } catch (e) { ElMessage.error(e.message); }
}

onMounted(() => {
  load();
  timer = setInterval(load, 15000);
});
onBeforeUnmount(() => timer && clearInterval(timer));
defineExpose({ load });
</script>

<template>
  <div class="group-list" v-loading="loading">
    <!-- 入群邀请横幅 -->
    <div v-for="i in invites" :key="i.id" class="invite-card">
      <div class="invite-main">
        <div class="invite-title">
          <span class="lock">{{ i.visibility === 'private' ? '🔒' : '👥' }}</span>
          <b>{{ i.group_name }}</b>
          <span class="invite-from">{{ i.inviter_name }} 邀请你入群</span>
        </div>
        <div class="invite-team">{{ i.team_name }}</div>
      </div>
      <div class="invite-ops">
        <el-button size="small" type="primary" @click="acceptInvite(i)">接受</el-button>
        <el-button size="small" @click="rejectInvite(i)">拒绝</el-button>
      </div>
    </div>

    <div class="list-head">
      <span class="list-title">群聊（{{ groups.length }}/10）</span>
      <el-button size="small" type="primary" plain @click="openCreate">＋ 创建群聊</el-button>
    </div>

    <div v-if="!groups.length" class="empty">还没有群聊，点「创建群聊」发起第一个吧</div>

    <div
      v-for="g in groups"
      :key="g.id"
      class="group-card"
      :class="{ disabled: !g.joined && g.visibility === 'private' }"
      @click="onClickGroup(g)"
    >
      <div class="g-avatar" :style="g.avatar ? null : { background: colorOf(g.id) }">
        <img v-if="g.avatar" :src="g.avatar" :alt="g.name" />
        <span v-else>{{ initialOf(g.name) }}</span>
      </div>
      <div class="g-main">
        <div class="g-row1">
          <span class="g-name">{{ g.name }}</span>
          <span v-if="g.visibility === 'private'" class="g-tag">🔒 私有</span>
          <span v-else-if="!g.joined" class="g-tag public">未加入</span>
          <span v-if="g.joined" class="g-count">{{ g.member_count }}人</span>
          <span class="g-time">{{ g.last_message ? fmtShort(g.last_message.create_time) : '' }}</span>
        </div>
        <div class="g-row2">
          <span v-if="!g.joined && g.visibility === 'private'" class="g-preview locked">私有群聊，仅群成员可查看</span>
          <span v-else class="g-preview">{{ previewText(g) }}</span>
        </div>
      </div>
    </div>

    <!-- 建群弹窗 -->
    <el-dialog v-model="showCreate" title="创建群聊" width="460px" append-to-body>
      <el-form label-position="top">
        <el-form-item label="群名称（≤20字）" required>
          <el-input v-model="form.name" maxlength="20" show-word-limit placeholder="例如：机械组讨论群" @keyup.enter="submitCreate" />
        </el-form-item>
        <el-form-item label="群类型">
          <el-radio-group v-model="form.visibility">
            <el-radio value="public">👥 公开群（全组可见，谁都能自由加入）</el-radio>
            <el-radio value="private">🔒 私有群（列表可见，仅受邀/被添加的成员能进）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="form.visibility === 'private'" label="初始成员（建群者自动入群）">
          <el-select v-model="form.member_ids" multiple filterable collapse-tags collapse-tags-tooltip
            placeholder="选择初始成员，可不选" style="width: 100%">
            <el-option v-for="m in privateMemberOptions" :key="m.id" :value="m.id" :label="displayName(m)" />
          </el-select>
        </el-form-item>
        <el-form-item label="群头像（复用成员头像，不额外存储）">
          <el-select v-model="form.avatar_user_id" clearable placeholder="默认使用群名首字色块" style="width: 100%">
            <el-option v-for="m in avatarOptions" :key="m.id" :value="m.id" :label="`${displayName(m)} 的头像`">
              <div class="opt-avatar">
                <img v-if="m.avatar" :src="m.avatar" />
                <span>{{ displayName(m) }}</span>
              </div>
            </el-option>
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showCreate = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">创建</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style lang="scss" scoped>
.group-list { display: flex; flex-direction: column; gap: 10px; }
.invite-card {
  display: flex; align-items: center; gap: 10px; padding: 10px 14px;
  border: 1px solid color-mix(in srgb, var(--primary) 35%, white);
  background: var(--primary-tint); border-radius: 10px;
  .invite-main { flex: 1; min-width: 0; }
  .invite-title { display: flex; align-items: center; gap: 6px; font-size: 13.5px;
    b { font-size: 14px; } .lock { font-size: 15px; } }
  .invite-from { color: #64748b; font-size: 12px; }
  .invite-team { color: #94a3b8; font-size: 11.5px; margin-top: 2px; }
}
.list-head { display: flex; align-items: center; justify-content: space-between; margin: 4px 2px; }
.list-title { font-weight: 700; font-size: 14px; color: var(--text); }
.empty { text-align: center; color: #94a3b8; font-size: 13px; padding: 40px 0; }
.group-card {
  display: flex; align-items: center; gap: 12px; padding: 10px 12px;
  background: var(--surface-3); border: 1px solid var(--border); border-radius: 12px;
  cursor: pointer; transition: border-color 0.15s, transform 0.15s;
  &:hover { border-color: var(--primary); transform: translateY(-1px); }
  &.disabled { cursor: not-allowed; opacity: 0.85; &:hover { transform: none; border-color: var(--border); } }
}
.g-avatar {
  width: 44px; height: 44px; border-radius: 12px; flex: none; overflow: hidden;
  display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; font-size: 19px;
  img { width: 100%; height: 100%; object-fit: cover; }
}
.g-main { flex: 1; min-width: 0; }
.g-row1 { display: flex; align-items: center; gap: 8px; }
.g-name { font-weight: 700; font-size: 14px; color: var(--text); max-width: 46%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.g-tag { font-size: 11px; color: #b45309; background: #fef3c7; border-radius: 6px; padding: 1px 6px;
  &.public { color: var(--primary); background: var(--primary-tint); } }
.g-count { font-size: 11.5px; color: #64748b; }
.g-time { margin-left: auto; font-size: 11.5px; color: #94a3b8; flex: none; }
.g-row2 { margin-top: 3px; }
.g-preview {
  font-size: 12.5px; color: #64748b; display: block;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  &.locked { color: #b45309; }
}
.opt-avatar { display: flex; align-items: center; gap: 8px;
  img { width: 26px; height: 26px; border-radius: 50%; object-fit: cover; } }
</style>