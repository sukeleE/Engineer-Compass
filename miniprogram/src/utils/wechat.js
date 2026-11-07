// 微信登录流程：uni.login 拿 code → 后端换 openid → 已绑定直发 token / 未绑定走绑定页
import { api } from './api.js';
import { setAuth, clearAuth } from './auth.js';

const MOCK_CODE_KEY = 'ec_mock_wechat_code';

export function uniLogin() {
  return new Promise((resolve, reject) => {
    uni.login({
      provider: 'weixin',
      success: (r) => (r.code ? resolve(r.code) : reject(new Error('微信登录未返回 code'))),
      fail: () => reject(new Error('微信登录调用失败，请在微信开发者工具或手机微信中打开')),
    });
  });
}

// 未配置微信凭证的本地/测试环境：生成并持久化稳定 mock code，保证同设备多次登录映射到同一个 openid
function devMockCode() {
  let code = uni.getStorageSync(MOCK_CODE_KEY);
  if (!code) {
    code = `mock:dev_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
    uni.setStorageSync(MOCK_CODE_KEY, code);
  }
  return code;
}

// 一键微信登录：成功落库返回；未绑定抛 NEED_BIND 错误（携带 bindTicket 交给登录页）
// opts.mock=true 可强制 mock；默认先查后端 wechat-status，未配置凭证且允许 mock 时自动切换
export async function loginWithWechat(opts = {}) {
  let useMock = opts.mock === true;
  if (opts.mock === undefined) {
    try {
      const st = await api.wechatStatus();
      useMock = !st.configured && st.mock_enabled;
    } catch {
      useMock = false;
    }
  }
  const code = useMock ? devMockCode() : await uniLogin();
  const res = await api.wechatLogin(code);
  if (res.need_bind) {
    const err = new Error('NEED_BIND');
    err.needBind = true;
    err.bindTicket = res.bind_ticket;
    err.mock = !!res.mock;
    throw err;
  }
  setAuth(res.token, res.user);
  return res;
}

// 绑定已有账号 / 注册新账号后登录（bindTicket 来自 loginWithWechat 的 NEED_BIND 错误）
export async function bindAndLogin(bindTicket, payload) {
  const res = await api.wechatBind({ bind_ticket: bindTicket, ...payload });
  setAuth(res.token, res.user);
  return res;
}

export function logout() {
  api.logout().catch(() => {}); // 后端会话失效不阻塞本地清理
  clearAuth();
}
