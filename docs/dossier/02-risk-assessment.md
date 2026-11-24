# 02 Risk assessment

| # | Risk | Control | Residual |
| --- | --- | --- | --- |
| R1 | A user edits or deletes an audit entry through the app | No route edits the log; entries are only appended | Low |
| R2 | Someone with server file access edits the log | Storage layer refuses non-append writes; hash chain and daily verification detect edits, deletions, reordering and truncation; head record detects tail loss | Medium: see F5 |
| R3 | Someone with server access rewrites the log **and** recomputes every hash | Exported anchors (kept off the server) expose it; anchors can be HMAC-signed with a key the app holds | Medium: needs the user to keep anchors, ideally on write-once storage |
| R4 | Two writers append at once | Compare-and-swap on the month file with retry; test of 12 parallel appends | Low |
| R5 | A signature is applied to content the signer did not see | Content hash and evidence hash must match what the server recomputes at signing time (409 otherwise) | Low |
| R6 | An unattended session signs | Password re-entry on each signature; limited attempts | Low |
| R7 | A signed record is altered later | Record locked; supersede needs manager and reason; out-of-band edits flagged as "changed after signing" | Low |
| R8 | A signer's account is shared | Per-user accounts and password reset; no technical control against deliberate sharing | Medium: procedural |
| R9 | The audit clock is wrong | Times come from the server clock | Low: run NTP on the host |
| R10 | Backups restore an older log | Anchors and head record show the log is shorter than the anchor | Low |

## F5 (known limitation, carried from Argus)

A person with administrative access to the host can bypass the application. The application cannot prevent this by itself.
Mitigations: limit server access, keep exported anchors off the server, keep backups on write-once storage.
