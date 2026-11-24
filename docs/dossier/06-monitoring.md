# 06 Monitoring and operation

- The host verifies the whole audit chain one minute after start and then daily. Look for `Audit chain verified` or
  `AUDIT CHAIN BROKEN` in `journalctl -u literasift`.
- Managers can press **Verify whole chain** in the Audit tab at any time. The last result is shown there.
- Download an anchor (Audit tab) regularly, for example monthly, and keep it outside the server (email, locked folder, write-once storage).
  Use **Check an anchor** to prove nothing before it was rewritten.
- Back up `/var/lib/literasift` (see `deploy/enable-backups.sh`) and keep at least one backup on storage the server cannot overwrite.
- Keep the server clock synchronised.
- If verification fails: stop, keep a copy of the data directory, find the first broken sequence in the message, compare with the latest
  backup and anchor, and treat it as a data-integrity incident under your own procedures.
- Review who can sign (Settings) and the four-eyes setting when roles change.
