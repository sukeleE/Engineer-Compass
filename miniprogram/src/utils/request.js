// 网络请求封装：语义对齐 H5 版 frontend/src/api.js（Bearer token / 错误 hint / 401 处理 / 实名门禁）
// 微信小程序 wx.request 单次超时硬上限 60s，AI 类长请求统一压到 60s（后续后端可改异步任务轮询）
// 注意：uni:mp-inject 对 uni.request 内联参数中的展开/可选链解析较差，这里先构造配置对象再传入
import { API_BASE } from '../env.js';
import { clearAuth } from './auth.js';

const TOKEN_KEY = 'ec_token';
const MAX_TIMEOUT = 60000;

export function qs(params) {
  const p = params || {};
  const parts = [];
  for (const k in p) {
    const v = p[k];
    if (v !== undefined && v !== null && v !== '') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

let loginRedirecting = false;

function goLogin() {
  if (loginRedirecting) return;
  const pages = getCurrentPages();
  // 整栈检查：栈中任意一层已是登录页就不再堆叠，防止多个页面并发 401 时
  // 连续 navigateTo 出多个登录页实例（返回时反复触发自动登录的导航陷阱）
  const routes = pages.map((p) => '/' + p.route);
  if (routes.indexOf('/pages/login/main') >= 0) return;
  loginRedirecting = true;
  const current = pages[pages.length - 1];
  const route = current ? '/' + current.route : '';
  uni.navigateTo({
    url: '/pages/login/main?redirect=' + encodeURIComponent(route),
    complete: function () { loginRedirecting = false; },
  });
}

// 通用请求：request(path, { method, data, header, timeout, showError })
export function request(path, options) {
  const opts = options || {};
  const method = opts.method || 'GET';
  const timeout = Math.min(opts.timeout || 30000, MAX_TIMEOUT);
  const showError = opts.showError !== false;
  const token = uni.getStorageSync(TOKEN_KEY);

  const header = Object.assign({ 'Content-Type': 'application/json' }, opts.header || {});
  if (token) header.Authorization = 'Bearer ' + token;

  return new Promise((resolve, reject) => {
    uni.request({
      url: API_BASE + path,
      method: method,
      data: opts.data,
      timeout: timeout,
      header: header,
      success: function (res) {
        const body = res.data || {};
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(body);
        const err = new Error(body.error || '请求失败（' + res.statusCode + '）');
        err.status = res.statusCode;
        err.data = body;
        err.hint = body.hint || '';
        if (res.statusCode === 401) {
          clearAuth();
          goLogin();
        } else if (res.statusCode === 403 && body.code === 'need_real_name') {
          uni.showModal({
            title: '需要实名认证',
            content: '请先完成实名认证（填写真实姓名）后再使用该功能，是否现在去填写？',
            confirmText: '去实名',
            success: function (m) {
              if (!m.confirm) return;
              // 标志位：我的页 onShow 检测到后自动拉起实名弹窗（switchTab 不支持传参）
              uni.setStorageSync('ec_pending_realname', 1);
              uni.switchTab({ url: '/pages/me/main' });
            },
          });
        } else if (showError) {
          uni.showToast({ title: err.hint ? err.message + '（' + err.hint + '）' : err.message, icon: 'none', duration: 2800 });
        }
        reject(err);
      },
      fail: function (fail) {
        const msg = fail.errMsg && String(fail.errMsg).indexOf('timeout') >= 0
          ? '请求超时（60s），请稍后重试'
          : '网络连接失败，请检查网络或后端地址';
        const err = new Error(msg);
        err.raw = fail;
        if (showError) uni.showToast({ title: err.message, icon: 'none' });
        reject(err);
      },
    });
  });
}

// 登录后统一回跳：tab 页用 switchTab，普通页 navigateBack/redirectTo
export function navigateAfterLogin(redirect) {
  const tabRoutes = ['/pages/timeline/main', '/pages/schedule/main', '/pages/team/main', '/pages/resource/main', '/pages/me/main'];
  if (redirect && tabRoutes.indexOf(redirect) >= 0) return uni.switchTab({ url: redirect });
  const pages = getCurrentPages();
  if (pages.length > 1) return uni.navigateBack();
  return uni.switchTab({ url: '/pages/timeline/main' });
}