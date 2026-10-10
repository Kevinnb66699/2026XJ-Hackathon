#!/usr/bin/env bash
# 知适数据目录的加密滚动备份（服务器上以 root 运行，由 zhishi-backup.timer 每天触发，见 deploy/README.md「服务器运维」）。
# 把 DATA_DIR 打成 tar.gz（跳过写到一半的 .tmp），用 KEY_FILE 第一行做口令、openssl AES-256-CBC + PBKDF2 加密，
# 先写同目录的 .tmp 再改名成 zhishi-data-YYYYMMDD-HHMMSS.tar.gz.enc（600）；成功后删掉 BACKUP_DIR 里早于 BACKUP_DAYS 天的旧备份
# 和超过 1 小时的残留 .tmp（中途被杀掉的那次留下的）。只输出一行：备份文件名和大小。不输出密钥。
# 用法：sudo bash deploy/backup.sh
#       DATA_DIR=… BACKUP_DIR=… KEY_FILE=… BACKUP_DAYS=… bash deploy/backup.sh（路径和天数都能覆盖，测试就这样跑）
# 解开用 deploy/restore-backup.sh（同一个密钥）。
set -euo pipefail
umask 077

DATA_DIR=${DATA_DIR:-/srv/zhishi/server/data}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/zhishi}
KEY_FILE=${KEY_FILE:-/etc/zhishi/backup.key}
BACKUP_DAYS=${BACKUP_DAYS:-30}

fail() {
  echo "备份失败：$1" >&2
  exit 1
}

# 密钥文件不在、是空的、第一行是空的都不备份（openssl 拿第一行做口令，空口令等于没加密）
[ -s "$KEY_FILE" ] || fail "找不到备份密钥 $KEY_FILE，或者它是空的"
awk 'NR == 1 { exit !length($0) }' "$KEY_FILE" || fail "备份密钥 $KEY_FILE 第一行是空的"
[ -d "$DATA_DIR" ] || fail "找不到数据目录 $DATA_DIR"
case "$BACKUP_DAYS" in
  '' | 0* | *[!0-9]*) fail "BACKUP_DAYS 要是正整数（现在是 $BACKUP_DAYS）" ;;
esac

# 不存在就建（700）；已经存在的目录不改权限（可能是别人也在用的目录）
[ -d "$BACKUP_DIR" ] || mkdir -p -m 700 "$BACKUP_DIR"

name="zhishi-data-$(date +%Y%m%d-%H%M%S).tar.gz.enc"
out="$BACKUP_DIR/$name"
tmp="$out.tmp"
trap 'rm -f "$tmp"' EXIT

# 服务在跑时打包：事件文件正在追加、临时文件刚改名，tar 会报「文件在读的时候变了 / 已经不在了」并退出 1，
# 这份备份照样能用（JSON 文件都是写临时文件再改名的，读到的是完整的旧版或新版）；退出码大于 1 才算失败。
# openssl 失败时 set -e 直接退出，trap 删掉 .tmp
set +o pipefail
tar -czf - --exclude='*.tmp' -C "$DATA_DIR" . |
  openssl enc -aes-256-cbc -md sha256 -pbkdf2 -iter 200000 -salt -pass "file:$KEY_FILE" -out "$tmp"
tar_status=${PIPESTATUS[0]}
set -o pipefail
[ "$tar_status" -le 1 ] || fail "打包 $DATA_DIR 出错（tar 退出码 $tar_status）"

chmod 600 "$tmp"
mv "$tmp" "$out"

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'zhishi-data-*.tar.gz.enc' -mmin +$((BACKUP_DAYS * 1440)) -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'zhishi-data-*.tar.gz.enc.tmp' -mmin +60 -delete

echo "$name $(wc -c < "$out" | tr -d ' ') 字节"
