// 仅用于本地冒烟：pdfjs legacy 在 Node 缺 DOMMatrix 等浏览器 API，且本机未装 @napi-rs/canvas。
// 冒烟不渲染 PDF，给一个最小可用垫片让后端能启动即可（线上无需此文件）。
if (!globalThis.DOMMatrix) {
  class SimpleMatrix {
    constructor(init) {
      this.m = new Float64Array(16);
      this.m[0] = 1; this.m[3] = 1; this.m[6] = 1; this.m[10] = 1; this.m[15] = 1;
      if (typeof init === 'string') {
        const v = init.trim().split(/[ ,]+/).map(Number);
        if (v.length >= 6) this.m.set([v[0], v[1], 0, 0, v[2], v[3], 0, 0, 0, 0, 1, 0, v[4], v[5], 0, 1]);
      }
    }
    get a() { return this.m[0]; } get b() { return this.m[1]; } get c() { return this.m[4]; }
    get d() { return this.m[5]; } get e() { return this.m[12]; } get f() { return this.m[13]; }
    get m11() { return this.m[0]; } get m12() { return this.m[1]; } get m13() { return this.m[2]; } get m14() { return this.m[3]; }
    get m21() { return this.m[4]; } get m22() { return this.m[5]; } get m23() { return this.m[6]; } get m24() { return this.m[7]; }
    get m31() { return this.m[8]; } get m32() { return this.m[9]; } get m33() { return this.m[10]; } get m34() { return this.m[11]; }
    get m41() { return this.m[12]; } get m42() { return this.m[13]; } get m43() { return this.m[14]; } get m44() { return this.m[15]; }
    multiplySelf() { return this; } translateSelf() { return this; } scaleSelf() { return this; } transformPoint() { return this; }
    toJSON() { return { a: this.a, b: this.b, c: this.c, d: this.d, e: this.e, f: this.f }; }
    toString() { return `matrix(${this.a}, ${this.b}, ${this.c}, ${this.d}, ${this.e}, ${this.f})`; }
  }
  globalThis.DOMMatrixReadOnly = SimpleMatrix;
  globalThis.DOMMatrix = SimpleMatrix;
}
if (!globalThis.DOMPoint) globalThis.DOMPoint = class { constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; } };
if (!globalThis.DOMPointReadOnly) globalThis.DOMPointReadOnly = globalThis.DOMPoint;
if (!globalThis.DOMRectReadOnly) globalThis.DOMRectReadOnly = class { constructor(x = 0, y = 0, width = 0, height = 0) { this.x = x; this.y = y; this.width = width; this.height = height; } };
if (!globalThis.Path2D) globalThis.Path2D = class {};
if (!globalThis.ImageData) globalThis.ImageData = class { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
