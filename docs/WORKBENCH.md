# LiteraSift pharmacovigilance workbench

Literature screening through to ICSR output, on the existing Worker, private R2 evidence and Hostinger Docker host. Everything here is rule-based; no model is called.

## What is where
| Area | Where | Notes |
|---|---|---|
| Versioned watchlists, product dictionaries, query preview/apply | `/api/dictionary-save`, `/api/watch-preview`, `/api/watch-version` | Each import stores the exact executed query, query version, date field (Create Date `[crdt]` monitoring, Publication Date `[dp]` backfill), window and timestamp. Changes apply prospectively. |
| Restartable imports | `/api/import-resume` | Bounded windows, checkpoints, retries with provider rate limits, per-window reconciliation. States: zero results, partially imported, failed, reconciled. Replays keep completed decisions and never duplicate assignments. |
| Evidence | `article.evidence.*`, R2 `evidence/<pmid>/…` | EFetch XML, PMC JATS/PDF (only where licensed), PubMed screenshot and labelled citation snapshot are separate objects with hash, source, licence, time and parser version. |
| Batch ZIP | `/api/batch-readiness`, `/api/evidence-retry`, `/api/batch-zip` | Versioned; every matched PMID listed with available/missing/restricted/failed/pending. Restricted full text is never packaged. |
| Roles and QC | `/api/membership-save`, `/api/disposition`, `/api/qc-decision`, `/api/reassign`, `/api/allocate-bulk` | Per-portfolio manager, screener, medical reviewer, QC. One shared article record, separate assignments per portfolio. |
| Extraction | `/api/extract`, `/api/extraction-decide` | Per patient: reporter, drugs and roles, events classified (AE, manifestation, indication, history, lab, alternative cause), negation, exact sentence/table-cell links. Verbatim, normalised and suggested MedDRA are separate. |
| ICH E2D(R1) criteria, drafts | `/api/criteria`, `/api/drafts-create` | Four criteria per patient (supported / uncertain / missing, with evidence and a follow-up checklist). One idempotent draft per supported patient per portfolio. Aggregate-only data is refused. |
| Medical review | `/api/case-dates`, `/api/reportability`, `/api/listedness-*`, `/api/rsi-*` | Publication, retrieval, review and reviewer-confirmed awareness dates are separate. Listedness needs a versioned RSI and an exact passage plus a reviewer decision. |
| Duplicates and follow-ups | `/api/duplicates`, `/api/duplicate-decide`, `/api/case-diff`, `/api/case-versions` | Explained matches; nothing is linked without a reviewer; the original is preserved; every version records who edited, reviewed, approved and exported. |
| Narrative and outputs | `/api/narrative-*`, `/api/e2b-validate`, `/api/case-approve`, `/api/case-export` | Evidence-linked narrative, CIOMS I PDF, case JSON, E2B(R3) XML (ICH, EU; FDA is review-only). Field-level errors; final output needs approval of the exact current content hash. Regulator transmission is out of scope. |

## Store, migration, backups
Operational state moves from `bench.json` on disk to SQLite (`state.db`, WAL, every state write versioned). Article files stay in R2 / `evidence/`.
```
node server/store-admin.mjs migrate --dry-run   # list what would move
node server/store-admin.mjs migrate             # copy and verify byte for byte; the file store is untouched
node server/store-admin.mjs check | backup | versions
node server/store-admin.mjs rollback <version>  # itself a new version
node server/store-admin.mjs restore <file>      # checksum verified
node server/store-admin.mjs export-files        # back to the file store
```
The host uses SQLite when `state.db` exists and takes a daily backup. Going back is deleting nothing: remove `state.db` from use and the old file store is still there.

## Optional schema validation
`deploy/enable-xsd.sh` installs `xmllint` and the ICH E2B(R3) schemas on the host (`ICH_SCHEMA_DIR`). Without them the validator still applies the field rules and says the schema check was not run.

## Licensed content
MedDRA and IME lists (`*ime-meddra*.json`, `ime/`) and RSI text are loaded by the customer and never committed. Without them coding is shown as "Proposed (unverified lexicon)" and listedness stays unknown.

## Tests
`npm test` (84 tests) covers: failed import resume, ZIP completeness, two portfolios reviewing one citation, two-patient articles, the aciclovir chronology, ambiguous reporters, aggregate-only articles, duplicate follow-ups, restricted full text, valid and invalid E2B, approval gating, store migration/rollback and the audit chain.

## Search, tags, folders, archive and deletion
- **Search** tab (everyone, scoped to what the person may see): citations and cases, with `pmid: case: drug: event: tag: author: status: portfolio:` operators, quoted phrases and `-exclude`. Filters: serious / non-serious, listed / unlisted / unknown, status, portfolio, folder, tag, archive.
- **Tags** are user labels (for example `serious:hospitalization`, `listed`) added on a case or in bulk; they feed the filters and record who added them. The formal seriousness and listedness fields stay in the case data.
- **Folders** group cases (created by a manager or medical reviewer, deleted by a manager; cases are never deleted with a folder).
- **Archive** tab: archived cases leave working lists and series counts, cannot be edited, stay searchable and can be restored.
- **Deletion** is manager-only, needs a reason and the typed case number, and leaves a tombstone plus an audit entry. Approved, signed or exported cases must be archived first. After deleting, the pulled citation can be removed from the library too.
- Every search, tag, folder, archive, restore and delete is written to the audit trail.

## Routing, timelines, clinical summary and drug names
- **Pipeline:** an item goes screener, then QC, then a medical reviewer without anyone moving it; the medical reviewer is chosen by workload and availability. Managers and medical reviewers can route any citation or case to any stage and any active person (Route… in the row Actions, the bulk bar, the Admin tab or the case panel). Every move needs a reason and is audited.
- **Categories and timelines:** the Synchrony matrix counts cases by seriousness and listedness (click a cell to filter); every case shows its clock (15 days serious, 90 non-serious, or the marketing-authorisation record) from the reviewer-confirmed awareness date, falling back to the creation date until it is confirmed.
- **Clinical summary:** indication, action taken, dechallenge and rechallenge are shown with each case; "Confounded" is shown when a positive dechallenge coincides with treatment given for the event, or the case lists treatment or alternative-cause confounders.
- **Drug names:** `/api/drugkb-sync` pulls generics, brands and salts from RxNorm and openFDA labels (watchlist, ingredient list and enrich modes, restartable) into the private bucket (`drugkb.json`). Searches expand a generic, brand or salt to all of its names. Needs outbound access to `rxnav.nlm.nih.gov` and `api.fda.gov`.

## Two deployment shapes
- **Sites Worker + VPS services** (`compose.yaml`, `capture/`, `scripts/run-watchlists.mjs`): the Worker serves the app and stores state in the Site's storage; the VPS runs the Playwright capture service (set `SCREENSHOT_ENDPOINT`, `SCREENSHOT_AUTH=bearer`, `SCREENSHOT_TOKEN`) and a scheduler that calls `/api/scheduled` every minute with the run token.
- **Self-hosted Node host** (`server/`, `Dockerfile`, `docker-compose.host.yml`, `deploy/*.sh`): SQLite store, built-in scheduler, in-host capture.
Both run the same `worker/index.js`. Records from the earlier build keep working: citation XML saved under `citationXmlKey` counts as EFetch evidence and is adopted with a hash on the next scheduler tick.

## Scheduler, ledger and heartbeat
Coverage is a ledger of search windows per watchlist, day and date field. A day is covered only by a reconciled (or zero-result) window; a later success or a Publication-Date backfill never hides an earlier failed or missing day. Failed and partial windows are retried at most 8 times with a pause that doubles from 5 minutes to 6 hours, then stay visible as "gave up" until a manager presses Retry now. Every scheduler tick writes a heartbeat; the Batches tab shows the last heartbeat, the last fully successful run, the last successful batch and every missed window, and flags a scheduler that has been silent for more than three hours (`settings.schedulerStaleMinutes`).

## Open-source integrations
| Project (licence) | What was integrated | Where |
|---|---|---|
| Lixplore (MIT) | Multi-source search (PubMed, Europe PMC, Crossref, DOAJ), de-duplication, BibTeX/RIS/CSV export, Unpaywall open-access status | Discover tab, `/api/discover`, `/api/discover-export` |
| pv-case-triage-agents (MIT) | PHI redaction and leak check, negation-aware seriousness with the emergency-department rule, important-event list, triage priority | `redactPhi`, `eventSeriousness`, `triageFor`, `/api/phi-scan` |
| drug-adverse-event-explorer (MIT) | PRR signal context from openFDA FAERS | `/api/faers-context`, case panel |
| drug-causality-bert-v2 (Apache-2.0) | Naranjo and WHO-UMC calculators; optional BioBERT inference service | `/api/causality-assess`, `/api/bert-causality`, `services/causality/` |

**Discover and Unpaywall cross-links.** A result found by several sources is one row. Each DOI is checked in Unpaywall (open-access status, licence, version, PDF and landing page, shown only when the DOI is valid and a contact email is set in Settings). Results that are already in LiteraSift link to the article and its cases (only for people who may see them); a manager can add a PMID to a portfolio from the result. In the other direction, an article's dialog and a case's panel carry links to PubMed, Europe PMC, DOI, Unpaywall and Crossref and a "Find similar in Discover" link. Open-access copies are linked or retrieved only through Unpaywall and the publisher, as elsewhere in the app; shadow libraries are not supported.

**Machine suggestions stay apart from decisions.** The BioBERT answer (binary causal / non-causal, with a probability and the model name) is stored as a `machine_suggestion`; its input is PHI-redacted first. Naranjo and WHO-UMC results are reviewer calculations that change the case's causality fields only when the reviewer chooses "apply".

Settings: `OPENFDA_API_KEY` (optional, raises the openFDA rate limit), `CAUSALITY_ENDPOINT` and `CAUSALITY_TOKEN` (optional BioBERT service, see `services/causality/README`), the Unpaywall contact email (Settings tab).

Not incorporated: AI-Powered-Pharmacovigilance-via-Literature-Monitoring is CC BY-NC-ND 4.0 (non-commercial, no derivatives), so none of its code or text is used.

## MedDRA (licensed)
A manager with a MedDRA licence loads the release in **Settings, MedDRA dictionary**: choose the release zip from the MSSO (the MedAscii folder with `llt.asc`, `mdhier.asc`, `meddra_release.asc`), tick the licence confirmation and upload. The release is parsed into a compact index kept in private storage (`meddra/index.json`), never in the repository, the state document, exports or the audit trail (the audit entry records the version, counts and who loaded it). No endpoint lists or downloads the dictionary; people can only search it a few terms at a time.
- **Coding suggestions** in the case form give LLT, PT, HLT, HLGT and SOC with codes; "Search MedDRA…" searches any wording. Exact matches rank first, non-current LLTs are marked, and nothing is guessed.
- **Drafts** propose a coding only for exact term matches, marked "Proposed (MedDRA x.y, exact term match; reviewer to confirm)".
- **E2B(R3)** reports the reaction as the LLT code (`E.i.2.1b`) with the MedDRA version (`E.i.2.1a`); validation checks each code exists in the loaded release, warns about PT-only codes and version differences.
- **New release:** loading it replaces the old one; "Check cases against this release" lists events whose code is missing, whose LLT is no longer current, whose PT changed, or that were coded with an older version. Case codes are never changed automatically.
- Group the case list by SOC; searches also match PT, LLT and SOC wording.

## Synchrony intake, permissions and automation (added)

- **Only QC-selected articles become cases.** A screener marks an article "potential ICSR"; QC approves it; if the full text is stored, the case is added to Synchrony automatically and routed to a medical reviewer (or a manager when none exists). Articles that are not selected stay in the screening queues.
- **Only the holder edits.** A case can be edited by the person it is currently routed to, and by managers. Anyone who holds a case (screener, QC, medical reviewer) can route it to anybody at any stage, with a reason. A screener sees a case only while it is routed to them.
- **Literature minimum criteria.** No patient name is expected. A patient is identifiable from descriptors (age, sex, case label, initials, weight, height, BMI, ethnicity, gestation, birth year, hospital number); each one found is listed with its sentence. Every author is carried as a reporter (primary plus additional primary sources in E2B). Reporter comments (the authors' own words), general comments and sender comments are separate fields. A completeness checklist shows what the article did and did not give.
- **Full-article scanner.** Reads every sentence of the stored full text and tags products, events, doses, timing, dechallenge, rechallenge, outcomes, causality statements, lab values and patient descriptors, with MedDRA (when loaded) and IME suggestions. Rules only; no outside call; no cost.
- **Optional AI event check (OpenAI).** Off by default; a monthly token limit of 0 means nothing is ever sent. When on, it runs only when a person presses the button on one article, sends only tagged sentences with personal data masked, discards any proposed event whose quote is not in the text, applies nothing to a case by itself, and stops before a call that would exceed the monthly limit. Usage is counted and every call is audited.
- **Line listing.** Built live from the cases a person can see (Line Listing tab), and a copy is saved once a day by the scheduler (`exports/line-listing/YYYY-MM-DD.csv`).
- **Automatic PubMed pull.** On by default for every molecule; pause it globally or per molecule on the Watchlists tab, or press Pull now.
