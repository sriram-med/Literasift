# 01 User requirements

| ID | Requirement |
| --- | --- |
| AUD-1 | Every state-changing action (screening decisions, cases, imports, pulls, settings, sign-in, exports) is recorded with who, what, when and on which record. |
| AUD-2 | The record is append-only: entries cannot be edited, removed, reordered or truncated without detection. |
| AUD-3 | Entries are numbered contiguously and chained by hash so any gap or change is detectable. |
| AUD-4 | A manager can verify the whole chain on demand; it is also verified automatically every day and the result is recorded. |
| AUD-5 | A manager can export an anchor (head sequence and hash, authenticated) and later prove history was not rewritten. |
| AUD-6 | Actors are identified individually (`user:<email>`) or as the system. Failed sign-ins are recorded. |
| AUD-7 | Audit writing never silently changes business data, and a failure to audit does not corrupt the business write. |
| SIG-1 | A signature records signer id, name, meaning, UTC time, and a SHA-256 over the exact content signed. |
| SIG-2 | Signing requires the signer to re-enter their password. |
| SIG-3 | A signer can only sign what they reviewed: if the record or the article evidence changed since they opened it, signing is refused. |
| SIG-4 | A signed record is locked. Changing it requires a manager to supersede the signature with a reason; the old signature is kept. |
| SIG-5 | Approval signatures are restricted to managers by default; an optional four-eyes rule stops creators approving their own cases. |
| SIG-6 | The signature, its meaning and validity are shown with the record and included in exports. |
| SIG-7 | Records changed outside the application after signing are reported as "changed after signing". |
