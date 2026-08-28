<script setup>
// 「我的」个人中心：账号信息 + 数据概览（备赛/学习计划、小组）+ 快捷入口 + 退出登录
// 四个标签：概览 / 我的帖子 / 我的收藏 / 好友私聊（好友申请、删除、私信轮询）
// 未登录时内嵌 AuthView 完成登录
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api.js';
import auth, { clearAuth, patchUser } from '../auth.js';
import { cnt, excerpt, firstImage, attDataURL } from '../utils/share.js';
import AuthView from './AuthView.vue';
import DmDialog from './DmDialog.vue'; // 公共私聊弹窗（3s 轮询，关闭即停）

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
    // 同步最新用户信息（管理员权限可能刚被授予/撤销，localStorage 缓存是登录时的快照）
    patchUser(me.user);
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
// 好友头像 → 公开主页
const goUserPage = (id) => router.push(`/user/${id}`);

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
// 私聊弹窗：仅保留状态，消息逻辑在 DmDialog.vue（3s 轮询拉新，GET 顺带标已读，关闭即停）
const dmDlg = ref(false);
const dmFriend = ref(null);
function openDm(f) { dmFriend.value = f; dmDlg.value = true; }

// ================= 我的资源（≤128MB 个人文件库，配额 1GB） =================
const MAX_SIZE = 128 * 1024 * 1024;
const resInput = ref(null);
const resList = ref([]);
const resTotal = ref(0);
const resPage = ref(1);
const resSize = ref(20);
const resUsed = ref(0);
const resQuota = ref(1024 * 1024 * 1024);
const resLoading = ref(false);
const resUploading = ref(false);
const resLoaded = ref(false);
const fmtBytes = (n) => {
  n = Number(n) || 0;
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
};
async function loadResources() {
  resLoading.value = true;
  try {
    const r = await api.resourceList({ page: resPage.value, size: resSize.value });
    resList.value = r.list;
    resTotal.value = r.total;
    resUsed.value = r.used;
    resQuota.value = r.quota;
  } catch (e) { ElMessage.error(e.message); }
  finally { resLoading.value = false; }
}
// 隐藏 input → 直接 FormData 上传（不经 FileReader，128MB 内存安全）；上传成功回第一页刷新
async function onResFile(e) {
  const file = e.target.files?.[0];
  e.target.value = ''; // 置空以支持重复选择同一文件
  if (!file) return;
  if (file.size > MAX_SIZE) return ElMessage.warning('单个文件不能超过 128MB');
  if (file.size === 0) return ElMessage.warning('文件为空');
  resUploading.value = true;
  try {
    const r = await api.resourceUpload(file);
    ElMessage.success(`「${r.file_name}」上传成功（${fmtBytes(r.file_size)}）`);
    resPage.value = 1;
    await loadResources();
  } catch (err) { ElMessage.error(err.message); }
  finally { resUploading.value = false; }
}
// 分享管理：绑定飞书且 ≤20MB → 上传云盘换飞书链接（mode=feishu）；否则降级站内 token 链接（mode=local，可引用）
async function shareResource(row) {
  try {
    const s = await api.resourceShare(row.id);
    const link = s.mode === 'feishu' ? s.url : `${location.origin}${s.url}`;
    try { await navigator.clipboard.writeText(link); }
    catch { /* 非安全上下文剪贴板不可用，链接已在提示中展示 */ }
    ElMessage.success(s.mode === 'feishu'
      ? `已上传到飞书云盘，链接已复制：${link}\n（对方需有飞书访问权限才能打开）`
      : `已开启分享：${link}\n（复制成功，可在小组资料/帖子/编辑器等「我的资源」入口引用）`);
    loadResources();
  } catch (e) { ElMessage.error(e.message); }
}
async function unshareResource(row) {
  try {
    await ElMessageBox.confirm(`撤销「${row.file_name}」的分享？所有引用该资源的位置（小组资料/帖子附件/插图）将立即失效。`, '撤销分享', { type: 'warning' });
  } catch { return; }
  try {
    await api.resourceUnshare(row.id);
    ElMessage.success('分享已撤销');
    loadResources();
  } catch (e) { ElMessage.error(e.message); }
}
async function delResource(row) {
  try {
    await ElMessageBox.confirm(`删除资源「${row.file_name}」？磁盘文件将一并移除，不可恢复。`, '删除资源', { type: 'warning' });
  } catch { return; }
  try {
    await api.resourceDelete(row.id);
    ElMessage.success('已删除');
    loadResources();
  } catch (e) { ElMessage.error(e.message); }
}

// 切标签懒加载：帖子 / 收藏 / 好友 / 资源
watch(tab, (t) => {
  if (t === 'mine' && !mineLoaded.value) { mineLoaded.value = true; loadPosts('mine'); }
  else if (t === 'favs' && !favLoaded.value) { favLoaded.value = true; loadPosts('favs'); }
  else if (t === 'friends' && !friendsLoaded.value) { friendsLoaded.value = true; loadFriends(); }
  else if (t === 'resources' && !resLoaded.value) { resLoaded.value = true; loadResources(); }
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
// ---- 飞书绑定（P0：每用户绑定；一个飞书账号可绑定多个网页账号） ----
// 授权在飞书页面完成，回调页 window.opener.postMessage 通知 → 此处监听并刷新状态
const feishu = ref({ bound: false, loading: false });
const feishuListener = (e) => {
  if (e.data?.type === 'feishu-bound') {
    ElMessage.success('✅ 飞书绑定成功');
    loadFeishu();
  }
};
async function loadFeishu() {
  if (!auth.token) return;
  try {
    feishu.value = { ...(await api.feishuStatus()), loading: false };
  } catch { feishu.value = { bound: false, loading: false }; }
}
async function bindFeishu() {
  feishu.value.loading = true;
  try {
    const { url } = await api.feishuAuth();
    if (!url) throw new Error('飞书未配置，请联系管理员');
    window.open(url, '_blank'); // 不用 noopener：回调页需 postMessage 通知绑定结果
  } catch (e) {
    ElMessage.error(e.message);
    feishu.value.loading = false;
  }
}
async function unbindFeishu() {
  await ElMessageBox.confirm('解绑后本账号将无法使用飞书文档编辑与分享功能，确定解绑？', '解绑飞书', { type: 'warning' });
  feishu.value.loading = true;
  try {
    await api.feishuUnbind();
    ElMessage.success('已解绑飞书账号');
  } finally {
    feishu.value.loading = false;
    loadFeishu();
  }
}

onMounted(() => {
  load();
  deepLink();
  window.addEventListener('message', feishuListener);
  loadFeishu();
});
onBeforeUnmount(() => {
  window.removeEventListener('message', feishuListener);
  if (mailTimer) clearInterval(mailTimer);
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
              <router-link v-if="auth.user?.is_admin" to="/admin-console" class="quick-btn">⚙️ 后台管理</router-link>
            </div>
          </section>

          <!-- 飞书绑定（P0：每用户绑定，文档编辑 / 资源分享走飞书） -->
          <section class="me-block">
            <h3>
              🪶 飞书账号
              <el-tag size="small" :type="feishu.bound ? 'success' : 'info'" style="margin-left:6px">
                {{ feishu.bound ? '已绑定' : '未绑定' }}
              </el-tag>
            </h3>
            <p class="fb-tip">绑定飞书后，日程笔记 / 进度汇报 / 分享帖可直接在飞书文档里编辑，资源分享可从飞书引出链接</p>
            <div v-if="feishu.bound" class="feishu-bound">
              <el-avatar :src="feishu.avatar_url" :size="40" style="flex-shrink:0">{{ feishu.user_name?.[0] }}</el-avatar>
              <div class="feishu-info">
                <b>{{ feishu.user_name || '飞书用户' }}</b>
                <span class="feishu-sub">授权有效约 {{ Math.max(0, Math.floor((feishu.expires_in || 0) / 60)) }} 分钟 · 过期自动刷新</span>
              </div>
            </div>
            <div class="fb-foot">
              <el-button v-if="!feishu.bound" type="primary" :loading="feishu.loading" @click="bindFeishu">🔗 绑定飞书账号</el-button>
              <template v-else>
                <el-button type="success" plain @click="loadFeishu">🔄 刷新状态</el-button>
                <el-button type="danger" plain :loading="feishu.loading" @click="unbindFeishu">解绑</el-button>
              </template>
            </div>
          </section>

          <!-- 意见反馈 -->
          <section class="me-block fb-block">
            <h3>📮 意见反馈</h3>
            <p class="fb-tip">有建议或问题？直达管理员邮箱 📧</p>
            <el-input v-model="fbContent" type="textarea" :rows="4" maxlength="5000" show-word-limit
              placeholder="描述你的问题或建议…" />
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

      <!-- 我的资源 -->
      <el-tab-pane label="📁 我的资源" name="resources">
        <div class="tab-pad">
          <section class="me-block">
            <div class="res-bar">
              <el-button type="primary" :loading="resUploading" @click="resInput?.click()">⬆ 上传资源</el-button>
              <input ref="resInput" type="file" class="hide-file" @change="onResFile" />
              <span class="res-tip">单文件 ≤128MB · 个人配额 {{ fmtBytes(resQuota) }}</span>
            </div>
            <div class="res-quota">
              <span class="res-used">已用 {{ fmtBytes(resUsed) }} / {{ fmtBytes(resQuota) }}</span>
              <el-progress :percentage="resQuota ? Math.min(100, Math.round(resUsed / resQuota * 100)) : 0"
                :stroke-width="6" :show-text="false"
                :color="resQuota && resUsed / resQuota > 0.85 ? '#ef4444' : 'var(--primary)'" />
            </div>
          </section>
          <div v-loading="resLoading">
            <el-table :data="resList" stripe>
              <el-table-column prop="file_name" label="文件名" min-width="200" show-overflow-tooltip />
              <el-table-column label="大小" width="100">
                <template #default="{ row }">{{ fmtBytes(row.file_size) }}</template>
              </el-table-column>
              <el-table-column prop="file_type" label="类型" width="150" show-overflow-tooltip />
              <el-table-column prop="create_time" label="上传时间" width="165" />
              <el-table-column label="操作" width="225" fixed="right">
                <template #default="{ row }">
                  <a :href="`${api.resourceDownload(row.id)}?token=${auth.token}`" class="res-dl">⬇ 下载</a>
                  <el-button v-if="!row.shared" link type="primary" size="small" @click="shareResource(row)">🔗 分享</el-button>
                  <el-button v-else link type="warning" size="small" @click="unshareResource(row)">取消分享</el-button>
                  <el-button link type="danger" size="small" @click="delResource(row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
            <el-pagination v-if="resTotal > resSize" class="pg" background layout="total, prev, pager, next"
              :total="resTotal" :page-size="resSize" v-model:current-page="resPage" @current-change="loadResources" />
            <el-empty v-if="!resLoading && !resList.length"
              description="还没有资源 — 上传第一个（≤128MB/个）" :image-size="80" />
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
              <img v-if="f.avatar" :src="f.avatar" class="fr-ava big" alt="" title="查看主页" @click="goUserPage(f.id)" />
              <span v-else class="fr-ava big no-ava" title="查看主页" @click="goUserPage(f.id)">{{ f.nickname?.charAt(0) || '👤' }}</span>
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

    <!-- 私聊弹窗（DmDialog 内 3s 轮询拉新，关闭即停；@refresh 兜住好友未读徽标） -->
    <DmDialog :open="dmDlg" :user="dmFriend" @close="dmDlg = false" @refresh="loadFriends" />
  </main>
</template>

<style lang="scss" scoped>
.me-page { padding: 20px 24px 80px; max-width: 860px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }

.me-card {
  display: flex; align-items: center; gap: 18px;
  background: linear-gradient(135deg, #1e3a8a, var(--primary));
  color: #fff; border-radius: 14px; padding: 22px 24px;
  box-shadow: 0 6px 20px color-mix(in srgb, var(--primary) 25%, transparent);

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
        &:hover { color: color-mix(in srgb, var(--primary) 30%, white); }
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
  .sc-num { font-size: 26px; color: var(--primary); }
  .sc-label { font-size: 13px; color: var(--text-2); }
  .sc-sub { font-size: 12px; color: #94a3b8; }
}

.me-tip { border-radius: 10px; }

.me-block {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px;
  h3 { margin: 0 0 12px; font-size: 15px; }
}

// —— 我的资源 ——
.res-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.res-tip { font-size: 12.5px; color: var(--text-2); }
.res-quota { margin-top: 12px;
  .res-used { font-size: 12.5px; color: var(--text-2); display: block; margin-bottom: 6px; }
}
.res-dl { font-size: 13px; color: var(--primary); text-decoration: none; margin-right: 10px;
  &:hover { text-decoration: underline; }
}
.team-list { display: flex; flex-direction: column; gap: 8px; }
.team-item {
  display: flex; align-items: center; gap: 12px; text-decoration: none; color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px;
  transition: background .15s;
  &:hover { background: var(--surface-2); }
  .ti-info { flex: 1; min-width: 0; b { display: block; font-size: 14px; }
    .ti-desc { font-size: 12px; color: var(--text-2); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  }
  .ti-count { font-size: 12px; color: #94a3b8; }
}
.quick-row { display: flex; gap: 10px; flex-wrap: wrap; }
.quick-btn {
  text-decoration: none; font-size: 13px; color: var(--primary);
  border: 1px solid color-mix(in srgb, var(--primary) 33%, transparent); background: color-mix(in srgb, var(--primary) 5%, transparent); border-radius: 999px;
  padding: 7px 16px; transition: all .15s;
  &:hover { background: var(--primary); color: #fff; }
}

// 反馈区块
.fb-block {
  .fb-tip { margin: 0 0 10px; font-size: 12.5px; color: var(--text-2); }
  .fb-foot { margin-top: 10px; display: flex; justify-content: flex-end; }
}

// 飞书绑定卡
.feishu-bound {
  display: flex; align-items: center; gap: 12px;
  background: var(--card-bg); border: 1px solid var(--border);
  border-radius: 10px; padding: 12px 14px;
  .feishu-info { display: flex; flex-direction: column; gap: 2px; }
  .feishu-sub { font-size: 12px; color: var(--text-2); }
}

.code-row { display: flex; gap: 8px; width: 100%; }

// —— 我的帖子 / 收藏 ——
.mp-list { display: flex; flex-direction: column; gap: 10px; min-height: 120px; }
.mp-card {
  display: flex; gap: 12px; background: var(--card-bg); border: 1px solid var(--border);
  border-radius: 12px; padding: 12px 14px; cursor: pointer; transition: all .15s;
  &:hover { border-color: #93c5fd; box-shadow: 0 2px 10px color-mix(in srgb, var(--primary) 8%, transparent); }
  .mp-thumb { width: 96px; height: 68px; border-radius: 8px; object-fit: cover; flex-shrink: 0; border: 1px solid var(--border); background: var(--surface-2); }
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
  background: var(--primary)22; color: var(--primary); font-size: 15px; font-weight: 600;
  &.big { width: 40px; height: 40px; }
}
/* 好友列表头像可点击进主页（搜索/申请列表不受影响） */
.fr-friend .fr-ava { cursor: pointer; transition: box-shadow .15s;
  &:hover { box-shadow: 0 0 0 2px var(--primary)66; }
}
.fr-uinfo { flex: 1; min-width: 0;
  b { display: block; font-size: 14px; }
  .fr-uname { font-size: 12px; color: #94a3b8; }
  .fr-last { display: block; font-size: 12px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
}
.fr-empty2 { color: #94a3b8; font-size: 12.5px; padding: 8px 0; }
</style>
