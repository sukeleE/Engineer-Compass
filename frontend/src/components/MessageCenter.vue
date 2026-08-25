<script setup>
// 全局消息中心（右下角浮窗，仿 AIChatBox）：评论/点赞/收藏通知 + 好友私信
// 有未读时按钮右上角显示红点数字；面板分「私信评论 / 点赞 / 收藏」三组（小红书风格）
import { ref, watch, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';

// 纯面板：由 ToolDock 控制开关；面板打开期间 3s 快轮询未读计数（红点徽标轮询在 ToolDock）
const props = defineProps({ open: Boolean });
const emit = defineEmits(['close']);
const router = useRouter();
const tab = ref('dm');
const counts = ref({ comments: 0, likes: 0, favs: 0, dm: 0 });
const notif = ref({ comments: [], likes: [], favs: [] });
const friends = ref([]); // 好友列表（带 unread/last_msg/last_time）

let fastTimer = null;

async function refreshUnread() {
  try {
    counts.value = await api.notificationsUnread();
  } catch { /* 网络错误静默 */ }
}

async function loadAll() {
  try {
    const [n, f] = await Promise.all([api.notifications(), api.friendList()]);
    notif.value = n;
    friends.value = f;
  } catch { /* 静默 */ }
}

// 通知跳转：标已读 + 跳到帖子详情（评论区可直接回复）
async function goNotif(n) {
  if (!n.is_read) {
    n.is_read = 1;
    api.notificationsRead([n.type]).catch(() => {});
    refreshUnread();
  }
  emit('close'); // 跳转前关闭面板
  router.push(`/share?post=${n.post.id}`);
}

// 私信跳转：跳到「我的」- 好友 tab，自动打开与对方的私聊弹窗
function goDm(f) {
  emit('close'); // 跳转前关闭面板
  router.push(`/me?tab=friends&dm=${f.id}`);
}

// 头像点击：跳转对方公开主页（停止冒泡，不触发整行点击）
function goProfile(id) {
  if (!id) return;
  emit('close'); // 跳转前关闭面板
  router.push(`/user/${id}`);
}

async function readAll() {
  await api.notificationsRead(['comment', 'like', 'fav']).catch(() => {});
  for (const k of ['comments', 'likes', 'favs']) notif.value[k].forEach((n) => (n.is_read = 1));
  refreshUnread();
  ElMessage.success('已全部标记为已读');
}

// 时间：今天 HH:MM / 昨天 / MM-DD
function fmtTime(t) {
  if (!t) return '';
  const d = new Date(String(t).replace(' ', 'T'));
  const now = new Date();
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, now)) return d.toTimeString().slice(0, 5);
  if (same(d, new Date(now.getTime() - 86400000))) return '昨天';
  return String(t).slice(5, 10);
}

// 各 tab 未读数徽标
const dmUnread = () => (counts.value.comments || 0) + (counts.value.dm || 0);
const likeUnread = () => counts.value.likes || 0;
const favUnread = () => counts.value.favs || 0;

onBeforeUnmount(() => {
  clearInterval(fastTimer);
});

watch(() => props.open, (v) => {
  if (v) {
    refreshUnread();
    loadAll();
    fastTimer = setInterval(refreshUnread, 3000); // 面板打开期间快轮询
  } else {
    clearInterval(fastTimer);
    fastTimer = null;
  }
});
</script>

<template>
  <!-- 消息面板（由 ToolDock 控制开关） -->
  <transition name="chat">
    <div v-if="props.open" class="m-panel">
      <div class="m-head">
        <b>🔔 消息中心</b>
        <div class="m-actions">
          <el-button v-if="counts.total > 0" link size="small" @click="readAll">全部已读</el-button>
          <el-button link size="small" @click="emit('close')">收起</el-button>
        </div>
      </div>

      <el-tabs v-model="tab" class="m-tabs">
        <!-- Tab1 私信评论 -->
        <el-tab-pane name="dm">
          <template #label>
            <span class="t-label">私信评论<em v-if="dmUnread()" class="t-num">{{ dmUnread() }}</em></span>
          </template>
          <div class="m-scroll">
            <!-- 好友私信（按最近消息排序，来自 friendList） -->
            <template v-if="friends.length">
              <div class="m-section">好友私信</div>
              <div
                v-for="f in friends" :key="f.id" class="n-item"
                :class="{ unread: f.unread > 0 }" @click="goDm(f)"
              >
                <div class="av av-link" title="查看主页" @click.stop="goProfile(f.id)">
                  <img v-if="f.avatar" :src="f.avatar" alt="" />
                  <span v-else>{{ f.nickname?.charAt(0) || '?' }}</span>
                </div>
                <div class="n-body">
                  <div class="n-line1">
                    <span class="n-who">{{ f.nickname }}</span>
                    <span class="n-time">{{ fmtTime(f.last_time) }}</span>
                  </div>
                  <div class="n-act">
                    <em v-if="f.unread > 0" class="n-unread">{{ f.unread }} 条未读 · </em>{{ f.last_msg || '打个招呼吧' }}
                  </div>
                </div>
              </div>
            </template>

            <!-- 评论通知 -->
            <template v-if="notif.comments.length">
              <div class="m-section">评论我的帖子</div>
              <div
                v-for="n in notif.comments" :key="n.id" class="n-item"
                :class="{ unread: !n.is_read }" @click="goNotif(n)"
              >
                <div class="av av-link" title="查看主页" @click.stop="goProfile(n.actor?.id)">
                  <img v-if="n.actor?.avatar" :src="n.actor.avatar" alt="" />
                  <span v-else>{{ n.actor?.nickname?.charAt(0) || '?' }}</span>
                </div>
                <div class="n-body">
                  <div class="n-line1">
                    <span class="n-who">{{ n.actor?.nickname }}</span>
                    <span class="n-time">{{ fmtTime(n.create_time) }}</span>
                  </div>
                  <div class="n-act">评论了你的帖子</div>
                  <div class="n-txt">{{ n.content || '（评论已删除）' }}</div>
                  <div class="n-post">📄 {{ n.post?.title }}</div>
                </div>
              </div>
            </template>

            <el-empty v-if="!friends.length && !notif.comments.length" description="暂无私信和评论" :image-size="50" />
          </div>
        </el-tab-pane>

        <!-- Tab2 点赞 -->
        <el-tab-pane name="like">
          <template #label>
            <span class="t-label">点赞<em v-if="likeUnread()" class="t-num">{{ likeUnread() }}</em></span>
          </template>
          <div class="m-scroll">
            <div
              v-for="n in notif.likes" :key="n.id" class="n-item"
              :class="{ unread: !n.is_read }" @click="goNotif(n)"
            >
              <div class="av av-link" title="查看主页" @click.stop="goProfile(n.actor?.id)">
                <img v-if="n.actor?.avatar" :src="n.actor.avatar" alt="" />
                <span v-else>{{ n.actor?.nickname?.charAt(0) || '?' }}</span>
              </div>
              <div class="n-body">
                <div class="n-line1">
                  <span class="n-who">{{ n.actor?.nickname }}</span>
                  <span class="n-time">{{ fmtTime(n.create_time) }}</span>
                </div>
                <div class="n-act">👍 赞了你的帖子</div>
                <div class="n-post">📄 {{ n.post?.title }}</div>
              </div>
            </div>
            <el-empty v-if="!notif.likes.length" description="暂无点赞通知" :image-size="50" />
          </div>
        </el-tab-pane>

        <!-- Tab3 收藏 -->
        <el-tab-pane name="fav">
          <template #label>
            <span class="t-label">收藏<em v-if="favUnread()" class="t-num">{{ favUnread() }}</em></span>
          </template>
          <div class="m-scroll">
            <div
              v-for="n in notif.favs" :key="n.id" class="n-item"
              :class="{ unread: !n.is_read }" @click="goNotif(n)"
            >
              <div class="av av-link" title="查看主页" @click.stop="goProfile(n.actor?.id)">
                <img v-if="n.actor?.avatar" :src="n.actor.avatar" alt="" />
                <span v-else>{{ n.actor?.nickname?.charAt(0) || '?' }}</span>
              </div>
              <div class="n-body">
                <div class="n-line1">
                  <span class="n-who">{{ n.actor?.nickname }}</span>
                  <span class="n-time">{{ fmtTime(n.create_time) }}</span>
                </div>
                <div class="n-act">⭐ 收藏了你的帖子</div>
                <div class="n-post">📄 {{ n.post?.title }}</div>
              </div>
            </div>
            <el-empty v-if="!notif.favs.length" description="暂无收藏通知" :image-size="50" />
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>
  </transition>
</template>

<style lang="scss" scoped>
.m-panel {
  position: fixed; right: 22px; bottom: 140px; z-index: 1000;
  width: 420px; height: 640px; max-height: calc(100vh - 120px);
  background: #fff; border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, .2); border: 1px solid var(--border);
  display: flex; flex-direction: column; overflow: hidden;
  @media (max-width: 768px) {
    right: 0; bottom: 0; width: 100vw; height: 100vh; max-height: 100vh; border-radius: 0;
  }
}

.m-head {
  padding: 12px 16px; background: #2563eb; color: #fff; position: relative;
  b { font-size: 15px; }
  .m-actions { position: absolute; top: 8px; right: 8px; :deep(.el-button) { color: #dbeafe; } }
}

.m-tabs {
  flex: 1; display: flex; flex-direction: column; overflow: hidden;
  :deep(.el-tabs__header) { margin: 0; padding: 0 6px; }
  :deep(.el-tabs__content) { flex: 1; overflow: hidden; }
  // tab 标签未读数字徽标
  .t-label { display: inline-flex; align-items: center; gap: 4px;
    .t-num {
      font-style: normal; font-size: 10px; min-width: 15px; height: 15px; line-height: 15px;
      padding: 0 3px; border-radius: 999px; background: #ef4444; color: #fff; text-align: center;
    }
  }
}

.m-scroll { height: 100%; overflow-y: auto; background: #f8fafc; }
.m-section { padding: 10px 16px 4px; font-size: 12px; color: #94a3b8; }

// 消息条目（小红书风格：头像 + 昵称 + 动作 + 摘要；未读浅蓝底 + 左侧蓝条）
.n-item {
  display: flex; gap: 10px; padding: 10px 14px; cursor: pointer; align-items: flex-start;
  border-bottom: 1px solid #eef2f7; background: #fff;
  &:hover { background: #f8fafc; }
  &.unread { background: #eff6ff; border-left: 3px solid #2563eb; }
  .av {
    width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    background: #e2e8f0; color: #475569; font-size: 15px; overflow: hidden;
    img { width: 100%; height: 100%; object-fit: cover; }
  }
  .av-link { cursor: pointer; transition: box-shadow .15s;
    &:hover { box-shadow: 0 0 0 2px #2563eb66; }
  }
  .n-body { flex: 1; min-width: 0; }
  .n-line1 { display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
    .n-who { font-size: 13.5px; font-weight: 600; color: #111827; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .n-time { font-size: 11px; color: #94a3b8; flex-shrink: 0; }
  }
  .n-act { font-size: 12.5px; color: #64748b; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    .n-unread { font-style: normal; color: #ef4444; font-weight: 600; }
  }
  .n-txt {
    font-size: 12.5px; color: #374151; margin-top: 4px; background: #f1f5f9;
    border-radius: 6px; padding: 5px 8px; line-height: 1.5;
    overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  }
  .n-post { font-size: 12px; color: #2563eb; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}

.chat-enter-active, .chat-leave-active { transition: all .25s ease; }
.chat-enter-from, .chat-leave-to { opacity: 0; transform: translateY(16px) scale(.96); }
</style>
