// 日程笔记接口冒烟测试（node 内联 fetch，中文无 GBK 问题）
// 覆盖：匿名创建/列表/单查/更新、跨月隔离、登录用户与匿名数据隔离、删除权限
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'http://localhost:3000/api';
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const TODAY = '2026-08-24';
const Y = 'smoke_notes_' + Date.now().toString().slice(-6);
let anonNoteId = null, userNoteId = null;

// 1) 匿名创建
console.log('— 匿名创建笔记');
let r = await req('/notes', { method: 'POST', body: JSON.stringify({ note_date: TODAY, content: '<p>今天开始学 STM32 点灯</p>', status: 'good' }) });
ok('匿名 POST /notes → 201', r.status === 201, `got ${r.status}`);
anonNoteId = r.data.id;

// 2) 月份列表
r = await req('/notes?month=2026-08');
ok('GET /notes?month=2026-08 含新笔记', r.data.some((n) => n.id === anonNoteId && n.status === 'good' && n.note_date === TODAY));

// 3) 单日查询
r = await req('/notes/' + TODAY);
ok('GET /notes/:date 返回内容', r.data?.id === anonNoteId && (r.data.content || '').includes('STM32'));

// 4) 更新（同日期 upsert 同 id）
r = await req('/notes', { method: 'POST', body: JSON.stringify({ note_date: TODAY, content: '<p>点灯成功，明天学定时器</p>', status: 'hard' }) });
ok('更新后 id 不变', r.data?.id === anonNoteId && r.status === 200, `got ${r.status} id=${r.data?.id}`);
r = await req('/notes/' + TODAY);
ok('更新内容/状态生效', (r.data.content || '').includes('定时器') && r.data.status === 'hard');

// 5) 跨月隔离
r = await req('/notes?month=2026-07');
ok('GET /notes?month=2026-07 不含 8 月笔记', !r.data.some((n) => n.id === anonNoteId));

// 6) 非法状态值兜底（内容保持不变，供后续「未被串改」检查）
r = await req('/notes', { method: 'POST', body: JSON.stringify({ note_date: TODAY, content: '<p>点灯成功，明天学定时器</p>', status: 'bogus' }) });
ok('非法状态回落为空', r.status === 200 && r.data.id === anonNoteId);

// 7) 注册测试账号（密码登录）
console.log('— 登录用户与匿名隔离');
r = await req('/auth/register', { method: 'POST', body: JSON.stringify({ username: Y, password: 'test123456', email: Y + '@test.dev' }) });
ok('注册测试账号', r.status === 201, `got ${r.status} ${r.data.error || ''}`);
const token = r.data.token;
const userId = r.data.user?.id;

// 8) 登录用户列表不应看到匿名 'local' 笔记
r = await req('/notes?month=2026-08', { token });
ok('登录用户列表不含匿名笔记', !r.data.some((n) => n.id === anonNoteId));

// 9) 登录用户同日创建独立笔记
r = await req('/notes', { method: 'POST', token, body: JSON.stringify({ note_date: TODAY, content: '<p>账号侧笔记</p>', status: 'slow' }) });
ok('登录用户同日创建 → 201', r.status === 201);
userNoteId = r.data.id;

// 10) 登录用户更新的是自己的笔记（匿名笔记不被改）
r = await req('/notes', { method: 'POST', token, body: JSON.stringify({ note_date: TODAY, content: '<p>账号侧笔记 v2</p>', status: 'good' }) });
ok('登录用户 upsert 命中自己的笔记', r.data.id === userNoteId);
r = await req('/notes/' + TODAY);
ok('匿名笔记内容未被串改', (r.data.content || '').includes('定时器'));

// 11) 登录用户删不了匿名笔记
r = await req('/notes/' + anonNoteId, { method: 'DELETE', token });
ok('登录用户删匿名笔记 → 404', r.status === 404, `got ${r.status}`);

// 12) 登录用户删除自己的笔记
r = await req('/notes/' + userNoteId, { method: 'DELETE', token });
ok('登录用户删自己的笔记 → 200', r.status === 200);

// 13) 匿名删除自己的笔记
r = await req('/notes/' + anonNoteId, { method: 'DELETE' });
ok('匿名删自己的笔记 → 200', r.status === 200);

// ---- 清理：删测试账号（session 级联）+ 其遗留笔记 ----
const { DatabaseSync } = await import('node:sqlite');
const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(join(__dirname, '..', 'data', 'compass.db'));
db.prepare("DELETE FROM daily_note WHERE user_id = 'local' AND note_date = ?").run(TODAY); // 兜底清理匿名测试笔记
if (userId) db.prepare('DELETE FROM daily_note WHERE user_id = ?').run(String(userId)); // 账号侧测试笔记
db.prepare('DELETE FROM user WHERE username = ?').run(Y);
db.close();
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
