#!/usr/bin/env bash
# One-time setup (run as root on the VPS): daily backup of all LiteraSift data, keeping the last 14.
# Usage: bash /opt/literasift-src/deploy/enable-backups.sh
set -euo pipefail
cat > /usr/local/bin/literasift-backup <<'BAK'
#!/usr/bin/env bash
# Archives the data directory (database, stored files, audit trail, library folders, accounts) into dated .tar.gz files.
set -euo pipefail
DATA="${LITERASIFT_DATA:-/var/lib/literasift}"; DEST="${LITERASIFT_BACKUPS:-/var/backups/literasift}"; KEEP="${LITERASIFT_KEEP:-14}"
umask 077; mkdir -p "$DEST"
out="$DEST/literasift-$(date +%F-%H%M).tar.gz"
tar -czf "$out.tmp" -C "$DATA" . && mv "$out.tmp" "$out"
ls -1t "$DEST"/literasift-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "Backup written: $out ($(du -h "$out" | cut -f1))"
BAK
chmod +x /usr/local/bin/literasift-backup
cat > /etc/systemd/system/literasift-backup.service <<'UNIT'
[Unit]
Description=LiteraSift data backup

[Service]
Type=oneshot
ExecStart=/usr/local/bin/literasift-backup
UNIT
cat > /etc/systemd/system/literasift-backup.timer <<'UNIT'
[Unit]
Description=Daily LiteraSift backup

[Timer]
OnCalendar=*-*-* 02:30:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now literasift-backup.timer
/usr/local/bin/literasift-backup
echo "Daily backups are on (02:30, last 14 kept in /var/backups/literasift)."
echo "For safety, also copy them off this server now and then, e.g.: scp root@<server>:/var/backups/literasift/<file> ."
