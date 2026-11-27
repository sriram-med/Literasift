#!/usr/bin/env bash
# One-time setup (run as root on the VPS): lets the web server accept full-text PDF uploads up to 40 MB (the default here was 3 MB).
set -euo pipefail
sed -i 's/max_size 3MB/max_size 40MB/' /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy
grep -n max_size /etc/caddy/Caddyfile
echo "Uploads up to 40 MB are enabled."
