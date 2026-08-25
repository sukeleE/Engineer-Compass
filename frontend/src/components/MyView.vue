<script setup>
// 「我的」个人中心：账号信息 + 数据概览（备赛/学习计划、小组）+ 快捷入口 + 退出登录
// 四个标签：概览 / 我的帖子 / 我的收藏 / 好友私聊（好友申请、删除、私信轮询）
// 未登录时内嵌 AuthView 完成登录
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api.js';
import auth, { clearAuth, patchUser } from '../auth.js';
import { cnt, excerpt, firstImage, attDataURL } from '../utils/share.js';
import AuthView from './AuthView.vue';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const router = useRouter();
// 小组角色摘要：组长显示「组长 · 角色」（组长也可多角色），普通成员显示角色名/组员
const teamRoleText = (t) => {
  const roles = (t.role_names || []).join('、');
  if (t.is_owner) return roles ? `组长 · ${roles}` : '组长';
  return roles || '组员';
};
const loading = ref(false);
const profile = ref(null); // api.me()：{ user, teams[] }
const schedules = ref([]);
const studies = ref([]);

async function load() {
  if (!auth.token) return;
  loading.value = true;
  try {
    const [me, sched, study] = await Promise.all([api.me(), api.scheduleList(), api.studyList()]);
    profile.value = me;
    schedules.value = sched;
    studies.value = study;
  } catch (e) {
    if (e.message.includes('401') || e.message.includes('登录')) clearAuth();
    else ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

// 备赛计划总进度
const planStat = computed(() => {
  const all = schedules.value.flatMap((s) => (s.plan?.phases || []).flatMap((p) => p.tasks || []));
  return { count: schedules.value.length, done: all.filter((t) => t.done).length, total: all.length };
});
// 学习日程总进度
const studyStat = computed(() => {
  const all = studies.value.flatMap((s) => (s.plan?.phases || []).flatMap((p) => p.tasks || []));
  return { count: studies.value.length, done: all.filter((t) => t.done).length, total: all.length };
});
const pct = (st) => (st.total ? Math.round((st.done / st.total) * 100) : 0);

function logout() {
  clearAuth();
  ElMessage.success('已退出登录');
  router.push('/');
}

// ---- 头像：隐藏 input → FileReader → canvas 128px 居中裁剪 JPEG 压缩 → dataURL 存库 ----
const avatarInput = ref(null);
const avatarUploading = ref(false);
function pickAvatar() { avatarInput.value?.click(); }
function onAvatarFile(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) return ElMessage.warning('请选择图片文件');
  if (file.size > 5 * 1024 * 1024) return ElMessage.warning('图片不能超过 5MB');
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const sq = Math.min(img.width, img.height); // 居中裁剪正方形
      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 128;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 128, 128); // JPEG 无透明通道，先铺白底
      ctx.drawImage(img, (img.width - sq) / 2, (img.height - sq) / 2, sq, sq, 0, 0, 128, 128);
      let dataURL = canvas.toDataURL('image/jpeg', 0.85);
      if (dataURL.length > 60000) dataURL = canvas.toDataURL('image/jpeg', 0.6); // 仍过大降质
      saveAvatar(dataURL);
    };
    img.onerror = () => ElMessage.error('图片读取失败');
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}
async function saveAvatar(dataURL) {
  avatarUploading.value = true;
  try {
    const res = await api.updateProfile({ avatar: dataURL });
    patchUser(res.user);
    ElMessage.success('头像已更新');
  } catch (err) { ElMessage.error(err.message); }
  finally { avatarUploading.value = false; }
}

// ---- 昵称编辑 ----
const nickDlg = ref(false);
const nickVal = ref('');
function openNick() { nickVal.value = auth.user?.nickname || ''; nickDlg.value = true; }
async function saveNick() {
  const nk = nickVal.value.trim();
  if (!nk) return ElMessage.warning('昵称不能为空');
  try {
    const res = await api.updateProfile({ nickname: nk });
    patchUser(res.user);
    nickDlg.value = false;
    ElMessage.success('昵称已更新');
  } catch (err) { ElMessage.error(err.message); }
}

// ---- 邮箱绑定 / 更换（新邮箱验证码校验，purpose=bind） ----
const mailDlg = ref(false);
const mailVal = ref('');
const mailCode = ref('');
const mailSending = ref(false);
const mailCountdown = ref(0);
let mailTimer = null;
function openMail() {
  mailVal.value = auth.user?.email || '';
  mailCode.value = '';
  mailDlg.value = true;
}
async function sendBindCode() {
  const mail = mailVal.value.trim();
  if (!EMAIL_RE.test(mail)) return ElMessage.warning('请输入正确的邮箱地址');
  mailSending.value = true;
  try {
    const res = await api.sendCode(mail, 'bind');
    if (res.dev_code) {
      mailCode.value = res.dev_code;
      ElMessage.success(`开发模式验证码：${res.dev_code}（配置 SMTP 后改为邮件发送）`);
    } else {
      ElMessage.success('验证码已发送到新邮箱，10 分钟内有效');
    }
    mailCountdown.value = 60;
    mailTimer = setInterval(() => {
      if (--mailCountdown.value <= 0) { clearInterval(mailTimer); mailTimer = null; }
    }, 1000);
  } catch (err) { ElMessage.error(err.message); }
  finally { mailSending.value = false; }
}
async function saveMail() {
  const mail = mailVal.value.trim();
  if (!EMAIL_RE.test(mail)) return ElMessage.warning('请输入正确的邮箱地址');
  if (!/^\d{6}$/.test(mailCode.value.trim())) return ElMessage.warning('请输入 6 位数字验证码');
  try {
    const res = await api.bindEmail({ email: mail, code: mailCode.value.trim() });
    patchUser(res.user);
    mailDlg.value = false;
    ElMessage.success('邮箱已更新，下次可用新邮箱登录');
  } catch (err) { ElMessage.error(err.message); }
}

// ---- 意见反馈（存库 + 邮件转发管理员） ----
const fbContent = ref('');
const fbSending = ref(false);
async function submitFeedback() {
  const content = fbContent.value.trim();
  if (!content) return ElMessage.warning('请先填写反馈内容');
  fbSending.value = true;
  try {
    await api.feedback({ content });
    fbContent.value = '';
    ElMessage.success('反馈已提交，感谢你的建议！');
  } catch (err) { ElMessage.error(err.message); }
  finally { fbSending.value = false; }
}

// ================= 帖子：我的 / 收藏（切到对应标签才拉取） =================
const tab = ref('overview');
const postsLoading = ref(false);
const minePosts = ref([]);
const favPosts = ref([]);
const mineLoaded = ref(false);
const favLoaded = ref(false);
const postsShown = computed(() => (tab.value === 'mine' ? minePosts.value : favPosts.value));
async function loadPosts(scope) {
  postsLoading.value = true;
  try {
    const data = await api.sharePosts({ scope, page: 1, size: 20 });
    if (scope === 'mine') minePosts.value = data.rows;
    else favPosts.value = data.rows;
  } catch (e) { ElMessage.error(e.message); }
  finally { postsLoading.value = false; }
}
// 点卡片 → 资源分享页并自动打开详情弹窗
const goPost = (p) => router.push(`/share?post=${p.id}`);

// ================= 好友与私聊 =================
const friends = ref([]); // [{id, nickname, username, avatar, unread, last_msg, last_time}]
const reqs = ref({ incoming: [], outgoing: [] });
const friendsLoaded = ref(false);
async function loadFriends() {
  try {
    const [f, r] = await Promise.all([api.friendList(), api.friendRequests()]);
    friends.value = f;
    reqs.value = r;
  } catch (e) { ElMessage.error(e.message); }
}
// 搜索结果的用户状态：friend 已是好友 / out 已发申请 / in 对方申请了我 / none 可添加
const stateOf = (u) => {
  const id = Number(u.id);
  if (friends.value.some((f) => Number(f.id) === id)) return 'friend';
  if (reqs.value.outgoing.some((x) => Number(x.user_id) === id)) return 'out';
  if (reqs.value.incoming.some((x) => Number(x.user_id) === id)) return 'in';
  return 'none';
};
async function sendReq(u) {
  try {
    const r = await api.friendRequest(u.id);
    ElMessage.success(r.message);
    await loadFriends(); await doSearch(true); // 刷新状态
  } catch (e) { ElMessage.error(e.message); }
}
async function acceptReq(x) {
  try {
    await api.friendAccept(x.id);
    ElMessage.success(`已和 ${x.nickname} 成为好友`);
    await loadFriends();
  } catch (e) { ElMessage.error(e.message); }
}
async function rejectReq(x) {
  try {
    await api.friendReject(x.id);
    ElMessage.success('已拒绝申请');
    await loadFriends();
  } catch (e) { ElMessage.error(e.message); }
}
async function removeFriend(f) {
  try {
    await ElMessageBox.confirm(`删除好友「${f.nickname}」？聊天记录保留`, '删除好友', { type: 'warning' });
  } catch { return; }
  try {
    await api.friendRemove(f.id);
    ElMessage.success('已删除好友');
    await loadFriends();
  } catch (e) { ElMessage.error(e.message); }
}
// 用户搜索
const searchQ = ref('');
const searchRes = ref([]);
const searching = ref(false);
const searched = ref(false);
async function doSearch(silent = false) {
  const q = searchQ.value.trim();
  if (!q) return ElMessage.warning('输入用户名或昵称');
  searching.value = true;
  if (!silent) searched.value = true;
  try { searchRes.value = await api.friendSearch(q); } catch (e) { ElMessage.error(e.message); }
  finally { searching.value = false; }
}
// 私聊：弹窗打开时 3s 轮询拉新消息（GET 顺带把对方发来的标已读），关闭即停
const dmDlg = ref(false);
const dmFriend = ref(null);
const dmMsgs = ref([]);
const dmText = ref('');
const dmSending = ref(false);
const dmListEl = ref(null);
let dmTimer = null;
async function loadDm() {
  if (!dmFriend.value) return;
  try {
    dmMsgs.value = await api.dmList(dmFriend.value.id);
    await loadFriends(); // 顺带刷新好友未读徽标
    nextTick(scrollDm);
  } catch (e) { ElMessage.error(e.message); }
}
function scrollDm() {
  const el = dmListEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}
async function sendDm() {
  const content = dmText.value.trim();
  if (!content) return ElMessage.warning('输入私信内容');
  if (!dmFriend.value) return;
  dmSending.value = true;
  try {
    await api.dmSend(dmFriend.value.id, content);
    dmText.value = '';
    await loadDm();
  } catch (e) { ElMessage.error(e.message); }
  finally { dmSending.value = false; }
}
function openDm(f) { dmFriend.value = f; dmDlg.value = true; loadDm(); }

// 切标签懒加载：帖子 / 收藏 / 好友
watch(tab, (t) => {
  if (t === 'mine' && !mineLoaded.value) { mineLoaded.value = true; loadPosts('mine'); }
  else if (t === 'favs' && !favLoaded.value) { favLoaded.value = true; loadPosts('favs'); }
  else if (t === 'friends' && !friendsLoaded.value) { friendsLoaded.value = true; loadFriends(); }
});
// 私聊弹窗开关 → 轮询启停
watch(dmDlg, (open) => {
  if (dmTimer) { clearInterval(dmTimer); dmTimer = null; }
  if (open) dmTimer = setInterval(loadDm, 3000);
});

// 深链：/me?tab=friends&dm=好友id → 切到好友标签并自动打开与该好友的私聊（消息中心跳转用）
const route = useRoute();
function deepLink() {
  if (!route.query.tab) return;
  tab.value = String(route.query.tab);
  if (String(route.query.tab) === 'friends') {
    if (!friendsLoaded.value) { friendsLoaded.value = true; loadFriends(); }
    const target = Number(route.query.dm);
    if (target) {
      const tryOpen = () => {
        const f = friends.value.find((x) => Number(x.id) === target);
        router.replace({ query: {} }); // 清掉 query，避免刷新重复触发
        if (f) openDm(f);
      };
      if (friends.value.length) tryOpen();
      else {
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (friends.value.length) { clearInterval(iv); tryOpen(); }
          else if (Date.now() - t0 > 3000) { clearInterval(iv); router.replace({ query: {} }); }
        }, 100);
      }
    }
  }
}
onMounted(() => { load(); deepLink(); });
onBeforeUnmount(() => {
  if (mailTimer) clearInterval(mailTimer);
  if (dmTimer) clearInterval(dmTimer);
});
</script>

<template>
  <!-- 未登录：内嵌登录界面 -->
  <AuthView v-if="!auth.token" />

  <main v-else v-loading="loading" class="me-page">
    <!-- 账号卡片 -->
    <section class="me-card">
      <div class="me-avatar" :class="{ uploading: avatarUploading }" title="点击更换头像" @click="pickAvatar">
        <img v-if="auth.user?.avatar" :src="auth.user.avatar" alt="" />
        <template v-else>{{ auth.user?.nickname?.charAt(0) || '👤' }}</template>
        <span class="av-mask">{{ avatarUploading ? '上传中…' : '📷 更换' }}</span>
      </div>
      <input ref="avatarInput" type="file" accept="image/*" class="hide-file" @change="onAvatarFile" />
      <div class="me-info">
        <h2>{{ auth.user?.nickname }}
          <el-tag v-if="auth.user?.is_admin" size="small" type="danger" style="margin-left:8px">管理员</el-tag>
          <el-button text size="small" class="nick-edit" title="修改昵称" @click="openNick">✏️</el-button>
        </h2>
        <p class="me-id">@{{ auth.user?.username }}</p>
        <p class="me-mail">
          <template v-if="auth.user?.email">📧 {{ auth.user.email }}</template>
          <template v-else>📧 未绑定邮箱</template>
          <a class="mail-bind" @click="openMail">{{ auth.user?.email ? '🔄 更换邮箱' : '🔗 绑定邮箱' }}</a>
        </p>
      </div>
      <div class="me-actions">
        <el-button type="danger" plain @click="logout">退出登录</el-button>
      </div>
    </section>

    <!-- 修改昵称弹窗 -->
    <el-dialog v-model="nickDlg" title="修改昵称" width="400px" destroy-on-close>
      <el-input v-model="nickVal" maxlength="20" show-word-limit placeholder="输入新昵称" @keyup.enter="saveNick" />
      <template #footer>
        <el-button @click="nickDlg = false">取消</el-button>
        <el-button type="primary" @click="saveNick">保存</el-button>
      </template>
    </el-dialog>

    <!-- 绑定 / 更换邮箱弹窗（新邮箱验证码校验） -->
    <el-dialog v-model="mailDlg" :title="auth.user?.email ? '更换邮箱' : '绑定邮箱'" width="440px" destroy-on-close>
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="新邮箱（用于登录与接收验证码）">
          <el-input v-model="mailVal" placeholder="you@example.com" />
        </el-form-item>
        <el-form-item label="验证码">
          <div class="code-row">
            <el-input v-model="mailCode" maxlength="6" placeholder="6 位验证码" />
            <el-button :disabled="mailCountdown > 0" :loading="mailSending" @click="sendBindCode" style="width: 150px; flex-shrink: 0">
              {{ mailCountdown > 0 ? `${mailCountdown}s 后重发` : '发送验证码' }}
            </el-button>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="mailDlg = false">取消</el-button>
        <el-button type="primary" @click="saveMail">确认{{ auth.user?.email ? '更换' : '绑定' }}</el-button>
      </template>
    </el-dialog>

    <!-- 四个标签：概览 / 我的帖子 / 我的收藏 / 好友私聊 -->
    <el-tabs v-model="tab" class="me-tabs">
      <!-- 概览：数据统计 + 小组 + 快捷入口 + 反馈 -->
      <el-tab-pane label="📊 概览" name="overview">
        <div class="tab-pad">
          <section class="stat-row">
            <router-link to="/schedule" class="stat-card">
              <b class="sc-num">{{ planStat.count }}</b>
              <span class="sc-label">备赛计划</span>
              <el-progress :percentage="pct(planStat)" :stroke-width="6" :show-text="false" />
              <span class="sc-sub">{{ planStat.done }}/{{ planStat.total }} 任务完成 · {{ pct(planStat) }}%</span>
            </router-link>
            <router-link to="/schedule?tab=study" class="stat-card">
              <b class="sc-num">{{ studyStat.count }}</b>
              <span class="sc-label">学习日程</span>
              <el-progress :percentage="pct(studyStat)" :stroke-width="6" :show-text="false" />
              <span class="sc-sub">{{ studyStat.done }}/{{ studyStat.total }} 任务完成 · {{ pct(studyStat) }}%</span>
            </router-link>
            <router-link to="/team" class="stat-card">
              <b class="sc-num">{{ profile?.teams?.length || 0 }}</b>
              <span class="sc-label">加入小组</span>
              <span class="sc-sub">{{ profile?.teams?.map(teamRoleText).join(' / ') || '尚未加入小组' }}</span>
            </router-link>
          </section>

          <!-- 数据归属说明 -->
          <el-alert
            type="success" :closable="false" class="me-tip"
            title="登录后创建的计划已存入数据库并关联到本账号，任何设备登录都能查看"
          />

          <!-- 我的小组 -->
          <section v-if="profile?.teams?.length" class="me-block">
            <h3>🏗️ 我的小组</h3>
            <div class="team-list">
              <router-link v-for="t in profile.teams" :key="t.id" :to="`/team?team=${t.id}`" class="team-item">
                <div class="ti-info">
                  <b>{{ t.name }}</b>
                  <span class="ti-desc">{{ t.desc || '—' }}</span>
                </div>
                <el-tag size="small" :type="t.is_owner ? 'danger' : 'info'" v-if="t.is_owner">👑 组长</el-tag>
                <el-tag v-for="rn in t.role_names || []" :key="rn" size="small" type="info" style="margin-right:4px">{{ rn }}</el-tag>
                <el-tag v-if="!(t.role_names || []).length && !t.is_owner" size="small" type="info">组员</el-tag>
                <span class="ti-count">{{ t.member_count }} 人</span>
              </router-link>
            </div>
          </section>

          <!-- 快捷入口 -->
          <section class="me-block">
            <h3>⚡ 快捷入口</h3>
            <div class="quick-row">
              <router-link to="/schedule" class="quick-btn">📅 日程规划（竞赛 + 学习）</router-link>
              <router-link to="/team" class="quick-btn">🏗️ 项目小组</router-link>
              <router-link to="/" class="quick-btn">🗓️ 竞赛时间轴</router-link>
              <router-link to="/share" class="quick-btn">📤 资源分享</router-link>
              <router-link v-if="auth.user?.is_admin" to="/admin" class="quick-btn">🧠 AI 收录管理</router-link>
            </div>
          </section>

          <!-- 意见反馈 -->
          <section class="me-block fb-block">
            <h3>📮 意见反馈</h3>
            <p class="fb-tip">遇到问题或有好建议？告诉我们，反馈会直达管理员邮箱 📧</p>
            <el-input v-model="fbContent" type="textarea" :rows="4" maxlength="5000" show-word-limit
              placeholder="描述你遇到的问题或建议…（如：希望支持导出 PDF / 页面 XX 显示异常）" />
            <div class="fb-foot">
              <el-button type="primary" :loading="fbSending" @click="submitFeedback">提交反馈</el-button>
            </div>
          </section>
        </div>
      </el-tab-pane>

      <!-- 我的帖子 -->
      <el-tab-pane :label="`📝 我的帖子${minePosts.length ? `（${minePosts.length}）` : ''}`" name="mine">
        <div class="tab-pad" v-loading="postsLoading">
          <div class="mp-list">
            <div v-for="p in postsShown" :key="p.id" class="mp-card" @click="goPost(p)">
              <img v-if="firstImage(p)" :src="attDataURL(firstImage(p))" class="mp-thumb" alt="" loading="lazy" />
              <div class="mp-main">
                <div class="mp-title">
                  <b>{{ p.title }}</b>
                  <el-tag v-for="t in p.tags" :key="t" size="small" effect="plain" class="mp-tag">#{{ t }}</el-tag>
                </div>
                <div class="mp-ex">{{ excerpt(p.content) || '（纯附件帖）' }}</div>
                <div class="mp-meta">
                  <span class="mp-time">{{ p.create_time?.slice(0, 16) }}</span>
                  <span class="mp-acts">👍 {{ cnt(p.like_count) }} · ⭐ {{ cnt(p.fav_count) }} · 💬 {{ cnt(p.comment_count) }}</span>
                </div>
              </div>
            </div>
            <el-empty v-if="!postsLoading && !postsShown.length"
              :description="tab === 'mine' ? '你还没有发过帖子，去资源分享开第一楼吧' : '还没有收藏任何帖子'" :image-size="80" />
          </div>
        </div>
      </el-tab-pane>

      <!-- 我的收藏 -->
      <el-tab-pane :label="`⭐ 我的收藏${favPosts.length ? `（${favPosts.length}）` : ''}`" name="favs">
        <div class="tab-pad" v-loading="postsLoading">
          <div class="mp-list">
            <div v-for="p in postsShown" :key="p.id" class="mp-card" @click="goPost(p)">
              <img v-if="firstImage(p)" :src="attDataURL(firstImage(p))" class="mp-thumb" alt="" loading="lazy" />
              <div class="mp-main">
                <div class="mp-title">
                  <b>{{ p.title }}</b>
                  <el-tag v-for="t in p.tags" :key="t" size="small" effect="plain" class="mp-tag">#{{ t }}</el-tag>
                </div>
                <div class="mp-ex">{{ excerpt(p.content) || '（纯附件帖）' }}</div>
                <div class="mp-meta">
                  <span class="mp-time">{{ p.create_time?.slice(0, 16) }}</span>
                  <span class="mp-acts">👍 {{ cnt(p.like_count) }} · ⭐ {{ cnt(p.fav_count) }} · 💬 {{ cnt(p.comment_count) }}</span>
                </div>
              </div>
            </div>
            <el-empty v-if="!postsLoading && !postsShown.length"
              :description="tab === 'mine' ? '你还没有发过帖子，去资源分享开第一楼吧' : '还没有收藏任何帖子'" :image-size="80" />
          </div>
        </div>
      </el-tab-pane>

      <!-- 好友私聊 -->
      <el-tab-pane label="👥 好友私聊" name="friends">
        <div class="tab-pad">
          <div class="fr-grid">
            <!-- 添加好友 -->
            <div class="fr-card">
              <h4 class="fr-h">➕ 添加好友</h4>
              <div class="fr-search">
                <el-input v-model="searchQ" placeholder="搜索用户名 / 昵称" clearable @keyup.enter="doSearch()" />
                <el-button type="primary" :loading="searching" @click="doSearch()">搜索</el-button>
              </div>
              <div v-if="searchRes.length" class="fr-results">
                <div v-for="u in searchRes" :key="u.id" class="fr-user">
                  <img v-if="u.avatar" :src="u.avatar" class="fr-ava" alt="" />
                  <span v-else class="fr-ava no-ava">{{ u.nickname?.charAt(0) || '👤' }}</span>
                  <div class="fr-uinfo">
                    <b>{{ u.nickname }}</b>
                    <span class="fr-uname">@{{ u.username }}</span>
                  </div>
                  <el-button v-if="stateOf(u) === 'none'" size="small" type="primary" plain @click="sendReq(u)">➕ 加好友</el-button>
                  <el-button v-else-if="stateOf(u) === 'in'" size="small" type="primary" plain @click="sendReq(u)">✓ 同意对方</el-button>
                  <el-tag v-else-if="stateOf(u) === 'out'" size="small" type="info">已申请</el-tag>
                  <el-tag v-else size="small" type="success">已是好友</el-tag>
                </div>
              </div>
              <el-empty v-else-if="searched && !searching && !searchRes.length" description="没有找到用户" :image-size="60" />
            </div>

            <!-- 好友申请 -->
            <div class="fr-card">
              <h4 class="fr-h">📨 好友申请
                <span v-if="reqs.incoming.length" class="fr-badge">{{ reqs.incoming.length }}</span>
              </h4>
              <div v-if="reqs.incoming.length" class="fr-results">
                <div v-for="x in reqs.incoming" :key="x.id" class="fr-user">
                  <img v-if="x.avatar" :src="x.avatar" class="fr-ava" alt="" />
                  <span v-else class="fr-ava no-ava">{{ x.nickname?.charAt(0) || '👤' }}</span>
                  <div class="fr-uinfo">
                    <b>{{ x.nickname }}</b>
                    <span class="fr-uname">@{{ x.username }}</span>
                  </div>
                  <el-button size="small" type="success" plain @click="acceptReq(x)">✓ 同意</el-button>
                  <el-button size="small" type="danger" plain @click="rejectReq(x)">✗ 拒绝</el-button>
                </div>
              </div>
              <div v-else class="fr-empty2">暂无待处理的申请</div>

              <h4 class="fr-h fr-h2">🕐 我发出的申请</h4>
              <div v-if="reqs.outgoing.length" class="fr-results">
                <div v-for="x in reqs.outgoing" :key="x.id" class="fr-user">
                  <img v-if="x.avatar" :src="x.avatar" class="fr-ava" alt="" />
                  <span v-else class="fr-ava no-ava">{{ x.nickname?.charAt(0) || '👤' }}</span>
                  <div class="fr-uinfo">
                    <b>{{ x.nickname }}</b>
                    <span class="fr-uname">@{{ x.username }}</span>
                  </div>
                  <el-tag size="small" type="warning">等待对方同意</el-tag>
                </div>
              </div>
              <div v-else class="fr-empty2">暂无待对方同意的申请</div>
            </div>
          </div>

          <!-- 我的好友 -->
          <h4 class="fr-h">👥 我的好友（{{ friends.length }}）
            <span v-if="friends.length" class="fr-tip">有未读私信的好友显示红点</span>
          </h4>
          <div v-if="friends.length" class="fr-friends">
            <div v-for="f in friends" :key="f.id" class="fr-friend">
              <img v-if="f.avatar" :src="f.avatar" class="fr-ava big" alt="" />
              <span v-else class="fr-ava big no-ava">{{ f.nickname?.charAt(0) || '👤' }}</span>
              <div class="fr-uinfo">
                <b>{{ f.nickname }}</b>
                <span class="fr-last">{{ f.last_msg ? excerpt(f.last_msg, 28) : '还没有聊过天，发条消息打个招呼吧' }}</span>
              </div>
              <span v-if="f.unread > 0" class="fr-unread">{{ f.unread }}</span>
              <span class="fr-act">
                <el-button size="small" type="primary" round @click="openDm(f)">💬 私聊</el-button>
                <el-button size="small" text type="danger" @click="removeFriend(f)">删除</el-button>
              </span>
            </div>
          </div>
          <el-empty v-else description="还没有好友，搜索用户名添加吧" :image-size="80" />
        </div>
      </el-tab-pane>
    </el-tabs>

    <!-- 私聊弹窗（轮询拉新，关闭即停） -->
    <el-dialog v-model="dmDlg" :title="dmFriend ? `💬 私聊 · ${dmFriend.nickname}` : '私聊'" width="480px" top="6vh"
      destroy-on-close append-to-body>
      <div ref="dmListEl" class="dm-list">
        <div v-for="m in dmMsgs" :key="m.id" :class="['dm-bubble', Number(m.from_id) === Number(auth.user?.id) ? 'mine' : 'other']">
          <div class="dm-text">{{ m.content }}</div>
          <div class="dm-time">{{ m.create_time?.slice(5, 16) }}</div>
        </div>
        <el-empty v-if="!dmMsgs.length" description="还没有消息，说点什么吧" :image-size="50" />
      </div>
      <div class="dm-input">
        <el-input v-model="dmText" maxlength="2000" show-word-limit placeholder="输入私信，Enter 发送" @keyup.enter="sendDm" />
        <el-button type="primary" :loading="dmSending" @click="sendDm">发送</el-button>
      </div>
    </el-dialog>
  </main>
</template>

<style lang="scss" scoped>
.me-page { padding: 20px 24px 80px; max-width: 860px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }

.me-card {
  display: flex; align-items: center; gap: 18px;
  background: linear-gradient(135deg, #1e3a8a, #2563eb);
  color: #fff; border-radius: 14px; padding: 22px 24px;
  box-shadow: 0 6px 20px rgba(37, 99, 235, .25);

  .me-avatar {
    width: 64px; height: 64px; border-radius: 50%; flex-shrink: 0; position: relative;
    display: flex; align-items: center; justify-content: center; overflow: hidden;
    font-size: 28px; background: rgba(255, 255, 255, .18); border: 2px solid rgba(255, 255, 255, .4);
    cursor: pointer;
    img { width: 100%; height: 100%; object-fit: cover; }
    .av-mask {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      background: rgba(15, 23, 42, .55); color: #fff; font-size: 12px; opacity: 0;
      transition: opacity .15s;
    }
    &:hover .av-mask { opacity: 1; }
    // 触屏无 hover：更换头像遮罩恒显
    @media (max-width: 768px) { .av-mask { opacity: 1; font-size: 11px; } }
  }
  .hide-file { display: none; }
  .me-info { flex: 1; min-width: 0;
    h2 { margin: 0; font-size: 20px; display: flex; align-items: center; flex-wrap: wrap;
      .nick-edit { padding: 0 4px; color: rgba(255, 255, 255, .8); }
    }
    .me-id { margin: 2px 0 0; font-size: 13px; opacity: .75; }
    .me-mail { margin: 4px 0 0; font-size: 12.5px; opacity: .9;
      .mail-bind { color: #fff; text-decoration: underline; cursor: pointer; margin-left: 8px;
        &:hover { color: #bfdbfe; }
      }
    }
  }
}

.tab-pad { padding-top: 4px; display: flex; flex-direction: column; gap: 16px; }
.me-tabs { :deep(.el-tabs__item) { font-size: 14.5px; } }

.stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.stat-card {
  display: flex; flex-direction: column; gap: 6px;
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px;
  padding: 16px 18px; text-decoration: none; color: var(--text);
  transition: transform .15s, box-shadow .15s;
  &:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(30, 41, 59, .1); }
  .sc-num { font-size: 26px; color: #2563eb; }
  .sc-label { font-size: 13px; color: var(--text-2); }
  .sc-sub { font-size: 12px; color: #94a3b8; }
}

.me-tip { border-radius: 10px; }

.me-block {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px;
  h3 { margin: 0 0 12px; font-size: 15px; }
}
.team-list { display: flex; flex-direction: column; gap: 8px; }
.team-item {
  display: flex; align-items: center; gap: 12px; text-decoration: none; color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px;
  transition: background .15s;
  &:hover { background: #f1f5f9; }
  .ti-info { flex: 1; min-width: 0; b { display: block; font-size: 14px; }
    .ti-desc { font-size: 12px; color: var(--text-2); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  }
  .ti-count { font-size: 12px; color: #94a3b8; }
}
.quick-row { display: flex; gap: 10px; flex-wrap: wrap; }
.quick-btn {
  text-decoration: none; font-size: 13px; color: #2563eb;
  border: 1px solid #2563eb55; background: #2563eb0d; border-radius: 999px;
  padding: 7px 16px; transition: all .15s;
  &:hover { background: #2563eb; color: #fff; }
}

// 反馈区块
.fb-block {
  .fb-tip { margin: 0 0 10px; font-size: 12.5px; color: var(--text-2); }
  .fb-foot { margin-top: 10px; display: flex; justify-content: flex-end; }
}

.code-row { display: flex; gap: 8px; width: 100%; }

// —— 我的帖子 / 收藏 ——
.mp-list { display: flex; flex-direction: column; gap: 10px; min-height: 120px; }
.mp-card {
  display: flex; gap: 12px; background: var(--card-bg); border: 1px solid var(--border);
  border-radius: 12px; padding: 12px 14px; cursor: pointer; transition: all .15s;
  &:hover { border-color: #93c5fd; box-shadow: 0 2px 10px rgba(37, 99, 235, .08); }
  .mp-thumb { width: 96px; height: 68px; border-radius: 8px; object-fit: cover; flex-shrink: 0; border: 1px solid var(--border); background: #f1f5f9; }
  .mp-main { flex: 1; min-width: 0; }
  .mp-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    b { font-size: 15px; }
    .mp-tag { font-size: 11px; }
  }
  .mp-ex {
    color: var(--text-2); font-size: 13px; margin: 5px 0 8px; line-height: 1.6;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .mp-meta { display: flex; align-items: center; justify-content: space-between; font-size: 12.5px; color: #94a3b8; }
}
@media (max-width: 768px) {
  .mp-card { .mp-thumb { width: 84px; height: 60px; } .mp-meta { flex-direction: column; align-items: flex-start; gap: 2px; } }
}

// —— 好友与私聊 ——
.fr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 768px) { .fr-grid { grid-template-columns: 1fr; } }
.fr-card {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px;
  min-width: 0;
}
.fr-h { margin: 0 0 10px; font-size: 14.5px; display: flex; align-items: center; gap: 8px;
  .fr-badge {
    background: #ef4444; color: #fff; font-size: 11px; font-weight: 600;
    border-radius: 999px; padding: 1px 8px; line-height: 18px;
  }
  .fr-tip { font-size: 12px; color: #94a3b8; font-weight: 400; }
  &.fr-h2 { margin-top: 16px; }
}
.fr-search { display: flex; gap: 8px; margin-bottom: 10px; .el-input { flex: 1; } }
.fr-results { display: flex; flex-direction: column; gap: 8px; }
.fr-user {
  display: flex; align-items: center; gap: 10px; min-width: 0;
  border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px;
}
.fr-friends { display: flex; flex-direction: column; gap: 8px; }
.fr-friend {
  display: flex; align-items: center; gap: 10px; min-width: 0; position: relative;
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px;
  .fr-unread {
    position: absolute; top: -6px; left: 32px;
    background: #ef4444; color: #fff; font-size: 10.5px; font-weight: 700;
    border-radius: 999px; padding: 1px 7px; line-height: 16px;
    box-shadow: 0 0 0 2px #fff;
  }
  .fr-act { margin-left: auto; display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
}
.fr-ava {
  width: 36px; height: 36px; border-radius: 50%; object-fit: cover; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: #2563eb22; color: #2563eb; font-size: 15px; font-weight: 600;
  &.big { width: 40px; height: 40px; }
}
.fr-uinfo { flex: 1; min-width: 0;
  b { display: block; font-size: 14px; }
  .fr-uname { font-size: 12px; color: #94a3b8; }
  .fr-last { display: block; font-size: 12px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
}
.fr-empty2 { color: #94a3b8; font-size: 12.5px; padding: 8px 0; }

// —— 私聊弹窗 ——
.dm-list {
  height: 380px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px;
  padding: 6px 2px; margin-bottom: 12px;
}
.dm-bubble {
  max-width: 74%; padding: 8px 12px; border-radius: 12px; font-size: 13.5px; line-height: 1.7;
  overflow-wrap: anywhere; position: relative;
  .dm-time { font-size: 10.5px; opacity: .7; margin-top: 3px; }
  &.mine { align-self: flex-end; background: #2563eb; color: #fff; border-bottom-right-radius: 4px; }
  &.other { align-self: flex-start; background: #f1f5f9; border: 1px solid var(--border); border-bottom-left-radius: 4px; }
}
.dm-input { display: flex; gap: 8px; .el-input { flex: 1; } }
</style>
