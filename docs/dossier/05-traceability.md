# 05 Traceability

| Requirement | Design | Test |
| --- | --- | --- |
| AUD-1 | `auditRules`, `audit()` in `worker/index.js`; host `record()` | screening signature test (log entry), manager-only routes |
| AUD-2 | storage guard in `server/storage.mjs`, no edit routes | storage refuses rewrite; tamper tests |
| AUD-3 | sequence + `prev_hash` | contiguous chain; parallel appends |
| AUD-4 | `/api/audit-verify`, daily `verifyChainDaily` | tamper tests; manager-only routes |
| AUD-5 | `/api/audit-anchor`, `/api/audit-anchor-check` | anchor test |
| AUD-6 | `auditActor`; `login.failed` events | chain test (actors) |
| AUD-7 | `audit()` catches its own errors | design review |
| SIG-1 | `signContent`, signature object | screening signature test |
| SIG-2 | host `/api/sign` interception | password re-entry test |
| SIG-3 | evidence and content hash checks | review binding test |
| SIG-4 | lock, supersede route | signed record locked test; case policy test |
| SIG-5 | `signPolicyProblems`, settings | case policy test |
| SIG-6 | state, `SIGNATURES.txt`, `signatures.json` | design review; manual check |
| SIG-7 | `signatureIntact` | change-after-signing test |
