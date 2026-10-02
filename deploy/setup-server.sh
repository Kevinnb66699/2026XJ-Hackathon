#!/usr/bin/env bash
# 服务器首次配置（只需一次）：建目录、装 systemd 服务、新增一个 Nginx 站点。
# 不改服务器上已有的其他站点；Nginx 配置测试不通过时自动撤回，不 reload。
# 用法：DOMAIN=zhishi.example.com bash deploy/setup-server.sh
set -euo pipefail

HOST=${HOST:-ubuntu@124.221.78.13}
DIR=${DIR:-/srv/zhishi}
DOMAIN=${DOMAIN:?请提供域名，例如 DOMAIN=zhishi.example.com}

cd "$(dirname "$0")/.."

# 已配置过的站点（certbot 已经往里写了 HTTPS 配置）不要覆盖，除非显式 FORCE=1
if ssh "$HOST" "test -e /etc/nginx/sites-available/zhishi" && [ "${FORCE:-0}" != "1" ]; then
  echo "服务器上已有 zhishi 站点配置（可能含 certbot 写入的 HTTPS），为避免覆盖已停止。确需重装：FORCE=1 DOMAIN=$DOMAIN bash deploy/setup-server.sh，之后重新运行 certbot。"
  exit 1
fi

tmp_nginx=$(mktemp)
sed -e "s/server_name _;/server_name $DOMAIN;/" -e "s#/srv/zhishi#$DIR#g" deploy/nginx.conf.example > "$tmp_nginx"
tmp_unit=$(mktemp)
sed -e "s#/srv/zhishi#$DIR#g" -e "s#^EnvironmentFile=/#EnvironmentFile=-/#" deploy/zhishi.service > "$tmp_unit"

ssh "$HOST" "sudo mkdir -p $DIR && sudo chown \$(whoami) $DIR"
scp "$tmp_unit" "$HOST:/tmp/zhishi.service"
scp "$tmp_nginx" "$HOST:/tmp/zhishi.nginx"
rm -f "$tmp_unit" "$tmp_nginx"

ssh "$HOST" "set -e
sudo mv /tmp/zhishi.service /etc/systemd/system/zhishi.service
sudo systemctl daemon-reload
sudo systemctl enable zhishi
sudo mv /tmp/zhishi.nginx /etc/nginx/sites-available/zhishi
sudo ln -sf /etc/nginx/sites-available/zhishi /etc/nginx/sites-enabled/zhishi
if sudo nginx -t; then
  sudo systemctl reload nginx
else
  sudo rm -f /etc/nginx/sites-enabled/zhishi
  echo 'Nginx 配置测试失败，已撤回新站点，其他站点不受影响'
  exit 1
fi"

echo "首次配置完成。接下来："
echo "1. 把 Key 放到服务器（队长执行）：scp .env $HOST:$DIR/.env && ssh $HOST chmod 600 $DIR/.env"
echo "2. 部署：bash deploy/deploy.sh"
echo "3. HTTPS：ssh $HOST sudo certbot --nginx -d $DOMAIN --non-interactive --redirect"
