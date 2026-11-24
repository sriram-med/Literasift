#!/usr/bin/env bash
# One-time setup (run as root on the VPS): installs an updater and a systemd timer that deploys new commits automatically.
# Usage: curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/<branch>/deploy/enable-autoupdate.sh | bash
set -euo pipefail
REPO_URL="${REPO_URL:-https://github.com/sriram-med/Literasift}"
REPO_BRANCH="${REPO_BRANCH:-claude/vigilant-planck-42pjio}"
export DEBIAN_FRONTEND=noninteractive
command -v git >/dev/null || apt-get install -y git
command -v flock >/dev/null || apt-get install -y util-linux

mkdir -p /opt/literasift /var/lib/literasift
if [ ! -d /opt/literasift-src/.git ]; then
  rm -rf /opt/literasift-src && git init -q /opt/literasift-src
fi

cat > /etc/literasift-update.conf <<CONF
REPO_URL="$REPO_URL"
REPO_BRANCH="$REPO_BRANCH"
CONF

# Read-only deploy key, used only if the repository is (or becomes) private.
mkdir -p /root/.ssh && chmod 700 /root/.ssh
[ -f /root/.ssh/literasift_deploy ] || ssh-keygen -q -t ed25519 -N '' -C literasift-vps -f /root/.ssh/literasift_deploy

# Public address used in emailed links, and placeholders for optional email delivery.
DOMAIN="${DOMAIN:-literasift.tech}"
if [ -f /etc/literasift.env ]; then
  grep -q '^PUBLIC_URL=' /etc/literasift.env || echo "PUBLIC_URL=https://$DOMAIN" >> /etc/literasift.env
  grep -q 'SMTP_HOST' /etc/literasift.env || cat >> /etc/literasift.env <<'ENVMAIL'
# Optional: email invites and password resets (SMTP over TLS, port 465). Without these, managers are shown links to share.
#SMTP_HOST=smtp.example.com
#SMTP_PORT=465
#SMTP_USER=
#SMTP_PASS=
#MAIL_FROM=LiteraSift <noreply@example.com>
ENVMAIL
  systemctl restart literasift 2>/dev/null || true
fi

cat > /usr/local/bin/literasift-update <<'UPD'
#!/usr/bin/env bash
# Deploys the latest commit of the configured branch. Safe to run any time: it does nothing if already current,
# checks the new code before swapping it in, and rolls back if the service does not become healthy.
set -uo pipefail
CONF="${LITERASIFT_CONF:-/etc/literasift-update.conf}"; . "$CONF"
SRC="${LITERASIFT_SRC:-/opt/literasift-src}"; APP="${LITERASIFT_APP:-/opt/literasift}"
RESTART="${LITERASIFT_RESTART:-systemctl restart literasift}"
HEALTH="${LITERASIFT_HEALTH:-http://127.0.0.1:8787/healthz}"
LOCK="${LITERASIFT_LOCK:-/var/lock/literasift-update.lock}"
exec 9>"$LOCK"; flock -n 9 || exit 0
export GIT_TERMINAL_PROMPT=0
SSH_URL=$(echo "$REPO_URL" | sed -E 's#^https://github.com/#git@github.com:#; s#(\.git)?$#.git#')
if ! git -C "$SRC" fetch -q --depth 1 "$REPO_URL" "$REPO_BRANCH" 2>/dev/null; then
  GIT_SSH_COMMAND="ssh -i /root/.ssh/literasift_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
    git -C "$SRC" fetch -q --depth 1 "$SSH_URL" "$REPO_BRANCH" || { echo "literasift-update: cannot reach the repository (is it private without a deploy key?)"; exit 1; }
fi
new=$(git -C "$SRC" rev-parse FETCH_HEAD)
[ "${1:-}" = "--force" ] || { [ "$new" = "$(cat "$APP/.version" 2>/dev/null)" ] && exit 0; [ "$new" = "$(cat "$APP/.failed" 2>/dev/null)" ] && exit 0; }
git -C "$SRC" reset -q --hard FETCH_HEAD
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cp -r "$SRC/package.json" "$SRC/worker" "$SRC/server" "$tmp/"
if ! node --check "$tmp/worker/index.js" || ! node --check "$tmp/server/index.mjs"; then
  echo "$new" > "$APP/.failed"; echo "literasift-update: $new failed syntax check; keeping current version"; exit 1
fi
rm -rf "$APP.prev"; cp -a "$APP" "$APP.prev"
rm -rf "$APP/server" "$APP/worker"; cp -r "$tmp/server" "$tmp/worker" "$tmp/package.json" "$APP/"
$RESTART 9>&-
for i in $(seq 1 20); do
  curl -fsS "$HEALTH" >/dev/null 2>&1 && { echo "$new" > "$APP/.version"; rm -f "$APP/.failed"; echo "literasift-update: deployed $new"; exit 0; }
  sleep 2
done
echo "literasift-update: $new did not become healthy; rolling back"
rm -rf "$APP/server" "$APP/worker"; cp -r "$APP.prev/server" "$APP.prev/worker" "$APP.prev/package.json" "$APP/"
echo "$new" > "$APP/.failed"; $RESTART 9>&-
for i in $(seq 1 20); do curl -fsS "$HEALTH" >/dev/null 2>&1 && { echo "literasift-update: rolled back; service healthy"; exit 1; }; sleep 2; done
echo "literasift-update: ROLLBACK ALSO UNHEALTHY - check: journalctl -u literasift -n 50"; exit 1
UPD
chmod +x /usr/local/bin/literasift-update

cat > /etc/systemd/system/literasift-update.service <<'UNIT'
[Unit]
Description=Deploy new LiteraSift commits
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/literasift-update
UNIT
cat > /etc/systemd/system/literasift-update.timer <<'UNIT'
[Unit]
Description=Check for new LiteraSift commits every 3 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=3min
AccuracySec=15s

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now literasift-update.timer
/usr/local/bin/literasift-update --force || true

echo
echo "Auto-deploy is on: new commits on '$REPO_BRANCH' go live within about 3 minutes."
echo "Check it with:  journalctl -u literasift-update -n 20 --no-pager"
echo
echo "Optional, to make the GitHub repo private again: add this read-only deploy key at"
echo "  GitHub > repository > Settings > Deploy keys > Add deploy key (leave 'Allow write access' OFF):"
cat /root/.ssh/literasift_deploy.pub
