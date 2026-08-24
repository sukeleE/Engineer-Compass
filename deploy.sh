#!/usr/bin/env bash
# Engineer-Compass 一键部署脚本（Linux 服务器，方案A：Nginx 静态托管 + PM2 守护后端）
# 用法：bash deploy.sh
# 前置：代码已克隆到 APP_DIR、已装 Node 24 + PM2 + Nginx、backend/.env 已配好（含 DEEPSEEK_API_KEY）
set -e

APP_DIR=/opt/compass          # git 仓库根目录（脚本所在处可改）
BACKEND_DIR=$APP_DIR/backend
FRONTEND_DIR=$APP_DIR/frontend
WEB_DIR=/var/www/compass      # Nginx 静态文件目录
BACKUP_DIR=$APP_DIR/backups   # 数据库备份目录

cd "$APP_DIR"

# 1. 备份数据库（更新前安全网，一条命令可回滚数据；首次部署无库则跳过）
if [ -f "$BACKEND_DIR/data/compass.db" ]; then
  mkdir -p "$BACKUP_DIR"
  cp "$BACKEND_DIR/data/compass.db" "$BACKUP_DIR/compass-$(date +%Y%m%d-%H%M%S).db"
  echo "✅ 数据库已备份"
else
  echo "ℹ️ 首次部署：暂无数据库（后端启动时自动创建），跳过备份"
fi

# 2. 拉取最新代码
git pull
echo "✅ 代码已更新（当前: $(git log --oneline -1)）"

# 3. 后端：装依赖（没变则秒级）+ 重启（启动时自动迁移表结构，无需手动操作）
cd "$BACKEND_DIR"
npm install --omit=dev
pm2 restart compass --update-env || pm2 start server.js --name compass --cwd "$BACKEND_DIR"
echo "✅ 后端已重启"

# 4. 前端：构建 + 发布到 Nginx
cd "$FRONTEND_DIR"
npm install
npm run build
mkdir -p "$WEB_DIR"
cp -r dist/* "$WEB_DIR/"
echo "✅ 前端已发布"

# 5. 验收：health 输出 ai:true 即线上用户 AI 可用
echo "----- 部署完成 -----"
curl -s http://localhost:3000/api/health || echo "⚠️ 后端 health 检查失败"
echo
echo "页面: http://服务器IP  |  AI 状态见上方 health 输出"
