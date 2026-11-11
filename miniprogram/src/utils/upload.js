// 文件上传：统一走 multipart（wx.uploadFile），对齐后端既有 multer 接口；P1 暂未使用，先备好地基
import { API_BASE } from '../env.js';

const TOKEN_KEY = 'ec_token';

// uploadFile('/share/upload', filePath, { name: 'file', formData }) → Promise<响应体 JSON>
export function uploadFile(path, filePath, options) {
  const opts = options || {};
  const token = uni.getStorageSync(TOKEN_KEY);
  const header = {};
  if (token) header.Authorization = 'Bearer ' + token;
  return new Promise((resolve, reject) => {
    uni.uploadFile({
      url: API_BASE + path,
      filePath: filePath,
      name: opts.name || 'file',
      formData: opts.formData || {},
      timeout: opts.timeout || 300000, // 百兆表格上传默认 5 分钟
      header: header,
      success: function (res) {
        let body = {};
        try { body = JSON.parse(res.data); } catch (e) { /* 非 JSON 响应 */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(body);
        const err = new Error(body.error || '上传失败（' + res.statusCode + '）');
        err.status = res.statusCode;
        err.data = body;
        uni.showToast({ title: err.message, icon: 'none' });
        reject(err);
      },
      fail: function () {
        uni.showToast({ title: '上传失败，请检查网络', icon: 'none' });
        reject(new Error('upload fail'));
      },
    });
  });
}

// 选择并压缩图片（拍照/相册），返回临时文件路径
export function chooseImage(compressed) {
  const sizeType = compressed === false ? ['original'] : ['compressed'];
  return new Promise((resolve, reject) => {
    uni.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: sizeType,
      success: function (r) { resolve(r.tempFiles[0].tempFilePath); },
      fail: function (e) { reject(e); },
    });
  });
}
// 选择发票素材：图片（拍照/相册）或聊天文件中的 PDF；返回 { filePath, name }
export function chooseInvoiceFile() {
  return new Promise((resolve, reject) => {
    uni.showActionSheet({
      itemList: ['拍照 / 相册图片', '从聊天记录选 PDF'],
      success: (m) => {
        if (m.tapIndex === 0) {
          chooseImage().then((filePath) => resolve({ filePath, name: 'invoice_' + Date.now() + '.jpg' })).catch(reject);
        } else {
          uni.chooseMessageFile({
            count: 1,
            type: 'file',
            extension: ['pdf'],
            success: (r) => {
              const f0 = r.tempFiles[0];
              resolve({ filePath: f0.path, name: f0.name || 'invoice.pdf' });
            },
            fail: reject,
          });
        }
      },
      fail: reject,
    });
  });
}
