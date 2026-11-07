// 小组多群聊：群列表/建群/加入/退出、群成员管理与邀请、群消息（仅群成员可见）
// 挂载前缀 /api/team；路径以 /chat-group、/chat-invites 与 /:id/chat-groups 区分，避开 teamCollab 旧路由
import { Router } from 'express';
import db from '../db/database.js';
import { authRequired, teamCtx, mutedGuard } from './middleware.js';
import { sanitizeAttachments, attachComments, cleanContent } from './teamCollab.js';
import { MAX_CHAT_GROUPS, getGroup, isGroupMember, listGroupMembers, listTeamGroups, dissolveGroup } from '../lib/teamChat.js';

const r = Router();
r.use(authRequired);

const parseAtt = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
const inTeam = (teamId, userId) => !!db.prepare(
  'SELECT 1 FROM team_member WHERE team_id = ? AND user_id = ?'
).all(teamId, userId).length;
const intIds = (v) => (Array.isArray(v) ? v : []).map(Number).filter((x) => Number.isInteger(x) && x > 0);

// 载入群 + 小组上下文；null=群不存在；noTeam=不是小组成员；joined=是否已入群
function loadCtx(gid, userId) {
  const group = getGroup(gid);
  if (!group) return null;
  const ctx = teamCtx(group.team_id, userId);
  if (!ctx || !ctx.member) return { noTeam: true };
  return { ctx, group, joined: isGroupMember(group.id, userId) };
}

// ==================== 群聊邀请（我的待处理）====================

// GET /api/team/chat-invites — 我收到的待入群邀请（跨小组）
r.get('/chat-invites', (req, res) => {
  const rows = db.prepare(
    `SELECT i.id, i.group_id, i.inviter_id, i.create_time,
            g.name AS group_name, g.team_id, g.visibility,
            t.name AS team_name,
            COALESCE(ui.nickname, ui.username) AS inviter_name
     FROM team_chat_group_invite i
     JOIN team_chat_group g ON g.id = i.group_id
     JOIN team t ON t.id = g.team_id
     JOIN user ui ON ui.id = i.inviter_id
     WHERE i.invitee_id = ? AND i.status = 'pending' ORDER BY i.id DESC`
  ).all(req.user.id);
  res.json(rows);
});

// ==================== 单群操作 ====================

// GET /api/team/chat-group/:gid — 群详情（私有群非成员只返回锁定信息，不给成员名单/公告）
r.get('/chat-group/:gid', (req, res) => {
  const c = loadCtx(Number(req.params.gid), req.user.id);
  if (!c) return res.status(404).json({ error: '群聊不存在' });
  if (c.noTeam) return res.status(403).json({ error: '不是小组成员' });
  const { group, joined, ctx } = c;
  const base = {
    id: group.id, team_id: group.team_id, name: group.name, owner_id: group.owner_id,
    visibility: group.visibility, avatar_user_id: group.avatar_user_id || null, joined,
  };
  if (!joined && group.visibility === 'private') {
    return res.json({ ...base, locked: true, notice: '', members: [], member_count: 0 });
  }
  const members = listGroupMembers(group.id);
  const avatarUser = group.avatar_user_id
    ? db.prepare('SELECT avatar FROM user WHERE id = ?').get(group.avatar_user_id) : null;
  res.json({
    ...base, locked: false, notice: group.notice || '',
    avatar: avatarUser?.avatar || null,
    member_count: members.length, members,
    is_team_owner: ctx.isOwner,
  });
});

// POST /api/team/chat-group/:gid/join — 加入（公开群自由加入，幂等；私有群请走邀请）
r.post('/chat-group/:gid/join', (req, res) => {
  const c = loadCtx(Number(req.params.gid), req.user.id);
  if (!c) return res.status(404).json({ error: '群聊不存在' });
  if (c.noTeam) return res.status(403).json({ error: '不是小组成员' });
  if (c.joined) return res.json({ id: c.group.id, message: '已在群内' });
  if (c.group.visibility === 'private') {
    return res.status(403).json({ code: 'private_group', error: '私有群聊，仅群成员可查看，请让群成员邀请你入群' });
  }
  db.prepare('INSERT OR IGNORE INTO team_chat_group_member (group_id, user_id) VALUES (?,?)')
    .run(c.group.id, req.user.id);
  res.status(201).json({ id: c.group.id, message: `已加入「${c.group.name}」` });
});

// POST /api/team/chat-group/:gid/leave — 退群（群主自动转让给最早入群者；最后一人退群即解散）
r.post('/chat-group/:gid/leave', (req, res) => {
  const c = loadCtx(Number(req.params.gid), req.user.id);
  if (!c) return res.status(404).json({ error: '群聊不存在' });
  if (c.noTeam) return res.status(403).json({ error: '不是小组成员' });
  if (!c.joined) return res.status(403).json({ error: '你不在该群中' });
  const remain = db.prepare('SELECT COUNT(*) AS n FROM team_chat_group_member WHERE group_id = ?').get(c.group.id).n;
  if (remain <= 1) {
    dissolveGroup(c.group.id);
    return res.json({ dissolved: true, message: '你是最后一位成员，群聊已解散' });
  }
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM team_chat_group_member WHERE group_id = ? AND user_id = ?').run(c.group.id, req.user.id);
    if (c.group.owner_id === req.user.id) {
      const next = db.prepare('SELECT user_id FROM team_chat_group_member WHERE group_id = ? ORDER BY rowid LIMIT 1').get(c.group.id);
      db.prepare('UPDATE team_chat_group SET owner_id = ? WHERE id = ?').run(next.user_id, c.group.id);
    }
    // 退群后其待处理邀请（作为邀请人发出的）一并撤销
    db.prepare("UPDATE team_chat_group_invite SET status = 'cancelled', handle_time = CURRENT_TIMESTAMP WHERE group_id = ? AND inviter_id = ? AND status = 'pending'")
      .run(c.group.id, req.user.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ message: '已退出群聊' });
});

// GET /api/team/chat-group/:gid/messages?before=&limit= — 群消息分页（仅群成员）
r.get('/chat-group/:gid/messages', (req, res) => {
  const c = loadCtx(Number(req.params.gid), req.user.id);
  if (!c) return res.status(404).json({ error: '群聊不存在' });
  if (c.noTeam || !c.joined) return res.status(403).json({ error: '仅群成员可查看消息' });
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 30));
  const before = Number(req.query.before) || 0;
  const rows0 = before
    ? db.prepare(
      `SELECT m.id, m.team_id, m.chat_group_id, m.content, m.attachments, m.create_time,
              u.id AS user_id, COALESCE(u.nickname, u.username) AS nickname
       FROM team_message m JOIN user u ON u.id = m.user_id
       WHERE m.chat_group_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`
    ).all(c.group.id, before, limit)
    : db.prepare(
      `SELECT m.id, m.team_id, m.chat_group_id, m.content, m.attachments, m.create_time,
              u.id AS user_id, COALESCE(u.nickname, u.username) AS nickname
       FROM team_message m JOIN user u ON u.id = m.user_id
       WHERE m.chat_group_id = ? ORDER BY m.id DESC LIMIT ?`
    ).all(c.group.id, limit);
  const rows = rows0.map((m) => ({
    ...m, content: cleanContent(m.content), attachments: parseAtt(m.attachments),
  })).reverse();
  res.json(attachComments(c.group.team_id, 'message', rows));
});

// POST /api/team/chat-group/:gid/message — 发消息（群成员皆可发言；禁言账号由 mutedGuard 拦截）
r.post('/chat-group/:gid/message', mutedGuard, (req, res) => {
  const c = loadCtx(Number(req.params.gid), req.user.id);
  if (!c) return res.status(404).json({ error: '群聊不存在' });
  if (c.noTeam || !c.joined) return res.status(403).json({ error: '仅群成员可发言' });
  const { content, attachments } = req.body || {};
  if (content !== undefined && typeof content !== 'string') return res.status(400).json({ error: '消息内容格式错误' });
  if (!String(content || '').trim() && !(attachments || []).length) {
    return res.status(400).json({ error: '消息内容或图片至少填写一项' });
  }
  let att = [];
  try { att = sanitizeAttachments(attachments); } catch (e) { return res.status(413).json({ error: e.message }); }
  const rr = db.prepare('INSERT INTO team_message (team_id, chat_group_id, user_id, content, attachments) VALUES (?,?,?,?,?)')
    .run(c.group.team_id, c.group.id, req.user.id, String(content || ''), JSON.stringify(att));
  res.status(201).json({ id: rr.lastInsertRowid, message: '已发送' });
});

// DELETE /api/team/chat-group/:gid/message/:mid — 删除消息（本人/群主/组长；不提供编辑）
r.delete('/chat-group/:gid/message/:mid', (req, res) => {
  const c = loadCtx(Number(req.params.gid), req.user.id);
  if (!c) return res.status(404).json({ error: '群聊不存在' });
  if (c.noTeam || !c.joined) return res.status(403).json({ error: '仅群成员可操作' });
  const msg = db.prepare('SELECT * FROM team_message WHERE id = ? AND chat_group_id = ?')
    .get(Number(req.params.mid), c.group.id);
  if (!msg) return res.status(404).json({ error: '消息不存在' });
  const canMod = c.ctx.isOwner || c.group.owner_id === req.user.id || msg.user_id === req.user.id;
  if (!canMod) return res.status(403).json({ error: '仅本人、群主或组长可删除' });
  db.prepare("DELETE FROM comment WHERE target_type = 'message' AND target_id = ?").run(msg.id);
  db.prepare('DELETE FROM team_message WHERE id = ?').run(msg.id);
  res.json({ message: '已删除' });
});

// ==================== 群成员管理（群主）与邀请（全员）====================

// POST /api/team/chat-group/:gid/members — 群主直接加人（目标须为小组成员）
r.post('/chat-group/:gid/members', (req, res) => {
  const c = loadCtx(Number(req.params.gid), req.user.id);
  if (!c) return res.status(404).json({ error: '群聊不存在' });
  if (c.noTeam || !c.joined) return res.status(403).json({ error: '仅群成员可操作' });
  if (c.group.owner_id !== req.user.id) return res.status(403).json({ error: '仅群主可直接添加成员' });
  const ids = [...new Set(intIds(req.body?.user_ids))];
  if (!ids.length) return res.status(400).json({ error: '请选择要拉入的成员' });
  const bad = ids.filter((uid) => !inTeam(c.group.team_id, uid));
  if (bad.length) return res.status(400).json({ error: '包含非本小组成员，已取消操作' });
  db.exec('BEGIN');
  try {
    for (const uid of ids) {
      db.prepare('INSERT OR IGNORE INTO team_chat_group_member (group_id, user_id) VALUES (?,?)').run(c.group.id, uid);
      // 直接加人后，其待处理邀请不再需要
      db.prepare("DELETE FROM team_chat_group_invite WHERE group_id = ? AND invitee_id = ? AND status = 'pending'")
        .run(c.group.id, uid);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.status(201).json({ message: `已添加 ${ids.length} 人（已在群内的自动跳过）` });
});

// DELETE /api/team/chat-group/:gid/members/:uid — 群主移除成员
r.delete('/chat-group/:gid/members/:uid', (req, res) => {
  const c = loadCtx(Number(req.params.gid), req.user.id);
  if (!c) return res.status(404).json({ error: '群聊不存在' });
  if (c.noTeam || !c.joined) return res.status(403).json({ error: '仅群成员可操作' });
  if (c.group.owner_id !== req.user.id) return res.status(403).json({ error: '仅群主可移除成员' });
  const uid = Number(req.params.uid);
  if (uid === req.user.id) return res.status(400).json({ error: '群主请使用退群功能' });
  const rr = db.prepare('DELETE FROM team_chat_group_member WHERE group_id = ? AND user_id = ?').run(c.group.id, uid);
  if (!rr.changes) return res.status(404).json({ error: '该成员不在群内' });
  db.prepare("UPDATE team_chat_group_invite SET status = 'cancelled', handle_time = CURRENT_TIMESTAMP WHERE group_id = ? AND invitee_id = ? AND status = 'pending'")
    .run(c.group.id, uid);
  res.json({ message: '已移出群聊' });
});

// POST /api/team/chat-group/:gid/invites — 群成员邀请队友（对方确认后入群）
r.post('/chat-group/:gid/invites', (req, res) => {
  const c = loadCtx(Number(req.params.gid), req.user.id);
  if (!c) return res.status(404).json({ error: '群聊不存在' });
  if (c.noTeam || !c.joined) return res.status(403).json({ error: '仅群成员可邀请' });
  const uid = Number(req.body?.user_id);
  if (!Number.isInteger(uid) || uid <= 0) return res.status(400).json({ error: '请选择要邀请的成员' });
  if (!inTeam(c.group.team_id, uid)) return res.status(400).json({ error: '只能邀请同小组成员' });
  if (isGroupMember(c.group.id, uid)) return res.status(409).json({ error: '对方已在群内' });
  const exist = db.prepare("SELECT id FROM team_chat_group_invite WHERE group_id = ? AND invitee_id = ? AND status = 'pending'")
    .get(c.group.id, uid);
  if (exist) return res.status(409).json({ error: '已发出邀请，等待对方确认' });
  const rr = db.prepare('INSERT INTO team_chat_group_invite (group_id, inviter_id, invitee_id) VALUES (?,?,?)')
    .run(c.group.id, req.user.id, uid);
  res.status(201).json({ id: rr.lastInsertRowid, message: '邀请已发出' });
});

// 邀请处理通用守卫：返回邀请行或发错误响应
function loadInvite(gid, iid, userId) {
  const inv = db.prepare('SELECT * FROM team_chat_group_invite WHERE id = ? AND group_id = ?').get(Number(iid), Number(gid));
  if (!inv || inv.status !== 'pending') return { error: ['邀请不存在或已处理', 404] };
  return { inv };
}

// POST /api/team/chat-group/:gid/invites/:iid/accept — 被邀请人接受
r.post('/chat-group/:gid/invites/:iid/accept', (req, res) => {
  const g = loadCtx(Number(req.params.gid), req.user.id);
  if (!g) return res.status(404).json({ error: '群聊不存在' });
  if (g.noTeam) return res.status(403).json({ error: '你已不在该小组中' });
  const x = loadInvite(req.params.gid, req.params.iid, req.user.id);
  if (x.error) return res.status(x.error[1]).json({ error: x.error[0] });
  if (x.inv.invitee_id !== req.user.id) return res.status(403).json({ error: '只能处理发给自己的邀请' });
  db.exec('BEGIN');
  try {
    db.prepare('INSERT OR IGNORE INTO team_chat_group_member (group_id, user_id) VALUES (?,?)').run(x.inv.group_id, req.user.id);
    db.prepare("UPDATE team_chat_group_invite SET status = 'accepted', handle_time = CURRENT_TIMESTAMP WHERE id = ?").run(x.inv.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ message: '已加入群聊' });
});

// POST /api/team/chat-group/:gid/invites/:iid/reject — 被邀请人拒绝
r.post('/chat-group/:gid/invites/:iid/reject', (req, res) => {
  const x = loadInvite(req.params.gid, req.params.iid, req.user.id);
  if (x.error) return res.status(x.error[1]).json({ error: x.error[0] });
  if (x.inv.invitee_id !== req.user.id) return res.status(403).json({ error: '只能处理发给自己的邀请' });
  db.prepare("UPDATE team_chat_group_invite SET status = 'rejected', handle_time = CURRENT_TIMESTAMP WHERE id = ?").run(x.inv.id);
  res.json({ message: '已拒绝邀请' });
});

// POST /api/team/chat-group/:gid/invites/:iid/cancel — 邀请人或群主撤销
r.post('/chat-group/:gid/invites/:iid/cancel', (req, res) => {
  const c = loadCtx(Number(req.params.gid), req.user.id);
  if (!c) return res.status(404).json({ error: '群聊不存在' });
  if (c.noTeam) return res.status(403).json({ error: '不是小组成员' });
  const x = loadInvite(req.params.gid, req.params.iid, req.user.id);
  if (x.error) return res.status(x.error[1]).json({ error: x.error[0] });
  if (x.inv.inviter_id !== req.user.id && c.group.owner_id !== req.user.id) {
    return res.status(403).json({ error: '仅邀请人或群主可撤销' });
  }
  db.prepare("UPDATE team_chat_group_invite SET status = 'cancelled', handle_time = CURRENT_TIMESTAMP WHERE id = ?").run(x.inv.id);
  res.json({ message: '邀请已撤销' });
});

// ==================== 小组维度：群列表与建群 ====================

// GET /api/team/:id/chat-groups — 群列表（小组成员可见；私有群非成员只显示名字与锁）
r.get('/:id/chat-groups', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  res.json(listTeamGroups(ctx.team.id, req.user.id));
});

// POST /api/team/:id/chat-groups — 建群（任何成员可建，每组最多 10 个；建群者自动入群）
r.post('/:id/chat-groups', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: '群名称必填' });
  if (name.length > 20) return res.status(400).json({ error: '群名称过长（≤20字）' });
  const visibility = req.body?.visibility === 'private' ? 'private' : 'public';
  const count = db.prepare('SELECT COUNT(*) AS n FROM team_chat_group WHERE team_id = ?').get(ctx.team.id).n;
  if (count >= MAX_CHAT_GROUPS) return res.status(400).json({ error: `每个小组最多 ${MAX_CHAT_GROUPS} 个群聊` });
  // 初始成员 / 头像引用成员都必须是本组成员
  const memberIds = [...new Set([req.user.id, ...intIds(req.body?.member_ids)])];
  const bad = memberIds.filter((uid) => !inTeam(ctx.team.id, uid));
  if (bad.length) return res.status(400).json({ error: '初始成员包含非本小组成员' });
  let avatarUserId = null;
  if (req.body?.avatar_user_id != null && req.body?.avatar_user_id !== '') {
    avatarUserId = Number(req.body.avatar_user_id);
    if (!memberIds.includes(avatarUserId) || !inTeam(ctx.team.id, avatarUserId)) {
      return res.status(400).json({ error: '群头像引用的成员无效' });
    }
  }
  let gid;
  db.exec('BEGIN');
  try {
    const rr = db.prepare('INSERT INTO team_chat_group (team_id, name, owner_id, visibility, avatar_user_id) VALUES (?,?,?,?,?)')
      .run(ctx.team.id, name, req.user.id, visibility, avatarUserId);
    gid = Number(rr.lastInsertRowid);
    for (const uid of memberIds) {
      db.prepare('INSERT OR IGNORE INTO team_chat_group_member (group_id, user_id) VALUES (?,?)').run(gid, uid);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.status(201).json({ id: gid, name, visibility, message: '群聊已创建' });
});

export default r;