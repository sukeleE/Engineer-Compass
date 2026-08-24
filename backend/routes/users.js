// 用户公开主页（只读）：任何登录用户可查看任一用户的基本资料 + 竞赛计划 + 学习日程 + 参加的小组
// 不暴露邮箱/密码等隐私字段；数据聚合复用 auth.js /me（角色）与 teamCollab plans（计划进度）模式
import { Router } from 'express';
import db from '../db/database.js';
import { authRequired } from './middleware.js';
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

export default r;
