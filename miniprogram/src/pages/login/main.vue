<template>
  <view class="page-wrap login-page">
    <view v-if="mockMode" class="mock-banner">
      🧪 开发联调模式：后端未配置微信凭证，uni.login 的 code 将以 mock 方式换 openid（仅限非生产环境）
    </view>

    <view class="card hero">
      <view class="logo">🧭</view>
      <view class="title">工科竞赛助手</view>
      <view class="subtitle">竞赛时间轴 · AI 问答 · 备赛日程</view>
    </view>

    <!-- 第一步：微信登录 -->
    <button class="btn btn-primary btn-block" :disabled="busy" @click="startWechat">
      {{ busy ? '正在调起微信…' : '微信一键登录' }}
    </button>

    <!-- 第二步：未绑定 → 绑定/注册面板 -->
    <view v-if="bindTicket" class="card bind-panel">
      <view class="bind-tip">首次使用，请绑定已有账号或注册新账号（与网页版共用账号）</view>

      <view class="mode-seg">
        <view v-for="m in modes" :key="m.key" class="mode-item" :class="{ active: mode === m.key }" @click="mode = m.key">{{ m.label }}</view>
      </view>

      <!-- 密码绑定 -->
      <block v-if="mode === 'password'">
        <input v-model="form.account" class="field" placeholder="邮箱 / 用户名" />
        <input v-model="form.password" class="field" placeholder="密码" password />
      </block>

      <!-- 验证码绑定 -->
      <block v-else-if="mode === 'email-code'">
        <input v-model="form.email" class="field" placeholder="已注册邮箱" />
        <view class="code-row">
          <input v-model="form.code" class="field code-field" placeholder="6 位邮箱验证码" type="number" maxlength="6" />
          <button class="btn btn-outline code-btn" :disabled="cooldown > 0" @click="sendCode">{{ cooldown > 0 ? cooldown + 's' : '获取验证码' }}</button>
        </view>
      </block>

      <!-- 注册新账号 -->
      <block v-else>
        <input v-model="form.email" class="field" placeholder="邮箱（注册后可用于网页版登录）" />
        <input v-model="form.nickname" class="field" placeholder="昵称（选填）" maxlength="20" />
        <input v-model="form.password" class="field" placeholder="密码（选填，不填用初始密码）" password />
      </block>

      <button class="btn btn-primary btn-block" :disabled="submitting" @click="submit">
        {{ submitting ? '提交中…' : '绑定并登录' }}
      </button>
      <view class="refresh-ticket" @click="refreshTicket">绑定票据过期？点此重新微信登录</view>
    </view>
  </view>
</template>

<script setup>
import { reactive, ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { api } from '../../utils/api.js';
import { loginWithWechat, bindAndLogin } from '../../utils/wechat.js';
import { navigateAfterLogin } from '../../utils/request.js';

const modes = [
  { key: 'password', label: '密码绑定' },
  { key: 'email-code', label: '验证码绑定' },
  { key: 'register', label: '注册新号' },
];

const busy = ref(false);
const submitting = ref(false);
const bindTicket = ref('');
const mockMode = ref(false);
const mode = ref('password');
const cooldown = ref(0);
const redirect = ref('');
const form = reactive({ account: '', email: '', password: '', code: '', nickname: '' });

async function startWechat() {
  busy.value = true;
  try {
    const res = await loginWithWechat();
    uni.showToast({ title: '登录成功', icon: 'success' });
    setTimeout(() => navigateAfterLogin(redirect.value), 500);
    return res;
  } catch (e) {
    if (e.needBind) {
      bindTicket.value = e.bindTicket;
      mockMode.value = !!e.mock;
    }
    // 其余错误 request 层已 toast
  } finally {
    busy.value = false;
  }
}


async function sendCode() {
  const email = form.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return uni.showToast({ title: '请输入正确的邮箱', icon: 'none' });
  await api.sendCode(email, 'login');
  uni.showToast({ title: '验证码已发送', icon: 'success' });
  cooldown.value = 60;
  const timer = setInterval(() => {
    cooldown.value -= 1;
    if (cooldown.value <= 0) clearInterval(timer);
  }, 1000);
}

async function submit() {
  if (!bindTicket.value) return uni.showToast({ title: '请先微信登录获取票据', icon: 'none' });
  let payload;
  if (mode.value === 'password') {
    if (!form.account.trim() || !form.password) return uni.showToast({ title: '请输入账号和密码', icon: 'none' });
    payload = { mode: 'password', username: form.account.trim(), password: form.password };
  } else if (mode.value === 'email-code') {
    if (!form.email.trim() || !form.code.trim()) return uni.showToast({ title: '请输入邮箱和验证码', icon: 'none' });
    payload = { mode: 'email-code', email: form.email.trim(), code: form.code.trim() };
  } else {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return uni.showToast({ title: '请输入正确的邮箱', icon: 'none' });
    payload = { mode: 'register', email: form.email.trim(), nickname: form.nickname.trim(), password: form.password };
  }
  submitting.value = true;
  try {
    await bindAndLogin(bindTicket.value, payload);
    uni.showToast({ title: '绑定成功', icon: 'success' });
    setTimeout(() => navigateAfterLogin(redirect.value), 500);
  } catch (e) {
    if (e.status === 400 && String(e.message).includes('票据')) bindTicket.value = '';
  } finally {
    submitting.value = false;
  }
}

function refreshTicket() {
  bindTicket.value = '';
  startWechat();
}

onLoad(async (options) => {
  redirect.value = options.redirect ? decodeURIComponent(options.redirect) : '';
  try {
    const st = await api.wechatStatus();
    mockMode.value = !st.configured;
  } catch { /* 忽略，登录时再判断 */ }
  if (options.bind_ticket) {
    bindTicket.value = options.bind_ticket;
    mockMode.value = options.mock === '1';
  }
  // 不自动发起 wx.login：未登录用户被 401 弹到本页时自动登录会形成
  // 「资源页 401 → 登录页自动登录 → 返回资源页再 401」的导航陷阱与请求风暴，
  // 统一由用户显式点击「微信一键登录」发起
});
</script>

<style lang="scss" scoped>
.mock-banner {
  background: #fef3c7;
  color: #b45309;
  font-size: 23rpx;
  line-height: 1.6;
  border-radius: 14rpx;
  padding: 18rpx 22rpx;
  margin-bottom: 20rpx;
}
.hero { text-align: center; padding: 48rpx 28rpx 36rpx; }
.logo { font-size: 88rpx; }
.title { font-size: 38rpx; font-weight: 800; color: #1e293b; margin-top: 14rpx; }
.subtitle { color: #64748b; font-size: 25rpx; margin-top: 10rpx; }

.bind-panel { margin-top: 24rpx; }
.bind-tip { font-size: 25rpx; color: #64748b; line-height: 1.6; margin-bottom: 22rpx; }
.mode-seg { display: flex; background: #f1f5f9; border-radius: 14rpx; padding: 6rpx; margin-bottom: 24rpx; }
.mode-item {
  flex: 1;
  text-align: center;
  height: 64rpx;
  line-height: 64rpx;
  font-size: 25rpx;
  color: #64748b;
  border-radius: 10rpx;
}
.mode-item.active { background: #fff; color: #2563eb; font-weight: 700; box-shadow: 0 2rpx 8rpx rgba(15, 23, 42, 0.08); }
.field {
  width: 100%;
  box-sizing: border-box;
  height: 92rpx;
  background: #f8fafc;
  border: 1rpx solid #e2e8f0;
  border-radius: 14rpx;
  padding: 0 24rpx;
  font-size: 27rpx;
  margin-bottom: 18rpx;
}
.code-row { display: flex; gap: 16rpx; }
.code-field { flex: 1; }
.code-btn { width: 220rpx; height: 92rpx; font-size: 25rpx; padding: 0; margin-bottom: 18rpx; }
.code-btn[disabled] { color: #94a3b8; border-color: #cbd5e1; }
.refresh-ticket { text-align: center; color: #94a3b8; font-size: 24rpx; margin-top: 22rpx; text-decoration: underline; }
</style>