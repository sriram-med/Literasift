#!/usr/bin/env bash
# One-time setup (run as root on the VPS): installs pdf.js (pdfjs-dist, Apache-2.0) so LiteraSift can read the text of PDF full texts.
# Without it, PDF full texts are stored but have no searchable text, so events and key passages come from the abstract only.
# Usage: bash /opt/literasift-src/deploy/enable-pdf-text.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
command -v npm >/dev/null || apt-get install -y npm
mkdir -p /opt/literasift-pdf
cd /opt/literasift-pdf
[ -f package.json ] || echo '{"name":"literasift-pdf","private":true,"type":"module"}' > package.json
npm install --no-audit --no-fund pdfjs-dist
chmod -R a+rX /opt/literasift-pdf
systemctl restart literasift
sleep 3
journalctl -u literasift -n 8 --no-pager | grep -i "pdf text" || true
echo "PDF text extraction enabled. PDFs captured from now on are read."
