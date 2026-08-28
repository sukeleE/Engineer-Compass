<script setup>
// 登录 / 注册：邮箱验证码（推荐，未注册自动注册）+ 邮箱密码（登录名由邮箱自动生成）
import { ref, onBeforeUnmount } from 'vue';
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

onBeforeUnmount(() => { if (timer) clearInterval(timer); });
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
          </div>
        </el-tab-pane>
      </el-tabs>

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
  .auth-switch { margin-top: 14px; text-align: center; font-size: 13px; color: var(--text-2);
    a { color: var(--primary); cursor: pointer; }
  }
  .auth-back { margin-top: 10px; text-align: center; font-size: 12.5px;
    a { color: #94a3b8; text-decoration: none; &:hover { color: var(--primary); } }
  }
}
</style>
