// 选图并读为 base64（小组汇报/聊天/消息附件契约：{name,size,mime,data}，data 为 base64 不带前缀）
export function chooseImageAsBase64(maxMB) {
  const limit = (maxMB || 7) * 1024 * 1024;
  return new Promise((resolve, reject) => {
    uni.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (res) => {
        const file = res.tempFiles[0];
        if (file.size > limit) {
          uni.showToast({ title: '图片过大，请压缩后重试（≤' + maxMB + 'MB）', icon: 'none' });
          return reject(new Error('file too large'));
        }
        uni.getFileSystemManager().readFile({
          filePath: file.tempFilePath,
          encoding: 'base64',
          success: (r) => {
            const name = 'image_' + Date.now() + '.jpg';
            resolve({ name, size: file.size, mime: 'image/jpeg', data: r.data });
          },
          fail: reject,
        });
      },
      fail: reject,
    });
  });
}

// 附件是否为图片
export function isImage(att) {
  return /^image\//i.test(att?.mime || '') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(att?.name || '');
}