// 用户公开主页（只读）：任何登录用户可查看任一用户的基本资料 + 竞赛计划 + 学习日程 + 参加的小组
// 不暴露邮箱/密码等隐私字段；数据聚合复用 auth.js /me（角色）与 teamCollab plans（计划进度）模式
import { Router } from 'express';
import db from '../db/database.js';
import { authRequired, mutedGuard, hasAdminPerm, logAudit } from './middleware.js';
import { normalizePlan } from './schedule.js';

const r = Router();

// GET /api/users/:id/public — 公开主页数据
r.get('/:id/public', authRequired, (req, res) => {
  const uid = Number(req.params.id);
  if (!Number.isInteger(uid)) return res.status(400).json({ error: 'id 非法' });
  const u = db.prepare('SELECT id, username, nickname, avatar, create_time FROM user WHERE id = ?').get(uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });

  // 参加的小组（角色聚合同 auth.js /me：team_member_role JOIN team_role，level DESC）
  const roleMap = {};
  for (const x of db.prepare(
    `SELECT tmr.team_id, tmr.user_id, tr.name AS role_name FROM team_member_role tmr
     JOIN team_role tr ON tr.id = tmr.role_id ORDER BY tr.level DESC, tr.id`
  ).all()) {
    if (x.user_id === uid) (roleMap[x.team_id] ||= []).push(x.role_name);
  }
  const teams = db.prepare(
    `SELECT t.id, t.name, t.desc, t.owner_id,
       (SELECT COUNT(*) FROM team_member tm2 WHERE tm2.team_id = t.id) AS member_count
     FROM team_member tm JOIN team t ON t.id = tm.team_id
     WHERE tm.user_id = ? ORDER BY t.create_time DESC`
  ).all(uid).map((t) => ({
    id: t.id, name: t.name, desc: t.desc, member_count: t.member_count,
    is_owner: t.owner_id === uid,
    role_names: roleMap[t.id] || [], role_name: (roleMap[t.id] || [])[0] || null,
  }));

  // 竞赛备赛计划（同 teamCollab /:id/plans 聚合：normalizePlan → done/total/phases；只查本人数据，不含匿名 'local'）
  const schedules = db.prepare(
    `SELECT s.id, s.plan_json, c.name AS comp_name, c.short_name FROM user_schedule s
     LEFT JOIN competition c ON c.id = s.comp_id WHERE s.user_id = ? ORDER BY s.create_time DESC`
  ).all(uid).map((s) => {
    const plan = normalizePlan(JSON.parse(s.plan_json || '{}'));
    const all = plan.phases.flatMap((p) => p.tasks || []);
    return {
      id: s.id, comp_name: s.comp_name || '未知竞赛', short_name: s.short_name,
      phaseCount: plan.phases.length,
      done: all.filter((t) => t.done).length, total: all.length,
      phases: plan.phases.map((p) => ({ phase: p.phase, date: p.date, done: p.tasks.filter((t) => t.done).length, total: p.tasks.length })),
    };
  });

  // 学习日程
  const studies = db.prepare(
    'SELECT id, topic, level, plan_json FROM user_study WHERE user_id = ? ORDER BY create_time DESC'
  ).all(uid).map((s) => {
    const plan = normalizePlan(JSON.parse(s.plan_json || '{}'));
    const all = plan.phases.flatMap((p) => p.tasks || []);
    return {
      id: s.id, topic: s.topic, level: s.level, phaseCount: plan.phases.length,
      done: all.filter((t) => t.done).length, total: all.length,
      phases: plan.phases.map((p) => ({ phase: p.phase, date: p.date, done: p.tasks.filter((t) => t.done).length, total: p.tasks.length })),
    };
  });

  res.json({ user: u, teams, schedules, studies });
});

// ==================== 用户主页评论（独立 profile_comment 表，无小组/帖子归属） ====================

// GET /api/users/:id/comments — 主页评论列表（登录可见，最新在前）
r.get('/:id/comments', authRequired, (req, res) => {
  const profileId = Number(req.params.id);
  if (!Number.isInteger(profileId)) return res.status(400).json({ error: 'id 非法' });
  const rows = db.prepare(
    `SELECT c.id, c.content, c.create_time, c.user_id, c.profile_id,
            u.nickname, u.username, u.avatar
     FROM profile_comment c JOIN user u ON u.id = c.user_id
     WHERE c.profile_id = ? ORDER BY c.id DESC LIMIT 100`
  ).all(profileId);
  res.json(rows);
});

// POST /api/users/:id/comments — 发表主页评论（禁言用户被 mutedGuard 拦截；不能评论自己）
r.post('/:id/comments', authRequired, mutedGuard, (req, res) => {
  const me = Number(req.user.id);
  const profileId = Number(req.params.id);
  if (!Number.isInteger(profileId)) return res.status(400).json({ error: 'id 非法' });
  const content = String(req.body?.content || '').trim();
  if (!content || content.length > 500) return res.status(400).json({ error: '评论 1-500 字' });
  const target = db.prepare('SELECT id FROM user WHERE id = ?').get(profileId);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  if (profileId === me) return res.status(400).json({ error: '不能给自己的主页评论' });
  const info = db.prepare('INSERT INTO profile_comment (profile_id, user_id, content) VALUES (?, ?, ?)')
    .run(profileId, me, content);
  const c = db.prepare(
    `SELECT c.id, c.content, c.create_time, c.user_id, c.profile_id, u.nickname, u.username, u.avatar
     FROM profile_comment c JOIN user u ON u.id = c.user_id WHERE c.id = ?`
  ).get(Number(info.lastInsertRowid));
  logAudit(req, 'comment-profile', `user#${profileId}`);
  res.json(c);
});

// DELETE /api/users/:id/comments/:cid — 删评论（评论者本人 / 主页主人 / 内容管理员）
r.delete('/:id/comments/:cid', authRequired, (req, res) => {
  const me = Number(req.user.id);
  const c = db.prepare('SELECT * FROM profile_comment WHERE id = ? AND profile_id = ?')
    .get(Number(req.params.cid), Number(req.params.id));
  if (!c) return res.status(404).json({ error: '评论不存在' });
  if (c.user_id !== me && c.profile_id !== me && !hasAdminPerm(req.user, 'content:comment')) {
    return res.status(403).json({ error: '只能删除自己的评论' });
  }
  db.prepare('DELETE FROM profile_comment WHERE id = ?').run(c.id);
  logAudit(req, 'comment-delete', `profile-comment#${c.id}`);
  res.json({ message: '已删除' });
});

export default r;
