// PDF 引擎浏览器 API 垫片（2026-11-06）
// 背景：pdfjs-dist@5 的 legacy 构建在模块求值阶段就执行 new DOMMatrix()，
// 正常由可选依赖 @napi-rs/canvas 注入 DOMMatrix/ImageData/Path2D。
// Linux 服务器装有 canvas-linux 原生绑定，运行正常；Windows 开发机缺少 win32
// 绑定时 pdfjs 只打印 warning，但顶层 new DOMMatrix() 随即 ReferenceError，
// 导致整个后端进程启动即崩（影响全部路由，而不只是 PDF 功能）。
// 本垫片在 pdfjs 求值前补三个最小实现，保证模块可加载、文字层解析可用；
// PDF 光栅化仍需原生 canvas，缺失时由 pdfDoc.js 既有的 try/catch 转成
// PdfInputError 友好提示。所有赋值均判存在，生产环境的真绑定不会被覆盖。

if (!globalThis.DOMMatrix) {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor(init) {
      // 单位矩阵初值
      this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
      this.m11 = 1; this.m12 = 0; this.m13 = 0; this.m14 = 0;
      this.m21 = 0; this.m22 = 1; this.m23 = 0; this.m24 = 0;
      this.m31 = 0; this.m32 = 0; this.m33 = 1; this.m34 = 0;
      this.m41 = 0; this.m42 = 0; this.m43 = 0; this.m44 = 1;
      this.is2D = true;
      // pdfjs viewport 以 [m11,m12,m21,m22,m41,m42] 六元数组初始化
      if (Array.isArray(init) && init.length >= 6) {
        this.m11 = init[0]; this.m12 = init[1]; this.m21 = init[2];
        this.m22 = init[3]; this.m41 = init[4]; this.m42 = init[5];
        this.a = this.m11; this.b = this.m12; this.c = this.m21;
        this.d = this.m22; this.e = this.m41; this.f = this.m42;
      }
    }
    multiplySelf() { return this; }
    preMultiplySelf() { return this; }
    translateSelf() { return this; }
    scaleSelf() { return this; }
    rotateSelf() { return this; }
    rotateAxisAngleSelf() { return this; }
    skewXSelf() { return this; }
    skewYSelf() { return this; }
    invertSelf() { return this; }
    multiply() { return new DOMMatrix(); }
    inverse() { return new DOMMatrix(); }
    clone() { return new DOMMatrix(); }
    transformPoint(p) { return p || { x: 0, y: 0, z: 0, w: 1 }; }
    toFloat64Array() {
      return Float64Array.from([
        this.m11, this.m12, this.m13, this.m14,
        this.m21, this.m22, this.m23, this.m24,
        this.m31, this.m32, this.m33, this.m34,
        this.m41, this.m42, this.m43, this.m44,
      ]);
    }
    toString() { return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`; }
  };
}

if (!globalThis.ImageData) {
  globalThis.ImageData = class ImageData {
    constructor(arg, width, height) {
      if (ArrayBuffer.isView(arg)) {
        this.data = arg;
        this.width = width;
        this.height = height;
      } else {
        this.width = Number(arg) || 1;
        this.height = Number(width) || 1;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      }
      this.colorSpace = 'srgb';
    }
  };
}

if (!globalThis.Path2D) {
  const noop = () => {};
  globalThis.Path2D = class Path2D {
    addPath() {}
  };
  [
    'closePath', 'moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo',
    'arc', 'arcTo', 'ellipse', 'rect', 'roundRect', 'save', 'restore',
    'scale', 'rotate', 'translate', 'transform', 'setTransform', 'resetTransform', 'clip',
  ].forEach((m) => { globalThis.Path2D.prototype[m] = noop; });
}