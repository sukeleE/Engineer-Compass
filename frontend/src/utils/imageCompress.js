// 图片上传前压缩（荣誉墙奖状用）
//
// 为什么必须压：手机拍的奖状常有 3–8MB，一面墙几十张就是上百 MB 首屏；后端**没有任何图像处理库**
// （依赖只有 cors/express/mammoth/multer/pdf-parse/xlsx），没有第二道防线能替我们缩图。
// 压到长边 1600 + JPEG 0.85 后单张约 150–500KB —— 这才是门面页能接受的首屏体量。
//
// 附带好处：canvas 重编码会天然剥掉 EXIF（含 GPS 拍摄地），上传的图不带拍摄地信息。
// 这里必须是普通 .js 模块：<script setup> 顶层代码编译进 setup()、没有模块作用域，
// 且后台弹窗与将来任何上传点都要复用同一个实现。
//
// 失败一律**回落原文件**，绝不阻断上传：浏览器解不了的格式（HEIC 等）交给后端魔数嗅探去拒。
const SKIP_MIME = new Set(['image/gif']); // 压了就没动画了，原样放行

// 解码：优先 createImageBitmap（可按 EXIF 方向摆正，手机竖拍不会躺倒），
// 失败回落 <img> + objectURL（现代浏览器对 <img> 默认已应用 EXIF 方向）
async function decode(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { src: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close?.() };
  } catch { /* 走回落路径 */ }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('图片解码失败'));
      i.src = url;
    });
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url); // 失败也要回收，否则每次选图都漏一个 blob
    throw e;
  }
}

// 返回 File（可能压缩过、也可能是原文件）。名字统一换成 .jpg 与产物类型保持一致。
export async function compressImage(file, { maxEdge = 1600, quality = 0.85 } = {}) {
  if (!file || !String(file.type || '').startsWith('image/')) return file;
  if (SKIP_MIME.has(file.type)) return file;

  let dec;
  try {
    dec = await decode(file);
  } catch {
    return file; // 浏览器解不了 → 交给服务端嗅探
  }

  try {
    // 本来就不大（尺寸与体积都够小）→ 不无谓重编码，省时间也避免二次损失
    if (Math.max(dec.w, dec.h) <= maxEdge && file.size <= 1.2 * 1024 * 1024) return file;

    const scale = Math.min(1, maxEdge / Math.max(dec.w, dec.h));
    const cw = Math.max(1, Math.round(dec.w * scale));
    const ch = Math.max(1, Math.round(dec.h * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // 透明 PNG 铺白底（JPEG 没有 alpha 通道，不铺会变黑块）
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(dec.src, 0, 0, cw, ch);

    // toBlob 而不是 toDataURL：dataURL 会 +33% 且多一次大字符串转换（MyView 头像用 dataURL 是因为要存库）
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    if (!blob || blob.size >= file.size) return file; // 压完反而更大 → 不值当
    const name = String(file.name || 'honor').replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg' });
  } finally {
    dec.done(); // 成功失败都要释放（ImageBitmap.close / revokeObjectURL）
  }
}

// 给界面用的一句人话：「3.4MB → 320KB」
export function shrinkHint(before, after) {
  if (!after || after === before) return '';
  const mb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
  return `已压缩：${mb(before.size)} → ${mb(after.size)}`;
}
