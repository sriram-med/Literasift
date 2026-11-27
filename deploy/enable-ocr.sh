#!/usr/bin/env bash
# One-time setup (run as root on the VPS): installs Tesseract and poppler so LiteraSift can read scanned PDFs (full-article OCR).
# Usage: bash /opt/literasift-src/deploy/enable-ocr.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y tesseract-ocr poppler-utils
tesseract --version | head -1
systemctl restart literasift
sleep 3
journalctl -u literasift -n 8 --no-pager | grep -i "ocr" || true
echo "OCR enabled. Scanned PDFs captured from now on are read; press Process pending evidence to re-read stored ones."
