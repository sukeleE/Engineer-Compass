<script setup>
// 小组讨论（支持附图）
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import auth from '../../auth.js';
import AttachmentList from './AttachmentList.vue';
import CommentThread from './CommentThread.vue';

const router = useRouter();
// 点击作者昵称 → 进入其公开主页（只读）；自己 → 我的管理界面
const toProfile = (m) => router.push(m.user_id === auth.user?.id ? '/me' : `/user/${m.user_id}`);

const props = defineProps({ teamId: Number, me: Object, perms: Object, members: Array });

const msgs = ref([]);
const input = ref('');
const imgAtts = ref([]); // 待发送图片
const imgInput = ref(null);
const sending = ref(false);

async function load() {
  msgs.value = await api.teamMessages(props.teamId);
}

// 选图（最多 5 张，单张 ≤10MB）
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

async function send() {
  if (!input.value.trim() && !imgAtts.value.length) return;
  sending.value = true;
  try {
    await api.teamMessage(props.teamId, { content: input.value, attachments: imgAtts.value });
    input.value = '';
    imgAtts.value = [];
    await load();
  } catch (e) { ElMessage.error(e.message); } finally { sending.value = false; }
}

async function remove(m) {
  if (!canMod(m)) return ElMessage.warning('仅本人或管理员可删除');
  try {
    await api.teamMessageDelete(props.teamId, m.id);
    await load();
  } catch (e) { ElMessage.error(e.message); }
}

// 可改/可删：本人或组长/管理员
const canMod = (m) => Number(m.user_id) === Number(props.me.user_id) || props.perms.task;

// 作者角色（members 由 TeamDetail 传入，含 role_names 数组）
const roleNamesOf = (uid) => props.members?.find((x) => Number(x.id) === Number(uid))?.role_names || [];

// 原地编辑：消息体切换为输入框
const editId = ref(null);
const editText = ref('');
function startEdit(m) {
  editId.value = m.id;
  editText.value = m.content || '';
}
async function saveEdit(m) {
  if (!editText.value.trim()) return ElMessage.warning('消息内容不能为空');
  try {
    await api.teamMessageUpdate(props.teamId, m.id, { content: editText.value.trim(), attachments: m.attachments || [] });
    editId.value = null;
    await load();
  } catch (e) { ElMessage.error(e.message); }
}

onMounted(() => load().catch((e) => ElMessage.error(e.message)));
</script>

<template>
  <div class="chat">
    <div class="chat-list">
      <div v-if="!msgs.length" class="chat-empty">还没有讨论 — 来聊第一句吧 💬</div>
      <div v-for="m in msgs" :key="m.id" class="chat-item" :class="{ mine: m.user_id === me.user_id }">
        <div class="ci-head">
          <b class="u-link" @click="toProfile(m)">{{ m.nickname }}</b>
          <el-tag v-for="rn in roleNamesOf(m.user_id)" :key="rn" size="small" effect="plain" style="margin-left:2px">{{ rn }}</el-tag>
          <span class="ci-time">{{ m.create_time?.slice(5, 16) }}</span>
          <span class="ci-ops">
            <el-button v-if="canMod(m)" size="small" text type="primary" title="编辑消息" @click="startEdit(m)">✏️</el-button>
            <el-button v-if="canMod(m)" size="small" text type="danger" title="删除消息" @click="remove(m)">🗑</el-button>
          </span>
        </div>
        <div v-if="editId === m.id" class="ci-edit">
          <el-input v-model="editText" size="small" placeholder="修改消息…" @keyup.enter="saveEdit(m)" />
          <el-button size="small" type="primary" @click="saveEdit(m)">保存</el-button>
          <el-button size="small" @click="editId = null">取消</el-button>
        </div>
        <div v-else-if="m.content" class="ci-body">{{ m.content }}</div>
        <AttachmentList v-if="m.attachments?.length" :attachments="m.attachments" />
        <CommentThread :team-id="teamId" type="message" :target="m" />
      </div>
    </div>
    <div class="chat-input">
      <input ref="imgInput" type="file" accept="image/*" multiple hidden @change="pickImgs" />
      <el-button :disabled="!perms.message" title="附图片" @click="imgInput.click()">🖼️</el-button>
      <div v-if="imgAtts.length" class="img-preview">
        <div v-for="(a, i) in imgAtts" :key="i" class="ip-item">
          <img :src="`data:${a.mime};base64,${a.data}`" />
          <el-button size="small" text type="danger" @click="imgAtts.splice(i, 1)">×</el-button>
        </div>
      </div>
      <el-input v-model="input" placeholder="说点什么…（按 Enter 发送，可附图）" @keyup.enter="send" />
      <el-button type="primary" :disabled="!perms.message" :loading="sending" @click="send">发送</el-button>
    </div>
    <div v-if="!perms.message" class="chat-noperm">你的角色没有「发消息」权限（可让组长在 成员与角色 页调整）</div>
  </div>
</template>

<style lang="scss" scoped>
.chat-list { max-height: 480px; overflow-y: auto; padding: 4px 2px; }
.chat-empty { color: #94a3b8; text-align: center; padding: 50px 0; font-size: 13px; }
.chat-item {
  border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; margin-bottom: 8px; background: #f8fafc;
  &.mine { background: #eff6ff; border-color: #bfdbfe; }
  .ci-head { display: flex; align-items: center; gap: 8px; b { font-size: 13px; }
    .u-link { cursor: pointer; &:hover { color: #2563eb; } }
    .ci-time { color: #94a3b8; font-size: 11.5px; }
    .ci-ops { margin-left: auto; display: flex; align-items: center; gap: 2px; }
  }
  .ci-edit { display: flex; gap: 6px; margin-top: 6px; .el-input { flex: 1; } }
  .ci-body { font-size: 13.5px; line-height: 1.7; margin-top: 4px; white-space: pre-wrap; word-break: break-word; }
}
.chat-input { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap;
  .img-preview { display: flex; gap: 8px; width: 100%; flex-wrap: wrap;
    .ip-item { position: relative;
      img { height: 60px; border-radius: 6px; border: 1px solid var(--border); }
      .el-button { position: absolute; top: -8px; right: -8px; padding: 2px 5px; }
    }
  }
}
.chat-noperm { color: #94a3b8; font-size: 12px; margin-top: 6px; }
</style>
