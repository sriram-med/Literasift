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

## Case workspace (redesigned)

The case opens as a full-screen workspace, laid out like PV Nexus's case page: a pipeline strip (Screening, QC, Medical review, Signed, Sent), a section list (Patient, Reporter, Sender, Products, Events, Special situations, Treatment, Authors, Comments, Source), the form in the middle, and a right-hand assist panel.

The assist panel, per event, with no cost and no outside call unless noted:
- **Seriousness detected** from the case's own sentences (death, life-threatening, hospitalisation, disability, congenital anomaly, other medically important), with the quoted basis; the EMA IME list marks important medical events. One click applies it as a proposal.
- **MedDRA coding suggestions** (when a licensed release is loaded): exact and similar terms with LLT/PT/SOC and codes; "Auto-code all events" applies exact matches only, as proposals.
- **Listedness (SmPC)**, online: the product's label is read through openFDA (cached 30 days) and each event is searched in the adverse reactions, warnings, precautions, contraindications and overdosage sections. A hit is "Listed" with the quoted sentence; a miss is "Not found" (never "Unlisted" automatically) and a missing label is "Unknown". The US label is a proxy for the EU SmPC, so EU reporting should check section 4.8: paste it into the panel to check against it, or follow the EMA, UK eMC and DailyMed links. Applying a result sets listedness and the reference safety information as proposals.
- **Text source**: shows whether the full text came from a structured XML, a PDF text layer, or OCR of a scanned PDF (OCR is on when `deploy/enable-ocr.sh` has been run).
- The full-article scanner and the optional AI event check open from the "Scan full text" button.

## Three workflows (screener, QC, medical reviewer)

The QC check now happens on the **finished case**, not on the article (set `qcPotentialIcsr` to true in settings to bring back the old article-level QC). My Desk has one tab per role, each with its own list and actions.

1. **Screener, data entry.** Marking an article "Potential ICSR" creates the draft case straight away, assigned to the screener. The workspace shows a checklist and **Fill with AI**: rules and dictionaries fill what they can for free; the AI is asked only about fields still empty, from at most 14 short sentences (about 600 tokens), and each answer is kept only if the value appears word for word in the sentence it cites. An identical request is answered from the saved result with no tokens, and a monthly limit of 0 means nothing is ever sent. **Submit to QC** checks the case is a valid ICSR with no major findings, picks the least-loaded QC reviewer, and hands the case over; the screener can no longer edit it.
2. **QC.** Reviews the case with the automatic findings. **Approve** sends it to a medical reviewer; **Return to screener** needs a note and sends it back to the screener who did the data entry (round count kept). A QC reviewer can also use Route to send it anywhere.
3. **Medical review.** Confirms coding, seriousness and listedness, sets causality, approves and signs. Route sends it to QC or the screener if something is wrong.

Every hand-off is recorded in the case history and the audit trail. All times printed on screenshots, snapshot cards and PDF snapshot lines are IST (UTC+05:30); the capture browser also runs in Asia/Kolkata. Stored timestamps and signatures stay UTC.

## Automation first (Synchrony)

- **Case automation** runs on every new draft and when a screener opens a case that has not been automated: event detection (from the full-text scan when the case has none), IME flags, MedDRA exact matches, seriousness from the text, listedness from the online label (openFDA) and the narrative. Everything is a proposal with its evidence; a person's own entry is never overwritten; running it again is safe. The AI data-entry step is separate: off unless a manager turns it on under Settings, Case workflow, and set a monthly token limit.
- **Paste the OpenAI key in the app:** in the case workspace (Workflow tab) a manager sees a field to paste the key and set the limit; it can also be set under Settings, Case workflow.
- **Export from Synchrony** follows the ticked cases, or every case shown: line listing (CSV), E2B(R3) batch (XML), CIOMS I (ZIP of PDFs), FHIR (ZIP), narratives (TXT), and a full package (per-case E2B, CIOMS and narrative, plus line listing, batch XML and manifest).

## Investigations (laboratory, radiological, other tests)

Pre-populated from the article text when a draft is created and again by automation: laboratory values with units, day or timing and any "rose from X to Y" change, plus imaging and other tests (X-ray, CT, MRI, ultrasound, ECG, EEG, biopsy, culture and similar) with the stated finding. Each row keeps the sentence it came from and is a proposal until someone edits or confirms it. In the case workspace they are in the Investigations section, where tests can be added, edited or removed.

Only populated rows exist: a row needs a test and a result to be saved, so blank rows are dropped on save and never reach an export. They appear in the narrative ("Relevant investigations: ..."), the E2B(R3) file (tests and procedures block, omitted entirely when there are none), CIOMS I (the table is omitted when there are none), the line listing (Investigations column) and the FHIR bundle (Observation resources).

## Synchrony search

A search bar sits at the top of Synchrony and filters the tracker live. All words must match; quotes make a phrase; a minus excludes. It searches case number, PMID, article title, journal, authors and reporters, drug and indication, events with PT and SOC, outcome, investigations, assignee, status, stage, folder, tags, country, sex, age, narrative, comments and notes. Narrow with `drug:` `event:` `pt:` `soc:` `lab:` `author:` `assignee:` `status:` `stage:` `tag:` `folder:` `country:` `case:` `pmid:` `text:`, for example `drug:aripiprazole event:akathisia -stage:qc`. It combines with the filter chips, folders and category grid, and the exports follow what it shows.

## Synchrony end-to-end automation: what exists and how to verify it

- **Preparation** (Shadow and Active modes, per portfolio AI allow-list), patient separation, negation-in-time, source-linked fields, duplicate-publication flags, review exceptions with a concrete action and an owner, signed release packages and handoff records are described above and in `test/synchrony-automation.test.mjs`.
- **Every new draft is automated** (events, IME, MedDRA exact matches, seriousness, listedness from the online label, causality for each suspect drug and reaction pair, investigations, narrative). Pairs that cannot be assessed stay blank.
- **QC returns specific fields.** The reviewer flags fields with a reason; the screener sees them highlighted; on resubmission each flagged field is recorded as fixed or unchanged, and an unedited narrative is rebuilt from the corrected fields.
- **Contradictory dates** (stop before start, onset before exposure, end before onset) appear as review findings, and the case has an ordered timeline (exposure, dose, action taken, dechallenge, rechallenge, onset, tests, outcome).
- **Released cases are never edited.** When their source evidence changes, one linked follow-up version is opened per evidence revision; the signed version stays as released.
- **OpenAI controls:** pause (rules only), monthly and per-case token limits, results cached by evidence, task, model and prompt version, and a synthetic smoke test (Settings, Case workflow, "Run smoke test") that reports only availability and usage. The key can come from the server environment (`OPENAI_API_KEY`) or Settings; it is never returned.
- **Shadow report:** `POST /api/synchrony {action:"shadow_report", reference:[{pmid, patients:[{reactions:[...]}]}]}` (manager) compares the proposals with a reference set and reports wrong-patient attribution, missed and false reactions, unsupported evidence, reviewer minutes and tokens per case.
- The regression for the whole path is `test/synchrony-e2e.test.mjs`: one synthetic article from Potential ICSR to separate patient drafts, field-specific QC, medical approval, a signed package, replay with no duplicate case or package, and revised evidence opening a linked follow-up while the original signed version is intact.

### Assignments list and clean-draft hand-off

- All Assignments and My Queue show one search box, a status filter, a "More filters" menu (access, full text, country, events, source, client, portfolio, sort) and one Export menu. Filters still update the table in place.
- Settings > Case workflow > Case automation has "Send clean drafts to QC". In Active mode, a prepared draft with no exceptions, no missing required fields, no major QC or expectedness findings, no date conflicts and no open QC flags goes to QC by itself and the history records it. Anything else stays with the screener and shows on the review desk. QC approval, medical review, signing and transmission remain human.

### Phases 1-4 additions

- **Source labels:** evidence is labelled abstract, table, full text or OCR (`evidenceKind`). The case workspace shows the label beside each reaction in the assessment matrix and each chronology item.
- **Chronology:** every prepared draft stores an ordered account from that patient's own passages (exposure, onset including a denial such as "no rash on day 1", action, dechallenge, rechallenge, treatment, tests, outcome), shown in the Synchrony panel as "From the article, in order".
- **My Desk** opens with up to five queues (due soon, missing evidence, failed jobs, QC returns, evidence changes). Each item has an owner, a reason and one next action. Managers see everyone's; others see their own.
- **Assessment matrix:** one row per suspect product and reaction with MedDRA, IME, seriousness, listedness and its reference text, causality, method and rationale. Manifestations show under their parent reaction. An unassessed pair stays blank. The reporting clock names its basis and warns when the awareness date is unconfirmed.
- **Format check:** the narrative, E2B(R3), CIOMS I and line listing are compared for patient age, suspect products, reactions, outcomes and per-pair causality. Differences show before release and are recorded in the package manifest, which also records the case version, content and evidence hashes and the signer.
- **Delivery:** a handoff can be acknowledged or rejected; a rejected one can be followed by a corrected delivery bound to the same package. Nothing is sent externally by the application.
- **Jobs dashboard** (managers, top of Synchrony): pending, running, retrying, failed and completed preparation jobs, retry history, source problems, OpenAI tokens, and tokens per prepared case. Set `settings.ai.usdPer1MTokens` to see a cost per case.
