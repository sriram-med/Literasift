#!/usr/bin/env bash
# LiteraSift installer for a fresh Ubuntu VPS (run as root). Clones the app from Git, so the repository must be readable from the VPS.
set -euo pipefail
exec > >(tee -a /var/log/literasift-install.log) 2>&1
DOMAIN="__DOMAIN__"
ADMIN_EMAIL="__ADMIN_EMAIL__"
REPO_URL="__REPO_URL__"
REPO_BRANCH="__REPO_BRANCH__"
export DEBIAN_FRONTEND=noninteractive
echo "== LiteraSift install $(date -u +%FT%TZ)"

apt-get update -y
apt-get install -y curl ca-certificates openssl ufw caddy git
if ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
  apt-get install -y nodejs || true
  if ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
fi
node -v

id literasift >/dev/null 2>&1 || useradd --system --home /opt/literasift --shell /usr/sbin/nologin literasift
mkdir -p /opt/literasift /var/lib/literasift
rm -rf /opt/literasift-src
git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" /opt/literasift-src
cp -r /opt/literasift-src/package.json /opt/literasift-src/worker /opt/literasift-src/server /opt/literasift/
chown -R root:root /opt/literasift
chown -R literasift:literasift /var/lib/literasift
chmod 700 /var/lib/literasift

if [ ! -f /etc/literasift.env ]; then
  umask 077
  cat > /etc/literasift.env <<ENV
PORT=8787
HOST=127.0.0.1
DATA_DIR=/var/lib/literasift
SESSION_SECRET=$(openssl rand -hex 32)
RUN_TOKEN=$(openssl rand -hex 32)
SCHEDULE_MINUTES=60
PUBLIC_URL=https://$DOMAIN
# Optional integrations:
#UNPAYWALL_EMAIL=
#CROSSREF_EMAIL=
#SCREENSHOT_ENDPOINT=
#SCREENSHOT_TOKEN=
# Optional: email invites and password resets (SMTP over TLS, port 465).
#SMTP_HOST=
#SMTP_PORT=465
#SMTP_USER=
#SMTP_PASS=
#MAIL_FROM=LiteraSift <noreply@example.com>
ENV
fi

cat > /etc/systemd/system/literasift.service <<UNIT
[Unit]
Description=LiteraSift
After=network-online.target
Wants=network-online.target

[Service]
User=literasift
EnvironmentFile=/etc/literasift.env
WorkingDirectory=/opt/literasift
ExecStart=/usr/bin/node /opt/literasift/server/index.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/literasift

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/caddy/Caddyfile <<CADDY
www.$DOMAIN {
	redir https://$DOMAIN{uri} permanent
}
$DOMAIN {
	encode zstd gzip
	request_body {
		max_size 3MB
	}
	reverse_proxy 127.0.0.1:8787
}
CADDY

cat > /usr/local/bin/literasift-user <<'CLI'
#!/usr/bin/env bash
# Usage: literasift-user set <email> | remove <email> | list
exec runuser -u literasift -- env DATA_DIR=/var/lib/literasift node /opt/literasift/server/users.mjs "$@"
CLI
chmod +x /usr/local/bin/literasift-user


if [ -n "$ADMIN_EMAIL" ] && [ -z "$(literasift-user list | grep -x "$ADMIN_EMAIL" || true)" ]; then
  umask 077
  PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)A1
  LITERASIFT_PASSWORD="$PASS" literasift-user set "$ADMIN_EMAIL"
  printf 'Sign in at https://%s\nEmail: %s\nPassword: %s\n(Change it: literasift-user set %s)\n' "$DOMAIN" "$ADMIN_EMAIL" "$PASS" "$ADMIN_EMAIL" > /root/literasift-admin.txt
fi

ufw allow OpenSSH || true
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

systemctl daemon-reload
systemctl enable --now literasift
systemctl enable caddy
systemctl restart caddy
REPO_URL="$REPO_URL" REPO_BRANCH="$REPO_BRANCH" bash /opt/literasift-src/deploy/enable-autoupdate.sh
echo "== Done. Credentials (if created): /root/literasift-admin.txt"
exit 0
