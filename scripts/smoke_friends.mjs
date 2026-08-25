// 好友+私信+帖子scope 冒烟测试：注册两人 → 搜索 → 加好友 → 同意 → 私聊 → 已读 → 帖子 mine/favs → 删好友
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
const A = `fr_a_${stamp}@test.dev`, B = `fr_b_${stamp}@test.dev`;
const pw = 'pass123456';
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}`)); };

try {
  // 注册两人
  const ra = await api('/auth/register', { method: 'POST', body: { email: A, password: pw, nickname: '好友甲' } });
  const rb = await api('/auth/register', { method: 'POST', body: { email: B, password: pw, nickname: '好友乙' } });
  ok('注册两用户', ra.token && rb.token);
  const ta = ra.token, tb = rb.token;
  const uidA = Number(ra.user.id), uidB = Number(rb.user.id);

  // 搜索：A 搜 "好友乙"（昵称模糊）
  const search = await api(`/friends/search?q=${encodeURIComponent('好友乙')}`, { token: ta });
  ok('A 按昵称搜索到 B', Array.isArray(search) && search.some((u) => Number(u.id) === uidB));
  ok('A 搜索不包含自己', search.every((u) => Number(u.id) !== uidA));

  // A 发申请 → B 收到
  const req = await api('/friends/request', { method: 'POST', token: ta, body: { to_id: uidB } });
  ok('A 发好友申请', !!req.id);
  const reqsB = await api('/friends/requests', { token: tb });
  ok('B 收到 incoming 申请', reqsB.incoming.some((x) => Number(x.user_id) === uidA));
  const reqId = reqsB.incoming[0].id;

  // 重复申请被拦截
  let dupBlocked = false;
  try { await api('/friends/request', { method: 'POST', token: ta, body: { to_id: uidB } }); }
  catch { dupBlocked = true; }
  ok('重复申请被拦截', dupBlocked);

  // B 同意 → 互为好友
  await api(`/friends/request/${reqId}/accept`, { method: 'POST', token: tb });
  const fa = await api('/friends', { token: ta });
  const fb = await api('/friends', { token: tb });
  ok('A 好友列表含 B', fa.some((f) => Number(f.id) === uidB));
  ok('B 好友列表含 A', fb.some((f) => Number(f.id) === uidA));
  const reqsA2 = await api('/friends/requests', { token: ta });
  ok('申请状态流转后 A 无 pending', reqsA2.incoming.length === 0 && reqsA2.outgoing.length === 0);

  // 私聊：B 发 → A 未读数=1；A 拉取自动已读
  const dm = await api(`/friends/dm/${uidA}`, { method: 'POST', token: tb, body: { content: '你好，赛题资料我发你邮箱' } });
  ok('B 发私信成功', dm.id && dm.content.includes('邮箱'));
  const fa2 = await api('/friends', { token: ta });
  ok('A 未读徽标=1', fa2.find((f) => Number(f.id) === uidB)?.unread === 1);
  ok('A 好友列表显示最近消息', fa2.find((f) => Number(f.id) === uidB)?.last_msg === dm.content);
  const dmA = await api(`/friends/dm/${uidB}`, { token: ta });
  ok('A 拉到 B 的私信', dmA.length === 1 && Number(dmA[0].from_id) === uidB);
  const fa3 = await api('/friends', { token: ta });
  ok('A 拉取后未读归零', fa3.find((f) => Number(f.id) === uidB)?.unread === 0);
  const dmB = await api(`/friends/dm/${uidA}`, { token: tb });
  ok('B 侧会话含自己发出的消息', dmB.some((m) => Number(m.from_id) === uidB));

  // A 回复
  const dm2 = await api(`/friends/dm/${uidB}`, { method: 'POST', token: ta, body: { content: '收到，谢谢！' } });
  ok('A 回复成功', Number(dm2.from_id) === uidA);
  const dmB2 = await api(`/friends/dm/${uidA}`, { token: tb });
  ok('B 会话两条消息按时间升序', dmB2.length === 2 && dmB2[0].id < dmB2[1].id);

  // 发帖 + scope 过滤：A 发帖 → A scope=mine 1 条；B 收藏后 scope=favs 1 条
  const post = await api('/share/posts', { method: 'POST', token: ta, body: { title: '电赛电源类资料合集', content: '<p>分享一些往年赛题资源</p>', tags: ['电子设计'] } });
  ok('A 发帖成功', !!post.id);
  const mineA = await api(`/share/posts?scope=mine&size=20`, { token: ta });
  ok('A scope=mine 只含自己帖子', mineA.rows.every((p) => Number(p.author_id) === uidA) && mineA.total >= 1);
  await api(`/share/posts/${post.id}/fav`, { method: 'POST', token: tb });
  const favsB = await api(`/share/posts?scope=favs&size=20`, { token: tb });
  ok('B scope=favs 含收藏帖', favsB.rows.some((p) => p.id === post.id));
  const favsA = await api(`/share/posts?scope=favs&size=20`, { token: ta });
  ok('A scope=favs 为空', favsA.total === 0);
  let anonBlocked = false;
  try { await api('/share/posts?scope=mine'); } catch { anonBlocked = true; }
  ok('未登录 scope=mine 被拒', anonBlocked);

  // 删好友：双向清空
  await api(`/friends/${uidB}`, { method: 'DELETE', token: ta });
  const fa4 = await api('/friends', { token: ta });
  const fb4 = await api('/friends', { token: tb });
  ok('删好友后双方列表为空', fa4.length === 0 && fb4.length === 0);
  let dmAllowed = true;
  const dmAfter = await api(`/friends/dm/${uidB}`, { method: 'POST', token: ta, body: { content: '不是好友也能发吗' } });
  ok('删好友后仍可发私信（记录保留）', !!dmAfter.id);

  // 清理：删测试用户（级联清 session/friend/dm/share）
  const cleanup = await import('node:sqlite').then(({ DatabaseSync }) => {
    const d = new DatabaseSync('D:\\desktop\\竞赛指导\\backend\\data\\compass.db');
    const info = d.prepare('SELECT id FROM user WHERE email IN (?, ?)').all(A, B);
    for (const u of info) d.prepare('DELETE FROM user WHERE id = ?').run(u.id);
    d.close();
    return info.length;
  });
  ok(`清理测试用户 ×${cleanup}`, cleanup === 2);
} catch (e) {
  fail++;
  console.log(`❌ 异常中断: ${e.message}`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
