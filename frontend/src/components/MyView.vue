<script setup>
// 「我的」个人中心：账号信息 + 数据概览（备赛/学习计划、小组）+ 快捷入口 + 退出登录
// 未登录时内嵌 AuthView 完成登录
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';
import auth, { clearAuth, patchUser } from '../auth.js';
import AuthView from './AuthView.vue';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const router = useRouter();
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

onMounted(load);
onBeforeUnmount(() => { if (mailTimer) clearInterval(mailTimer); });
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

    <!-- 数据统计 -->
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
        <span class="sc-sub">{{ profile?.teams?.map((t) => t.role_name || '组长').join(' / ') || '尚未加入小组' }}</span>
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
        <router-link v-for="t in profile.teams" :key="t.id" to="/team" class="team-item">
          <div class="ti-info">
            <b>{{ t.name }}</b>
            <span class="ti-desc">{{ t.desc || '—' }}</span>
          </div>
          <el-tag size="small" :type="t.is_owner ? 'danger' : 'info'">
            {{ t.is_owner ? '👑 组长' : t.role_name || '组员' }}
          </el-tag>
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
</style>
