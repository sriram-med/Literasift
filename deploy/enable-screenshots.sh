#!/usr/bin/env bash
# One-time setup (run as root on the VPS): installs Playwright + Chromium so LiteraSift can screenshot every article page.
# Usage: bash /opt/literasift-src/deploy/enable-screenshots.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
command -v npm >/dev/null || apt-get install -y npm
mkdir -p /opt/literasift-shots/browsers
cd /opt/literasift-shots
[ -f package.json ] || echo '{"name":"literasift-shots","private":true,"type":"module"}' > package.json
npm install --no-audit --no-fund playwright
PLAYWRIGHT_BROWSERS_PATH=/opt/literasift-shots/browsers npx playwright install --with-deps chromium
chmod -R a+rX /opt/literasift-shots
grep -q '^PLAYWRIGHT_BROWSERS_PATH=' /etc/literasift.env || echo 'PLAYWRIGHT_BROWSERS_PATH=/opt/literasift-shots/browsers' >> /etc/literasift.env
grep -q '^HOME=' /etc/literasift.env || echo 'HOME=/var/lib/literasift' >> /etc/literasift.env
systemctl restart literasift
sleep 3
journalctl -u literasift -n 5 --no-pager | grep -i screenshots || true
echo "Screenshots enabled. New articles are captured automatically; existing ones are picked up by the next scheduled run."
