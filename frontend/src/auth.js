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

// 局部更新用户信息（昵称/头像/邮箱变更后全站同步；勿用 setAuth——会覆盖 token 且可能缺字段）
export function patchUser(patch) {
  auth.user = { ...(auth.user || {}), ...patch };
  localStorage.setItem(USER_KEY, JSON.stringify(auth.user));
}

export function clearAuth() {
  auth.token = '';
  auth.user = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export default auth;
