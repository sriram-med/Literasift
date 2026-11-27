# Synchrony release checklist

Reviewed commit base: `b063f18` (PR #1, branch `claude/vigilant-planck-42pjio`, which is the branch `deploy/enable-autoupdate.sh` follows). Production `/healthz` could not be read from the review environment (network blocked), so the live revision is **Blocked / unverified**.

Status: **Verified** (test or code reference), **Partial**, **Missing**, **Blocked**.

## Intake and evidence
| Item | Status | Evidence |
|---|---|---|
| Queue preparation from Potential ICSR, bounded and idempotent | Verified | `prepareSynchrony`; `synchrony-automation.test.mjs` #1 |
| Resume after interruption (expired lease) | Verified | `synchrony-regression.test.mjs` "interrupted mid-run" |
| Full text, source, licence, method, checksum recorded | Verified | `buildFullTextEvidence`; regression "scanned PDF falls back to OCR" |
| pdf.js reader test | Blocked | skipped locally: `pdfjs-dist` not installed |
| Missing or unreadable evidence becomes an exception with a concrete action and owner | Partial | `syncExceptions` (now with `action` and `owner`); it is an assignment exception, not a separate task object |
| Duplicate citations and possible duplicate patients kept separate | Verified | `publicationDuplicates`, `duplicateSignals`; `phase3.test.mjs` |
| One citation stored once, independent per-portfolio decisions | Partial | model supports it (assignment per portfolio, idempotency key includes portfolio); no two-portfolio test |

## Patient-specific drafts
| Item | Status | Evidence |
|---|---|---|
| Separate draft per patient with identical demographics | Verified | `synchrony-verify.test.mjs` #1 |
| Four minimum criteria with exact passages | Verified | same test (criteria and evidence asserted) |
| Rash absent on day 1, present on day 4: one reaction, onset day 4 | Verified | same test; `review-release.test.mjs` |
| Manifestation of a documented diagnosis not a separate reaction | **Fixed** | "diagnosed with X on day N" was read as history, so Stevens-Johnson syndrome was missed; lexicon now has SJS/TEN manifestations |
| Per drug and reaction causality, carried to every format | Verified | `synchrony-verify.test.mjs` #2 (narrative, CIOMS I, E2B, line listing agree) |
| Narrative describes every suspect's exposure and dechallenge | **Fixed** | `buildNarrative` only described the first suspect |
| Listedness by market, product and RSI version | Partial | US label (openFDA) as a proxy plus pasted SmPC text; no market/version matching |
| MedDRA and IME suggestions | Partial | verified with synthetic MedAscii only; no licensed release available to test |
| Contradictory dates, ordered timeline | Verified | `synchrony-e2e.test.mjs` |

## OpenAI
| Item | Status | Evidence |
|---|---|---|
| Existing server key (`OPENAI_API_KEY`) reused, never returned | Verified | `synchrony-e2e.test.mjs` "AI controls" |
| Unsupported quote rejected | Verified | `synchrony-automation.test.mjs` #4; regression "background OpenAI" |
| Other patient's quote rejected | Verified | regression "background OpenAI"; automation and AI fill no longer see another patient's sentences (**fixed**) |
| Portfolio permission | **Fixed** | automation's AI step ignored the pilot list; now requires it |
| Source permission and redaction | **Fixed** | restricted-licence text and automation send only the public abstract; manual button sends redacted sentences |
| Monthly and per-case budget, pause, cache by evidence/task/model/prompt version, rule-based fallback | Verified | `aiChat`, `aiFillCase`; e2e and regression tests |
| Structured response with evidence version | Partial | patient, field, value, quote unit and excerpt are required; no explicit evidence-version field (the fingerprint and prompt version cover it) |
| Production smoke test | Blocked | route `/api/ai-smoke` and Settings button exist; not run against production |

## QC, routing, review desk
| Item | Status | Evidence |
|---|---|---|
| QC returns specific fields with reasons; recheck on resubmission | Verified | `synchrony-e2e.test.mjs` |
| Return reaches the screener when the case was routed to QC | **Fixed** | returned 409 when no submit had set the screener |
| Eligible reviewer by role, workload and availability | Verified | `pickRole` |
| Stale tab cannot overwrite a newer save | Verified | `review-release.test.mjs` |
| Automation cannot overwrite an edit saved meanwhile | **Fixed** | automation wrote back a stale copy of the case |
| Investigations and events taken only from the case's own patient | **Fixed** | automation scanned the whole article |
| Side by side article, click-through to the exact sentence, per-field Accept, Edit, Reject | Partial | Source tab and proposal states exist; no per-field accept/reject controls |
| Audit of status changes, assignments, decisions | Verified | `audit` calls in each route |

## Release, delivery, follow-up
| Item | Status | Evidence |
|---|---|---|
| Package from one snapshot, bound to approval and signature | Verified | `synchrony-automation.test.mjs` #3; e2e |
| Business rules and schema validation | Verified | `validateE2b`; ICH schema test runs when xmllint and schemas exist (they did here) |
| Handoff, receipt, rejection records | Partial | handoff and acknowledgement exist; no rejection or retransmission state |
| Follow-up tasks with question, owner, due date, response history | Partial | question, status, resolution exist; owner and due date are not fields |
| Revised evidence: one follow-up version, signed original intact | Verified | `synchrony-e2e.test.mjs` |
| No author outreach or regulator transmission without a person | Verified | nothing in Synchrony sends externally |

## Operations
| Item | Status | Evidence |
|---|---|---|
| Durable jobs, bounded retries, idempotency | Verified | `syncDue`, leases; tests above |
| Manager view of pending, running, failed jobs | Partial | per-assignment status and "Run next preparation jobs"; no consolidated job list |
| Shadow vs reference report | **Added** | `shadow_report` action; e2e test |
| Active rollout by portfolio | **Fixed** | mode was global; `syncActivePortfolios` now scopes it |
| Deployment and live verification | Blocked | no access to the VPS or production from the review environment |
