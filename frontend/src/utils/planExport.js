// 计划导出工具：计划对象 → Markdown 文本；下载 .md 文件；导出到飞书（新建飞书文档写入内容）
// 三处共用（备赛日程 ScheduleView / 学习日程 StudyView / 小组计划 TeamPlanView），title 用调用方传入的计划名
import { api } from '../api.js';

// 计划 → Markdown：phases 结构 {phase,date,tasks:[{text,done}],check_standard,week_hours}；study 额外 summary
export function planToMarkdown(title, plan) {
  const L = [`# ${title}`];
  if (plan?.summary) L.push('', plan.summary);
  for (const [i, ph] of (plan?.phases || []).entries()) {
    L.push('', `## 阶段${i + 1}：${ph.phase || ''}`);
    if (ph.date) L.push(`> 🗓️ ${ph.date}`);
    for (const t of (ph.tasks || [])) {
      const text = typeof t === 'string' ? t : t.text;
      if (!text) continue;
      L.push(`- ${t?.done ? '☑' : '☐'} ${text}`);
    }
    if (ph.check_standard) L.push('', `- **达标要求**：${ph.check_standard}`);
    if (ph.week_hours) L.push(`- **每周时长**：${ph.week_hours} 小时`);
  }
  return L.join('\n');
}

// 下载 .md 到本地（UTF-8 BOM：Windows 记事本打开中文不乱码）
export function downloadPlanMd(filename, title, plan) {
  const md = planToMarkdown(title, plan);
  const blob = new Blob(['﻿' + md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// 导出到飞书：新建飞书文档（标题加 📋 前缀）写入计划内容，返回 {url, document_id}
// 未绑定飞书时后端返回 403「请先在『我的』页绑定飞书账号」——由调用方提示
export async function exportPlanToFeishu(title, plan) {
  const md = planToMarkdown(title, plan);
  const r = await api.feishuDocCreate({ title: `📋 ${title}`, content: md });
  window.open(r.url, '_blank');
  return r;
}
