# Incident: Square pull counts do not match PubMed

Status: **open**. The code changes below are tested against synthetic PubMed responses only. The live reconciliation of Square has **not** been run, so the incident is not resolved.

## What could not be done from the build environment

The build environment has no route to production or to NCBI:

- `eutils.ncbi.nlm.nih.gov`, `literasift.tech` and `srv2194091.hstgr.cloud` are refused by the network proxy (HTTP 403 on CONNECT).
- The Hostinger connector refused its stored sign-in.

So the following are **unverified**:

- the deployed revision (`/healthz`);
- Square's eight saved watches as stored in production (names, approved aliases, custom queries, search mode, query versions, watch IDs, date basis, filters);
- the request the UI actually sent;
- the PubMed term the server actually executed;
- whether all eight watches ran, and which jobs are waiting, failed, partial or missing from the Library;
- the organisation's own PubMed query, dates, date field, filters and PMID export;
- every live PubMed count, translation and PMID set.

## Reproduced locally (synthetic PubMed), before any engine change

| # | Symptom | First point of divergence | Class |
|---|---|---|---|
| R2 | Same total, different PMID sets: the pull reported only counts | Completeness compared counts. PMIDs stored but not returned by PubMed were never reported. | Reconciliation (set comparison missing) |
| R3 | A pull interrupted mid-run never appeared in the Library | `libraryLayout` listed only runs with status `Imported` | Library visibility |
| R5 | PubMed's query translation and warnings were discarded | The window search read only `count` and `idlist` | Query transparency |
| R6 | A run did not record the exact term, date basis, filters, watch or query version | `execute` stored only the date field | Audit / retry consistency |
| R7 | A citation stored without its EFetch detail kept the pull "incomplete" forever | Detail XML missing was counted as a missing PMID, and the record was never retried on its own | Citation fetch / status conflation |

Earlier fixes in this incident addressed further divergence points:

- PubMed book chapters (`<PubmedBookArticle>`, for example LiverTox) were not parsed.
- Records with no English title were treated as missing.
- PMIDs that PubMed lists but cannot supply held runs open.
- Manual pulls stopped after 12 search windows.
- Data-entry users received no client molecules.
- Busy PubMed answers (HTTP 429, HTML pages, cut-off replies, ERROR in JSON) were not retried everywhere.

## Changes (search contract, reconciliation, recovery)

### One query builder

`searchSpec` is used by Compare, client pulls, one-molecule pulls, the daily scheduled search and retries.

**Modes**
- **PubMed default.** Names are sent bare, so PubMed applies its automatic term mapping, as on the website. PubMed's translation of the query is captured and shown.
- **Precise.** Quoted names with `[tiab]`, `[MeSH Terms]` and `[Supplementary Concept]`.
- **Custom.** A watch's approved expression (`customQuery`, or a hand-written query) runs as written. Only the chosen date clause and explicitly selected filters are added.

**What never enters a query:** client, portfolio and therapeutic class.

**Names:** a query uses the molecule name plus operator-approved names only.
- Spelling variants are suggested (`/api/name-variants`; for example aciclovir/acyclovir, sulphate/sulfate) and are searched only once approved.
- A salt is never reduced to its ion or class: "calcium acetate" never becomes "calcium".

**Date basis** is explicit and shown beside every comparison and result:
- Create date `[crdt]`;
- Publication date `[dp]`;
- Created or published: one search, `[crdt] OR [dp]`, so the union is deduplicated by PubMed itself.

Dates are inclusive. Scheduled monitoring uses `[crdt]`.

**Run snapshot.** Every manual run stores: mode, query, executed term, approved names, filters, query version, watch ID, client, date basis, inclusive dates, user and time. Window retries reuse the stored window terms. A change to the query, date basis or filters creates a new run with its own snapshot.

**Compare** checks exactly the ticked molecules with the pull's own settings. It shows:
- the executed term;
- PubMed's translation of it, and any PubMed warnings;
- counts under the run's search, PubMed default, Precise, and any date.

**Pull exactly these** reuses the compared selection and refuses if the settings have changed since the comparison. Checked on desktop and on a 390 px phone viewport.

### Reconciliation by PMID set

`reconcileRun` compares these sets:
- the set PubMed returns for the run's exact term (up to 10,000; above that, the union of the date-window searches, because PubMed ESearch cannot return more than the first 10,000 records of a search);
- the set stored on the run;
- the subset with a stored citation;
- the subset linked to the molecule.

It records missing, unexpected and unavailable PMIDs, fetches and links missing ones, and saves all sets to `runs/<id>/recon.json`, with their sizes on the run.

**Statuses are kept apart:** citation stored; citation stored with detail XML pending (retried record by record); PubMed has no record; full text. Citation import and molecule linkage do not wait for full texts, screenshots, AI or IME.

**ESearch checks:** an answer with no count, or an ERROR in the JSON, is treated as unresolved and retried. Warnings are recorded per window. A single day holding more PMIDs than one search can return is reported as incomplete, never silently truncated.

**Links:** one canonical article per PMID. Every watch match is kept:
- the molecule is added to the portfolio assignment, with no limit on links;
- the watch ID is added to the article.

Existing reviewers, IRD, dispositions, QC decisions and cases are never reset.

**Retry missing PMIDs** (`/api/run-repair`, available to a manager or to the person who ran the pull):
- re-runs the run's unreconciled windows with its saved search;
- compares the PMID sets again;
- fetches and links what is missing.

It deletes nothing and does not clear coverage.

**Reconciliation CSV** (`/api/reconciliation-csv`) has one row per PMID per run, with: client, molecule, portfolio, watch, run, PMID, match status, citation status, linked, full text, reason, mode, date basis, dates, query version and executed term.

**Pull jobs** are recorded in state with the request that started them. A job cut off by a restart is resumed by the scheduler, and the page keeps following it.

**Library:** interrupted and partial runs are listed with their status.

**Batch ZIP:** the manifest covers the union of every window's PMIDs and every stored PMID (unchanged and verified).

## Regression tests (`test/reconcile.test.mjs`, synthetic PubMed)

| Scenario | Result |
|---|---|
| Calcium acetate, 426 synthetic PMIDs | 426 matched, 426 citations, 426 linked; compared PMID by PMID; the CSV has 426 "matched and stored" rows |
| Same count, different PMID sets | Missing `999` and unexpected `100` are reported; the pull is not complete; the CSV lists both |
| One PMID matched by two Square molecules | One article; one assignment linked to both molecules; both watch IDs on the article |
| One watch fails in an eight-molecule pull | Only that molecule is shown as failed; retrying it completes it |
| ESearch truncation, partial EFetch, worker restart | Truncation stays visibly incomplete; the citation counts while its XML is pending; a dead job is resumed and finished by the scheduler |
| Citation exists, no full text | Counted and linked; remains in the queue for abstract screening |
| Query, date basis, filter or mode change | Four separate runs, each with its own executed term and snapshot |
| Re-import of a reviewed article | Missing molecule link added; reviewer, status, IRD, disposition and QC unchanged; no duplicate assignment |
| Retry missing PMIDs | Missing goes from 1 to 0; nothing deleted; coverage kept; other users refused |
| Search contract | Custom runs as written plus filters and inclusive dates; no client, portfolio or class text in any term |
| Spelling variants | Suggested, not searched until approved; searched once approved |
| Query version change inside a scheduled range | Each window keeps its own version; created-or-published is a single deduplicated search |
| Compare | Only the ticked molecules; the executed term, translation and warnings shown; a pull with the same settings runs the identical term |

Full suite: 244 passed, 0 failed, 1 skipped (optional PDF parser). Production build and artifact validation pass.

## Calcium Acetate: the queries the app now generates

These are shown without approved names; any approved brands or salts are ORed in the same way. Dates use the run's chosen basis, inclusive of both days. For example, created or published from 2026-11-20 to 2026-11-27 is `AND ((2026/11/20[crdt]:2026/11/27[crdt]) OR (2026/11/20[dp]:2026/11/27[dp]))`.

- PubMed default: `((calcium acetate))`
- Precise: `("calcium acetate"[tiab] OR "calcium acetate"[MeSH Terms] OR "calcium acetate"[Supplementary Concept])`
- Custom: the watch's approved expression, unchanged.

The actual executed term for Square, and which clauses explain the count differences, can only be read from production. Each result row and comparison now shows the term and PubMed's translation.

## Live reconciliation runbook (to be done on production)

1. Confirm `/healthz` shows the deployed revision.
2. **Read-only first.** Search & Pull → By client → Square: tick all eight molecules, set the organisation's exact dates, date basis and filters, then **Compare with PubMed**. Record the executed term, translation, warnings and counts for each molecule. Compare them with the organisation's query, or with the **Same search on PubMed** link.
3. **Pull exactly these.** When it settles, download **Reconciliation (CSV)**.
4. For any row that is not "All N accounted for", use **Retry missing PMIDs**, then download the CSV again.
5. Check Batches and the Library for the same runs.
6. Fill in the table below.

| Molecule | Organisation reference | PubMed matched (executed query) | Stored and linked before | Stored and linked after | Unresolved | Reason |
|---|---|---|---|---|---|---|
| Calcium acetate | not provided | unverified | unverified | unverified | unverified | needs production access |
| (seven more Square molecules, names unverified) | not provided | unverified | unverified | unverified | unverified | needs production access |
