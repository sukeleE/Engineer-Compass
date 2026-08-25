// 消息中心冒烟测试：注册两人 → 发帖 → 赞/藏/评 → 通知分组/未读计数/标已读 → 私信未读 → 自己操作不通知 → 删帖级联清理
const BASE = 'http://localhost:3000/api';
const j = (r) => r.json();
const api = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    method: opts.method || 'GET',
  });
  const data = await j(res);
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
};

const stamp = Date.now().toString().slice(-8);
const A = `nt_a_${stamp}@test.dev`, B = `nt_b_${stamp}@test.dev`;
const pw = 'pass123456';
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}`)); };

try {
  const ra = await api('/auth/register', { method: 'POST', body: { email: A, password: pw, nickname: '通知甲' } });
  const rb = await api('/auth/register', { method: 'POST', body: { email: B, password: pw, nickname: '通知乙' } });
  const ta = ra.token, tb = rb.token;
  const uidA = Number(ra.user.id);

  // A 发两帖
  const p1 = await api('/share/posts', { method: 'POST', token: ta, body: { title: '通知测试帖一', content: '正文一' } });
  const p2 = await api('/share/posts', { method: 'POST', token: ta, body: { title: '通知测试帖二', content: '正文二' } });
  ok('A 发帖两篇', p1.id && p2.id);

  // B 赞/藏/评 P1 → 三组各 1 条未读
  await api(`/share/posts/${p1.id}/like`, { method: 'POST', token: tb });
  await api(`/share/posts/${p1.id}/fav`, { method: 'POST', token: tb });
  await api(`/share/posts/${p1.id}/comments`, { method: 'POST', token: tb, body: { content: 'B 的评论内容' } });
  let c = await api('/notifications/unread-count', { token: ta });
  ok('未读计数：likes=1/favs=1/comments=1', c.likes === 1 && c.favs === 1 && c.comments === 1 && c.total === 3);
  ok('私信未读=0', c.dm === 0);

  // 通知列表三组内容
  const n = await api('/notifications', { token: ta });
  ok('三组各 1 条通知', n.likes.length === 1 && n.favs.length === 1 && n.comments.length === 1);
  ok('评论通知含内容/演员/帖子', n.comments[0].content === 'B 的评论内容' && n.comments[0].actor.nickname === '通知乙' && n.comments[0].post.id === p1.id);
  ok('点赞通知 actor 正确', n.likes[0].actor.nickname === '通知乙');

  // 标已读 → 归零
  await api('/notifications/read', { method: 'POST', token: ta, body: { types: ['comment', 'like', 'fav'] } });
  c = await api('/notifications/unread-count', { token: ta });
  ok('标已读后 total=0', c.total === 0);

  // B 私信 A → dm 未读 1
  await api(`/friends/dm/${uidA}`, { method: 'POST', token: tb, body: { content: '在吗？' } });
  c = await api('/notifications/unread-count', { token: ta });
  ok('私信后 dm=1 total=1', c.dm === 1 && c.total === 1);

  // A 自己赞自己的帖子 → 不产生通知
  await api(`/share/posts/${p2.id}/like`, { method: 'POST', token: ta });
  c = await api('/notifications/unread-count', { token: ta });
  ok('自己操作自己帖子不通知（total 仍=1 仅私信）', c.total === 1 && c.likes === 0);

  // 删帖 → 通知级联删除
  await api(`/share/posts/${p1.id}`, { method: 'DELETE', token: ta });
  const n2 = await api('/notifications', { token: ta });
  ok('删帖后通知级联清空', n2.comments.length === 0 && n2.likes.length === 0 && n2.favs.length === 0);

  // 清理：删 P2
  await api(`/share/posts/${p2.id}`, { method: 'DELETE', token: ta });

  console.log(`\n通过 ${pass} / ${pass + fail}`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error('💥', e.message);
  process.exit(1);
}
