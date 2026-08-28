<script setup>
// 怪奇小队（幽灵模式面板，仅幽灵用户可见）：列出所有同等权限用户，点击直接私聊（零好友门槛）
// 入口：ToolDock 👻 按钮；打开时拉取名单；「进入秘密分享页」跳 /ghost-share；可退出幽灵模式
import { ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api.js';
import auth, { patchUser } from '../auth.js';
import DmDialog from './DmDialog.vue';

const props = defineProps({ open: Boolean });
const emit = defineEmits(['close']);
const router = useRouter();

const users = ref([]);
const loading = ref(false);
// 私聊：点击成员 → 打开公共 DmDialog（后端 /friends/dm 不校验好友关系，直接互通）
const dmUser = ref(null);
const dmOpen = ref(false);

async function load() {
  if (!props.open) return;
  loading.value = true;
  try {
    users.value = await api.ghostUsers();
  } catch (e) { ElMessage.error(e.message); }
  finally { loading.value = false; }
}
watch(() => props.open, load);

function openDm(u) { dmUser.value = u; dmOpen.value = true; }
function goShare() {
  emit('close');
  router.push('/ghost-share');
}

// 退出幽灵模式：确认 → 后端置 0 → patchUser 全站同步（App watch 自动摘反色、隐藏全部入口）
async function exitGhost() {
  try {
    await ElMessageBox.confirm('退出后将恢复普通世界：反色 UI、怪奇小队、秘密分享入口都会消失。你的幽灵帖仍会保留（仅幽灵可见）。确定退出？', '退出幽灵模式', { type: 'warning' });
  } catch { return; }
  try {
    const res = await api.ghostExit();
    patchUser(res.user);
    emit('close');
    router.push('/');
    ElMessage.success('已退出幽灵模式，欢迎回到普通世界');
  } catch (e) { ElMessage.error(e.message); }
}
</script>

<template>
  <!-- 怪奇小队面板（右下角，仿 MessageCenter 浮窗） -->
  <transition name="dock">
    <div v-if="props.open" class="g-panel">
      <div class="g-head">
        <b>👻 怪奇小队</b>
        <div class="g-actions">
          <button class="g-link" @click="goShare">秘密分享 →</button>
          <button class="g-close" title="关闭" @click="emit('close')">✕</button>
        </div>
      </div>
      <div v-loading="loading" class="g-body">
        <div class="g-tip">同等权限的幽灵成员，点击即可私聊</div>
        <div v-if="users.length" class="g-list">
          <button v-for="u in users" :key="u.id" class="g-user" :title="`@${u.username}`" @click="openDm(u)">
            <span class="g-avatar">
              <img v-if="u.avatar" :src="u.avatar" alt="" />
              <template v-else>{{ u.nickname?.charAt(0) || '👻' }}</template>
            </span>
            <span class="g-meta">
              <b>{{ u.nickname }}</b>
              <i>@{{ u.username }}</i>
            </span>
            <span class="g-dm">💬 私聊</span>
          </button>
        </div>
        <el-empty v-else description="还没有其他幽灵，把暗号分享给朋友吧" :image-size="60" />
      </div>
      <div class="g-foot">
        <button class="g-exit" @click="exitGhost">退出幽灵模式</button>
      </div>
    </div>
  </transition>

  <!-- 私聊弹窗（公共组件，3s 轮询；幽灵间无需好友关系） -->
  <DmDialog :open="dmOpen" :user="dmUser" @close="dmOpen = false" />
</template>

<style lang="scss" scoped>
.g-panel {
  position: fixed; right: 22px; bottom: 140px; z-index: 1000;
  width: 320px; max-height: calc(100vh - 160px);
  background: var(--card-bg); border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, .2); border: 1px solid var(--border);
  display: flex; flex-direction: column; overflow: hidden;
  @media (max-width: 768px) {
    right: 0; bottom: 0; width: 100vw; height: 70vh; max-height: 70vh; border-radius: 0;
  }
}
.g-head {
  padding: 12px 14px; background: linear-gradient(135deg, #7f1d1d, #dc2626); color: #fff;
  display: flex; align-items: center; justify-content: space-between;
  b { font-size: 15px; }
  .g-actions { display: flex; align-items: center; gap: 8px; }
  .g-link { background: rgba(255, 255, 255, .16); border: none; color: #fecaca; font-size: 12px;
    padding: 4px 10px; border-radius: 999px; cursor: pointer; }
  .g-close { background: none; border: none; color: #fca5a5; font-size: 14px; cursor: pointer; }
}
.g-body { flex: 1; overflow-y: auto; padding: 10px 12px; background: var(--surface-3); }
.g-tip { font-size: 12px; color: #94a3b8; margin-bottom: 8px; }
.g-list { display: flex; flex-direction: column; gap: 8px; }
.g-user {
  display: flex; align-items: center; gap: 10px; width: 100%;
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px;
  padding: 8px 10px; cursor: pointer; text-align: left; transition: all .15s;
  &:hover { border-color: var(--primary); box-shadow: 0 3px 10px rgba(220, 38, 38, .15); transform: translateY(-1px); }
  .g-avatar {
    width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0; overflow: hidden;
    display: flex; align-items: center; justify-content: center;
    background: var(--primary-tint); color: #f87171; font-size: 16px;
    img { width: 100%; height: 100%; object-fit: cover; }
  }
  .g-meta { flex: 1; min-width: 0;
    b { display: block; font-size: 13.5px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    i { font-style: normal; font-size: 11.5px; color: #94a3b8; }
  }
  .g-dm { font-size: 11.5px; color: #f87171; flex-shrink: 0; }
}
.g-foot { padding: 8px 12px; border-top: 1px solid var(--border); }
.g-exit {
  width: 100%; padding: 8px 0; border-radius: 999px; cursor: pointer;
  border: 1px solid #fecaca; background: var(--card-bg); color: #dc2626; font-size: 12.5px;
  &:hover { background: #fef2f2; }
}
</style>
