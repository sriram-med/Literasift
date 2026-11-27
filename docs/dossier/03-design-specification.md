# 03 Design specification

## Audit entry
`{sequence, occurred_at, actor, action, entity_type, entity_id, detail, schema_version, prev_hash, hash}`

`hash = SHA-256(prev_hash + canonical_json(entry without hash and prev_hash))`; canonical JSON has sorted keys, `,` and `:`
separators and `\uXXXX` escapes for non-ASCII. The first entry's `prev_hash` is 64 zeros. This matches Argus's Python
`AuditEntry` byte for byte.

## Storage
`audit2/YYYY-MM.ndjson` holds one entry per line (append only); `audit2/head.json` holds `{sequence, hash, months, count}`.
Appends use compare-and-swap on the month file, then advance the head. On the VPS the storage layer additionally refuses any
write to an audit file that does not start with the existing bytes, and refuses to move the head backwards.
Entries from before this version stay readable under "earlier entries" and are verified on their own.

## Verification
`verifyAuditEntries` checks sequence contiguity, `prev_hash` linkage and recomputed hashes. `verifyAuditChain` runs it
across all months and compares the last entry with the head. Result `{ok, entries_checked, first_broken_sequence, reason}`.
Runs on demand (Audit tab) and daily on the host; results are stored and appended to the log.

## Anchors
`{sequence, hash, anchored_at, mac?}`. `mac` is an HMAC with `AUDIT_ANCHOR_KEY` (derived from the host secret unless set).
Checking an anchor verifies the whole chain first, then that the entry at that sequence still has that hash.

## Electronic signatures
Signature `{id, signer_id, signer_name, meaning, meaning_text, signed_at, content_sha256, evidence_sha256, auth, superseded}`.
Meanings: `case_approve`, `case_invalid`, `screening`. `content_sha256` is the hash of a canonical object holding the record
fields that matter (case data or decision) plus `evidence_sha256`, the hash of the article text, authors, detected events and
stored full-text reference. Flow: preview (returns both hashes and any policy problems) → sign (client echoes both hashes; the
server recomputes; mismatch → 409; the host verifies the password and marks the request re-authenticated).
Policy: approvals by managers (configurable), four-eyes on cases (optional), readiness checks before "ready for medical review",
a reason in the notes before "not a valid ICSR".
Signed cases are locked; assignments reject changes. Supersede (manager, reason ≥ 10 characters) keeps the old signature.
Case state reports `signature_intact`; exports include `signatures.json` and `SIGNATURES.txt`.
