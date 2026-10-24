<script setup>
// 登录 / 注册：邮箱验证码（推荐，未注册自动注册）+ 邮箱密码（登录名由邮箱自动生成）
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { api } from '../api.js';
import { setAuth } from '../auth.js';

const router = useRouter();
const tab = ref('email'); // email | pwd

// 登录成功后回跳（/login?redirect=/team），默认去「我的」个人中心
const redirect = typeof router.currentRoute.value.query.redirect === 'string'
  ? router.currentRoute.value.query.redirect : '';
const afterLogin = () => router.push(redirect || '/me');

// ---- 邮箱验证码 ----
const email = ref('');
const code = ref('');
const countdown = ref(0);
const loading = ref(false);
const sending = ref(false);
let timer = null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sendCode() {
  const mail = email.value.trim();
  if (!EMAIL_RE.test(mail)) return ElMessage.warning('请输入正确的邮箱地址');
  sending.value = true;
  try {
    const res = await api.sendCode(mail);
    if (res.dev_code) {
      // 开发模式（未配置 SMTP）：验证码随响应返回，自动填入
      code.value = res.dev_code;
      ElMessage.success(`开发模式验证码：${res.dev_code}（配置 SMTP 后改为邮件发送）`);
    } else {
      ElMessage.success('验证码已发送到邮箱，10 分钟内有效');
    }
    countdown.value = 60;
    timer = setInterval(() => {
      if (--countdown.value <= 0) { clearInterval(timer); timer = null; }
    }, 1000);
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    sending.value = false;
  }
}

async function emailLogin() {
  const mail = email.value.trim();
  if (!EMAIL_RE.test(mail)) return ElMessage.warning('请输入正确的邮箱地址');
  if (!/^\d{6}$/.test(code.value.trim())) return ElMessage.warning('请输入 6 位数字验证码');
  loading.value = true;
  try {
    const res = await api.emailLogin(mail, code.value.trim());
    setAuth(res.token, res.user);
    if (res.migrated > 0) {
      ElMessage.success(`登录成功，已把本机 ${res.migrated} 条匿名计划关联到你的账号`);
    } else {
      ElMessage.success(`欢迎，${res.user.nickname}`);
    }
    afterLogin();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

// ---- 邮箱 + 密码（登录 / 注册；登录名由邮箱前缀自动生成，无需填写） ----
const mode = ref('login'); // login | register
const form = ref({ email: '', password: '', nickname: '', password2: '' });

async function submit() {
  const f = form.value;
  const mail = f.email.trim();
  if (!EMAIL_RE.test(mail)) return ElMessage.warning('请输入正确的邮箱地址');
  if (!f.password) return ElMessage.warning('请输入密码');
  if (mode.value === 'register' && f.password !== f.password2) return ElMessage.warning('两次密码不一致');
  loading.value = true;
  try {
    const apiFn = mode.value === 'login' ? api.login : api.register;
    const card = mode.value === 'login'
      ? { email: mail, password: f.password }
      : { email: mail, password: f.password, nickname: f.nickname.trim() };
    const res = await apiFn(card);
    setAuth(res.token, res.user);
    ElMessage.success(mode.value === 'login' ? `欢迎回来，${res.user.nickname}` : '注册成功，已自动登录');
    afterLogin();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

// ---- 忘记密码（公开流：邮箱 + purpose=reset 验证码 + 新密码）----
// 邮箱是否已注册由后端防枚举统一返回；成功后弹窗关闭，用户用新密码登录
const resetDlg = ref(false);
const resetForm = ref({ email: '', code: '', password: '', password2: '' });
const resetCountdown = ref(0);
const resetSending = ref(false);
const resetSaving = ref(false);
let resetTimer = null;

function openReset() {
  // 默认带出登录表单里已填的邮箱，少输一次
  resetForm.value = { email: form.value.email || '', code: '', password: '', password2: '' };
  resetDlg.value = true;
}
async function sendResetCode() {
  const mail = resetForm.value.email.trim();
  if (!EMAIL_RE.test(mail)) return ElMessage.warning('请输入正确的邮箱地址');
  resetSending.value = true;
  try {
    const res = await api.sendCode(mail, 'reset');
    if (res.dev_code) {
      resetForm.value.code = res.dev_code;
      ElMessage.success(`开发模式验证码：${res.dev_code}（配置 SMTP 后改为邮件发送）`);
    } else {
      ElMessage.success('验证码已发送到邮箱，10 分钟内有效');
    }
    resetCountdown.value = 60;
    resetTimer = setInterval(() => {
      if (--resetCountdown.value <= 0) { clearInterval(resetTimer); resetTimer = null; }
    }, 1000);
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    resetSending.value = false;
  }
}
async function submitReset() {
  const f = resetForm.value;
  const mail = f.email.trim();
  if (!EMAIL_RE.test(mail)) return ElMessage.warning('请输入正确的邮箱地址');
  if (!/^\d{6}$/.test(f.code.trim())) return ElMessage.warning('请输入 6 位数字验证码');
  if (f.password.length < 6 || f.password.length > 64) return ElMessage.warning('新密码长度需 6-64 位');
  if (f.password !== f.password2) return ElMessage.warning('两次密码不一致');
  resetSaving.value = true;
  try {
    await api.resetPassword({ email: mail, code: f.code.trim(), new_password: f.password });
    ElMessage.success('密码已重置，请使用新密码登录');
    resetDlg.value = false;
    // 带回邮箱到登录表单
    form.value.email = mail;
    form.value.password = '';
    mode.value = 'login';
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    resetSaving.value = false;
  }
}

// ---- GitHub 一键登录（弹窗 OAuth；回调页 postMessage 同源消息；未配置则不显示入口） ----
const githubEnabled = ref(false);
const ghLoading = ref(false);
let ghWin = null;
let ghCloseTimer = null;

function cleanupGithub() {
  if (ghCloseTimer) { clearInterval(ghCloseTimer); ghCloseTimer = null; }
  ghWin = null;
}

async function githubLoginClick() {
  ghLoading.value = true;
  try {
    const { url } = await api.githubLogin();
    ghWin = window.open(url, 'github-oauth', 'width=720,height=640');
    if (!ghWin) {
      ghLoading.value = false;
      return ElMessage.warning('浏览器拦截了弹窗，请允许本站弹出窗口后重试');
    }
    // 用户直接关窗 = 放弃登录：轮询复位 loading，避免按钮永久转圈
    ghCloseTimer = setInterval(() => {
      if (ghWin?.closed) { cleanupGithub(); ghLoading.value = false; }
    }, 500);
  } catch (e) {
    ghLoading.value = false;
    ElMessage.error(e.message);
  }
}

function onGithubMessage(ev) {
  // 只接收同源消息（回调页经 Vite 代理/同源部署，origin 与本站一致）
  if (ev.origin !== location.origin) return;
  const d = ev.data;
  if (!d || typeof d !== 'object') return;
  if (d.type === 'github-login') {
    cleanupGithub();
    ghLoading.value = false;
    setAuth(d.token, d.user);
    ElMessage.success(`欢迎，${d.user.nickname}`);
    afterLogin();
  } else if (d.type === 'github-oauth-error') {
    cleanupGithub();
    ghLoading.value = false;
    ElMessage.error(d.message || 'GitHub 登录失败，请重试');
  }
}

onMounted(async () => {
  window.addEventListener('message', onGithubMessage);
  try {
    const cfg = await api.githubConfigured();
    githubEnabled.value = cfg.configured === true;
  } catch {
    githubEnabled.value = false; // 探测失败：不显示入口，不挡住常规登录
  }
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  if (resetTimer) clearInterval(resetTimer);
  cleanupGithub();
  window.removeEventListener('message', onGithubMessage);
});
</script>

<template>
  <div class="auth-page">
    <div class="auth-card">
      <h2>🏗️ 登录</h2>
      <p class="auth-sub">邮箱验证码登录 · 数据随账号保存</p>

      <el-tabs v-model="tab" stretch>
        <!-- Tab1 邮箱验证码（推荐） -->
        <el-tab-pane label="📧 邮箱验证码" name="email">
          <el-form label-position="top" @submit.prevent>
            <el-form-item label="邮箱">
              <el-input v-model="email" placeholder="you@example.com" @keyup.enter="emailLogin" />
            </el-form-item>
            <el-form-item label="验证码">
              <div class="code-row">
                <el-input v-model="code" maxlength="6" placeholder="6 位验证码" @keyup.enter="emailLogin" />
                <el-button
                  :disabled="countdown > 0" :loading="sending" @click="sendCode"
                  style="width: 150px; flex-shrink: 0"
                >
                  {{ countdown > 0 ? `${countdown}s 后重发` : '发送验证码' }}
                </el-button>
              </div>
            </el-form-item>
            <el-button type="primary" size="large" class="auth-btn" :loading="loading" @click="emailLogin">
              登录 / 注册
            </el-button>
          </el-form>
          <p class="email-tip">💡 未注册邮箱将自动创建账号，数据任意设备可查</p>
        </el-tab-pane>

        <!-- Tab2 邮箱 + 密码 -->
        <el-tab-pane label="🔑 邮箱+密码" name="pwd">
          <el-form label-position="top" @submit.prevent>
            <el-form-item label="邮箱">
              <el-input v-model="form.email" placeholder="you@example.com" @keyup.enter="submit" />
            </el-form-item>
            <el-form-item v-if="mode === 'register'" label="昵称（组内显示）">
              <el-input v-model="form.nickname" placeholder="选填，默认取邮箱前缀" @keyup.enter="submit" />
            </el-form-item>
            <el-form-item label="密码">
              <el-input v-model="form.password" type="password" show-password placeholder="至少 6 位" @keyup.enter="submit" />
            </el-form-item>
            <el-form-item v-if="mode === 'register'" label="确认密码">
              <el-input v-model="form.password2" type="password" show-password @keyup.enter="submit" />
            </el-form-item>
            <el-button type="primary" size="large" class="auth-btn" :loading="loading" @click="submit">
              {{ mode === 'login' ? '登 录' : '注 册' }}
            </el-button>
          </el-form>
          <div class="auth-switch">
            {{ mode === 'login' ? '还没有账号？' : '已有账号？' }}
            <a @click="mode = mode === 'login' ? 'register' : 'login'">
              {{ mode === 'login' ? '立即注册' : '去登录' }}
            </a>
            <template v-if="mode === 'login'">
              <span class="switch-dot">·</span>
              <a @click="openReset">忘记密码？</a>
            </template>
          </div>
        </el-tab-pane>
      </el-tabs>

      <!-- GitHub 一键登录（服务端配置 GITHUB_CLIENT_ID 后显示） -->
      <template v-if="githubEnabled">
        <div class="oauth-divider"><span>或</span></div>
        <el-button size="large" class="github-btn" :loading="ghLoading" @click="githubLoginClick">
          🐙 使用 GitHub 登录
        </el-button>
        <p class="email-tip">首次登录按 GitHub 已验证邮箱匹配账号；匹配不到会自动创建新账号</p>
      </template>

      <!-- 忘记密码弹窗：邮箱验证码重置（公开流，不需要登录） -->
      <el-dialog v-model="resetDlg" title="重置密码" width="400px" destroy-on-close
        @closed="resetCountdown = 0">
        <el-form label-position="top" @submit.prevent>
          <el-form-item label="注册邮箱">
            <el-input v-model="resetForm.email" placeholder="you@example.com" />
          </el-form-item>
          <el-form-item label="邮箱验证码">
            <div class="code-row">
              <el-input v-model="resetForm.code" maxlength="6" placeholder="6 位验证码" @keyup.enter="submitReset" />
              <el-button
                :disabled="resetCountdown > 0" :loading="resetSending" @click="sendResetCode"
                style="width: 130px; flex-shrink: 0"
              >
                {{ resetCountdown > 0 ? `${resetCountdown}s 后重发` : '发送验证码' }}
              </el-button>
            </div>
          </el-form-item>
          <el-form-item label="新密码（6-64 位）">
            <el-input v-model="resetForm.password" type="password" show-password placeholder="新密码" />
          </el-form-item>
          <el-form-item label="确认新密码">
            <el-input v-model="resetForm.password2" type="password" show-password
              placeholder="再输一次新密码" @keyup.enter="submitReset" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="resetDlg = false">取消</el-button>
          <el-button type="primary" :loading="resetSaving" @click="submitReset">确认重置</el-button>
        </template>
      </el-dialog>

      <div class="auth-back"><router-link to="/">← 返回竞赛时间轴</router-link></div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.auth-page { display: flex; justify-content: center; padding: 60px 20px; }
.auth-card {
  width: 400px; background: var(--card-bg); border: 1px solid var(--border);
  border-radius: 14px; padding: 28px 30px; box-shadow: 0 8px 24px rgba(30, 41, 59, .06);
  h2 { margin: 0 0 4px; font-size: 22px; }
  .auth-sub { color: var(--text-2); font-size: 13px; margin: 0 0 14px; }
  .auth-btn { width: 100%; }
  .code-row { display: flex; gap: 8px; width: 100%; }
  .email-tip { margin: 12px 0 0; font-size: 12px; color: #94a3b8; line-height: 1.7; }
  .oauth-divider { display: flex; align-items: center; gap: 10px; margin: 18px 0 14px;
    color: #94a3b8; font-size: 12px;
    &::before, &::after { content: ''; flex: 1; height: 1px; background: var(--border); }
  }
  .github-btn {
    width: 100%; background: #24292f; border-color: #24292f; color: #fff; font-weight: 600;
    &:hover, &:focus { background: #2f363d; border-color: #2f363d; color: #fff; }
  }
  .auth-switch { margin-top: 14px; text-align: center; font-size: 13px; color: var(--text-2);
    a { color: var(--primary); cursor: pointer; }
    .switch-dot { margin: 0 4px; color: var(--text-3); }
  }
  .auth-back { margin-top: 10px; text-align: center; font-size: 12.5px;
    a { color: #94a3b8; text-decoration: none; &:hover { color: var(--primary); } }
  }
}
</style>
