// 邮件发送（零依赖）：SMTP 客户端（node:net / node:tls 内置实现）+ 开发模式降级
// ⚠️ 时序：本模块被 server.js 静态 import 链提前加载（早于 server.js 的 loadEnvFile('.env')），
//    所以配置一律惰性读取（调用时读 process.env），绝不模块级快照 —— 否则 SMTP_* 恒为空。
// .env 配置：
//   SMTP_HOST=smtp.qq.com  SMTP_PORT=465  SMTP_USER=xxx@qq.com  SMTP_PASS=授权码  SMTP_FROM=可选（默认 SMTP_USER）
// 未配置 SMTP → dev 模式：控制台打印邮件内容，sendMail 返回 { dev: true }（调用方把验证码带给前端）
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';

// 运行时读取配置（模块加载顺序无关）
const cfg = () => ({
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT) || 465,
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || process.env.SMTP_USER || 'Engineer-Compass <noreply@localhost>',
});
export const hasSMTP = () => { const c = cfg(); return !!(c.host && c.user && c.pass); };

// MAIL FROM 地址解析（支持 "名称 <addr>" 形式）
const fromAddrOf = (c) => (c.from.match(/<([^>]+)>/) || [null, c.from])[1];

function tlsConnect(c) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: c.host, port: c.port, rejectUnauthorized: false });
    s.setTimeout(10000);
    s.on('secureConnect', () => resolve(s));
    s.on('error', reject);
    s.on('timeout', () => s.destroy(new Error('SMTP 连接超时')));
  });
}
function netConnect(c) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: c.host, port: c.port });
    s.setTimeout(10000);
    s.on('connect', () => resolve(s));
    s.on('error', reject);
    s.on('timeout', () => s.destroy(new Error('SMTP 连接超时')));
  });
}

// 读一行响应（已处理 TCP 分片缓冲 + 残留行预消费；multiline "250-xxx" 由 cmd 循环消费）
function makeReader(sock) {
  let buf = '';
  return () => new Promise((resolve, reject) => {
    // 先消费缓冲区里的残留行（multiline 响应剩余部分可能早已到达），否则会永久等新数据
    const tryParse = () => {
      const idx = buf.indexOf('\r\n');
      if (idx < 0) return false;
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      // last：原始行第 4 个字符（分隔符）是 '-' 表示 multiline 中间行，' ' 表示终行
      resolve({ code: +line.slice(0, 3), text: line.slice(4), last: line.charAt(3) !== '-' });
      return true;
    };
    if (tryParse()) return;
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      if (tryParse()) sock.off('data', onData);
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

// 发送命令并等待响应；multiline 中间行（last=false）自动吞掉，直到终行
async function cmd(sock, read, line, expect) {
  sock.write(line + '\r\n');
  for (;;) {
    const r = await read();
    if (r.last) {
      if (expect && !expect.includes(r.code)) {
        throw new Error(`SMTP ${line.split(' ')[0]} 失败: ${r.code} ${r.text}`);
      }
      return r;
    }
  }
}

// STARTTLS 升级（旧 socket 由 tls 接管，数据监听清空重建 reader）
function upgradeTls(sock) {
  return new Promise((resolve, reject) => {
    sock.removeAllListeners('data');
    const t = tls.connect({ socket: sock, rejectUnauthorized: false });
    t.on('secureConnect', () => resolve(t));
    t.on('error', reject);
  });
}

async function sendMail({ to, subject, html }) {
  const c = cfg(); // 运行时读取（.env 已在 server.js 加载）
  if (!hasSMTP()) {
    // 开发模式：不真正发邮件，控制台输出便于调试（前端通过 dev_code 拿到验证码）
    console.log(`\n===== [DEV MAIL] → ${to} =====\n主题: ${subject}\n${html.replace(/<[^>]+>/g, '').trim()}\n===== END =====`);
    return { dev: true };
  }
  let sock = c.port === 465 ? await tlsConnect(c) : await netConnect(c);
  try {
    let read = makeReader(sock);
    await read(); // 服务器 banner
    await cmd(sock, read, `EHLO ${os.hostname()}`, [250]);
    if (c.port !== 465 && c.port !== 25) {
      // 587 等：明文 EHLO 后 STARTTLS
      await cmd(sock, read, 'STARTTLS', [220]);
      sock = await upgradeTls(sock);
      read = makeReader(sock);
      await cmd(sock, read, `EHLO ${os.hostname()}`, [250]);
    }
    // AUTH LOGIN（base64 用户名 / 密码）
    await cmd(sock, read, 'AUTH LOGIN', [334]);
    await cmd(sock, read, Buffer.from(c.user, 'utf8').toString('base64'), [334]);
    await cmd(sock, read, Buffer.from(c.pass, 'utf8').toString('base64'), [235]);
    await cmd(sock, read, `MAIL FROM:<${fromAddrOf(c)}>`, [250]);
    await cmd(sock, read, `RCPT TO:<${to}>`, [250, 251]);
    await cmd(sock, read, 'DATA', [354]);
    const b64 = Buffer.from(html, 'utf8').toString('base64');
    const body = [
      `From: ${c.from}`,
      `To: <${to}>`,
      `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64,
      '.',
    ].join('\r\n');
    sock.write(body + '\r\n');
    await read(); // 250 邮件已排队
    await cmd(sock, read, 'QUIT', [221]);
    return { dev: false };
  } finally {
    sock.destroy();
  }
}

export default sendMail;
