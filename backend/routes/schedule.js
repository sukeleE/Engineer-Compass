// 日程接口：AI 生成备赛计划 / 手动编辑 / 导出
import { Router } from 'express';
import db from '../db/database.js';
import { callDeepSeek } from './ai.js';
import { optionalAuth, logAudit } from './middleware.js';

const r = Router();

// 兜底方案：无 AI key 时用子赛项表生成基础计划
function templatePlan(compId) {
  const comp = db.prepare('SELECT id, name, short_name, start_month FROM competition WHERE id = ?').get(compId);
  const subs = db.prepare('SELECT phase_name, check_standard FROM competition_process WHERE comp_id = ? ORDER BY sub_event_order').all(compId);
  return {
    comp_id: compId,
    comp_name: comp?.name,
    note: '基础模板计划（未配置 DeepSeek），AI 计划可用 .env 配置 DEEPSEEK_API_KEY 后重新生成',
    phases: subs.map((s, i) => ({
      phase: s.phase_name,
      date: comp?.start_month ? `${comp.start_month}月` : '',
      tasks: ['熟悉规则与往届作品', '按达标要求逐项练习'].map((t) => ({ text: t, done: false })),
      check_standard: s.check_standard,
      week_hours: 10,
      order: i + 1,
    })),
  };
}

// AI 生成个性化备赛计划（Prompt1）
async function aiPlan(comp) {
  const now = new Date();
  const system = `你是工科竞赛规划师。
竞赛名称:${comp.name}
当前日期:${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}
官方比赛时间:${comp.national_time || comp.timeline_raw || '以官网为准'}
用户基础水平:默认大二工科、掌握C语言，无项目经验
输出严格JSON格式，分为多个备赛阶段。JSON 顶级键必须是 phases（数组），每阶段包含：阶段名称、起止日期、任务清单（字符串数组）、本阶段硬性达标要求、推荐技术学习内容、每周最低学习时长。
禁止多余文字，直接返回json。`;
  const raw = await callDeepSeek([
    { role: 'system', content: system },
    { role: 'user', content: `为${comp.name}生成备赛计划` },
  ]);
  return JSON.parse(raw.replace(/^```json\s*|```$/g, '').trim());
}

// 从任意 AI 返回结构中找出阶段数组（兼容 phases / stages / plan / 顶级数组等）
// 注意：取第一个「非空」数组——历史数据可能存在 phases:[] 而实际数据在 stages 的情况
export function findPhases(plan) {
  if (Array.isArray(plan)) return plan;
  if (!plan || typeof plan !== 'object') return [];
  const candidates = [plan.phases, plan.stages, plan.阶段, plan.plan, plan.plan?.phases];
  for (const c of candidates) if (Array.isArray(c) && c.length) return c;
  return [];
}

// 归一化：任意来源的 plan → 统一结构 phases: [{phase, date, tasks:[{text,done}], check_standard, week_hours}]
export function normalizePlan(plan) {
  return {
    ...plan,
    phases: findPhases(plan).map((ph) => ({
      phase: ph.phase || ph.阶段名称 || ph.stage_name || '备赛阶段',
      date: ph.date || ph.起止日期 || (ph.start_date ? (ph.end_date ? `${ph.start_date} ~ ${ph.end_date}` : ph.start_date) : ''),
      tasks: (ph.tasks || ph.任务清单 || []).map((t) => {
        // 对象任务保留 dept/done_by（小组计划任务带部门分工，AI 生成的 dept 不能丢；undefined 字段序列化时自动省略）
        if (typeof t === 'string') return { text: t, done: false };
        const o = t || {};
        return { text: o.text ?? o.任务名称 ?? String(o), done: !!o.done, done_at: o.done_at || null, dept: o.dept ?? o.部门, done_by: o.done_by };
      }),
      check_standard: ph.check_standard || ph.达标要求 || '',
      week_hours: ph.week_hours || ph.每周学习时长 || ph.每周最低学习时长 || 0,
    })),
  };
}

// POST /api/schedule/add — 为某竞赛生成备赛日程
// 登录用户生成的计划绑定 user_id（小组计划同步可见）；匿名保持 'local' 标识
r.post('/add', optionalAuth, async (req, res) => {
  const { comp_id, user_id = 'local' } = req.body || {};
  if (!comp_id) return res.status(400).json({ error: 'comp_id 必填' });
  const uid = req.user ? req.user.id : user_id;
  const comp = db.prepare('SELECT * FROM competition WHERE id = ? AND status = ?').get(Number(comp_id), 'active');
  if (!comp) return res.status(404).json({ error: '竞赛不存在或未转正' });

  let plan;
  try {
    plan = normalizePlan(await aiPlan(comp));
    if (!plan.phases.length) throw new Error('AI 返回结构异常（无阶段数据）');
  } catch (err) {
    plan = normalizePlan(templatePlan(comp.id)); // AI 不可用/结构异常时降级为模板计划
  }
  const r2 = db.prepare(
    'INSERT INTO user_schedule (comp_id, user_id, is_custom, plan_json) VALUES (?,?,0,?)'
  ).run(comp.id, uid, JSON.stringify(plan));
  logAudit(req, 'plan-create', comp.name);
  res.status(201).json({ id: r2.lastInsertRowid, plan, note: plan.note });
});

// POST /api/schedule/:id/optimize — AI 优化现有计划（保留已完成勾选）
r.post('/:id/optimize', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 非法' });
  const row = db.prepare('SELECT * FROM user_schedule WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '日程不存在' });

  const cur = normalizePlan(JSON.parse(row.plan_json || '{}'));
  const comp = db.prepare('SELECT * FROM competition WHERE id = ?').get(row.comp_id);
  // 完成情况摘要
  const progress = cur.phases.map((ph) => {
    const done = ph.tasks.filter((t) => t.done).length;
    return `${ph.phase}（${done}/${ph.tasks.length}）`;
  });

  const now = new Date();
  const system = `你是工科竞赛规划师。
竞赛名称:${comp?.name || '未知'}
当前日期:${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}
官方比赛时间:${comp?.national_time || comp?.timeline_raw || '以官网为准'}
用户现有备赛计划已完成情况（阶段/完成度）:
${progress.join('\n') || '（全部未开始）'}
要求：基于当前进度输出优化版备赛计划——压缩已完成阶段、聚焦剩余任务、补足薄弱环节，起止日期从当前日期起排。输出严格JSON：phases 数组，每阶段含 阶段名称、起止日期、任务清单(字符串数组)、本阶段硬性达标要求、每周最低学习时长。禁止多余文字，直接返回json。`;
  try {
    const raw = await callDeepSeek([
      { role: 'system', content: system },
      { role: 'user', content: `优化「${comp?.name || ''}」备赛计划` },
    ]);
    const fresh = normalizePlan(JSON.parse(raw.replace(/^```json\s*|```$/g, '').trim()));
    if (!fresh.phases.length) throw new Error('AI 返回结构异常（无阶段数据）');
    // 保留已勾选任务：按任务文本匹配
    const doneSet = new Set(cur.phases.flatMap((ph) => ph.tasks.filter((t) => t.done).map((t) => t.text)));
    fresh.phases.forEach((ph) => ph.tasks.forEach((t) => { if (doneSet.has(t.text)) t.done = true; }));
    db.prepare('UPDATE user_schedule SET plan_json = ?, is_custom = 0 WHERE id = ?')
      .run(JSON.stringify(fresh), id);
    res.json({ id, plan: fresh, message: 'AI 已生成优化版计划' });
  } catch (err) {
    res.status(502).json({ error: err.message, hint: '检查 .env 中的 DEEPSEEK_API_KEY' });
  }
});

// GET /api/schedule/list — 用户全部日程
// 登录：显示自己的（user_id=账号）+ 历史匿名计划（'local'）；匿名：仅 'local'
r.get('/list', optionalAuth, (req, res) => {
  const base = `SELECT s.id, s.comp_id, s.is_custom, s.plan_json, s.create_time, c.name AS comp_name, c.short_name
     FROM user_schedule s LEFT JOIN competition c ON c.id = s.comp_id`;
  const rows = req.user
    ? db.prepare(`${base} WHERE s.user_id = ? OR s.user_id = 'local' ORDER BY s.create_time DESC`).all(req.user.id)
    : db.prepare(`${base} WHERE s.user_id = 'local' ORDER BY s.create_time DESC`).all();
  res.json(rows.map((row) => ({ ...row, plan: normalizePlan(JSON.parse(row.plan_json || '{}')) })));
});

// POST /api/schedule/manual — 自编备赛计划（不依赖 AI：用户手写阶段/日期/任务）
r.post('/manual', optionalAuth, (req, res) => {
  const { comp_id, title, phases } = req.body || {};
  const comp = comp_id ? db.prepare('SELECT * FROM competition WHERE id = ? AND status = ?').get(Number(comp_id), 'active') : null;
  const planTitle = String(title || '').trim() || comp?.name || '我的自编计划';
  if (!Array.isArray(phases) || !phases.length) return res.status(400).json({ error: '至少填写一个阶段' });
  const normPhases = phases.map((p) => ({
    phase: String(p?.phase || '').trim() || '未命名阶段',
    date: String(p?.date || '').trim(),
    tasks: (p?.tasks || [])
      .map((t) => (typeof t === 'string' ? { text: String(t).trim(), done: false } : { text: String(t?.text || '').trim(), done: !!t?.done }))
      .filter((t) => t.text),
    check_standard: String(p?.check_standard || '').trim(),
    week_hours: Number(p?.week_hours) || 0,
  })).filter((p) => p.phase !== '未命名阶段' || p.tasks.length);
  const totalTasks = normPhases.reduce((s, p) => s + p.tasks.length, 0);
  if (!normPhases.length || !totalTasks) return res.status(400).json({ error: '阶段内容为空，请至少写一个阶段和任务' });
  const plan = { summary: `${planTitle}（自编计划）`, phases: normPhases };
  const uid = req.user ? req.user.id : 'local';
  const rr = db.prepare(
    'INSERT INTO user_schedule (comp_id, user_id, is_custom, plan_json) VALUES (?,?,1,?)'
  ).run(comp?.id ?? null, uid, JSON.stringify(plan));
  logAudit(req, 'plan-manual', planTitle);
  res.status(201).json({ id: rr.lastInsertRowid, plan, message: '自编计划已保存' });
});

// POST /api/schedule/:id/edit — 手动修改日程（标记 is_custom=1）
r.post('/:id/edit', (req, res) => {
  const id = Number(req.params.id);
  const { plan_json } = req.body || {};
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 非法' });
  if (!plan_json) return res.status(400).json({ error: 'plan_json 必填（修改后的计划对象，前端序列化）' });
  const r2 = db.prepare(
    'UPDATE user_schedule SET plan_json = ?, is_custom = 1 WHERE id = ?'
  ).run(JSON.stringify(plan_json), id);
  if (r2.changes === 0) return res.status(404).json({ error: '日程不存在' });
  res.json({ id, is_custom: 1, message: '已保存（is_custom=1）' });
});

// DELETE /api/schedule/:id — 删除日程
r.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 非法' });
  const r2 = db.prepare('DELETE FROM user_schedule WHERE id = ?').run(id);
  if (r2.changes === 0) return res.status(404).json({ error: '日程不存在' });
  res.json({ id, message: '已删除' });
});

// GET /api/schedule/calendar?month=YYYY-MM — 月历聚合：当月完成事项（竞赛/学习/小组）+ 当月笔记
// 任务完成时由前端（竞赛/学习 plan_json）或后端（小组 team_plan）记录 done_at=YYYY-MM-DD，按完成日聚合
// 注册在 /:id/export 之前（express 按注册顺序匹配）
r.get('/calendar', optionalAuth, (req, res) => {
  const month = String(req.query.month || '').match(/^\d{4}-\d{2}$/)?.[0];
  if (!month) return res.status(400).json({ error: 'month 必填，格式 YYYY-MM' });
  const collect = (plan, planName) => {
    const out = [];
    for (const ph of (plan.phases || [])) {
      for (const t of (ph.tasks || [])) {
        if (t.done && typeof t.done_at === 'string' && t.done_at.startsWith(month)) {
          out.push({ date: t.done_at, plan_name: planName, task: t.text });
        }
      }
    }
    return out;
  };

  // 竞赛日程：登录=自己的 + 历史匿名 'local'；匿名=仅 'local'（与 /list 同规则）
  const compBase = `SELECT s.id, s.plan_json, c.name AS comp_name FROM user_schedule s
     LEFT JOIN competition c ON c.id = s.comp_id`;
  const compRows = req.user
    ? db.prepare(`${compBase} WHERE s.user_id = ? OR s.user_id = 'local'`).all(req.user.id)
    : db.prepare(`${compBase} WHERE s.user_id = 'local'`).all();
  const comp = compRows.flatMap((row) => collect(normalizePlan(JSON.parse(row.plan_json || '{}')), row.comp_name || '我的日程'));

  // 学习日程：仅登录（匿名为空）
  const studyRows = req.user
    ? db.prepare('SELECT id, plan_json, topic FROM user_study WHERE user_id = ?').all(req.user.id)
    : [];
  const study = studyRows.flatMap((row) => collect(normalizePlan(JSON.parse(row.plan_json || '{}')), row.topic || '学习日程'));

  // 小组计划：我所在小组的全部计划
  const teamRows = req.user
    ? db.prepare(
        `SELECT tp.id, tp.title, tp.plan_json FROM team_plan tp
         JOIN team_member tm ON tm.team_id = tp.team_id WHERE tm.user_id = ?`
      ).all(req.user.id)
    : [];
  const team = teamRows.flatMap((row) => collect(normalizePlan(JSON.parse(row.plan_json || '{}')), row.title || '小组计划'));

  // 当月笔记（与 notes.js 同归属规则）
  const uid = req.user ? String(req.user.id) : 'local';
  const notes = db.prepare(
    'SELECT id, note_date, status, content FROM daily_note WHERE user_id = ? AND substr(note_date, 1, 7) = ? ORDER BY note_date DESC'
  ).all(uid, month);

  res.json({ month, comp, study, team, notes });
});

// GET /api/schedule/:id/export?format=md|excel — 导出计划
r.get('/:id/export', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM user_schedule WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '日程不存在' });
  const plan = normalizePlan(JSON.parse(row.plan_json || '{}'));
  const comp = db.prepare('SELECT name FROM competition WHERE id = ?').get(row.comp_id);
  const fmt = req.query.format || 'md';

  // Excel：CSV（UTF-8 BOM，Excel 直接打开中文不乱码）
  if (fmt === 'excel') {
    const rows = [['竞赛', '阶段', '起止日期', '任务', '已完成', '达标要求', '每周时长(h)']];
    for (const ph of plan.phases) {
      const tasks = ph.tasks.length ? ph.tasks : [{ text: '', done: false }];
      for (const t of tasks) {
        rows.push([
          comp?.name || '', ph.phase, ph.date, t.text,
          t.done ? '是' : '否', ph.check_standard, ph.week_hours,
        ]);
      }
    }
    const csv = '﻿' + rows
      .map((r) => r.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=schedule_${id}.csv`);
    return res.send(csv);
  }

  // Markdown
  const lines = [`# ${comp?.name || '竞赛'} 备赛计划`, '', `> 生成时间：${row.create_time}`];
  if (plan.note) lines.push(`> 说明：${plan.note}`);
  for (const [i, ph] of plan.phases.entries()) {
    lines.push('', `## 阶段${i + 1}：${ph.phase}`);
    if (ph.date) lines.push(`> 起止日期：${ph.date}`);
    for (const t of ph.tasks) lines.push(`- ${t.done ? '[x]' : '[ ]'} ${t.text}`);
    if (ph.check_standard) lines.push(`- 达标要求：${ph.check_standard}`);
    if (ph.week_hours) lines.push(`- 每周最低学习时长：${ph.week_hours} 小时`);
  }
  lines.push('', '---', '由 Engineer-Compass 工科竞赛导航系统生成');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.send(lines.join('\n'));
});

export default r;
