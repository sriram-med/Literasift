# 04 Verification

Run `npm test` (Node's built-in test runner, no dependencies). Tests are in `test/audit-esign.test.mjs`.

| Test | Shows |
| --- | --- |
| contiguous, verifiable hash chain | sequence 0..n, genesis prev_hash, linkage |
| parallel appends stay contiguous | no lost or duplicated sequence numbers under concurrency |
| detects editing / deleting / reordering / truncating | tampering is caught even when written around the storage guard |
| storage refuses rewrite or shrink | append-only enforcement, head cannot go backwards |
| anchor detects later rewrite | external anchor catches history rewrite |
| audit routes are manager-only | access control |
| screening signature binds to content | signer, meaning, UTC time, hash recorded and audited |
| password re-entry required | no signature without re-authentication |
| review binding | stale content or evidence hash refused (409), including article change after opening |
| signed record locked, supersede rules | no double signing, no edits, manager and reason required, old signature kept, can re-sign |
| case policy | readiness and notes checks, lock, no delete, four-eyes |
| change after signing is reported | out-of-band edits flagged |

Hash compatibility with Argus was checked once against Argus's Python `AuditEntry` on four vectors, including non-ASCII and
nested detail; the scripts are not part of this repository.
Not covered by automated tests: the browser dialogs (checked by hand), and real password verification (done by the host).
