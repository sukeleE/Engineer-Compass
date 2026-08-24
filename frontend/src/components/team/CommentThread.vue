<script setup>
// 评论线程：进度汇报/讨论消息通用 —— 💬 展开评论列表 + 输入回复（全员可评，本人可删）
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../../api.js';
import auth from '../../auth.js';

const props = defineProps({ teamId: Number, type: String, target: Object });
const open = ref(false);
const text = ref('');
const sending = ref(false);

const fmt = (t) => t?.replace('T', ' ').slice(5, 16) || '';

async function send() {
  if (!text.value.trim()) return;
  sending.value = true;
  try {
    if (props.type === 'log') await api.teamLogComment(props.teamId, props.target.id, text.value);
    else await api.teamMessageComment(props.teamId, props.target.id, text.value);
    props.target.comments.push({
      id: Date.now(), user_id: auth.user.id, nickname: auth.user.nickname || auth.user.username,
      content: text.value.trim(), create_time: new Date().toISOString(),
    });
    text.value = '';
  } catch (e) { ElMessage.error(e.message); } finally { sending.value = false; }
}

async function remove(c) {
  try {
    await api.teamCommentDelete(props.teamId, c.id);
    const i = props.target.comments.findIndex((x) => x.id === c.id);
    if (i >= 0) props.target.comments.splice(i, 1);
  } catch (e) { ElMessage.error(e.message); }
}

const canDel = (c) => c.user_id === auth.user.id;
</script>

<template>
  <div class="ct">
    <div class="ct-bar">
      <el-button size="small" text type="primary" @click="open = !open">
        💬 {{ target.comments?.length || 0 }} 条评论 {{ open ? '▾' : '▸' }}
      </el-button>
    </div>
    <div v-if="open" class="ct-panel">
      <div v-if="!target.comments?.length" class="ct-empty">还没有评论，来抢沙发～</div>
      <div v-for="c in target.comments" :key="c.id" class="ct-item">
        <b>{{ c.nickname }}</b>
        <span class="ct-time">{{ fmt(c.create_time) }}</span>
        <p>{{ c.content }}</p>
        <el-button v-if="canDel(c)" size="small" text type="danger" class="ct-del" @click="remove(c)">删</el-button>
      </div>
      <div class="ct-input">
        <el-input v-model="text" size="small" placeholder="回复…（Enter 发送）" @keyup.enter="send" />
        <el-button size="small" type="primary" :loading="sending" @click="send">回复</el-button>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.ct { margin-top: 6px;
  .ct-bar { .el-button { padding: 2px 6px; } }
  .ct-panel {
    background: #f8fafc; border: 1px dashed var(--border); border-radius: 8px; padding: 8px 10px; margin-top: 4px;
    .ct-empty { color: #94a3b8; font-size: 12px; padding: 4px 0; }
    .ct-item {
      position: relative; padding: 5px 0; border-bottom: 1px solid #f1f5f9; font-size: 12.5px;
      b { color: #475569; margin-right: 6px; }
      .ct-time { color: #94a3b8; font-size: 11px; }
      p { margin: 2px 0 0; color: #334155; line-height: 1.6; word-break: break-word; padding-right: 34px; }
      .ct-del { position: absolute; right: 0; top: 2px; padding: 0 4px; }
      &:last-child { border-bottom: none; }
    }
    .ct-input { display: flex; gap: 6px; margin-top: 8px; }
  }
}
</style>
