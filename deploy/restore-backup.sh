#!/usr/bin/env bash
# 把 deploy/backup.sh 做的一份加密备份解开到指定目录（恢复演练、找回误删的数据时用）。只写目标目录，不碰线上数据目录：
# 目标目录不存在就建（700）；已经存在而且不是空的就拒绝，除非带 --force（同名文件会被覆盖，别的文件不动）；
# 目标是线上数据目录（DATA_DIR，默认 /srv/zhishi/server/data）时一律拒绝，真要恢复到线上的步骤见 deploy/README.md「服务器运维」。
# 用法：sudo bash deploy/restore-backup.sh [--force] <备份文件> <目标目录>
#       KEY_FILE=…（默认 /etc/zhishi/backup.key，和备份时同一个）
set -euo pipefail
umask 077

KEY_FILE=${KEY_FILE:-/etc/zhishi/backup.key}
DATA_DIR=${DATA_DIR:-/srv/zhishi/server/data}

fail() {
  echo "恢复失败：$1" >&2
  exit 1
}
usage() {
  echo '用法：sudo bash deploy/restore-backup.sh [--force] <备份文件> <目标目录>' >&2
  exit 1
}

force=0
file=''
target=''
for a in "$@"; do
  case "$a" in
    --force) force=1 ;;
    -*) usage ;;
    *) if [ -z "$file" ]; then file=$a; elif [ -z "$target" ]; then target=$a; else usage; fi ;;
  esac
done
[ -n "$file" ] && [ -n "$target" ] || usage

[ -f "$file" ] || fail "找不到备份文件 $file"
[ -s "$KEY_FILE" ] || fail "找不到备份密钥 $KEY_FILE，或者它是空的"
[ ! -e "$target" ] || [ -d "$target" ] || fail "$target 已经存在，而且不是目录"
if [ -d "$target" ] && [ -d "$DATA_DIR" ] && [ "$(cd "$target" && pwd -P)" = "$(cd "$DATA_DIR" && pwd -P)" ]; then
  fail "$target 是线上数据目录，不往这里解；先解到别的目录，再按 deploy/README.md 的步骤换上去"
fi
if [ -d "$target" ] && [ -n "$(ls -A "$target")" ] && [ "$force" -ne 1 ]; then
  fail "$target 不是空的；确定要往里解（同名文件会被覆盖）就加 --force"
fi

mkdir -p -m 700 "$target"
openssl enc -d -aes-256-cbc -md sha256 -pbkdf2 -iter 200000 -pass "file:$KEY_FILE" -in "$file" | tar -xzf - -C "$target"
echo "已解到 $target"
