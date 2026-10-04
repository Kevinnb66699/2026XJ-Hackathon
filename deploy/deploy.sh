#!/usr/bin/env bash
# 一键部署：本地构建 → rsync 代码和 dist 到服务器 → 服务器用国内镜像装运行依赖 → 重启后端。
# 服务器访问 GitHub 不稳定，所以从笔记本推送，不在服务器上 git clone。
# 服务器上的 .env（Key）和 server/data（事件数据）不会被覆盖或删除。
# docs/ 和 patches/ 运行时用不到，也有只放本地的文件（录音、转写稿等），不传。
# 用法：bash deploy/deploy.sh            （默认 ubuntu@124.221.78.13:/srv/zhishi）
#       HOST=user@host DIR=/path bash deploy/deploy.sh
set -euo pipefail

HOST=${HOST:-ubuntu@124.221.78.13}
DIR=${DIR:-/srv/zhishi}

cd "$(dirname "$0")/.."
npm run check

rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .claude --exclude .env --exclude '.env.*' \
  --exclude server/data --exclude 'pipeline/.tmp' --exclude '参赛选手手册*' --exclude 'docs/Day *.pdf' \
  --exclude /docs/ --exclude /patches/ \
  ./ "$HOST:$DIR/"

ssh "$HOST" "cd $DIR && npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com && sudo systemctl restart zhishi && sleep 1 && curl -s http://127.0.0.1:8787/api/health"
echo
echo "部署完成。"
