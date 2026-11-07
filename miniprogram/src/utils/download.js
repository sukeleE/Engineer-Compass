// 受 token 保护的文件下载并就地打开（Excel/PDF 等）。uni.downloadFile 需要在微信后台配置 downloadFile 合法域名
import { BASE_URL } from '../env.js';

const TOKEN_KEY = 'ec_token';

// downloadAndOpen('/api/xxx/export.xlsx?a=1', '借用记录.xlsx')
// 成功 resolve 临时文件路径；失败统一 toast 后 reject
export function downloadAndOpen(path, fallbackName) {
  const token = uni.getStorageSync(TOKEN_KEY);
  const url = path.indexOf('http') === 0 ? path : BASE_URL + path;
  const dot = String(fallbackName || '').lastIndexOf('.');
  const ext = dot >= 0 ? fallbackName.slice(dot + 1).toLowerCase() : 'xlsx';
  uni.showLoading({ title: '下载中…', mask: true });
  return new Promise((resolve, reject) => {
    uni.downloadFile({
      url: url,
      header: token ? { Authorization: 'Bearer ' + token } : {},
      success: function (res) {
        uni.hideLoading();
        if (res.statusCode !== 200) {
          uni.showToast({ title: '下载失败（' + res.statusCode + '）', icon: 'none' });
          reject(new Error('download ' + res.statusCode));
          return;
        }
        uni.openDocument({
          filePath: res.tempFilePath,
          fileType: ext,
          showMenu: true, // 右上角可转发给好友/保存
          success: function () { resolve(res.tempFilePath); },
          fail: function () {
            uni.showToast({ title: '无法打开该文件', icon: 'none' });
            reject(new Error('open fail'));
          },
        });
      },
      fail: function () {
        uni.hideLoading();
        uni.showToast({ title: '下载失败，请检查网络或 downloadFile 域名配置', icon: 'none', duration: 2800 });
        reject(new Error('download fail'));
      },
    });
  });
}