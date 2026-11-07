// 小组多群聊冒烟：自起临时后端(:3112)+临时库，覆盖
//   默认群迁移/建群上限/公开群自由加入/私有群锁定与 403/邀请接受/群主直加/删除权限/
//   群主退群转让/最后一人解散/旧接口映射默认群/移出小组清退群关系/删消息级联清评论
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PORT = 3112;
const BASE = `http://127.0.0.1:${PORT}/api`;
const work = mkdtempSync(join(tmpdir(), 'smk-chat-'));
const env = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
  PORT: String(PORT), DB_PATH: join(work, 'compass.db'),
  SHARE_UPLOAD_DIR: join(work, 'share'), HONOR_UPLOAD_DIR: join(work, 'honor'),
  PURCHASE_UPLOAD_DIR: join(work, 'purchase'),
};
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log(`✅ ${n}`)) : (fail++, console.log(`❌ ${n}${x !== undefined ? ' → ' + JSON.stringify(x) : ''}`)); };

const jreq = async (p, o = {}) => {
  const h = { 'Content-Type': 'application/json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) };
  const res = await fetch(BASE + p, { headers: h, method: o.method || 'GET', body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { res, data };
};
const api = async (p, o = {}) => { const { res, data } = await jreq(p, o); if (!res.ok) throw new Error(`${o.method || 'GET'} ${p} → ${res.status} ${JSON.stringify(data)}`); return data; };
const exp = async (p, st, o = {}) => { const { res, data } = await jreq(p, o); return { ok: res.status === st, got: res.status, data }; };

let server;
try {
  server = spawn(process.execPath, [
    '--import', pathToFileURL(join(process.cwd(), 'scripts', 'polyfill_dom.mjs')).href,
    join(process.cwd(), 'backend', 'server.js'),
  ], { cwd: work, env, stdio: 'ignore', shell: false });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!(await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.ok).catch(() => false))) throw new Error('后端未就绪');

  // ---------- 0. 用户与小组 ----------
  const stamp = Date.now().toString().slice(-8);
  const reg = async (k, nick) => api('/auth/register', { method: 'POST', body: { email: `ci_${k}_${stamp}@test.dev`, password: 'pass123456', nickname: nick } });
  const rO = await reg('o', '组长');
  const rA = await reg('a', '小甲');
  const rB = await reg('b', '小乙');
  const tO = rO.token, tA = rA.token, tB = rB.token;
  const tg = await api('/team', { method: 'POST', token: tO, body: { name: `群聊冒烟组${stamp}` } });
  const TID = tg.team?.id || tg.id;
  await api(`/team/${TID}/member/add`, { method: 'POST', token: tO, body: { user_ids: [rA.user.id, rB.user.id] } });

  // ---------- 1. 默认群 ----------
  const gs0 = await api(`/team/${TID}/chat-groups`, { token: tA });
  ok('建组后自动有默认群「小组讨论」', gs0.length === 1 && gs0[0].name === '小组讨论' && gs0[0].visibility === 'public', gs0);
  ok('新拉入成员自动进默认群（3人）', gs0[0].member_count === 3 && gs0[0].joined === true);

  // ---------- 2. 私有群可见性 ----------
  const pg = await api(`/team/${TID}/chat-groups`, { method: 'POST', token: tA, body: { name: '机械组私房话', visibility: 'private' } });
  const PGID = pg.id;
  const gsB = await api(`/team/${TID}/chat-groups`, { token: tB });
  const pgb = gsB.find((g) => g.id === PGID);
  ok('私有群在列表可见但锁定', pgb.visibility === 'private' && pgb.joined === false && pgb.last_message === null && pgb.member_count === null, pgb);
  let g = await exp(`/team/chat-group/${PGID}/join`, 403, { method: 'POST', token: tB });
  ok('私有群不能自由加入(403 private_group)', g.data.code === 'private_group');
  g = await exp(`/team/chat-group/${PGID}/messages`, 403, { token: tB });
  ok('非群成员拉消息 403', g.ok);

  // ---------- 3. 邀请流程 ----------
  await api(`/team/chat-group/${PGID}/invites`, { method: 'POST', token: tA, body: { user_id: rB.user.id } });
  g = await exp(`/team/chat-group/${PGID}/invites`, 409, { method: 'POST', token: tA, body: { user_id: rB.user.id } });
  ok('重复邀请 409', g.ok);
  const iv = await api('/team/chat-invites', { token: tB });
  ok('被邀请人收到待处理邀请', iv.length === 1 && iv[0].group_id === PGID, iv);
  const iid = iv[0].id;
  await api(`/team/chat-group/${PGID}/invites/${iid}/accept`, { method: 'POST', token: tB });
  const msgsB = await api(`/team/chat-group/${PGID}/messages`, { token: tB });
  ok('接受邀请后可拉消息（空数组）', Array.isArray(msgsB) && msgsB.length === 0);
  const sent = await api(`/team/chat-group/${PGID}/message`, { method: 'POST', token: tB, body: { content: '私有群第一条' } });
  ok('群成员皆可发言（无 message 权限要求）', !!sent.id);
  g = await exp(`/team/chat-group/${PGID}/messages`, 403, { token: tO });
  ok('组长非群成员照样 403（内容隔离）', g.ok);

  // ---------- 4. 群主直加 + 删除权限 ----------
  await api(`/team/chat-group/${PGID}/members`, { method: 'POST', token: tA, body: { user_ids: [rO.user.id] } });
  const detail = await api(`/team/chat-group/${PGID}`, { token: tO });
  ok('群主直加后组长可见群详情与成员', detail.joined && detail.member_count === 3, detail.member_count);
  const msgA = await api(`/team/chat-group/${PGID}/message`, { method: 'POST', token: tA, body: { content: '小甲的消息' } });
  g = await exp(`/team/chat-group/${PGID}/message/${msgA.id}`, 403, { method: 'DELETE', token: tB });
  ok('旁人不能删消息 403', g.ok);
  const del = await exp(`/team/chat-group/${PGID}/message/${sent.id}`, 200, { method: 'DELETE', token: tB });
  ok('本人可删自己消息', del.ok);

  // 评论随消息级联清理
  const msgC = await api(`/team/chat-group/${PGID}/message`, { method: 'POST', token: tO, body: { content: '带评论的消息' } });
  await api(`/team/${TID}/comment/message/${msgC.id}`, { method: 'POST', token: tB, body: { content: '抢沙发' } });
  const db = new DatabaseSync(env.DB_PATH);
  const cBefore = db.prepare("SELECT COUNT(*) n FROM comment WHERE target_type='message' AND target_id=?").get(msgC.id).n;
  ok('评论已落库', cBefore === 1);
  await api(`/team/chat-group/${PGID}/message/${msgC.id}`, { method: 'DELETE', token: tA }); // 群主可删
  const cAfter = db.prepare("SELECT COUNT(*) n FROM comment WHERE target_type='message' AND target_id=?").get(msgC.id).n;
  ok('删消息级联清评论', cAfter === 0);

  // ---------- 5. 旧接口映射默认群 ----------
  await api(`/team/${TID}/message`, { method: 'POST', token: tB, body: { content: '旧客户端发的消息' } });
  const legacy = await api(`/team/${TID}/messages`, { token: tB });
  ok('旧接口消息落在默认群', legacy.some((m) => m.content === '旧客户端发的消息'));
  const defId = gs0[0].id;
  const defMsgs = await api(`/team/chat-group/${defId}/messages`, { token: tB });
  ok('新接口能读到旧接口消息', defMsgs.some((m) => m.content === '旧客户端发的消息'));

  // ---------- 6. 10 群上限（已有默认群+私有群=2，再建 8 个到顶，第 11 次拒绝）----------
  for (let i = 0; i < 8; i++) {
    await api(`/team/${TID}/chat-groups`, { method: 'POST', token: tA, body: { name: `讨论群${i}` } });
  }
  const gsFull = await api(`/team/${TID}/chat-groups`, { token: tA });
  ok('群数量达到 10 个上限', gsFull.length === 10, gsFull.length);
  g = await exp(`/team/${TID}/chat-groups`, 400, { method: 'POST', token: tA, body: { name: '第十一个群' } });
  ok('第 11 个群被拒', g.ok);

  // ---------- 7. 退群转让与解散 ----------
  // 先解散一个刚建的群腾位置，再建 G2 由 B 当群主
  const spare = gsFull.find((x) => x.name === '讨论群7');
  // 讨论群7 建群者是 A，先拉 B 再由 A 退出，B 成群主后解散它（最后一人）
  await api(`/team/chat-group/${spare.id}/members`, { method: 'POST', token: tA, body: { user_ids: [rB.user.id] } });
  await api(`/team/chat-group/${spare.id}/leave`, { method: 'POST', token: tA });
  const d2 = await api(`/team/chat-group/${spare.id}`, { token: tB });
  ok('群主退群自动转让', d2.owner_id === rB.user.id, d2.owner_id);
  const leave = await api(`/team/chat-group/${spare.id}/leave`, { method: 'POST', token: tB });
  ok('最后一人退群返回解散标记', leave.dissolved === true);
  g = await exp(`/team/chat-group/${spare.id}`, 404, { token: tO });
  ok('群已不存在 404', g.ok);

  // ---------- 8. 移出小组 → 清退所有群关系 ----------
  const inBefore = db.prepare('SELECT COUNT(*) n FROM team_chat_group_member m JOIN team_chat_group g ON g.id=m.group_id WHERE g.team_id=? AND m.user_id=?').get(TID, rB.user.id).n;
  ok('B 移除前在多个群中', inBefore >= 1, inBefore);
  await api(`/team/${TID}/member/${rB.user.id}`, { method: 'DELETE', token: tO });
  g = await exp(`/team/${TID}/chat-groups`, 403, { token: tB });
  ok('被移出小组后群列表 403', g.ok);
  const inAfter = db.prepare('SELECT COUNT(*) n FROM team_chat_group_member m JOIN team_chat_group g ON g.id=m.group_id WHERE g.team_id=? AND m.user_id=?').get(TID, rB.user.id).n;
  ok('群成员关系已级联清退', inAfter === 0, inAfter);
  db.close();

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
} catch (e) {
  fail++;
  console.log('❌ 异常中断:', e.stack || e.message);
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
} finally {
  try { server?.kill(); } catch {}
  process.exit(fail ? 1 : 0);
}