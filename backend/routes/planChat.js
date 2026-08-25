// 对话式 AI 计划：统一「先对话、后成稿」入口（POST /api/plan-chat）
// 覆盖：team-create（建组前的分组+计划对话，不保存，前端确认后调 POST /team）、
//      team-generate（生成小组备赛计划）、team-edit（修改小组计划）、
//      schedule / schedule-edit（个人竞赛备赛日程）、study / study-edit（学习日程）
// 协议：AI 信息不足时输出自然语言提问 → {action:'question', reply}；
//      信息足够时输出严格 JSON 计划 → {action:'plan', reply, plan, departments?, plan_id?}（后端校验并保存）
import { Router } from 'express';
import db from '../db/database.js';
import { callDeepSeek } from './ai.js';
import { normalizePlan } from './schedule.js';
import { optionalAuth, teamCtx, hasPerm, logAudit } from './middleware.js';

const r = Router();

const DEFAULT_MEMBER_PERMS = ['progress', 'message', 'file_upload'];
const MAX_HISTORY = 16;
const TEAM_MODES = ['team-create', 'team-generate', 'team-edit'];
const SCHEDULE_MODES = ['schedule', 'schedule-edit'];
const STUDY_MODES = ['study', 'study-edit'];
const ALL_MODES = [...TEAM_MODES, ...SCHEDULE_MODES, ...STUDY_MODES];

// 阶段进度摘要（放进对话上下文，AI 参考现有进度调整）
function briefPlan(plan) {
  return (plan.phases || []).map((ph, i) => {
    const done = (ph.tasks || []).filter((t) => t.done).length;
    return `阶段${i + 1}「${ph.phase}」${ph.date || ''}（${done}/${(ph.tasks || []).length} 已完成）`;
  }).join('\n') || '（无阶段数据）';
}

// 保留已完成勾选：按「阶段名|任务文本」匹配旧计划，复制 done/done_by/done_at
export function mergeDone(norm, oldPlan) {
  const oldMap = new Map();
  for (const ph of oldPlan.phases || []) for (const t of ph.tasks || []) {
    if (t && t.text) oldMap.set(`${ph.phase}|${t.text}`, t);
  }
  for (const ph of norm.phases) for (const t of ph.tasks || []) {
    const o = oldMap.get(`${ph.phase}|${t.text}`);
    if (o) { t.done = !!o.done; t.done_by = o.done_by || null; t.done_at = o.done_at || null; }
  }
}

// 从 AI 回复提取 JSON：整段优先，失败再取首个 { 到最后一个 }（DeepSeek 可能夹带散文）
function extractJson(reply) {
  const cleaned = String(reply || '').replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const s = cleaned.indexOf('{');
  const e = cleaned.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(cleaned.slice(s, e + 1)); } catch {}
  }
  return null;
}

// 每轮消息注入的收尾指令：决定本轮是「继续提问」还是「输出计划」
const KICKER = '请继续推进：若关键信息仍不足，只输出自然语言提问（每次 1-3 个最关键的问题，禁止输出 JSON）；若信息已足够，直接输出最终计划（严格 JSON、禁止多余文字、不要代码块）。';
// 第一轮（无历史）：必须先提问，禁止直接出计划（此时没有任何用户信息）
const FIRST_KICKER = '这是对话的第一轮，你还没有任何用户信息：请先向用户提问，了解制定计划所需的关键信息（每次 1-3 个问题，用自然语言），本轮禁止输出计划 JSON。';
// 对话已 ≥2 轮问答：禁止再问，直接出计划（个别信息缺失用合理默认值，如每周 10 小时）
const FORCE_KICKER = '对话已经进行了足够多轮。请不要再提问，直接输出最终计划（严格 JSON、禁止多余文字、不要代码块）。个别信息确实缺失时用合理默认值补足即可。';

// POST /api/plan-chat — 对话制计划（每次请求带完整消息历史，后端截取最近 MAX_HISTORY 条）
r.post('/', optionalAuth, async (req, res) => {
  const { mode, messages, comp_id, team_id, plan_id, schedule_id, study_id } = req.body || {};
  if (!ALL_MODES.includes(mode)) return res.status(400).json({ error: 'mode 非法' });
  const uid = req.user?.id ?? null;

  // 必填参数（按模式）
  if (mode === 'team-generate' && !comp_id) return res.status(400).json({ error: 'team-generate 需要 comp_id（选定竞赛）' });
  if (mode === 'schedule' && !comp_id) return res.status(400).json({ error: 'schedule 需要 comp_id（选定竞赛）' });
  if (mode === 'team-edit' && !plan_id) return res.status(400).json({ error: 'team-edit 需要 plan_id' });
  if (mode === 'schedule-edit' && !schedule_id) return res.status(400).json({ error: 'schedule-edit 需要 schedule_id' });
  if (mode === 'study-edit' && !study_id) return res.status(400).json({ error: 'study-edit 需要 study_id' });

  // 小组模式：需登录 + 成员身份；生成/修改需组长权限
  let ctx = null;
  if (TEAM_MODES.includes(mode)) {
    if (!req.user) return res.status(401).json({ error: '请先登录' });
    if (mode !== 'team-create') {
      ctx = teamCtx(Number(team_id), req.user.id);
      if (!ctx || !ctx.member) return res.status(403).json({ error: '不是小组成员' });
      if (!(ctx.isOwner || hasPerm(ctx, 'team'))) return res.status(403).json({ error: '仅组长可生成/修改小组计划' });
    }
  }

  // —— 加载上下文（竞赛 / 现有计划 / 现有部门）——
  const comp = comp_id ? db.prepare('SELECT * FROM competition WHERE id = ? AND status = ?').get(Number(comp_id), 'active') : null;
  let teamPlan = null;
  if (mode === 'team-edit') {
    teamPlan = db.prepare('SELECT * FROM team_plan WHERE id = ? AND team_id = ?').get(Number(plan_id), ctx.team.id);
    if (!teamPlan) return res.status(404).json({ error: '计划不存在' });
  }
  let schedRow = null;
  if (mode === 'schedule-edit') {
    schedRow = db.prepare('SELECT * FROM user_schedule WHERE id = ?').get(Number(schedule_id));
    if (!schedRow) return res.status(404).json({ error: '日程不存在' });
  }
  let studyRow = null;
  if (mode === 'study-edit') {
    studyRow = db.prepare('SELECT * FROM user_study WHERE id = ?').get(Number(study_id));
    if (!studyRow) return res.status(404).json({ error: '学习日程不存在' });
  }

  // —— 组装系统提示（模式说明 + 上下文 + 输出协议）——
  const now = new Date();
  const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const compLine = comp ? `竞赛：${comp.name}（官方时间 ${comp.national_time || comp.timeline_raw || '以官网为准'}）` : '';
  const teamRoles = ctx ? db.prepare('SELECT id, name FROM team_role WHERE team_id = ? ORDER BY level DESC, id').all(ctx.team.id).map((x) => x.name) : [];
  const roleNames = teamRoles.join('、') || '（未设置部门）';

  let info = '', schema = '';
  if (mode === 'team-create') {
    info = `目标：为即将组建的竞赛小组设计「部门分组 + 备赛计划」。需要了解：拟分几组（3-6 个部门）及各自职责、备赛总周期与比赛时间、成员人数与分工偏好。${compLine ? '\n' + compLine : ''}`;
    schema = `最终 JSON 结构（顶级两个键）：{"departments":[{"name":"部门名","duty":"职责"}],"phases":[{"phase":"阶段名","date":"起止日期","check_standard":"本阶段硬性达标要求","week_hours":10,"tasks":[{"text":"任务描述","dept":"部门名"}]}]}
规则：departments 3-6 个；phases 覆盖整个备赛周期（如 报名备赛→初赛→决赛 或 基础→进阶→冲刺）；任务 dept 必须来自 departments，公共任务 dept 用"通用"；每阶段 4-10 个任务，多部门并行推进。`;
  } else if (mode === 'team-generate') {
    info = `目标：为小组「${ctx.team.name}」生成备赛计划。现有部门：${roleNames}。需要了解：备赛周期与比赛时间、当前准备进度、是否调整部门。${compLine ? '\n' + compLine : ''}`;
    schema = `最终 JSON 结构：{"departments":[{"name":"部门名","duty":"职责"}],"phases":[{"phase":"阶段名","date":"起止日期","check_standard":"本阶段硬性达标要求","week_hours":10,"tasks":[{"text":"任务描述","dept":"部门名"}]}]}
规则：departments 只在需要新建部门时给出（沿用现有部门就不列出）；phases 覆盖整个备赛周期；任务 dept 必须来自「现有部门∪新列部门」，公共任务 dept 用"通用"；每阶段 4-10 个任务，多部门并行推进。`;
  } else if (mode === 'team-edit') {
    info = `目标：修改小组计划「${teamPlan.title}」。现有部门：${roleNames}。现有计划完成情况：\n${briefPlan(JSON.parse(teamPlan.plan_json || '{}'))}\n需要了解：想调整什么（阶段时间/任务/部门分工）、当前进度。`;
    schema = `最终 JSON 结构：{"phases":[{"phase":"阶段名","date":"起止日期","check_standard":"本阶段硬性达标要求","week_hours":10,"tasks":[{"text":"任务描述","dept":"部门名"}]}]}
规则：任务 dept 必须来自现有部门：${roleNames}，公共任务 dept 用"通用"；输出调整后的完整计划（不要只给增量，已完成任务保持原有任务文本以便保留勾选）。`;
  } else if (mode === 'schedule' || mode === 'schedule-edit') {
    info = mode === 'schedule'
      ? `目标：为用户生成个人竞赛备赛日程。需要了解：当前基础水平、备赛总周期、每周可投入时间、参赛目标（冲奖/完赛）。${compLine ? '\n' + compLine : ''}`
      : `目标：修改用户现有备赛日程。现有计划完成情况：\n${briefPlan(JSON.parse(schedRow.plan_json || '{}'))}\n需要了解：想调整什么、当前进度。${compLine ? '\n' + compLine : ''}`;
    schema = `最终 JSON 结构：{"phases":[{"phase":"阶段名","date":"起止日期","tasks":["任务描述",...],"check_standard":"本阶段硬性达标要求","week_hours":10}]}
规则：3-5 个阶段，每阶段 3-6 条可执行任务；输出完整计划（不要只给增量，已完成任务保持原有任务文本以便保留勾选）。`;
  } else { // study / study-edit
    info = mode === 'study'
      ? '目标：为用户生成学习日程（与竞赛无关）。需要了解：学习主题、当前水平、学习目标、每周可投入时间、总周期。'
      : `目标：修改用户现有学习日程。现有：主题「${studyRow.topic}」${studyRow.level ? `、水平「${studyRow.level}」` : ''}${studyRow.goal ? `、目标「${studyRow.goal}」` : ''}。现有计划：\n${briefPlan(JSON.parse(studyRow.plan_json || '{}'))}\n需要了解：想调整什么。`;
    schema = `最终 JSON 结构：{"topic":"学习主题","summary":"一句话概述","phases":[{"phase":"阶段名","date":"约第x-y周","tasks":["任务",...],"check_standard":"本阶段硬性达标要求","week_hours":10}],"resource_keywords":["细分搜索关键词",...]}
规则：3-5 个阶段循序渐进，任务具体可落地；输出完整计划（不要只给增量，已完成任务保持原有任务文本以便保留勾选）。`;
  }
  const system = `你是工科竞赛备赛规划顾问，通过与用户对话共同制定计划。
当前日期:${today}
${info}
工作方式：
1. 先提问了解制定计划所需的关键信息，每次只问 1-3 个最关键的问题（自然语言，禁止输出 JSON）。
2. 当信息足够时，输出最终计划 —— 必须严格 JSON、禁止多余文字、不要代码块。
${schema}`;

  // 消息历史（截取最近 N 条，防上下文膨胀）
  const history = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));

  let reply;
  try {
    reply = String((await callDeepSeek(
      [{ role: 'system', content: system }, ...history,
       { role: 'user', content: history.length === 0 ? FIRST_KICKER : (history.length >= 4 ? FORCE_KICKER : KICKER) }],
      { json: false }
    )) || '').trim();
  } catch (err) {
    return res.status(502).json({ error: err.message, hint: '检查 .env 中的 DEEPSEEK_API_KEY' });
  }
  if (!reply) return res.status(502).json({ error: 'AI 无回复，请重试' });

  const parsed = extractJson(reply);
  if (!parsed || typeof parsed !== 'object') {
    return res.json({ action: 'question', reply }); // 自然语言 → 继续对话
  }

  // —— 是计划 JSON → 按模式校验 + 落地 ——
  try {
    const out = await finalize(mode, parsed, { uid, ctx, comp, teamPlan, schedRow, studyRow, reply });
    logAudit(req, 'plan-chat', comp?.name || '', { mode, topic: parsed.topic || '' });
    return res.json(out);
  } catch (err) {
    // 计划结构不完整（AI 偶发输出残缺 JSON）：引导继续对话，而不是硬报错打断
    if (/无有效阶段|缺少 topic/.test(err.message)) {
      return res.json({ action: 'question', reply: `⚠️ ${err.message}。请再补充一些信息，我会重新生成完整计划。` });
    }
    return res.status(502).json({ error: err.message, hint: '可回复继续对话补充信息后重试' });
  }
});

// 计划落地：team-create 只回传不保存（前端确认后调 POST /team）；其余模式直接入库
async function finalize(mode, parsed, o) {
  const { uid, ctx, comp, teamPlan, schedRow, studyRow, reply } = o;

  if (mode === 'team-create' || mode === 'team-generate') {
    const depts = (parsed.departments || []).map((d) => ({
      name: String(d.name || d.部门名 || '').trim(), duty: String(d.duty || d.职责 || '').trim(),
    })).filter((d) => d.name && d.name !== '通用'); // 「通用」是任务标签不是部门角色
    const existingRoles = mode === 'team-generate' ? db.prepare('SELECT id, name FROM team_role WHERE team_id = ?').all(ctx.team.id) : [];
    // 先做无副作用的结构校验（AI 偶发残缺计划时避免白插部门角色）
    if (!normalizePlan(parsed).phases.length) throw new Error('AI 计划无有效阶段，请继续对话补充信息');
    // team-generate：AI 建议的新部门先落库（level 递增），任务归一化要把新部门也算进角色表
    let created = [];
    if (mode === 'team-generate') {
      let level = db.prepare('SELECT COALESCE(MAX(level), 0) AS m FROM team_role WHERE team_id = ?').get(ctx.team.id).m;
      for (const d of depts) {
        if (existingRoles.some((x) => x.name === d.name)) continue;
        level += 1;
        const rr = db.prepare('INSERT INTO team_role (team_id, name, level, permissions) VALUES (?,?,?,?)')
          .run(ctx.team.id, d.name, level, JSON.stringify(DEFAULT_MEMBER_PERMS));
        created.push({ id: rr.lastInsertRowid, name: d.name });
      }
    }
    const roles = mode === 'team-create' ? depts : [...existingRoles, ...created];
    const norm = normalizePlan(parsed);
    // 部门计划任务带 dept/role_id 归一化（规则同 team.js：dept 匹配不到角色 → 通用）
    norm.phases = norm.phases.map((ph) => ({
      ...ph,
      tasks: (ph.tasks || []).map((t) => {
        const dept = String(t.dept || t.部门 || '').trim();
        const role = roles.find((x) => x.name === dept);
        return { ...t, dept: role ? role.name : (dept || '通用'), role_id: role?.id ?? null };
      }),
    }));
    const plan = { comp_id: comp?.id ?? null, comp_name: comp?.name ?? null, ...norm };

    if (mode === 'team-generate') {
      const rr2 = db.prepare('INSERT INTO team_plan (team_id, comp_id, title, plan_json) VALUES (?,?,?,?)')
        .run(ctx.team.id, comp?.id ?? null, comp?.name ?? '小组备赛计划', JSON.stringify(plan));
      return { action: 'plan', reply, plan, departments: created, plan_id: rr2.lastInsertRowid };
    }
    return { action: 'plan', reply, plan, departments: depts }; // 建组模式：前端确认后 POST /team
  }

  if (mode === 'team-edit') {
    const roles = db.prepare('SELECT id, name FROM team_role WHERE team_id = ?').all(ctx.team.id);
    const norm = normalizePlan(parsed);
    norm.phases = norm.phases.map((ph) => ({
      ...ph,
      tasks: (ph.tasks || []).map((t) => {
        const dept = String(t.dept || t.部门 || '').trim();
        const role = roles.find((x) => x.name === dept);
        return { ...t, dept: role ? role.name : (dept || '通用'), role_id: role?.id ?? null };
      }),
    }));
    if (!norm.phases.length) throw new Error('AI 计划无有效阶段，请继续对话补充信息');
    const old = JSON.parse(teamPlan.plan_json || '{}');
    mergeDone(norm, old);
    const planJson = { comp_id: teamPlan.comp_id, comp_name: old.comp_name ?? null, ...norm };
    db.prepare('UPDATE team_plan SET plan_json = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify(planJson), teamPlan.id);
    return { action: 'plan', reply, plan: planJson, plan_id: teamPlan.id };
  }

  if (mode === 'schedule' || mode === 'schedule-edit') {
    if (mode === 'schedule' && !comp) throw new Error('竞赛不存在或未转正');
    const norm = normalizePlan(parsed);
    if (!norm.phases.length) throw new Error('AI 计划无有效阶段，请继续对话补充信息');
    const old = mode === 'schedule-edit' ? JSON.parse(schedRow.plan_json || '{}') : {};
    mergeDone(norm, old);
    const planJson = { comp_id: comp?.id ?? schedRow?.comp_id ?? null, comp_name: comp?.name ?? old.comp_name ?? null, ...norm };
    if (mode === 'schedule') {
      const rr = db.prepare('INSERT INTO user_schedule (comp_id, user_id, is_custom, plan_json) VALUES (?,?,0,?)')
        .run(comp.id, uid ?? 'local', JSON.stringify(planJson));
      return { action: 'plan', reply, plan: planJson, plan_id: rr.lastInsertRowid };
    }
    db.prepare('UPDATE user_schedule SET plan_json = ?, is_custom = 0 WHERE id = ?').run(JSON.stringify(planJson), schedRow.id);
    return { action: 'plan', reply, plan: planJson, plan_id: schedRow.id };
  }

  // study / study-edit
  const topic = String(parsed.topic || '').trim();
  if (mode === 'study' && !topic) throw new Error('AI 计划缺少 topic（学习主题），请重新对话确认要学什么');
  const norm = normalizePlan(parsed);
  if (!norm.phases.length) throw new Error('AI 计划无有效阶段，请继续对话补充信息');
  const old = mode === 'study-edit' ? JSON.parse(studyRow.plan_json || '{}') : {};
  mergeDone(norm, old);
  let kws = Array.isArray(norm.resource_keywords) ? norm.resource_keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim()).slice(0, 4) : [];
  if (!kws.length) kws = [`${topic || studyRow.topic} 入门`, `${topic || studyRow.topic} 实战`];
  norm.resource_keywords = kws;
  if (!norm.summary) norm.summary = `${topic || studyRow.topic}（学习日程）`;
  const finalTopic = topic || studyRow.topic;
  if (mode === 'study') {
    const rr = db.prepare('INSERT INTO user_study (user_id, topic, level, goal, hours, plan_json) VALUES (?,?,?,?,?,?)')
      .run(uid, finalTopic, parsed.level ?? null, parsed.goal ?? null, Number(parsed.hours) || 10, JSON.stringify(norm));
    return { action: 'plan', reply, plan: { topic: finalTopic, ...norm }, plan_id: rr.lastInsertRowid };
  }
  db.prepare('UPDATE user_study SET plan_json = ?, topic = ? WHERE id = ?').run(JSON.stringify(norm), finalTopic, studyRow.id);
  return { action: 'plan', reply, plan: { topic: finalTopic, ...norm }, plan_id: studyRow.id };
}

export default r;
