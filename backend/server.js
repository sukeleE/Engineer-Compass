// Engineer-Compass 工科竞赛导航系统 后端入口
// 启动：npm start（默认 http://localhost:3000）
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { existsSync } from 'node:fs';
import db from './db/database.js';
import competitions from './routes/competitions.js';
import ai from './routes/ai.js';
import taskAssist from './routes/taskAssist.js';
import schedule from './routes/schedule.js';
import study from './routes/study.js';
import auth from './routes/auth.js';
import notes from './routes/notes.js';
import team from './routes/team.js';
import teamCollab from './routes/teamCollab.js';
import checkin from './routes/checkin.js';
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
import github from './routes/github.js';
import { configured as githubConfigured } from './lib/githubClient.js';
import expense from './routes/expense.js';
import purchase from './routes/purchase.js';
import booking from './routes/booking.js';
import honor, { adminR as adminHonor } from './routes/honor.js';
import { hasSMTP } from './routes/mailer.js';
import { accessLog } from './routes/middleware.js';
import { sweepStaging } from './lib/shareFiles.js';
import { sweepOrphanHonorFiles } from './lib/honorFiles.js';
import { sweepOrphanPurchaseFiles } from './lib/purchaseFiles.js';
import { runCheckinReminders } from './lib/checkin.js';

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
app.use('/api/team', checkin);
app.use('/api/feedback', feedback);
app.use('/api/users', users);
app.use('/api/plan-chat', planChat);
app.use('/api/share', share);
app.use('/api/friends', friends);
app.use('/api/ghost', ghost);
app.use('/api/notifications', notifications);
app.use('/api/admin/honors', adminHonor); // 必须排在 /api/admin 之前（否则要先白跑一遍 admin 的鉴权）
app.use('/api/admin', admin);
app.use('/api/honor', honor); // 荣誉墙：前台公开只读（无需登录）
app.use('/api/announcements', publicAnnounce);
app.use('/api/resource', publicR); // 公开分享下载先声明（无鉴权，token 即钥匙）；主 router 挂在后
app.use('/api/resource', resource);
app.use('/api/import', importPlan);
app.use('/api/feishu', feishu);
app.use('/api/github', github); // GitHub OAuth：账号绑定 + 一键登录（未配 env 时仅 configured/status 可用）
app.use('/api/expense', expense);
app.use('/api/purchase', purchase); // 物料采购申请（登录制：学生申请/负责人·老师按档案审批/发票上传）
app.use('/api/booking', booking); // 资源预约（项目资源台账：空间独占/物品库存池，资源级审批开关，甘特可视化）
// 飞书互传工作台页面（独立静态工具页，不参与业务）
app.use(express.static('public'));

// 健康检查（部署后验证：ai=true 表示线上用户 AI 功能可用；vision=true 表示报销票据图片识别可用；
// mail=true 表示邮箱登录发真邮件；gitee=true 表示配了 GITEE_ACCESS_TOKEN —— 只是配额更高，
// 公开仓库不配也能拉，所以它是可选增强而非功能开关；github=true 表示 GitHub 绑定/一键登录可用）
app.get('/api/health', (req, res) => {
  res.json({
    ok: true, name: 'Engineer-Compass API', time: new Date().toISOString(),
    ai: !!process.env.DEEPSEEK_API_KEY,
    vision: !!process.env.VISION_API_KEY,
    mail: hasSMTP(),
    gitee: !!process.env.GITEE_ACCESS_TOKEN,
    github: githubConfigured(),
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

// 分享文件夹的暂存清理：用户传完文件夹又关掉弹窗，行/文件就永远绑不上帖（24h 宽限）
try {
  const n = sweepStaging();
  if (n) console.log(`🧹 已清理 ${n} 个超期未发布的分享文件夹暂存文件`);
} catch (e) { console.error('暂存清理失败（不影响启动）:', e.message); }

// 荣誉墙孤儿图：已落盘但没写进 DB 的（配额校验不过、进程被杀在中间），盘上会永久占着
try {
  const n = sweepOrphanHonorFiles();
  if (n) console.log(`🧹 已清理 ${n} 张无主的荣誉墙奖状图`);
} catch (e) { console.error('荣誉墙清理失败（不影响启动）:', e.message); }

// 物料采购无主附件（multer 落盘后写库失败/进程被杀的残留；24h 宽限）
try {
  const n = sweepOrphanPurchaseFiles();
  if (n) console.log(`🧹 已清理 ${n} 个无主的采购附件`);
} catch (e) { console.error('采购附件清理失败（不影响启动）:', e.message); }

// 定期自动清理：三类无主/暂存文件，默认每 15 天一轮（CLEANUP_INTERVAL_HOURS 可调，单位小时）。
// 定时只在运行期补上「长期不重启」的空窗——启动时上面三段仍会先跑一遍。
const CLEANUP_INTERVAL_HOURS = Number(process.env.CLEANUP_INTERVAL_HOURS) || 15 * 24;
let cleanupRunning = false;
function runPeriodicCleanup() {
  if (cleanupRunning) return; // 上一轮没跑完不重入
  cleanupRunning = true;
  const tasks = [
    ['分享暂存文件', sweepStaging],
    ['荣誉墙无主图', sweepOrphanHonorFiles],
    ['采购无主附件', sweepOrphanPurchaseFiles],
  ];
  (async () => {
    for (const [label, fn] of tasks) {
      try {
        const n = fn();
        if (n) console.log(`🧹 定时清理：${label} ${n} 个（${new Date().toLocaleString('zh-CN')}）`);
      } catch (e) { console.error(`定时清理失败（${label}，不影响服务）:`, e.message); }
    }
  })().finally(() => { cleanupRunning = false; });
}
const cleanupTimer = setInterval(runPeriodicCleanup, CLEANUP_INTERVAL_HOURS * 3600 * 1000);
cleanupTimer.unref(); // 不拖住进程退出

// 打卡提醒：每 10 分钟扫描应交未交的周期打卡（截止前 1 小时「即将截止」、过期 15 分钟「未提交」）。
// 惰性去重：同任务同期同阶段每人仅一条未读通知；按 personal_notice(type,link,is_read) 自然去重。
function runCheckinOnce() {
  try {
    const n = runCheckinReminders(db);
    if (n) console.log(`🔔 打卡提醒：发出 ${n} 条（${new Date().toLocaleString('zh-CN')}）`);
  } catch (e) { console.error('打卡提醒扫描失败（不影响服务）:', e.message); }
}
const checkinTimer = setInterval(runCheckinOnce, 10 * 60 * 1000);
checkinTimer.unref();
setTimeout(runCheckinOnce, 20 * 1000); // 启动 20 秒后补跑一次（重启即恢复提醒）

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Engineer-Compass API 已启动: http://localhost:${PORT}`);
  console.log('   接口: /api/health | /api/competition | /api/ai/chat | /api/schedule');
});
