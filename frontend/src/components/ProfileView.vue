<script setup>
// 用户公开主页：登录用户可查看资料、竞赛/学习进度、参加小组，并可评论或发起好友申请。
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api.js';
import auth from '../auth.js';
import { fmtDateTime, fmtRelative } from '../utils/time.js';
import PlanTiles from './team/PlanTiles.vue';

const route = useRoute();
const router = useRouter();
const data = ref(null);
const loading = ref(false);
const error = ref('');

const comments = ref([]);
const commentText = ref('');
const commentSaving = ref(false);
const friends = ref([]);
const friendRequests = ref({ incoming: [], outgoing: [] });
const friendSaving = ref(false);

const uid = computed(() => Number(route.params.id));
const isMe = computed(() => Number(auth.user?.id) === uid.value);
const incomingRequest = computed(() => friendRequests.value.incoming.find((x) => Number(x.user_id) === uid.value) || null);
const friendState = computed(() => {
  if (isMe.value) return 'me';
  if (friends.value.some((f) => Number(f.id) === uid.value)) return 'friend';
  if (friendRequests.value.outgoing.some((x) => Number(x.user_id) === uid.value)) return 'outgoing';
  if (incomingRequest.value) return 'incoming';
  return 'none';
});

// 转成 PlanTiles 的紧凑标签数据（只取展示所需字段）
const schedTiles = (arr) => arr.map((s) => ({ id: s.id, name: s.comp_name, done: s.done, total: s.total, phases: s.phases || [] }));
const studyTiles = (arr) => arr.map((s) => ({ id: s.id, name: s.topic, done: s.done, total: s.total, phases: s.phases || [], level: s.level }));
const commenterName = (c) => c.nickname || c.username || `用户${c.user_id}`;
const canDeleteComment = (c) => Number(c.user_id) === Number(auth.user?.id)
  || isMe.value
  || (auth.user?.is_admin && (auth.user.perms || []).some((p) => p === 'content:comment' || p === 'content'));

async function loadComments() {
  comments.value = await api.profileComments(uid.value);
}

async function loadSocial() {
  if (isMe.value) {
    friends.value = [];
    friendRequests.value = { incoming: [], outgoing: [] };
    return;
  }
  const [friendRows, requestRows] = await Promise.all([api.friendList(), api.friendRequests()]);
  friends.value = friendRows;
  friendRequests.value = requestRows;
}

async function load() {
  if (!auth.token) { error.value = '登录后查看用户主页'; return; }
  loading.value = true;
  error.value = '';
  data.value = null;
  comments.value = [];
  try {
    data.value = await api.userPublic(uid.value);
    // 评论/好友状态是增强信息：单项失败不应让整个主页打不开
    await Promise.allSettled([loadComments(), loadSocial()]);
  } catch (e) {
    error.value = e.message;
    data.value = null;
  } finally {
    loading.value = false;
  }
}

async function submitComment() {
  const content = commentText.value.trim();
  if (!content) return ElMessage.warning('请输入评论内容');
  if (content.length > 500) return ElMessage.warning('评论不能超过 500 字');
  commentSaving.value = true;
  try {
    const c = await api.profileCommentCreate(uid.value, content);
    comments.value = [c, ...comments.value];
    commentText.value = '';
    ElMessage.success('评论已发布');
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    commentSaving.value = false;
  }
}

async function deleteComment(c) {
  try {
    await ElMessageBox.confirm('确定删除这条主页评论？', '删除确认', { type: 'warning' });
  } catch { return; }
  try {
    await api.profileCommentDelete(uid.value, c.id);
    comments.value = comments.value.filter((x) => Number(x.id) !== Number(c.id));
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function sendFriendRequest() {
  friendSaving.value = true;
  try {
    const r = await api.friendRequest(uid.value);
    ElMessage.success(r.message || '好友申请已发送');
    await loadSocial();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    friendSaving.value = false;
  }
}

async function acceptFriendRequest() {
  if (!incomingRequest.value) return;
  friendSaving.value = true;
  try {
    await api.friendAccept(incomingRequest.value.id);
    ElMessage.success('已添加为好友');
    await loadSocial();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    friendSaving.value = false;
  }
}

async function rejectFriendRequest() {
  if (!incomingRequest.value) return;
  friendSaving.value = true;
  try {
    await api.friendReject(incomingRequest.value.id);
    ElMessage.success('已拒绝申请');
    await loadSocial();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    friendSaving.value = false;
  }
}

function goUserPage(id) {
  if (Number(id) === Number(auth.user?.id)) router.push('/me');
  else router.push(`/user/${id}`);
}

watch(uid, load);
onMounted(load);
</script>

<template>
  <main class="profile-page">
    <!-- 未登录 -->
    <div v-if="!auth.token" class="need-login">
      <div class="nl-icon">👤</div>
      <h2>查看用户主页需要登录</h2>
      <router-link :to="`/login?redirect=/user/${uid}`"><el-button type="primary" size="large">去登录 / 注册</el-button></router-link>
    </div>

    <div v-else v-loading="loading" class="profile-body">
      <!-- 加载失败 -->
      <el-empty v-if="error" :description="error" />

      <template v-else-if="data">
        <!-- 头部资料卡 -->
        <div class="pv-head">
          <span class="pv-avatar">
            <img v-if="data.user.avatar" :src="data.user.avatar" alt="" />
            <template v-else>{{ data.user.nickname?.[0] || '?' }}</template>
          </span>
          <div class="pv-info">
            <div class="pv-name">
              <b>{{ data.user.nickname }}</b>
              <span class="pv-username">@{{ data.user.username }}</span>
              <el-tag v-if="isMe" size="small" type="warning" style="margin-left:6px">这是我</el-tag>
            </div>
            <div class="pv-meta">加入于 {{ (data.user.create_time || '').slice(0, 10) }} · 参加 {{ data.teams.length }} 个小组</div>
            <router-link v-if="isMe" to="/me" class="pv-manage">⚙️ 前往我的管理界面</router-link>
          </div>
          <div v-if="!isMe" class="pv-actions">
            <el-button v-if="friendState === 'none'" type="primary" :loading="friendSaving" @click="sendFriendRequest">＋ 添加好友</el-button>
            <el-button v-else-if="friendState === 'outgoing'" disabled>申请已发送</el-button>
            <template v-else-if="friendState === 'incoming'">
              <el-button type="primary" :loading="friendSaving" @click="acceptFriendRequest">同意申请</el-button>
              <el-button :loading="friendSaving" @click="rejectFriendRequest">拒绝</el-button>
            </template>
            <template v-else-if="friendState === 'friend'">
              <el-tag type="success" effect="light">已是好友</el-tag>
              <router-link :to="`/me?tab=friends&dm=${uid}`"><el-button type="primary" plain>发私信</el-button></router-link>
            </template>
          </div>
        </div>

        <!-- 主页评论 -->
        <section class="pv-sec comment-sec">
          <div class="pv-sec-head">
            <h3>💬 主页评论（{{ comments.length }}）</h3>
            <span class="pv-sec-tip">登录用户可见，评论会展示在 TA 的主页</span>
          </div>
          <div v-if="!isMe" class="comment-form">
            <el-input
              v-model="commentText"
              type="textarea"
              :rows="3"
              maxlength="500"
              show-word-limit
              placeholder="友善评论，例如交流竞赛方向、合作意向……"
            />
            <div class="comment-form-actions">
              <el-button type="primary" :loading="commentSaving" @click="submitComment">发布评论</el-button>
            </div>
          </div>
          <el-alert v-else title="不能给自己的主页评论，你可以在其他同学主页评论。" type="info" show-icon :closable="false" />
          <div v-if="comments.length" class="comment-list">
            <div v-for="c in comments" :key="c.id" class="comment-item">
              <span class="comment-avatar" @click="goUserPage(c.user_id)">
                <img v-if="c.avatar" :src="c.avatar" alt="" />
                <template v-else>{{ commenterName(c).charAt(0) || '?' }}</template>
              </span>
              <div class="comment-body">
                <div class="comment-meta">
                  <b @click="goUserPage(c.user_id)">{{ commenterName(c) }}</b>
                  <span v-if="c.username">@{{ c.username }}</span>
                  <time :title="fmtDateTime(c.create_time)">{{ fmtRelative(c.create_time) }}</time>
                </div>
                <div class="comment-content">{{ c.content }}</div>
              </div>
              <el-button v-if="canDeleteComment(c)" size="small" text type="danger" @click="deleteComment(c)">删除</el-button>
            </div>
          </div>
          <el-empty v-else description="还没有评论，来打个招呼吧" :image-size="64" class="comment-empty" />
        </section>

        <!-- 🏆 竞赛备赛计划（全部显示，含已完成——成果展示；紧凑标签点击展开详细进度） -->
        <section v-if="data.schedules.length" class="pv-sec">
          <h3>🏆 竞赛备赛计划（{{ data.schedules.length }}）</h3>
          <PlanTiles :items="schedTiles(data.schedules)" />
        </section>
        <el-empty v-else description="暂无竞赛备赛计划" :image-size="70" class="pv-empty" />

        <!-- 📚 学习日程（紧凑标签点击展开详细进度） -->
        <section v-if="data.studies.length" class="pv-sec">
          <h3>📚 学习日程（{{ data.studies.length }}）</h3>
          <PlanTiles :items="studyTiles(data.studies)" />
        </section>
        <el-empty v-else description="暂无学习日程" :image-size="70" class="pv-empty" />

        <!-- 🏗️ 参加的小组 -->
        <section v-if="data.teams.length" class="pv-sec">
          <h3>🏗️ 参加的项目小组（{{ data.teams.length }}）</h3>
          <div class="team-grid">
            <router-link v-for="t in data.teams" :key="t.id" :to="`/team?team=${t.id}`" class="team-card">
              <div class="tc-top">
                <b>{{ t.name }}</b>
                <el-tag v-if="t.is_owner" size="small" type="warning">👑 组长</el-tag>
              </div>
              <div v-if="t.desc" class="tc-desc">{{ t.desc }}</div>
              <div class="tc-meta">
                <el-tag v-for="rn in t.role_names || []" :key="rn" size="small" effect="plain" style="margin-right:4px">{{ rn }}</el-tag>
                <span class="tc-count">{{ t.member_count }} 人</span>
              </div>
            </router-link>
          </div>
        </section>
        <el-empty v-else description="未参加任何小组" :image-size="70" class="pv-empty" />
      </template>
    </div>
  </main>
</template>

<style lang="scss" scoped>
.profile-page { padding: 20px 24px; max-width: 960px; margin: 0 auto; }
.need-login { text-align: center; padding: 80px 0;
  .nl-icon { font-size: 48px; }
  h2 { margin: 12px 0 6px; }
}
.profile-body { min-height: 400px; }

.pv-head {
  display: flex; align-items: center; gap: 16px; margin-bottom: 20px;
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px;
  .pv-avatar {
    width: 72px; height: 72px; border-radius: 50%; background: var(--primary); color: #fff;
    display: flex; align-items: center; justify-content: center; font-size: 28px; flex-shrink: 0; overflow: hidden;
    img { width: 100%; height: 100%; object-fit: cover; }
  }
  .pv-info { min-width: 0; flex: 1; }
  .pv-name { display: flex; align-items: center; flex-wrap: wrap; gap: 6px;
    b { font-size: 20px; }
    .pv-username { color: var(--text-2); font-size: 13px; }
  }
  .pv-meta { color: var(--text-2); font-size: 12.5px; margin-top: 4px; }
  .pv-manage { display: inline-block; margin-top: 8px; font-size: 12.5px; color: var(--primary); }
  .pv-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
}

.pv-sec { margin-top: 18px;
  h3 { font-size: 15px; margin: 0 0 10px; }
}
.pv-sec-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 10px;
  h3 { margin: 0; }
}
.pv-sec-tip { color: var(--text-2); font-size: 12px; }
.pv-empty { background: var(--card-bg); border: 1px dashed var(--border); border-radius: 12px; margin-top: 18px; }

.comment-sec {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 14px; padding: 16px;
}
.comment-form { margin-bottom: 14px; }
.comment-form-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
.comment-list { display: flex; flex-direction: column; gap: 12px; }
.comment-item { display: flex; gap: 10px; align-items: flex-start; padding: 12px; border: 1px solid var(--border); border-radius: 12px; background: color-mix(in srgb, var(--primary) 2%, var(--card-bg)); }
.comment-avatar {
  width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; overflow: hidden; cursor: pointer;
  display: flex; align-items: center; justify-content: center; color: #fff; background: var(--primary); font-weight: 700;
  img { width: 100%; height: 100%; object-fit: cover; }
}
.comment-body { flex: 1; min-width: 0; }
.comment-meta { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 12.5px;
  b { cursor: pointer; color: var(--text-1); &:hover { color: var(--primary); } }
  span { color: var(--text-2); }
  time { color: #94a3b8; margin-left: auto; }
}
.comment-content { margin-top: 5px; font-size: 14px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; }
.comment-empty { padding: 16px 0; background: transparent; }

.team-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.team-card {
  display: block; background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px;
  padding: 12px 14px; text-decoration: none; color: inherit; transition: all .15s;
  &:hover { border-color: #93c5fd; box-shadow: 0 2px 10px color-mix(in srgb, var(--primary) 10%, transparent); }
  .tc-top { display: flex; align-items: center; gap: 6px; b { font-size: 14.5px; } }
  .tc-desc { color: var(--text-2); font-size: 12.5px; margin: 4px 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tc-meta { display: flex; align-items: center; flex-wrap: wrap; margin-top: 6px;
    .tc-count { margin-left: auto; color: var(--text-2); font-size: 12px; }
  }
}

@media (max-width: 768px) {
  .profile-page { padding: 14px; }
  .pv-head { flex-direction: column; align-items: flex-start; }
  .pv-actions { width: 100%; justify-content: flex-start; }
  .comment-meta time { margin-left: 0; width: 100%; }
}
</style>
