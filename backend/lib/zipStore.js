// 纯 Node store-only ZIP 写入器（零依赖，不引入 archiver）
// 只使用 STORE(0) 不压缩——发票 PDF/照片本身已压缩，压缩收益小；
// 附带好处：冒烟测试无需 inflate 即可逐条比对原字节
// 仅支持 UTF-8 文件名（general purpose bit 11 = 0x0800）
import { Buffer } from 'node:buffer';

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  CRC_TABLE = t;
  return t;
}
export function crc32(buf) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// entries: [{ name: '01报名费/x.pdf', data: Buffer }]
// 返回完整 zip Buffer（本地头 + 数据 + 中央目录 + EOCD，全部 STORE）
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const dataBuf = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const crc = crc32(dataBuf);
    const size = dataBuf.length;
    // 本地文件头（LFH）：PK\x03\x04
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);        // version needed
    lfh.writeUInt16LE(0x0800, 6);    // flags: UTF-8 文件名
    lfh.writeUInt16LE(0, 8);         // method: store
    lfh.writeUInt16LE(0x0021, 10);   // dos date 1980-01-01（store 无需真实时间）
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(size, 18);
    lfh.writeUInt32LE(size, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);        // extra len
    locals.push(lfh, nameBuf, dataBuf);
    // 中央目录头（CDH）：PK\x01\x02
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(0x031e, 4);    // version made by（unix）
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(0, 10);
    cdh.writeUInt16LE(0x0021, 12);
    cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(size, 20);
    cdh.writeUInt32LE(size, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);        // extra len
    cdh.writeUInt16LE(0, 32);        // comment len
    cdh.writeUInt16LE(0, 34);        // disk
    cdh.writeUInt16LE(0, 36);        // internal attrs
    cdh.writeUInt32LE(0, 38);        // external attrs
    cdh.writeUInt32LE(offset, 42);   // local header offset
    centrals.push(cdh, nameBuf);
    offset += lfh.length + nameBuf.length + dataBuf.length;
  }
  const centralStart = offset;
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  // EOCD：PK\x05\x06
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}
