#!/usr/bin/env bash
# One-time setup (run as root on the VPS): installs xmllint so E2B(R3) files can be checked against the ICH ICSR schema.
# The schema files are published by ICH (E2B(R3) Implementation Package) and are not stored in this repository.
# Usage: bash enable-xsd.sh /path/to/folder-with-MCCI_IN200100UV01.xsd
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get install -y libxml2-utils
SRC="${1:-}"
[ -n "$SRC" ] && [ -f "$SRC/MCCI_IN200100UV01.xsd" ] || { echo "Give the folder that contains MCCI_IN200100UV01.xsd"; exit 1; }
mkdir -p /opt/literasift-schemas && rm -rf /opt/literasift-schemas/multicacheschemas
cp -r "$SRC" /opt/literasift-schemas/multicacheschemas
# the schemas include ../coreschemas, so copy the sibling folder too
[ -d "$SRC/../coreschemas" ] && cp -r "$SRC/../coreschemas" /opt/literasift-schemas/coreschemas
grep -q '^ICH_SCHEMA_DIR=' /etc/literasift.env || echo 'ICH_SCHEMA_DIR=/opt/literasift-schemas/multicacheschemas' >> /etc/literasift.env
systemctl restart literasift
echo "Schema validation enabled."
