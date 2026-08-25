// Engineer-Compass 工科竞赛导航系统 后端入口
// 启动：npm start（默认 http://localhost:3000）
import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import competitions from './routes/competitions.js';
import ai from './routes/ai.js';
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
import { hasSMTP } from './routes/mailer.js';

// 加载 .env（Node 24 内置）；mailer 配置为惰性读取（调用时读 process.env），加载顺序无影响
if (existsSync('.env')) process.loadEnvFile('.env');

const app = express();
app.use(cors());
app.use(express.json({ limit: '30mb' })); // 资料上传走 base64 JSON（20MB 文件 → ~27MB）

app.use('/api/competition', competitions);
app.use('/api/ai', ai);
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
  console.error(err);
  res.status(500).json({ error: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Engineer-Compass API 已启动: http://localhost:${PORT}`);
  console.log('   接口: /api/health | /api/competition | /api/ai/chat | /api/schedule');
});
