// 登录硬门禁：需要登录的操作前调用，未登录弹窗引导并返回 false
import { isLoggedIn } from './auth.js';

export function ensureLogin(tip) {
  if (isLoggedIn()) return true;
  uni.showModal({
    title: '需要登录',
    content: tip || '该功能需要登录后使用，是否前往登录？',
    confirmText: '去登录',
    success: (m) => { if (m.confirm) uni.navigateTo({ url: '/pages/login/main' }); },
  });
  return false;
}

// 简单确认弹窗 Promise 化
export function confirm(content, title) {
  return new Promise((resolve) => {
    uni.showModal({
      title: title || '提示',
      content,
      success: (m) => resolve(!!m.confirm),
      fail: () => resolve(false),
    });
  });
}

// 轻提示
export function toast(title, icon) {
  uni.showToast({ title, icon: icon || 'none', duration: 2400 });
}