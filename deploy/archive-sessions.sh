#!/usr/bin/env bash
# 把服务器上指定会话（sid）的学习事件移到存档文件（只移动、不删除），其他人的数据留着。
# 用在排练、录视频之后：只移走自己人的会话，朋友试用的数据不动。
# sid 怎么找：拿事件文件跑 npm run trial:funnel，按时间段认出排练、录视频的会话。
# 存档文件名带时间戳，后端只读 events-<讲义>.jsonl，存档和备份都不会被统计。
# 用法：bash deploy/archive-sessions.sh [--dry] [--handout social-media] SID [SID...]
#       --dry 只打印每个 sid 有几条事件，不改任何文件
#       本地试跑：DATA_DIR=<目录> bash deploy/archive-sessions.sh ...（不连服务器，直接处理这个目录）
set -euo pipefail

HOST=${HOST:-ubuntu@124.221.78.13}
DIR=${DIR:-/srv/zhishi}
HANDOUT=${HANDOUT:-social-media}
DRY=0
SIDS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry) DRY=1 ;;
    --handout) HANDOUT=${2:?--handout 后面要写讲义 id}; shift ;;
    -*) echo "不认识的参数：$1" >&2; exit 1 ;;
    *) SIDS+=("$1") ;;
  esac
  shift
done
if [ ${#SIDS[@]} -eq 0 ]; then
  echo '用法：bash deploy/archive-sessions.sh [--dry] [--handout social-media] SID [SID...]' >&2
  exit 1
fi
# 只收字母、数字、下划线、短横线：要拼进远程命令和 grep 的匹配串
for s in "$HANDOUT" "${SIDS[@]}"; do
  if [[ ! $s =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then echo "不合法：$s" >&2; exit 1; fi
done

# 下面的脚本在服务器上跑（设了 DATA_DIR 就在本机跑）
run() {
  if [ -n "${DATA_DIR:-}" ]; then bash -s -- "$DATA_DIR" "$@"; else ssh "$HOST" bash -s -- "$DIR/server/data" "$@"; fi
}
run "$HANDOUT" "$DRY" "${SIDS[@]}" <<'EOF'
set -euo pipefail
data=$1 handout=$2 dry=$3
shift 3
f=$data/events-$handout.jsonl
echo "事件文件：$f"
if [ ! -s "$f" ]; then echo '没有事件'; exit 0; fi
# 后端用 JSON.stringify 写，键值之间没有空格；带上结尾引号，stu-ab 不会匹配到 stu-abc
pats=()
for s in "$@"; do
  pats+=(-e "\"sid\":\"$s\"")
  echo "$s：$(grep -acF "\"sid\":\"$s\"" "$f" || true) 条"
done
n=$(grep -acF "${pats[@]}" "$f" || true)
if [ "$dry" = 1 ]; then echo "试跑：共 $n 条会移走，没有改动"; exit 0; fi
if [ "$n" = 0 ]; then echo '没有要移走的事件'; exit 0; fi

ts=$(date +%Y%m%d-%H%M%S)
bak=$data/events-$handout.bak-$ts.jsonl
arc=$data/events-$handout.archive-sessions-$ts.jsonl
keep=$data/events-$handout.keep-$ts.jsonl
new=$data/events-$handout.new-$ts.jsonl
if [ -e "$bak" ]; then echo "已有 $bak，过一秒再跑" >&2; exit 1; fi
# 原文件整份改名当备份。后端每批事件都是重新打开文件追加、每次读也重新打开，改名后下一批会新建原文件
mv "$f" "$bak"
grep -aF "${pats[@]}" "$bak" >> "$arc"
grep -avF "${pats[@]}" "$bak" > "$keep" || [ $? -eq 1 ]
# 放回原名，改名期间新到的事件接在后面。原名已存在时 ln 会失败，不会盖掉新到的事件
until ln "$keep" "$f" 2>/dev/null; do
  mv "$f" "$new"
  cat "$new" >> "$keep"
  rm "$new"
done
rm "$keep"
echo "已存档 $n 条事件 → $arc"
echo "留下 $(grep -c '' "$f" || true) 条；移动前的整份备份 → $bak"
EOF
