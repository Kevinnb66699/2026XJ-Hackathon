#!/usr/bin/env bash
# 把服务器上当前的学习事件移到存档文件（只移动、不删除），让老师端从零开始统计。
# 用在同学试用、展位开始之前。存档文件名带时间戳，后端只读 events-<讲义>.jsonl，存档不会被统计。
# 用法：bash deploy/archive-events.sh            （默认讲义 social-media）
#       HANDOUT=mini-phones bash deploy/archive-events.sh
set -euo pipefail

HOST=${HOST:-ubuntu@124.221.78.13}
DIR=${DIR:-/srv/zhishi}
HANDOUT=${HANDOUT:-social-media}

ssh "$HOST" "set -e
f=$DIR/server/data/events-$HANDOUT.jsonl
if [ ! -s \"\$f\" ]; then echo '没有需要存档的事件'; exit 0; fi
n=\$(wc -l < \"\$f\")
a=$DIR/server/data/events-$HANDOUT.archive-\$(date +%Y%m%d-%H%M%S).jsonl
mv \"\$f\" \"\$a\"
echo \"已存档 \$n 条事件 → \$a\"
ls -la $DIR/server/data/"
