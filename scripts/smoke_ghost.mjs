// 幽灵模式（秘密通道）冒烟测试：
// 注册A/B → A发普通帖B可见 → B enter(幽灵) → B发帖默认幽灵帖 → A完全不可见(列表/详情/点赞) →
// B ghost=1 可见 → ghost/users 名单与权限 → 幽灵间零好友直聊 → exit 后 403 → 标签侧信道
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
const apiRaw = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    method: opts.method || 'GET',
  });
  return { status: res.status, data: await j(res) };
};

const stamp = Date.now().toString().slice(-8);
const A = `gh_a_${stamp}@test.dev`, B = `gh_b_${stamp}@test.dev`;
const pw = 'pass123456';
const TAG = `幽灵隔离${stamp}`;
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log(`✅ ${name}`)) : (fail++, console.log(`❌ ${name}`)); };

try {
  // 注册两人
  const ra = await api('/auth/register', { method: 'POST', body: { email: A, password: pw, nickname: '幽灵甲' } });
  const rb = await api('/auth/register', { method: 'POST', body: { email: B, password: pw, nickname: '幽灵乙' } });
  ok('注册两用户', ra.token && rb.token);
  ok('注册响应 user 含 is_ghost:false', ra.user.is_ghost === false);
  const ta = ra.token, tb = rb.token;
  const uidA = Number(ra.user.id), uidB = Number(rb.user.id);

  // A 发普通帖 → B 可见
  const postA = await api('/share/posts', { method: 'POST', token: ta, body: { title: '普通帖-公开资源', content: '<p>普通内容</p>', tags: [TAG] } });
  ok('A 发普通帖成功', !!postA.id);
  const listB0 = await api('/share/posts?size=50', { token: tb });
  ok('B（未激活）可见 A 普通帖', listB0.rows.some((p) => p.id === postA.id));

  // B 激活幽灵模式
  const enter = await api('/ghost/enter', { method: 'POST', token: tb });
  ok('B enter 后 is_ghost=true', enter.user.is_ghost === true);
  const meB = await api('/auth/me', { token: tb });
  ok('/auth/me 携带 is_ghost=true', meB.user.is_ghost === true);

  // B 发帖（不传 is_ghost）→ 默认幽灵帖
  const postB = await api('/share/posts', { method: 'POST', token: tb, body: { title: '幽灵帖-秘密基地', content: '<p>只给怪奇小队看</p>', tags: [TAG] } });
  ok('B 发帖成功', !!postB.id);

  // 幽灵帖对普通用户（A）完全不可见
  const listA1 = await api('/share/posts?size=50', { token: ta });
  ok('A 列表看不到幽灵帖', !listA1.rows.some((p) => p.id === postB.id));
  const detA = await apiRaw(`/share/posts/${postB.id}`, { token: ta });
  ok('A 详情幽灵帖 404', detA.status === 404);
  const likeA = await apiRaw(`/share/posts/${postB.id}/like`, { method: 'POST', token: ta });
  ok('A 点赞幽灵帖 404', likeA.status === 404);
  const cmtA = await apiRaw(`/share/posts/${postB.id}/comments`, { method: 'POST', token: ta, body: { content: '想评论' } });
  ok('A 评论幽灵帖 404', cmtA.status === 404);
  const listAnon = await apiRaw('/share/posts?size=50');
  ok('匿名列表也看不到幽灵帖', listAnon.status === 200 && !listAnon.data.rows.some((p) => p.id === postB.id));

  // B 幽灵视角：ghost=1 只看幽灵帖；无参数只普通帖
  const listB1 = await api('/share/posts?ghost=1&size=50', { token: tb });
  ok('B ghost=1 列表含幽灵帖', listB1.rows.some((p) => p.id === postB.id));
  ok('B ghost=1 列表不含普通帖', !listB1.rows.some((p) => p.id === postA.id));
  const listB2 = await api('/share/posts?size=50', { token: tb });
  ok('B 普通视图只见普通帖', !listB2.rows.some((p) => p.id === postB.id) && listB2.rows.some((p) => p.id === postA.id));
  const detB = await api(`/share/posts/${postB.id}`, { token: tb });
  ok('B 可看幽灵帖详情', detB.id === postB.id);
  // B 自己的「我的帖子」scope=mine 全量（幽灵帖在自己的 mine 里可见，无需 ghost=1）
  const mineB = await api('/share/posts?scope=mine&size=50', { token: tb });
  ok('B scope=mine 含自己的幽灵帖', mineB.rows.some((p) => p.id === postB.id));

  // 标签侧信道：A 的标签计数只统计普通帖
  const tagsA = await api('/share/tags', { token: ta });
  const tagRowA = tagsA.find((t) => t.name === TAG);
  ok('A 标签计数=1（只含普通帖）', tagRowA?.count === 1);
  const tagsB = await api('/share/tags', { token: tb });
  ok('B 标签计数=2（含幽灵帖）', tagsB.find((t) => t.name === TAG)?.count === 2);

  // 幽灵用户名单：B 激活后 /ghost/users 不含自己；A 未激活不可调
  const usersB1 = await api('/ghost/users', { token: tb });
  ok('B 名单不含自己', Array.isArray(usersB1) && !usersB1.some((u) => Number(u.id) === uidB));
  const anonGhost = await apiRaw('/ghost/users');
  ok('未登录 /ghost/users 401', anonGhost.status === 401);
  const Aghost = await apiRaw('/ghost/users', { token: ta });
  ok('非幽灵 /ghost/users 403', Aghost.status === 403);

  // A 也激活 → 双方互相可见 → 零好友直聊
  const enterA = await api('/ghost/enter', { method: 'POST', token: ta });
  ok('A enter 成功', enterA.user.is_ghost === true);
  const usersB2 = await api('/ghost/users', { token: tb });
  ok('B 名单含 A', usersB2.some((u) => Number(u.id) === uidA));
  const dm = await api(`/friends/dm/${uidB}`, { method: 'POST', token: ta, body: { content: '怪奇小队接头暗号确认' } });
  ok('幽灵间零好友直聊成功', Number(dm.from_id) === uidA && Number(dm.to_id) === uidB);

  // 幽灵用户发普通帖（显式传 0）→ 普通用户可见
  const postB2 = await api('/share/posts', { method: 'POST', token: tb, body: { title: '幽灵发的普通帖', content: '<p>公开</p>', is_ghost: 0 } });
  const listA2 = await api('/share/posts?size=50', { token: ta });
  ok('幽灵用户显式 is_ghost:0 发普通帖，A 可见', listA2.rows.some((p) => p.id === postB2.id));

  // B 退出 → is_ghost=false → /ghost/users 403
  const exitB = await api('/ghost/exit', { method: 'POST', token: tb });
  ok('B exit 后 is_ghost=false', exitB.user.is_ghost === false);
  const usersB3 = await apiRaw('/ghost/users', { token: tb });
  ok('B 退出后 /ghost/users 403', usersB3.status === 403);
  const listB3 = await api('/share/posts?ghost=1&size=50', { token: tb });
  ok('B 退出后 ghost=1 仍看不到幽灵帖', !listB3.rows.some((p) => p.id === postB.id));

  // 清理：删测试用户（级联清 session/dm/share 等）
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
