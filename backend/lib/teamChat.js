// 小组多群聊领域 helper：默认群、成员关系、群列表、解散清理。
// routes/teamChat.js、teamCollab.js（旧接口兜底）、team.js（建组/入组/移除）共用。
import db from '../db/database.js';

export const MAX_CHAT_GROUPS = 10;
export const DEFAULT_GROUP_NAME = '小组讨论';

// 取群行（不存在返回 undefined）
export const getGroup = (gid) => db.prepare('SELECT * FROM team_chat_group WHERE id = ?').get(Number(gid));

// 群成员判断
export const isGroupMember = (gid, userId) => !!db.prepare(
  'SELECT 1 FROM team_chat_group_member WHERE group_id = ? AND user_id = ?'
).get(Number(gid), Number(userId));

// 默认群（每组第一个群，恒为 public）；不存在则创建：全员入群 + 旧消息回填。幂等。
export function ensureDefaultGroup(teamId, ownerId) {
  const exist = db.prepare('SELECT id FROM team_chat_group WHERE team_id = ? ORDER BY id LIMIT 1').get(teamId);
  if (exist) return getGroup(exist.id);
  db.exec('BEGIN');
  try {
    const rr = db.prepare('INSERT INTO team_chat_group (team_id, name, owner_id, visibility) VALUES (?,?,?,?)')
      .run(teamId, DEFAULT_GROUP_NAME, ownerId, 'public');
    const gid = Number(rr.lastInsertRowid);
    db.prepare('INSERT OR IGNORE INTO team_chat_group_member (group_id, user_id) SELECT ?, user_id FROM team_member WHERE team_id = ?')
      .run(gid, teamId);
    db.prepare('UPDATE team_message SET chat_group_id = ? WHERE team_id = ? AND chat_group_id IS NULL').run(gid, teamId);
    db.exec('COMMIT');
    return getGroup(gid);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// 新成员入组同步进默认群（默认群对全组成员开放）；无默认群时静默（启动迁移会兜底）
export function addUserToDefaultGroup(teamId, userId) {
  const g = db.prepare("SELECT id FROM team_chat_group WHERE team_id = ? AND visibility = 'public' ORDER BY id LIMIT 1").get(teamId);
  if (!g) return;
  db.prepare('INSERT OR IGNORE INTO team_chat_group_member (group_id, user_id) VALUES (?,?)').run(g.id, userId);
}

// 成员被移出小组：清掉他在该组所有群的成员关系与待处理邀请，否则移除后仍可读群消息；
// 若他是某群群主，自动转让给最早入群者，空群则解散
export function removeUserFromTeamGroups(teamId, userId) {
  const gids = db.prepare('SELECT id FROM team_chat_group WHERE team_id = ?').all(teamId).map((x) => x.id);
  for (const gid of gids) {
    db.prepare('DELETE FROM team_chat_group_member WHERE group_id = ? AND user_id = ?').run(gid, userId);
    db.prepare("UPDATE team_chat_group_invite SET status = 'cancelled', handle_time = CURRENT_TIMESTAMP WHERE group_id = ? AND invitee_id = ? AND status = 'pending'")
      .run(gid, userId);
    const g = getGroup(gid);
    if (g && g.owner_id === userId) {
      const next = db.prepare('SELECT user_id FROM team_chat_group_member WHERE group_id = ? ORDER BY rowid LIMIT 1').get(gid);
      if (next) db.prepare('UPDATE team_chat_group SET owner_id = ? WHERE id = ?').run(next.user_id, gid);
      else dissolveGroup(gid);
    }
  }
}

// 解散群：comment 表无级联外键，先按消息 id 清评论，再删消息/邀请/成员/群
export function dissolveGroup(gid) {
  const mids = db.prepare('SELECT id FROM team_message WHERE chat_group_id = ?').all(gid).map((x) => x.id);
  db.exec('BEGIN');
  try {
    if (mids.length) {
      const ph = mids.map(() => '?').join(',');
      db.prepare(`DELETE FROM comment WHERE target_type = 'message' AND target_id IN (${ph})`).run(...mids);
    }
    db.prepare('DELETE FROM team_message WHERE chat_group_id = ?').run(gid);
    db.prepare('DELETE FROM team_chat_group_invite WHERE group_id = ?').run(gid);
    db.prepare('DELETE FROM team_chat_group_member WHERE group_id = ?').run(gid);
    db.prepare('DELETE FROM team_chat_group WHERE id = ?').run(gid);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// 群成员行（含展示名/头像/群主标记），按入群先后升序
export function listGroupMembers(gid) {
  return db.prepare(
    `SELECT u.id AS user_id, u.nickname, u.username, u.real_name, u.avatar,
            COALESCE(u.nickname, u.username) AS nickname_snap,
            m.join_time, g.owner_id
     FROM team_chat_group_member m
     JOIN user u ON u.id = m.user_id
     JOIN team_chat_group g ON g.id = m.group_id
     WHERE m.group_id = ? ORDER BY m.rowid`
  ).all(gid).map((x) => ({
    user_id: x.user_id, nickname: x.nickname_snap, real_name: x.real_name || '',
    avatar: x.avatar || null, join_time: x.join_time, is_owner: x.user_id === x.owner_id,
  }));
}

// 小组视角群列表：私有群对非成员隐藏消息预览与公告，只给群名+锁
export function listTeamGroups(teamId, userId) {
  const groups = db.prepare('SELECT * FROM team_chat_group WHERE team_id = ? ORDER BY id').all(teamId);
  return groups.map((g) => {
    const joined = !!db.prepare('SELECT 1 FROM team_chat_group_member WHERE group_id = ? AND user_id = ?').get(g.id, userId);
    const memberCount = db.prepare('SELECT COUNT(*) AS n FROM team_chat_group_member WHERE group_id = ?').get(g.id).n;
    const owner = db.prepare('SELECT id, nickname, username, real_name FROM user WHERE id = ?').get(g.owner_id);
    const avatarUser = g.avatar_user_id
      ? db.prepare('SELECT id, avatar FROM user WHERE id = ?').get(g.avatar_user_id) : null;
    let lastMessage = null;
    if (g.visibility === 'public' || joined) {
      lastMessage = db.prepare(
        `SELECT m.id, m.content, m.create_time, m.user_id,
                COALESCE(u.nickname, u.username) AS nickname,
                CASE WHEN m.attachments IS NOT NULL AND m.attachments != '[]' THEN 1 ELSE 0 END AS has_image
         FROM team_message m JOIN user u ON u.id = m.user_id
         WHERE m.chat_group_id = ? ORDER BY m.id DESC LIMIT 1`
      ).get(g.id) || null;
    }
    return {
      id: g.id, name: g.name, owner_id: g.owner_id,
      owner_name: owner ? (owner.real_name || owner.nickname || owner.username) : '',
      visibility: g.visibility, joined, member_count: joined || g.visibility === 'public' ? memberCount : null,
      avatar: avatarUser?.avatar || null, avatar_user_id: g.avatar_user_id || null,
      notice: joined ? (g.notice || '') : '',
      last_message: lastMessage,
    };
  });
}