#!/usr/bin/env bash
# Usage: DOMAIN=literasift.tech ADMIN_EMAIL=you@example.com REPO_URL=https://github.com/owner/repo REPO_BRANCH=main bash deploy/build-installer.sh
# Produces dist/install-literasift.sh (small enough for Hostinger's 48 KB post-install script limit).
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
out="$root/dist/install-literasift.sh"
mkdir -p "$root/dist"
sed -e "s|__DOMAIN__|${DOMAIN:-literasift.tech}|" -e "s|__ADMIN_EMAIL__|${ADMIN_EMAIL:-}|" \
    -e "s|__REPO_URL__|${REPO_URL:-https://github.com/sriram-med/Literasift}|" -e "s|__REPO_BRANCH__|${REPO_BRANCH:-main}|" \
    "$root/deploy/install.sh.tpl" > "$out"
chmod +x "$out"
echo "Built $out ($(wc -c < "$out") bytes)"
