// 小组接口：建组/加入/详情、自定义角色（高自由度权限）、成员管理、小组 AI 备赛计划
import { Router } from 'express';
import db from '../db/database.js';
import { authRequired, teamCtx, hasPerm, requirePerm, genInviteCode, PERM_KEYS } from './middleware.js';
import { callDeepSeek } from './ai.js';
import { findPhases } from './schedule.js';

const r = Router();
r.use(authRequired); // 以下接口全部需要登录

const DEFAULT_MEMBER_PERMS = ['progress', 'message', 'file_upload']; // 默认"组员"角色

// 某成员的角色名数组（桥表，level 降序）
const roleNamesOf = (teamId, userId) => db.prepare(
  `SELECT tr.name FROM team_member_role tmr JOIN team_role tr ON tr.id = tmr.role_id
   WHERE tmr.team_id = ? AND tmr.user_id = ? ORDER BY tr.level DESC, tr.id`
).all(teamId, userId).map((x) => x.name);

// 全组成员角色聚合：{ userId: [角色行] }（批量，避免 N+1）
const roleMapOf = (teamId) => {
  const rows = db.prepare(
    `SELECT tmr.user_id, tr.id AS role_id, tr.name AS role_name, tr.level AS role_level
     FROM team_member_role tmr JOIN team_role tr ON tr.id = tmr.role_id
     WHERE tmr.team_id = ? ORDER BY tr.level DESC, tr.id`
  ).all(teamId);
  const m = {};
  for (const rr of rows) (m[rr.user_id] ||= []).push(rr);
  return m;
};

// POST /api/team — 创建小组（组长=创建者，自动建默认"组员"角色）
// 可选 comp_id：AI 按竞赛智能拆分部门（team_role）并生成备赛计划（team_plan）；AI 失败时用子赛项模板兜底
r.post('/', async (req, res) => {
  const { name, desc, comp_id } = req.body || {};
  const tname = String(name || '').trim();
  if (!tname) return res.status(400).json({ error: '小组名称必填' });
  if (tname.length > 30) return res.status(400).json({ error: '小组名称过长（≤30字）' });

  let invite = genInviteCode();
  while (db.prepare('SELECT id FROM team WHERE invite_code = ?').get(invite)) invite = genInviteCode();
  let teamId;
  db.exec('BEGIN');
  try {
    const t = db.prepare('INSERT INTO team (name, desc, invite_code, owner_id) VALUES (?,?,?,?)')
      .run(tname, (desc || '').trim() || null, invite, req.user.id);
    teamId = Number(t.lastInsertRowid);
    // 默认组员角色
    db.prepare('INSERT INTO team_role (team_id, name, level, permissions) VALUES (?,?,?,?)')
      .run(teamId, '组员', 0, JSON.stringify(DEFAULT_MEMBER_PERMS));
    // 组长入组（role_id NULL = 组长身份，恒全权限）
    db.prepare('INSERT INTO team_member (team_id, user_id, role_id) VALUES (?,?,NULL)')
      .run(teamId, req.user.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // —— AI 智能拆解（部门 + 备赛计划）——
  const aiDepts = []; // 新部门角色 [{id, name}]
  let plan = null, template = false;
  const comp = comp_id ? db.prepare('SELECT * FROM competition WHERE id = ? AND status = ?').get(Number(comp_id), 'active') : null;
  if (comp) {
    try {
      const now = new Date();
      const system = `你是工科竞赛团队组建顾问，为竞赛小组设计部门与备赛计划。
竞赛名称:${comp.name}
子赛项:${comp.national_time || comp.timeline_raw || '以官网为准'}
官方比赛时间:${comp.national_time || comp.timeline_raw || '以官网为准'}
当前日期:${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}
要求输出严格 JSON，禁止多余文字，顶级键两个：
1. departments 数组，建议 3-6 个部门，每项 {"name": "部门名", "duty": "职责"}
2. phases 数组，每阶段含 阶段名称、起止日期、任务清单、本阶段硬性达标要求、每周最低学习时长。
   任务每项为对象 {"text": "任务描述", "dept": "部门名"}，dept 必须从 departments 中选；公共任务 dept 用"通用"。
   同一阶段任务按部门拆分、多部门并行推进。`;
      const raw = await callDeepSeek([
        { role: 'system', content: system },
        { role: 'user', content: `为「${comp.name}」设计小组部门分工与备赛计划` },
      ]);
      const parsed = JSON.parse(raw.replace(/^```json\s*|```$/g, '').trim());
      const depts = (parsed.departments || []).map((d) => ({
        name: String(d.name || d.部门名 || '').trim(), duty: String(d.duty || d.职责 || '').trim(),
      })).filter((d) => d.name);
      if (!depts.length) throw new Error('AI 未返回部门');

      // 建部门角色（level 递增，默认组员权限 —— 部门成员可汇报进度/讨论/传资料）
      for (let i = 0; i < depts.length; i++) {
        const rr = db.prepare('INSERT INTO team_role (team_id, name, level, permissions) VALUES (?,?,?,?)')
          .run(teamId, depts[i].name, i + 1, JSON.stringify(DEFAULT_MEMBER_PERMS));
        aiDepts.push({ id: rr.lastInsertRowid, name: depts[i].name });
      }
      // 按新部门生成备赛计划
      const norm = normTeamPlan(parsed, aiDepts);
      if (!norm.phases.length) throw new Error('AI 未返回阶段');
      const planJson = { comp_id: comp.id, comp_name: comp.name, ...norm };
      const rr = db.prepare('INSERT INTO team_plan (team_id, comp_id, title, plan_json) VALUES (?,?,?,?)')
        .run(teamId, comp.id, comp.name, JSON.stringify(planJson));
      plan = { id: rr.lastInsertRowid, plan: planJson };
    } catch {
      // 兜底：模板计划（任务 dept=通用，不建部门）
      const tpl = normTeamPlan(teamTemplatePlan(comp), []);
      tpl.template = true;
      const rr = db.prepare('INSERT INTO team_plan (team_id, comp_id, title, plan_json) VALUES (?,?,?,?)')
        .run(teamId, comp.id, comp.name, JSON.stringify({ comp_id: comp.id, comp_name: comp.name, ...tpl }));
      plan = { id: rr.lastInsertRowid, plan: { ...tpl, comp_name: comp.name } };
      template = true;
    }
  }

  const roles = [
    { id: db.prepare('SELECT id FROM team_role WHERE team_id = ? AND name = ?').get(teamId, '组员').id, name: '组员', level: 0, permissions: DEFAULT_MEMBER_PERMS },
    ...aiDepts.map((d) => ({ id: d.id, name: d.name, level: aiDepts.indexOf(d) + 1, permissions: DEFAULT_MEMBER_PERMS })),
  ];
  res.status(201).json({
    id: teamId, name: tname, invite_code: invite, owner_id: req.user.id,
    roles, ai_depts: aiDepts.map((d) => d.name), plan_id: plan?.id ?? null, template,
  });
});

// POST /api/team/join — 邀请码加入
r.post('/join', (req, res) => {
  const code = String((req.body || {}).invite_code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: '邀请码必填' });
  const team = db.prepare('SELECT * FROM team WHERE invite_code = ?').get(code);
  if (!team) return res.status(404).json({ error: '邀请码无效' });
  const exists = db.prepare('SELECT id FROM team_member WHERE team_id = ? AND user_id = ?').get(team.id, req.user.id);
  if (exists) return res.status(409).json({ error: '你已在该小组中' });
  const defaultRole = db.prepare("SELECT id FROM team_role WHERE team_id = ? AND name = '组员' ORDER BY level LIMIT 1").get(team.id);
  db.prepare('INSERT INTO team_member (team_id, user_id, role_id) VALUES (?,?,NULL)')
    .run(team.id, req.user.id);
  if (defaultRole) db.prepare('INSERT INTO team_member_role (team_id, user_id, role_id) VALUES (?,?,?)')
    .run(team.id, req.user.id, defaultRole.id);
  res.status(201).json({ id: team.id, name: team.name, message: `已加入「${team.name}」` });
});

// GET /api/team/my-tasks — 我的小组任务（个人日程页聚合：我所有小组的完整备赛计划，与小组页同一份 plan_json）
// 返回全部部门任务（含 dept/done/done_by）与原始 phase_idx/task_idx（前端回写定位用）；
// 勾选限权由前端按 role_name/is_owner 禁用、后端 POST plan/:pid/task 强制校验（越权 403）
// ⚠️ 必须注册在 GET /:id 之前，否则 'my-tasks' 会被 :id 吞掉
r.get('/my-tasks', (req, res) => {
  const myTeams = db.prepare(
    `SELECT t.id AS team_id, t.name AS team_name, t.owner_id
     FROM team_member tm JOIN team t ON t.id = tm.team_id
     WHERE tm.user_id = ? ORDER BY t.create_time DESC`
  ).all(req.user.id);
  const out = [];
  for (const mt of myTeams) {
    const rows = db.prepare('SELECT id, title, plan_json, update_time FROM team_plan WHERE team_id = ? ORDER BY update_time DESC').all(mt.team_id);
    const plans = [];
    for (const row of rows) {
      let plan;
      try { plan = JSON.parse(row.plan_json || '{}'); } catch { continue; }
      const phases = (plan.phases || []).map((ph, pi) => ({
        phase: ph.phase || '备赛阶段',
        date: ph.date || '',
        phase_idx: pi,
        tasks: (ph.tasks || []).map((t, ti) => ({
          text: t.text, done: !!t.done, dept: t.dept || '通用',
          done_by: t.done_by || null, done_at: t.done_at || null, task_idx: ti,
        })),
      }));
      if (phases.length) plans.push({ id: row.id, title: row.title, comp_name: plan.comp_name || null, update_time: row.update_time, phases });
    }
    if (plans.length) {
      const myRoles = roleNamesOf(mt.team_id, req.user.id);
      out.push({ team_id: mt.team_id, team_name: mt.team_name, role_name: myRoles[0] || null, role_names: myRoles, is_owner: mt.owner_id === req.user.id, plans });
    }
  }
  res.json(out);
});

// GET /api/team/:id — 组详情（成员+角色+统计）
r.get('/:id', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx) return res.status(404).json({ error: '小组不存在' });
  if (!ctx.member) return res.status(403).json({ error: '不是小组成员' });

  const roleMap = roleMapOf(ctx.team.id);
  const members = db.prepare(
    `SELECT u.id, u.username, u.nickname, u.avatar, tm.join_time
     FROM team_member tm JOIN user u ON u.id = tm.user_id
     WHERE tm.team_id = ? ORDER BY tm.join_time`
  ).all(ctx.team.id).map((m) => {
    const rs = roleMap[m.id] || [];
    return {
      ...m,
      role_id: rs[0]?.role_id ?? null, role_name: rs[0]?.role_name ?? null, role_level: rs[0]?.role_level ?? null,
      role_ids: rs.map((x) => x.role_id), role_names: rs.map((x) => x.role_name),
      is_owner: m.id === ctx.team.owner_id, is_me: m.id === req.user.id,
    };
  }).sort((a, b) => (b.is_owner - a.is_owner) || ((b.role_level ?? -1) - (a.role_level ?? -1)) || (a.join_time < b.join_time ? -1 : 1));

  const roles = db.prepare('SELECT id, name, level, permissions FROM team_role WHERE team_id = ? ORDER BY level DESC, id').all(ctx.team.id)
    .map((r2) => ({ ...r2, permissions: JSON.parse(r2.permissions || '[]') }));

  const tasks = db.prepare(
    `SELECT t.*, u.nickname AS assignee_name FROM team_task t LEFT JOIN user u ON u.id = t.assignee_id
     WHERE t.team_id = ? ORDER BY t.deadline, t.id`
  ).all(ctx.team.id);

  const devices = db.prepare(
    `SELECT d.*, (SELECT COUNT(*) FROM device_booking b WHERE b.device_id = d.id AND b.status = 'approved'
       AND b.start_time <= datetime('now','localtime') AND b.end_time > datetime('now','localtime')) AS in_use
     FROM team_device d WHERE d.team_id = ? ORDER BY d.id`
  ).all(ctx.team.id);

  res.json({
    team: ctx.team,
    me: {
      user_id: req.user.id, is_owner: ctx.isOwner,
      role: ctx.role ? { id: ctx.role.id, name: ctx.role.name, level: ctx.role.level, permissions: JSON.parse(ctx.role.permissions || '[]') } : null,
      roles: ctx.roles.map((r2) => ({ id: r2.id, name: r2.name, level: r2.level, permissions: JSON.parse(r2.permissions || '[]') })),
    },
    perms: {
      task: hasPerm(ctx, 'task'), progress: hasPerm(ctx, 'progress'), message: hasPerm(ctx, 'message'),
      file_upload: hasPerm(ctx, 'file_upload'), file_delete: hasPerm(ctx, 'file_delete'),
      device: hasPerm(ctx, 'device'), device_approve: hasPerm(ctx, 'device_approve'),
      member: hasPerm(ctx, 'member'), role: hasPerm(ctx, 'role'), team: hasPerm(ctx, 'team'),
    },
    members, roles, tasks, devices,
  });
});

// PUT /api/team/:id — 小组设置（改名/介绍）
r.put('/:id', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  const deny = requirePerm(ctx, res, 'team');
  if (deny) return deny;
  const { name, desc } = req.body || {};
  if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: '名称不能为空' });
  db.prepare('UPDATE team SET name = ?, desc = ? WHERE id = ?')
    .run(name !== undefined ? String(name).trim() : ctx.team.name, desc !== undefined ? (desc || '').trim() : ctx.team.desc, ctx.team.id);
  res.json({ message: '已更新' });
});

// GET /api/team/:id/invite — 邀请码（member 权限即可，方便拉人）
r.get('/:id/invite', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  res.json({ invite_code: ctx.team.invite_code });
});

// POST /api/team/:id/role — 创建/更新自定义角色（role 权限）
r.post('/:id/role', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  const deny = requirePerm(ctx, res, 'role');
  if (deny) return deny;
  const { name, level, permissions, id } = req.body || {};
  const rname = String(name || '').trim();
  if (!rname) return res.status(400).json({ error: '角色名必填' });
  const perms = Array.isArray(permissions) ? permissions.filter((p) => PERM_KEYS[p]) : [];
  const lv = Math.max(0, Math.min(100, Number(level) || 0));

  if (id) { // 更新
    const role = db.prepare('SELECT * FROM team_role WHERE id = ? AND team_id = ?').get(id, ctx.team.id);
    if (!role) return res.status(404).json({ error: '角色不存在' });
    db.prepare('UPDATE team_role SET name = ?, level = ?, permissions = ? WHERE id = ?')
      .run(rname, lv, JSON.stringify(perms), id);
    res.json({ id, name: rname, level: lv, permissions: perms });
  } else { // 新建
    const dup = db.prepare('SELECT id FROM team_role WHERE team_id = ? AND name = ?').get(ctx.team.id, rname);
    if (dup) return res.status(409).json({ error: '角色名已存在' });
    const rr = db.prepare('INSERT INTO team_role (team_id, name, level, permissions) VALUES (?,?,?,?)')
      .run(ctx.team.id, rname, lv, JSON.stringify(perms));
    res.status(201).json({ id: rr.lastInsertRowid, name: rname, level: lv, permissions: perms });
  }
});

// DELETE /api/team/:id/role/:rid — 删除角色（role 权限；引用该角色的成员降为无角色）
r.delete('/:id/role/:rid', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  const deny = requirePerm(ctx, res, 'role');
  if (deny) return deny;
  const role = db.prepare('SELECT * FROM team_role WHERE id = ? AND team_id = ?').get(Number(req.params.rid), ctx.team.id);
  if (!role) return res.status(404).json({ error: '角色不存在' });
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM team_member_role WHERE team_id = ? AND role_id = ?').run(ctx.team.id, role.id);
    db.prepare('UPDATE team_member SET role_id = NULL WHERE team_id = ? AND role_id = ?').run(ctx.team.id, role.id);
    db.prepare('DELETE FROM team_role WHERE id = ?').run(role.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ message: `已删除角色「${role.name}」` });
});

// 校验角色 id 列表都属于本组且 ≤3 个（返回规范化后的数组，非法返回 null + 响应已发出）
function checkRoleIds(ctx, res, ids) {
  if (ids.length > 3) { res.status(400).json({ error: '每个成员最多 3 个角色' }); return null; }
  for (const rid of [...new Set(ids)]) {
    if (!db.prepare('SELECT id FROM team_role WHERE id = ? AND team_id = ?').get(rid, ctx.team.id)) {
      res.status(404).json({ error: '角色不存在' }); return null;
    }
  }
  return [...new Set(ids)];
}

// POST /api/team/:id/member — 调整成员角色（member 权限；role_ids 数组替换全部角色，兼容旧 role_id 单值）
r.post('/:id/member', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  const deny = requirePerm(ctx, res, 'member');
  if (deny) return deny;
  const { user_id, role_ids, role_id } = req.body || {};
  const target = db.prepare('SELECT * FROM team_member WHERE team_id = ? AND user_id = ?').get(ctx.team.id, Number(user_id));
  if (!target) return res.status(404).json({ error: '成员不存在' });
  if (Number(user_id) === ctx.team.owner_id) return res.status(400).json({ error: '不能修改组长的角色' });
  const ids = checkRoleIds(ctx, res, Array.isArray(role_ids) ? role_ids.map(Number) : (role_id != null ? [Number(role_id)] : []));
  if (!ids) return;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM team_member_role WHERE team_id = ? AND user_id = ?').run(ctx.team.id, target.user_id);
    for (const rid of ids) db.prepare('INSERT INTO team_member_role (team_id, user_id, role_id) VALUES (?,?,?)').run(ctx.team.id, target.user_id, rid);
    db.prepare('UPDATE team_member SET role_id = ? WHERE id = ?').run(ids[0] ?? null, target.id); // 旧字段同步首角色
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ message: '已更新成员角色' });
});

// POST /api/team/:id/member/self-role — 成员自选角色（≤3，仅限自己；组长无需自选）
r.post('/:id/member/self-role', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  if (ctx.isOwner) return res.status(400).json({ error: '组长无需自选角色' });
  const { role_ids } = req.body || {};
  const ids = checkRoleIds(ctx, res, Array.isArray(role_ids) ? role_ids.map(Number) : []);
  if (!ids) return;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM team_member_role WHERE team_id = ? AND user_id = ?').run(ctx.team.id, req.user.id);
    for (const rid of ids) db.prepare('INSERT INTO team_member_role (team_id, user_id, role_id) VALUES (?,?,?)').run(ctx.team.id, req.user.id, rid);
    db.prepare('UPDATE team_member SET role_id = ? WHERE team_id = ? AND user_id = ?').run(ids[0] ?? null, ctx.team.id, req.user.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ message: '已更新我的角色' });
});

// DELETE /api/team/:id/member/:uid — 移除成员（member 权限；组长不可被移除）
r.delete('/:id/member/:uid', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  const deny = requirePerm(ctx, res, 'member');
  if (deny) return deny;
  const uid = Number(req.params.uid);
  if (uid === ctx.team.owner_id) return res.status(400).json({ error: '不能移除组长' });
  const r2 = db.prepare('DELETE FROM team_member WHERE team_id = ? AND user_id = ?').run(ctx.team.id, uid);
  if (r2.changes === 0) return res.status(404).json({ error: '成员不存在' });
  res.json({ message: '已移除成员' });
});

// POST /api/team/:id/transfer — 转让组长（组长本人）
r.post('/:id/transfer', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx) return res.status(404).json({ error: '小组不存在' });
  if (!ctx.isOwner) return res.status(403).json({ error: '仅组长可转让' });
  const { user_id } = req.body || {};
  const target = db.prepare('SELECT * FROM team_member WHERE team_id = ? AND user_id = ?').get(ctx.team.id, Number(user_id));
  if (!target) return res.status(404).json({ error: '目标成员不存在' });
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE team SET owner_id = ? WHERE id = ?').run(Number(user_id), ctx.team.id);
    // 新旧组长角色清理（桥表 + 旧字段同步）
    db.prepare('DELETE FROM team_member_role WHERE team_id = ? AND user_id = ?').run(ctx.team.id, Number(user_id));
    db.prepare('DELETE FROM team_member_role WHERE team_id = ? AND user_id = ?').run(ctx.team.id, ctx.team.owner_id);
    db.prepare('UPDATE team_member SET role_id = NULL WHERE team_id = ? AND user_id = ?').run(ctx.team.id, Number(user_id));
    db.prepare('UPDATE team_member SET role_id = NULL WHERE team_id = ? AND user_id = ?').run(ctx.team.id, ctx.team.owner_id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ message: '已转让组长' });
});

// DELETE /api/team/:id — 解散小组（组长）
r.delete('/:id', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx) return res.status(404).json({ error: '小组不存在' });
  if (!ctx.isOwner) return res.status(403).json({ error: '仅组长可解散小组' });
  db.prepare('DELETE FROM team WHERE id = ?').run(ctx.team.id);
  res.json({ message: '小组已解散' });
});

// ========== 小组 AI 备赛计划（部门拆分 / 任务分配 / 组长修改 / 全员跟进） ==========
// plan_json: { comp_id, comp_name, phases:[{phase,date,check_standard,week_hours,tasks:[{text,done,dept,role_id}]}] }
// dept=部门（角色名），role_id=对应 team_role id（角色删除后 dept 名仍可展示）
const canEditPlan = (ctx) => ctx.isOwner || hasPerm(ctx, 'team');

// 归一化：任意 AI 结构 → 统一 phases（任务带 dept/role_id；dept 匹配不到角色 → '通用'）
function normTeamPlan(plan, roles) {
  const phases = findPhases(plan).map((ph) => ({
    phase: ph.phase || ph.阶段名称 || '备赛阶段',
    date: ph.date || ph.起止日期 || '',
    check_standard: ph.check_standard || ph.达标要求 || '',
    week_hours: ph.week_hours || 0,
    tasks: (ph.tasks || ph.任务清单 || []).map((t) => {
      const raw = typeof t === 'string' ? { text: t } : t || {};
      const text = String(raw.text ?? raw.任务名称 ?? '').trim();
      if (!text) return null;
      const dept = String(raw.dept || raw.部门 || '').trim();
      const role = roles.find((x) => x.name === dept);
      // done_by 必须保留（老任务无该字段 → null），否则组长编辑保存会抹掉完成人
      return { text, done: !!raw.done, dept: role ? role.name : (dept || '通用'), role_id: role?.id ?? null, done_by: raw.done_by || null };
    }).filter(Boolean),
  })).filter((p) => p.tasks.length);
  return { phases };
}

// 兜底模板：无 DeepSeek key / AI 结构异常 → 子赛项生成基础计划（任务标记通用）
function teamTemplatePlan(comp) {
  const subs = db.prepare('SELECT phase_name, check_standard FROM competition_process WHERE comp_id = ? ORDER BY sub_event_order').all(comp.id);
  return {
    phases: subs.map((s, i) => ({
      phase: s.phase_name,
      date: comp.start_month ? `${comp.start_month}月` : '',
      tasks: [
        { text: '熟悉规则与往届作品', dept: '通用' },
        { text: '按达标要求逐项练习', dept: '通用' },
      ],
      check_standard: s.check_standard,
      week_hours: 10,
      order: i + 1,
    })),
  };
}

// GET /api/team/:id/plan — 小组备赛计划列表（成员可见）
r.get('/:id/plan', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const rows = db.prepare('SELECT * FROM team_plan WHERE team_id = ? ORDER BY update_time DESC').all(ctx.team.id);
  res.json(rows.map((row) => ({ ...row, plan: JSON.parse(row.plan_json || '{}') })));
});

// POST /api/team/:id/plan/generate — AI 按小组部门拆分生成备赛计划（组长/小组设置权限）
r.post('/:id/plan/generate', async (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  if (!canEditPlan(ctx)) return res.status(403).json({ error: '仅组长可生成小组计划' });
  const { comp_id } = req.body || {};
  const comp = db.prepare('SELECT * FROM competition WHERE id = ? AND status = ?').get(Number(comp_id), 'active');
  if (!comp) return res.status(404).json({ error: '竞赛不存在或未转正' });

  const roles = db.prepare('SELECT id, name FROM team_role WHERE team_id = ? ORDER BY level DESC, id').all(ctx.team.id);
  const roleNames = roles.map((x) => x.name);

  let plan;
  try {
    const now = new Date();
    const system = `你是工科竞赛备赛规划师，为团队制定分工计划。
竞赛名称:${comp.name}
当前日期:${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}
官方比赛时间:${comp.national_time || comp.timeline_raw || '以官网为准'}
团队部门:${roleNames.join('、') || '（未设置部门，任务标记为通用）'}
要求：
1. 输出严格 JSON：顶级键 phases（数组），每阶段含 阶段名称、起止日期、任务清单、本阶段硬性达标要求、每周最低学习时长。
2. 任务清单每项为对象 {"text": "任务描述", "dept": "部门名"}，dept 必须从团队部门中选；公共任务 dept 用"通用"。
3. 同一阶段任务按部门拆分、多部门并行推进，避免单人串行依赖。
禁止多余文字，直接返回json。`;
    const raw = await callDeepSeek([
      { role: 'system', content: system },
      { role: 'user', content: `为「${comp.name}」制定团队备赛计划，按部门拆分任务` },
    ]);
    const parsed = JSON.parse(raw.replace(/^```json\s*|```$/g, '').trim());
    plan = normTeamPlan(parsed, roles);
    if (!plan.phases.length) throw new Error('AI 返回结构异常（无阶段数据）');
  } catch {
    plan = normTeamPlan(teamTemplatePlan(comp), roles);
    plan.template = true; // 兜底模板标记（前端提示「无 AI 服务，已用模板」）
  }
  const planJson = { comp_id: comp.id, comp_name: comp.name, ...plan };
  const rr = db.prepare('INSERT INTO team_plan (team_id, comp_id, title, plan_json) VALUES (?,?,?,?)')
    .run(ctx.team.id, comp.id, comp.name, JSON.stringify(planJson));
  res.status(201).json({ id: rr.lastInsertRowid, title: comp.name, template: !!plan.template, plan: planJson });
});

// POST /api/team/:id/plan — 新建/保存小组计划（组长/小组设置权限；任务级勾选走 :pid/task）
r.post('/:id/plan', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  if (!canEditPlan(ctx)) return res.status(403).json({ error: '仅组长可修改小组计划' });
  const { id, title, plan_json, comp_id } = req.body || {};
  if (!plan_json || typeof plan_json !== 'object') return res.status(400).json({ error: 'plan_json 必填（计划对象）' });
  const roles = db.prepare('SELECT id, name FROM team_role WHERE team_id = ?').all(ctx.team.id);
  const norm = normTeamPlan(plan_json, roles);
  if (!norm.phases.length) return res.status(400).json({ error: '计划至少包含一个阶段和任务' });
  const t = String(title || '').trim();

  if (id) {
    const p = db.prepare('SELECT * FROM team_plan WHERE id = ? AND team_id = ?').get(Number(id), ctx.team.id);
    if (!p) return res.status(404).json({ error: '计划不存在' });
    const merged = { ...JSON.parse(p.plan_json || '{}'), ...norm };
    db.prepare('UPDATE team_plan SET title = ?, plan_json = ?, comp_id = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?')
      .run(t || p.title, JSON.stringify(merged), comp_id ? Number(comp_id) : p.comp_id, p.id);
    return res.json({ id: p.id, message: '已保存' });
  }
  const rr = db.prepare('INSERT INTO team_plan (team_id, comp_id, title, plan_json) VALUES (?,?,?,?)')
    .run(ctx.team.id, comp_id ? Number(comp_id) : null, t || '小组备赛计划', JSON.stringify({ ...norm, comp_id: comp_id ? Number(comp_id) : null }));
  res.status(201).json({ id: rr.lastInsertRowid, message: '已创建' });
});

// POST /api/team/:id/plan/:pid/task — 勾选任务（本部门成员勾本部门任务；通用任务全员；组长/小组设置权限可勾一切）
// 勾选记录完成人 done_by（取消勾选清空）——与个人日程页共用此接口，天然双向同步
r.post('/:id/plan/:pid/task', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  const { phase_idx, task_idx, done } = req.body || {};
  const p = db.prepare('SELECT * FROM team_plan WHERE id = ? AND team_id = ?').get(Number(req.params.pid), ctx.team.id);
  if (!p) return res.status(404).json({ error: '计划不存在' });
  const plan = JSON.parse(p.plan_json || '{}');
  const task = plan.phases?.[Number(phase_idx)]?.tasks?.[Number(task_idx)];
  if (!task) return res.status(400).json({ error: '任务不存在' });
  // 部门限权：dept 为空按通用；组长（is_owner）或「小组设置」权限可勾任何任务
  const dept = task.dept || '通用';
  const allowed = canEditPlan(ctx) || dept === '通用' || ctx.roles.some((rr) => rr.name === dept);
  if (!allowed) return res.status(403).json({ error: `仅「${dept}」成员可勾选该任务` });
  task.done = !!done;
  task.done_by = task.done ? (req.user.nickname || req.user.username) : null;
  // 完成日期（本地时区 YYYY-MM-DD）：月历视图按完成日聚合；取消勾选清空
  const d = new Date();
  task.done_at = task.done ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null;
  db.prepare('UPDATE team_plan SET plan_json = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?')
    .run(JSON.stringify(plan), p.id);
  res.json({ phase_idx: Number(phase_idx), task_idx: Number(task_idx), done: task.done, done_by: task.done_by, done_at: task.done_at, message: '已更新' });
});

// DELETE /api/team/:id/plan/:pid — 删除小组计划（组长/小组设置权限）
r.delete('/:id/plan/:pid', (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
  if (!canEditPlan(ctx)) return res.status(403).json({ error: '仅组长可删除小组计划' });
  const r2 = db.prepare('DELETE FROM team_plan WHERE id = ? AND team_id = ?').run(Number(req.params.pid), ctx.team.id);
  if (r2.changes === 0) return res.status(404).json({ error: '计划不存在' });
  res.json({ message: '已删除' });
});

// ========== AI 智能分组（成员与角色页）：按成员信息+部门+竞赛建议分组 ==========
// 仅返回建议（assignments），不写入；前端确认后逐个调用 POST /:id/member 应用（member 权限）
r.post('/:id/ai-grouping', async (req, res) => {
  const ctx = teamCtx(Number(req.params.id), req.user.id);
  const deny = requirePerm(ctx, res, 'member');
  if (deny) return deny;

  const members = db.prepare(
    `SELECT u.id, u.nickname, u.username
     FROM team_member tm JOIN user u ON u.id = tm.user_id
     WHERE tm.team_id = ? AND u.id <> ?` // 组长不可被改角色，不参与分组
  ).all(ctx.team.id, ctx.team.owner_id);
  const memberRoles = roleMapOf(ctx.team.id); // user_id → [{role_id,role_name,role_level}]
  for (const m of members) m.role_names = (memberRoles[m.id] || []).map((x) => x.role_name);
  const roles = db.prepare(`SELECT id, name FROM team_role WHERE team_id = ? AND name <> '组员' ORDER BY level DESC, id`).all(ctx.team.id);
  if (!members.length) return res.json({ message: '暂无其他成员', assignments: [] });
  if (!roles.length) return res.json({ message: '还没有部门角色，先创建部门（如：机械组/电控组/软件组）', assignments: [] });

  const compName = db.prepare(`SELECT plan_json FROM team_plan WHERE team_id = ? ORDER BY update_time DESC LIMIT 1`)
    .get(ctx.team.id)?.plan_json || '';
  const compTitle = (() => { try { return JSON.parse(compName).comp_name; } catch { return ''; } })();

  let assignments = [];
  try {
    const system = `你是竞赛小组管理助手，为成员智能分组。
竞赛:${compTitle || '（未关联具体竞赛）'}
部门:${roles.map((x) => x.name).join('、')}
成员:${JSON.stringify(members.map((m) => ({ user_id: m.id, nickname: m.nickname || m.username, current_role: (m.role_names || []).join('、') || '无' })))}
要求输出严格 JSON：{"assignments":[{"user_id":12,"role_name":"机械组"}]}，role_name 必须从部门中选择。
根据成员昵称/当前角色判断最合适部门；无法判断时归入最贴近的部门；不要遗漏任何成员。禁止多余文字。`;
    const raw = await callDeepSeek([{ role: 'system', content: system }, { role: 'user', content: '请给出分组建议' }]);
    const parsed = JSON.parse(raw.replace(/^```json\s*|```$/g, '').trim());
    const suggest = Array.isArray(parsed.assignments) ? parsed.assignments : [];
    for (const a of suggest) {
      const m = members.find((x) => x.id === Number(a.user_id));
      const role = roles.find((x) => x.name === String(a.role_name || '').trim());
      if (m && role && !m.suggested) {
        m.suggested = true;
        assignments.push({ user_id: m.id, nickname: m.nickname || m.username, current_role: (m.role_names || []).join('、') || '无', suggest_role: role.name, suggest_role_id: role.id });
      }
    }
    // 补漏：AI 遗漏的成员 → 不强制分配（交给前端展示）
  } catch {
    return res.json({ message: 'AI 服务不可用，无法生成分组建议', assignments: [] });
  }

  if (!assignments.length) return res.json({ message: 'AI 未给出有效分组建议，请稍后再试', assignments: [] });
  res.json({ message: `AI 建议将 ${assignments.length} 名成员分组`, assignments });
});

export default r;
