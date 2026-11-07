// 文件/图片/外链处理：小程序不能直接开浏览器，Office/PDF 走 downloadFile+openDocument，图片走 previewImage
import { API_BASE, BASE_URL } from '../env.js';

const TOKEN_KEY = 'ec_token';
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i;

export function absoluteUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/api/')) return BASE_URL + url;
  return API_BASE + (url.startsWith('/') ? url : '/' + url);
}

// 同源 API 文件地址附加会话 token：<image> 组件与 uni.previewImage 无法携带 Authorization 头，
// 后端 authRequired 明确支持 ?token= 直连（见 middleware.js 注释）；外链与 data: 地址原样返回
export function authedUrl(url) {
  const full = absoluteUrl(url);
  if (!full) return '';
  if (full.indexOf(BASE_URL) !== 0) return full;
  const token = uni.getStorageSync(TOKEN_KEY);
  if (!token) return full;
  return full + (full.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

function authHeader() {
  const token = uni.getStorageSync(TOKEN_KEY);
  return token ? { Authorization: 'Bearer ' + token } : {};
}

// 图片预览（支持单张/多张）
export function previewImages(urls, current) {
  const list = (Array.isArray(urls) ? urls : [urls]).map(authedUrl).filter(Boolean);
  if (!list.length) return;
  uni.previewImage({ urls: list, current: current ? authedUrl(current) : list[0] });
}

// 远程文件预览：图片直接预览；其他下载后用 openDocument 打开
export function previewFile(url, filename) {
  const full = absoluteUrl(url);
  if (!full) return;
  if (IMG_EXT.test(full)) return previewImages([full]);
  uni.showLoading({ title: '下载中…', mask: true });
  uni.downloadFile({
    url: full,
    header: authHeader(),
    success: (res) => {
      uni.hideLoading();
      if (res.statusCode !== 200) {
        uni.showToast({ title: '下载失败（' + res.statusCode + '）', icon: 'none' });
        return;
      }
      uni.openDocument({
        filePath: res.tempFilePath,
        showMenu: true,
        fileType: extOf(filename || full),
        fail: () => uni.showToast({ title: '无法打开此文件类型', icon: 'none' }),
      });
    },
    fail: () => {
      uni.hideLoading();
      uni.showToast({ title: '下载失败，请检查网络或域名配置', icon: 'none' });
    },
  });
}


// 分享帖附件预览：附件两种形态——{url} 站内/外链引用，{data} 内联 base64（先写临时文件再预览/打开）
function safeFileName(name) {
  return String(name || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}
function attIsImage(a) {
  return /^image\//i.test(a.mime || '') || /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(a.name || '');
}
export function previewAttachment(a) {
  if (!a) return;
  if (a.url) {
    if (/^https?:\/\//i.test(a.url) && a.url.indexOf('/api/') !== 0) return openExternal(a.url);
    return previewFile(a.url, a.name);
  }
  if (!a.data) return;
  const fs = uni.getFileSystemManager();
  const filePath = wx.env.USER_DATA_PATH + '/share_' + Date.now() + '_' + safeFileName(a.name);
  fs.writeFile({
    filePath: filePath,
    data: a.data,
    encoding: 'base64',
    success: function () {
      if (attIsImage(a)) {
        uni.previewImage({ urls: [filePath] });
      } else {
        uni.openDocument({
          filePath: filePath,
          showMenu: true,
          fail: function () { uni.showToast({ title: '无法打开此文件类型', icon: 'none' }); },
        });
      }
    },
    fail: function () { uni.showToast({ title: '文件读取失败', icon: 'none' }); },
  });
}

// base64 内联图片直接渲染为 data URL（image 组件支持）
export function inlineImageUrl(a) {
  if (!a || !a.data) return '';
  return 'data:' + (a.mime || 'image/jpeg') + ';base64,' + a.data;
}

function extOf(name) {
  const m = String(name).split('?')[0].match(/\.([a-z0-9]+)$/i);
  if (!m) return undefined;
  const map = { doc: 'doc', docx: 'docx', xls: 'xls', xlsx: 'xlsx', ppt: 'ppt', pptx: 'pptx', pdf: 'pdf', txt: 'txt', md: 'txt' };
  return map[m[1].toLowerCase()];
}

// 外链：复制到剪贴板（web-view 需企业主体+业务域名校验，MVP 统一复制）
export function openExternal(url) {
  if (!url) return;
  uni.setClipboardData({
    data: /^https?:/i.test(url) ? url : 'https://' + url,
    success: () => uni.showToast({ title: '链接已复制，到浏览器打开', icon: 'none' }),
  });
}