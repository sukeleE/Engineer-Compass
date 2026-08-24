// 登录状态（localStorage 持久化 + 响应式）
import { reactive } from 'vue';

const TOKEN_KEY = 'ec_token';
const USER_KEY = 'ec_user';

const auth = reactive({
  token: localStorage.getItem(TOKEN_KEY) || '',
  user: JSON.parse(localStorage.getItem(USER_KEY) || 'null'),
});

export function setAuth(token, user) {
  auth.token = token;
  auth.user = user;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearAuth() {
  auth.token = '';
  auth.user = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export default auth;
