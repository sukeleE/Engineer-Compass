// 用户反馈：存库留档 + 邮件转发给管理员（FEEDBACK_TO，默认 3209646785@qq.com）
import { Router } from 'express';
import db from '../db/database.js';
import { authRequired } from './middleware.js';
import sendMail from './mailer.js';

const r = Router();
const ADMIN = process.env.FEEDBACK_TO || '3209646785@qq.com';
// 用户输入拼 HTML 前必须转义（防 HTML 注入 + QQ 邮箱渲染错乱）
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// POST /api/feedback — 提交反馈（需登录）
r.post('/', authRequired, async (req, res) => {
  const content = String(req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: '反馈内容不能为空' });
  if (content.length > 5000) return res.status(400).json({ error: '反馈内容最多 5000 字' });

  db.prepare('INSERT INTO feedback (user_id, content, contact_email) VALUES (?,?,?)')
    .run(req.user.id, content, req.user.email || '');

  const html = `<div style="font-family:system-ui;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px">
    <h2 style="margin:0 0 12px;color:#1e293b">📮 Engineer-Compass 用户反馈</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;color:#475569">
      <tr><td style="padding:4px 0;width:90px">用户昵称</td><td style="font-weight:600">${esc(req.user.nickname)}</td></tr>
      <tr><td style="padding:4px 0">登录名</td><td>${esc(req.user.username)}</td></tr>
      <tr><td style="padding:4px 0">联系邮箱</td><td>${esc(req.user.email || '未绑定')}</td></tr>
      <tr><td style="padding:4px 0">用户 ID</td><td>${req.user.id}</td></tr>
      <tr><td style="padding:4px 0">提交时间</td><td>${new Date().toLocaleString('zh-CN')}</td></tr>
    </table>
    <div style="margin-top:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px;line-height:1.8;font-size:14px;white-space:pre-wrap">${esc(content)}</div>
  </div>`;
  try {
    const sent = await sendMail({ to: ADMIN, subject: '【Engineer-Compass】用户反馈', html });
    if (sent.dev) console.log(`📧 [DEV] 反馈邮件（未配置 SMTP，未真实发送）→ ${ADMIN}`);
  } catch (e) {
    console.error('反馈邮件发送失败（不影响提交）:', e.message);
  }
  res.json({ message: '反馈已提交，感谢你的建议！' });
});

export default r;
