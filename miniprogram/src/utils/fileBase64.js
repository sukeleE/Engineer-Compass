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

// 从微信聊天记录选择文档附件，读为同一套 {name,size,mime,data} 结构。
export function chooseFileAsBase64(maxMB = 10) {
  const limit = (maxMB || 10) * 1024 * 1024;
  const mimeOf = (name) => {
    const ext = String(name || '').split('.').pop().toLowerCase();
    return {
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      pdf: 'application/pdf',
      txt: 'text/plain',
      md: 'text/markdown',
      csv: 'text/csv',
      zip: 'application/zip',
    }[ext] || 'application/octet-stream';
  };
  return new Promise((resolve, reject) => {
    uni.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'txt', 'md', 'csv', 'zip'],
      success: (res) => {
        const file = res.tempFiles?.[0];
        if (!file) return reject(new Error('未选择文件'));
        if (file.size > limit) {
          uni.showToast({ title: '附件过大，请压缩后重试（≤' + maxMB + 'MB）', icon: 'none' });
          return reject(new Error('file too large'));
        }
        uni.getFileSystemManager().readFile({
          filePath: file.path || file.tempFilePath,
          encoding: 'base64',
          success: (r) => resolve({
            name: file.name || ('file_' + Date.now()),
            size: file.size,
            mime: mimeOf(file.name),
            data: r.data,
          }),
          fail: reject,
        });
      },
      fail: reject,
    });
  });
}
