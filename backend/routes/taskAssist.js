// AI 任务拆解 + 资源推荐：POST /api/ai/task-assist
// 一次 DeepSeek 调用 → subtasks（拆成可执行子任务）+ keywords（细分搜索关键词）→ 平台搜索链接
// 资源链接由 buildResources 纯模板生成（无幻觉链接）；任何 AI 失败（无 key/超时/坏 JSON）都返回 200 降级结果
import { Router } from 'express';
import { callDeepSeek } from './ai.js';
import { buildResources } from './study.js';

const r = Router();

// 纯函数（导出供冒烟单测确定性覆盖两条路径）：
// parsed 有效 → 过滤空串子任务（≤12）/关键词（≤4）；无效 → 降级：subtasks=[原任务]
export function finalizeTaskAssist(taskText, parsed) {
  const degraded = !parsed || typeof parsed !== 'object';
  let subtasks = degraded ? [taskText] : [];
  let keywords = [];
  if (!degraded) {
    subtasks = (Array.isArray(parsed.subtasks) ? parsed.subtasks : [])
      .map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 12);
    keywords = (Array.isArray(parsed.keywords) ? parsed.keywords : [])
      .map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 4);
    if (!subtasks.length) subtasks = [taskText];
  }
  return { subtasks, keywords, degraded, resources: buildResources(taskText, keywords) };
}

// POST /api/ai/task-assist — body: { task_text }
r.post('/task-assist', async (req, res) => {
  const taskText = String((req.body || {}).task_text || '').trim();
  if (!taskText) return res.status(400).json({ error: 'task_text 必填' });

  // 提示词含字面量 "json"（DeepSeek json_object 模式硬性要求）
  const system = `你是工科竞赛备赛任务拆解助手。把用户给出的任务拆成 3-8 个可直接执行的子任务，并给出 3-4 个细分搜索关键词（能在 B站/知乎/CSDN 搜到高质量教程，宁具体勿宽泛，如"STM32 GPIO 寄存器操作"）。
只输出 JSON，顶级键固定两个：{"subtasks":["子任务1",...],"keywords":["关键词1",...]}
子任务要具体可落地、覆盖准备/执行/复盘；禁止多余文字，直接返回json。`;
  try {
    const raw = await callDeepSeek(
      [{ role: 'system', content: system }, { role: 'user', content: `任务：${taskText}` }],
      { json: true, timeoutMs: 60000 }
    );
    let parsed = null;
    try { parsed = JSON.parse(raw.replace(/^```json\s*|```$/g, '').trim()); } catch { parsed = null; }
    const out = finalizeTaskAssist(taskText, parsed);
    res.json({ ...out, hint: out.degraded ? 'AI 服务暂不可用，已保留原任务；下方资源链接仍可用' : undefined });
  } catch (err) {
    const out = finalizeTaskAssist(taskText, null);
    res.json({ ...out, hint: `AI 服务不可用（${err.message}），已保留原任务` });
  }
});

export default r;
