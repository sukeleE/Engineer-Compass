// 登录态（uni.storage 持久化 + Vue 响应式），语义对齐 H5 版 frontend/src/auth.js
import { reactive } from 'vue';

const TOKEN_KEY = 'ec_token';
const USER_KEY = 'ec_user';

export const auth = reactive({
  token: uni.getStorageSync(TOKEN_KEY) || '',
  user: uni.getStorageSync(USER_KEY) || null,
});

export function setAuth(token, user) {
  auth.token = token;
  auth.user = user;
  uni.setStorageSync(TOKEN_KEY, token);
  uni.setStorageSync(USER_KEY, user);
}

// 局部更新用户信息（昵称/实名变更后全局同步；勿用 setAuth——会覆盖 token 且可能缺字段）
export function patchUser(patch) {
  auth.user = { ...(auth.user || {}), ...patch };
  uni.setStorageSync(USER_KEY, auth.user);
}

export function clearAuth() {
  auth.token = '';
  auth.user = null;
  uni.removeStorageSync(TOKEN_KEY);
  uni.removeStorageSync(USER_KEY);
}

export function isLoggedIn() {
  return !!auth.token;
}

export default auth;