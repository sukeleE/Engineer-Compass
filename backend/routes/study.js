// 学习日程接口：AI 根据用户想学的技能/知识点生成学习计划 + 推荐各平台学习资料
// 与竞赛无关 —— 用户告诉 AI 学什么，AI 出分阶段学习日程并推荐检索入口
import { Router } from 'express';
import db from '../db/database.js';
import { callDeepSeek } from './ai.js';
import { normalizePlan } from './schedule.js';
import { optionalAuth } from './middleware.js';
import { SEARCH, PLATFORM_META, KNOWLEDGE_PLATFORMS } from './platforms.js';

const r = Router();
const enc = encodeURIComponent;

// 兜底方案：无 AI key 时生成通用学习路径（基础→进阶→项目→复盘）
function templateStudyPlan(topic, level = '零基础') {
  const suffix = level === '进阶' ? '（面向已有基础的快速进阶版）' : '';
  return {
    summary: `「${topic}」系统学习路径：从${level}出发，基础 → 进阶 → 项目实战 → 复盘巩固${suffix}`,
    phases: [
      { phase: '基础入门', date: '约第1-2周', tasks: ['找一份系统性的入门教程/课程，通读目录', '搭建最小开发环境并跑通第一个示例', '记录核心概念笔记（术语/原理）'], check_standard: '能独立完成一个最小可运行示例', week_hours: 10 },
      { phase: '核心进阶', date: '约第3-5周', tasks: ['按官方文档系统过一遍核心功能', '完成 3 个中等难度的练习/小项目', '加入交流社区，整理常见问题'], check_standard: '能脱离教程独立完成中等难度任务', week_hours: 10 },
      { phase: '项目实战', date: '约第6-8周', tasks: ['选定一个综合项目，拆解需求与模块', '按模块逐步实现并调试', '解决至少 3 个真实问题，记录方案'], check_standard: '完整交付一个可演示的综合项目', week_hours: 10 },
      { phase: '复盘巩固', date: '约第9周', tasks: ['复盘项目，整理踩坑清单', '把笔记输出成一份可分享的总结/文章', '针对薄弱点查漏补缺'], check_standard: '能向他人讲清整体技术脉络', week_hours: 10 },
    ],
    resource_keywords: [`${topic} 入门`, `${topic} 实战`, `${topic} 进阶`],
  };
}

// AI 生成个性化学习日程（含推荐资料的细分检索关键词）
async function aiStudyPlan({ topic, level = '零基础', goal = '', hours = 10 }) {
  const now = new Date();
  const system = `你是学习规划导师。根据用户想学的主题，生成一份可执行的学习日程（与任何竞赛无关）。
当前日期:${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}
输出严格JSON（顶级键固定）：summary（一句话学习路径概述）、phases（数组，每阶段含 phase 阶段名称、date 起止日期或"约第x-y周"、tasks 字符串数组 3-6 条可执行任务、check_standard 本阶段硬性达标要求、week_hours 每周投入小时数）、resource_keywords（数组，3-5 个能直接搜出高质量教程的细分关键词，如"STM32 GPIO 寄存器操作"，宁具体勿宽泛）。
要求：3-5 个阶段循序渐进；任务具体可落地；资源关键词覆盖入门/核心/实战三个层次。
禁止多余文字，直接返回json。`;
  const raw = await callDeepSeek([
    { role: 'system', content: system },
    { role: 'user', content: `主题：${topic}；当前水平：${level}；学习目标：${goal || '系统掌握'}；每周可投入：${hours} 小时` },
  ]);
  return JSON.parse(raw.replace(/^```json\s*|```$/g, '').trim());
}

// 由主题 + 细分关键词生成各平台检索链接（全为平台搜索 URL，无幻觉链接）
export function buildResources(topic, keywords = []) {
  const res = [];
  // 主主题 × 8 平台
  for (const [plat, make] of Object.entries(SEARCH)) {
    res.push({ title: `${topic}`, platform: plat, url: make(enc(topic)), kind: 'topic' });
  }
  // AI 细分关键词 × 3 平台（B站/CSDN/知乎）
  for (const kw of (keywords || []).slice(0, 4)) {
    for (const plat of KNOWLEDGE_PLATFORMS) {
      res.push({ title: kw, platform: plat, url: SEARCH[plat](enc(kw)), kind: 'detail' });
    }
  }
  return res;
}

// 校验/兜底 AI 返回：phases 归一化 + 细分关键词必须是非空字符串数组
function finalizePlan(raw, topic, level, hours) {
  const plan = normalizePlan(raw);
  if (!plan.phases.length) throw new Error('AI 返回结构异常（无阶段数据）');
  let kws = Array.isArray(plan.resource_keywords) && plan.resource_keywords.every((k) => typeof k === 'string')
    ? plan.resource_keywords.map((k) => k.trim()).filter(Boolean)
    : [];
  if (kws.length < 3) kws = [...kws, `${topic} 入门`, `${topic} 实战`].slice(0, 4);
  plan.resource_keywords = kws.slice(0, 4);
  plan.summary = typeof plan.summary === 'string' && plan.summary.trim() ? plan.summary.trim() : templateStudyPlan(topic, level).summary;
  plan.phases.forEach((ph) => { ph.week_hours = ph.week_hours || hours; });
  return plan;
}

// POST /api/study/plan — 生成学习日程（主题/水平/目标/每周小时 → AI 计划 + 资料推荐）
// 登录用户创建的计划绑定 user_id（小组计划同步可见）；匿名创建为 NULL（仅本机可见）
r.post('/plan', optionalAuth, async (req, res) => {
  const { topic, level, goal, hours } = req.body || {};
  if (!topic || !String(topic).trim()) return res.status(400).json({ error: 'topic（学习主题）必填' });
  const h = Number(hours) || 10;

  let plan;
  try {
    plan = finalizePlan(await aiStudyPlan({ topic: String(topic).trim(), level, goal, hours: h }), topic, level, h);
  } catch (err) {
    plan = normalizePlan(templateStudyPlan(String(topic).trim(), level));
    plan.note = `基础模板计划（AI 不可用：${err.message}），可配置 DEEPSEEK_API_KEY 后重新生成`;
  }
  let resources = [];
  try { resources = buildResources(plan.topic || String(topic).trim(), plan.resource_keywords); } catch { resources = []; }
  const r2 = db.prepare(
    'INSERT INTO user_study (user_id, topic, level, goal, hours, plan_json) VALUES (?,?,?,?,?,?)'
  ).run(req.user?.id ?? null, String(topic).trim(), level ?? null, goal ?? null, h, JSON.stringify(plan));
  res.status(201).json({ id: r2.lastInsertRowid, topic: String(topic).trim(), plan, resources, note: plan.note });
});

// POST /api/study/manual — 自编学习计划（不依赖 AI：用户手写阶段/日期/任务）
r.post('/manual', optionalAuth, (req, res) => {
  const { topic, goal, hours, phases } = req.body || {};
  if (!String(topic || '').trim()) return res.status(400).json({ error: 'topic（学习主题）必填' });
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
  const t = String(topic).trim();
  const plan = { summary: `${t}（自编学习计划）`, phases: normPhases, resource_keywords: [t] };
  const rr = db.prepare(
    'INSERT INTO user_study (user_id, topic, level, goal, hours, plan_json) VALUES (?,?,?,?,?,?)'
  ).run(req.user?.id ?? null, t, null, goal ? String(goal).trim() : null, Number(hours) || 10, JSON.stringify(plan));
  res.status(201).json({ id: rr.lastInsertRowid, topic: t, plan, message: '自编学习计划已保存' });
});

// GET /api/study/list — 学习日程列表（登录后只看自己的 + 匿名遗留数据；匿名看全部）
r.get('/list', optionalAuth, (req, res) => {
  const rows = (req.user
    ? db.prepare('SELECT id, user_id, topic, level, goal, hours, plan_json, create_time FROM user_study WHERE user_id = ? OR user_id IS NULL ORDER BY create_time DESC')
    : db.prepare('SELECT id, user_id, topic, level, goal, hours, plan_json, create_time FROM user_study ORDER BY create_time DESC'))
    .all(...(req.user ? [req.user.id] : []));
  res.json(rows.map((row) => {
    const plan = normalizePlan(JSON.parse(row.plan_json || '{}'));
    const all = plan.phases.flatMap((p) => p.tasks || []);
    const done = all.filter((t) => t.done).length;
    return { ...row, plan, phaseCount: plan.phases.length, done, total: all.length };
  }));
});

// GET /api/study/:id — 详情（计划 + 实时生成的平台资料推荐）
r.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 非法' });
  const row = db.prepare('SELECT * FROM user_study WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '学习日程不存在' });
  const plan = normalizePlan(JSON.parse(row.plan_json || '{}'));
  res.json({ ...row, plan, resources: buildResources(row.topic, plan.resource_keywords) });
});

// POST /api/study/:id — 更新计划（勾选保存）
r.post('/:id', (req, res) => {
  const id = Number(req.params.id);
  const { plan_json } = req.body || {};
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 非法' });
  if (!plan_json) return res.status(400).json({ error: 'plan_json 必填' });
  const r2 = db.prepare('UPDATE user_study SET plan_json = ? WHERE id = ?').run(JSON.stringify(plan_json), id);
  if (r2.changes === 0) return res.status(404).json({ error: '学习日程不存在' });
  res.json({ id, message: '已保存' });
});

// DELETE /api/study/:id — 删除
r.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id 非法' });
  const r2 = db.prepare('DELETE FROM user_study WHERE id = ?').run(id);
  if (r2.changes === 0) return res.status(404).json({ error: '学习日程不存在' });
  res.json({ id, message: '已删除' });
});

export default r;
