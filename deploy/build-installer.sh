#!/usr/bin/env bash
# Usage: DOMAIN=literasift.tech ADMIN_EMAIL=you@example.com bash deploy/build-installer.sh
# Produces dist/install-literasift.sh (must stay under Hostinger's 48 KB post-install script limit).
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
out="$root/dist/install-literasift.sh"
mkdir -p "$root/dist"
sed -e "s|__DOMAIN__|${DOMAIN:-literasift.tech}|" -e "s|__ADMIN_EMAIL__|${ADMIN_EMAIL:-}|" "$root/deploy/install.sh.tpl" > "$out"
tar -czf - -C "$root" package.json worker server | base64 -w0 >> "$out"
echo >> "$out"
chmod +x "$out"
echo "Built $out ($(wc -c < "$out") bytes)"
