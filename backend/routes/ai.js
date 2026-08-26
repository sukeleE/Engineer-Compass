// AI 接口：DeepSeek 问答转发 + 未知竞赛资料提炼
// 注意：DeepSeek API 不带联网搜索，未知竞赛资料由前端/用户提供（粘贴官方通知）或后续接入搜索API
import { Router } from 'express';
import db from '../db/database.js';

const r = Router();
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

function getKey() {
  return process.env.DEEPSEEK_API_KEY || '';
}

// 调用 DeepSeek（json=true 时启用 JSON 输出模式——DeepSeek 要求提示词中必须出现 "json" 字样）
// timeoutMs > 0 时启用 AbortSignal.timeout（Node 24 内置）
export async function callDeepSeek(messages, { json = true, timeoutMs = 0 } = {}) {
  const key = getKey();
  if (!key) throw new Error('DEEPSEEK_API_KEY 未配置（.env 文件）');
  const body = {
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    messages,
    temperature: 0.7,
  };
  if (json) body.response_format = { type: 'json_object' };
  const resp = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`DeepSeek 请求失败 ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

// POST /api/ai/chat — 通用问答（带当前查看的竞赛上下文）
r.post('/chat', async (req, res) => {
  const { question, comp_id, comp_name } = req.body || {};
  if (!question) return res.status(400).json({ error: 'question 必填' });

  let ctx = comp_name || null;
  if (comp_id && !ctx) {
    const c = db.prepare('SELECT name FROM competition WHERE id = ?').get(Number(comp_id));
    if (c) ctx = c.name;
  }

  const system = ctx
    ? `你是工科竞赛助手，当前用户正在查看【${ctx}】。结合该比赛的赛制、时间、所需技术栈回答用户问题。如果用户问备赛方案，尽量给出分阶段可落地任务清单。回答使用中文。`
    : '你是工科竞赛助手。回答用户关于大学生竞赛的提问：难度、硬件需求、组队建议、备赛资料、时间冲突等。回答使用中文，尽量给出可落地的建议。';

  try {
    const answer = await callDeepSeek(
      [
        { role: 'system', content: system },
        { role: 'user', content: question },
      ],
      { json: false } // 问答输出自然语言，不开 JSON 模式
    );
    // 去掉 json_object 模式可能包裹的代码块
    res.json({ answer: answer.replace(/^```json\s*|```$/g, '').trim() });
  } catch (err) {
    res.status(502).json({ error: err.message, hint: '检查 .env 中的 DEEPSEEK_API_KEY' });
  }
});

// POST /api/ai/extract — 未知竞赛资料提炼 → 结构化竞赛卡片 JSON
r.post('/extract', async (req, res) => {
  const { material } = req.body || {};
  if (!material || material.trim().length < 20) {
    return res.status(400).json({ error: 'material 必填（粘贴官方通知/官网/资料的正文，至少20字）' });
  }

  const system = `你是竞赛情报员。根据用户提供的竞赛资料，提取竞赛信息。
只输出JSON，字段：name, short_name, type(A类/B类+赛道：电子机器人/机械/综合/数学基础/设计艺术/经管商科/医学技能), start_month(1-12), sign_start, sign_end, province_time, national_time, cycle, difficulty(1-5), intro, suitable_major, team, source_url, confidence(0-1), data_year
规则：
1. 资料里没有的字段必须为null，禁止编造
2. 对信息完整性自评 confidence
3. 禁止多余文字，直接返回json`;

  try {
    const raw = await callDeepSeek([
      { role: 'system', content: system },
      { role: 'user', content: material },
    ]);
    let card;
    try {
      card = JSON.parse(raw.replace(/^```json\s*|```$/g, '').trim());
    } catch {
      return res.status(502).json({ error: 'AI 输出不是合法 JSON', raw });
    }
    res.json({
      ...card,
      tip: '核实后可用 POST /api/competition 暂存入库（自动 status=pending，需带 source_url）',
    });
  } catch (err) {
    res.status(502).json({ error: err.message, hint: '检查 .env 中的 DEEPSEEK_API_KEY' });
  }
});

export default r;
