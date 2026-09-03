// Engineer-Compass 工科竞赛导航系统 后端入口
// 启动：npm start（默认 http://localhost:3000）
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { existsSync } from 'node:fs';
import competitions from './routes/competitions.js';
import ai from './routes/ai.js';
import taskAssist from './routes/taskAssist.js';
import schedule from './routes/schedule.js';
import study from './routes/study.js';
import auth from './routes/auth.js';
import notes from './routes/notes.js';
import team from './routes/team.js';
import teamCollab from './routes/teamCollab.js';
import feedback from './routes/feedback.js';
import users from './routes/users.js';
import planChat from './routes/planChat.js';
import share from './routes/share.js';
import friends from './routes/friends.js';
import ghost from './routes/ghost.js';
import notifications from './routes/notifications.js';
import admin, { publicAnnounce } from './routes/admin.js';
import resource, { publicR } from './routes/resource.js';
import importPlan from './routes/importPlan.js';
import feishu from './routes/feishu.js';
import expense from './routes/expense.js';
import { hasSMTP } from './routes/mailer.js';
import { accessLog } from './routes/middleware.js';

// 加载 .env（Node 24 内置）；mailer 配置为惰性读取（调用时读 process.env），加载顺序无影响
if (existsSync('.env')) process.loadEnvFile('.env');

const app = express();
app.use(cors());
app.use(express.json({ limit: '30mb' })); // 资料上传走 base64 JSON（20MB 文件 → ~27MB）

// 访问日志：认证前挂载（游客/认证失败也记录），health 探活不算噪音
app.use('/api', (req, res, next) => (req.originalUrl === '/api/health' ? next() : accessLog(req, res, next)));

app.use('/api/competition', competitions);
app.use('/api/ai', ai);
app.use('/api/ai', taskAssist);
app.use('/api/schedule', schedule);
app.use('/api/study', study);
app.use('/api/auth', auth);
app.use('/api/notes', notes);
app.use('/api/team', team);
app.use('/api/team', teamCollab);
app.use('/api/feedback', feedback);
app.use('/api/users', users);
app.use('/api/plan-chat', planChat);
app.use('/api/share', share);
app.use('/api/friends', friends);
app.use('/api/ghost', ghost);
app.use('/api/notifications', notifications);
app.use('/api/admin', admin);
app.use('/api/announcements', publicAnnounce);
app.use('/api/resource', publicR); // 公开分享下载先声明（无鉴权，token 即钥匙）；主 router 挂在后
app.use('/api/resource', resource);
app.use('/api/import', importPlan);
app.use('/api/feishu', feishu);
app.use('/api/expense', expense);
// 飞书互传工作台页面（独立静态工具页，不参与业务）
app.use(express.static('public'));

// 健康检查（部署后验证：ai=true 表示线上用户 AI 功能可用；mail=true 表示邮箱登录发真邮件）
app.get('/api/health', (req, res) => {
  res.json({
    ok: true, name: 'Engineer-Compass API', time: new Date().toISOString(),
    ai: !!process.env.DEEPSEEK_API_KEY,
    mail: hasSMTP(),
  });
});

app.use((req, res) => res.status(404).json({ error: '接口不存在', path: req.path }));
app.use((err, req, res, next) => {
  // multer 上传错误（LIMIT_FILE_SIZE 等）与 express.json 超限（entity.too.large）给中文 413
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '文件过大（单文件 ≤128MB）' });
    return res.status(400).json({ error: `上传失败：${err.message}` });
  }
  if (err.type === 'entity.too.large') return res.status(413).json({ error: '请求体过大' });
  console.error(err);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Engineer-Compass API 已启动: http://localhost:${PORT}`);
  console.log('   接口: /api/health | /api/competition | /api/ai/chat | /api/schedule');
});
