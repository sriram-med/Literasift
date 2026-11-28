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

### Documents, AI check, board and line listing

- **Add document** (Synchrony tracker) and **Send to Synchrony** (Discover results) call `/api/synchrony-import`: a PDF, XML, text file, pasted OCR text or a Discover record becomes an article, a potential-ICSR assignment in the chosen portfolio, stored full text and a prepared draft. Authors, affiliations and the corresponding address are read from the top of the text when none are typed. A document ID is derived from the DOI, title or text, so repeating the import adds nothing. Uploaded text is kept off OpenAI unless the box "may be sent, redacted, to OpenAI" is ticked.
- **AI check against the article** (case panel, Release tab; `/api/case-ai-review`) compares entered values with the same patient's own sentences. A finding must cite a sentence and any suggested value must appear in it. QC can flag a finding for the screener; editors can apply the suggestion as a proposal. Results are cached by case and text. With AI automation on, the check also runs after AI data entry (abstract only) and a draft with open AI findings is not auto-sent to QC.
- **Board** view (Synchrony, List/Board) shows cases in Data entry, QC, Medical review, Signed and Sent columns.
- **Line listing** has summary tiles, quick filters (serious, unlisted, fatal, overdue, no causality), search, and one row per event with seriousness, listedness, causality and clock.

### Write queue, safety-reference follow-up, richer pre-population, more automation

- **Writes** to the shared state now queue within a process, so many simultaneous saves (scheduler ticks, imports, reviewers) cannot starve one another. The compare-and-swap that protects against other processes remains, with more attempts and a short random pause. Thirty simultaneous profile saves all land (regression test).
- **Safety reference follow-up.** When automation uses an online label for listedness, the case remembers the label (set id, version, effective date) and which reactions relied on it (`referenceBasis`). Once a day the scheduler compares each remembered label with the current one. An open case gets a "Safety reference changed" card, a task naming the reactions, and the evidence re-review flag; "Listedness re-checked" records the check. A released case gets one linked follow-up version with the dependent listedness fields blank; the signed original is untouched. Managers can run the check from the Jobs panel.
- **Pre-population** now has a second pass over the patient's own sentences: weight, route per product, indication (an indication is no longer a reaction), frequency per product, onset day and time to onset, outcome, stop day, dechallenge and rechallenge ("not attempted" is "Not done"), hospitalisation or death stated in their own sentence, interventions such as dialysis, the authors' own causality wording mapped to WHO-UMC, reporter country and department, country proxy, and a worked causality worksheet (time relationship, concomitant factors, objective evidence, rationale). History items the text denies are dropped and duplicates merged. The event lexicon grew from about 100 to more than 500 terms, and reactions outside it are found after event verbs ("developed severe hypoglycaemia"). All values stay proposals with their sentence.
- **Automation:** open questions become tasks; "Draft letter to the author" builds a copy-ready message from them (nothing is sent); cases due within two days or late are escalated once per level and moved off an inactive holder.

### Timelines, Planner, Dashboard, client-wise assignment, drug search

- **IRD and working days.** Every citation records its IRD, the day LiteraSift received it. Screening and routing to QC are due 2 working days after the IRD, QC 2 working days after it was routed, and medical review 3 after QC. Weekends and holidays listed under Clients > Timelines do not count. Managers change the defaults, the days for one molecule (Clients, per molecule), or the date of one item (Planner > Change date, with a reason that is recorded).
- **Client-wise molecule assignment** (Clients): for every molecule a screener, a QC checker and a medical reviewer can be named, plus a priority (High, Normal, Low) and its own working days. Routing uses the named person when they are active and not away, and otherwise the usual least-loaded rule.
- **Planner**: a week, month or list calendar of what to screen, check or review, with a "Do next" list ordered by priority and due date. A person sees their own work; a manager can switch to anyone or everyone and filter by client. Overdue work is called out.
- **Priority** combines the molecule's priority, how late the item is, a likely ICSR or serious case, and a QC return.
- **Dashboard** for each of the three workflows (Screening, QC, Medical review), shown according to the person's roles: open, overdue, due today, next 5 days, high priority, done in 7 days and on-time rate; workload for the coming working days; open work by client and molecule; and for managers a people table with capacity.
- **Search & Pull** finds a drug by INN, generic name or brand name. One lookup fills in the INN, the generic names and salts and the brands, and shows the FDA label that Synchrony already uses for listedness (effective date, version, DailyMed link and the sections read). A label change opens a follow-up on affected cases.

- **Search & Pull for data entry and QC.** Screeners and QC checkers have their own Search & Pull: the INN, generic or brand lookup with the FDA label, then a PubMed pull (one year at most) into a portfolio they work in. The new articles go to their own queue with the usual two working days from the IRD. No watchlist is created and articles already assigned to someone else are left alone. Managers keep the full version with watchlists and batch import.

- **IRD everywhere.** Article cards (My Queue, All Assignments, the screening list on My Desk), case cards (My Desk, Synchrony tracker), board cards and the line listing show the IRD, the stage due date and the working days left or late. The line listing CSV has two new columns at the end: IRD and Stage due.
- **Desk visual.** The Data entry and QC desks open with a donut of serious versus non-serious cases and a card per client listing its molecules, each with a red/teal bar and a serious / non-serious count. Tapping a client or molecule filters the list below.

- **My Queue by timeline.** My Queue has the three workflows as tabs (Screening, QC, Medical review, shown by role). Items that are overdue or due today or tomorrow come first under "Needs you first", oldest deadline first. Everything else follows grouped by the ISO week of its due date ("Week 49 · Nov 30 to Dec 6 · next week"), soonest week first. Each card shows its IRD, its due date with working days left, its priority, and how many weeks it has been in the queue. "Full list, filters and exports" keeps the earlier table of articles.

- **Change portfolio (managers).** A "Portfolio" button on article cards (All Assignments, My Queue list) and case cards, "Change portfolio…" in a case's Actions menu and "Portfolio…" in the Synchrony bulk bar, and "Move portfolio" on each molecule under Clients. One dialog offers the existing portfolios or a new name. Moving an article also moves the cases made from it; moving a molecule moves its watchlist, articles and cases. Anyone with no role in the new portfolio is replaced by the usual routing, an article already present there is skipped rather than duplicated, and signed cases stay where they are. Every move is written to the case or article history and the audit log.

### People and accounts

- **Roles are what a person does, not "reviewer".** The Team page is now a set of people cards. Each shows the person's real roles with the portfolios each applies to (Manager, Screener, QC, Medical reviewer, and Portfolio manager where one was granted), availability, open work against their limit and sign-in status. Filter by role or search by name.
- **One place to create or change a person** (Add a person / Edit): name, email, roles, portfolios (All, or any number), open-work limit, availability and away dates, permission to manage clients, and for hosted sites whether to create a sign-in account and send the invite. Saving writes the profile and the matching role memberships together; the same dialog also holds Set password, Send invite or reset link, and Revoke sign-in.
- **Managers can be created.** Before, only the first person to sign in was a manager. Now a manager can make another, can never remove the owner's manager role or the last active manager, and cannot deactivate themselves.
- **A QC-only or medical-only person is not given screening.** Screening now goes only to people who hold the screener role for the portfolio. Older profiles that were given QC or medical review and no screener role are treated as that role. A person screening several portfolios is supported.
- **Deactivating** a person sends their open articles, QC items and cases back through routing and removes their role memberships. The invite flow keeps a person's roles when it re-saves their profile.

### Worldwide sources in Search & Pull

- **Search worldwide sources** (Search & Pull, for managers, screeners and QC): one search across PubMed, Europe PMC, OpenAlex (journals and repositories in every region, including SciELO, J-STAGE, KCI and African and Asian journals), Crossref, DOAJ, CORE (needs a key in Settings), ClinicalTrials.gov, UK MHRA (Drug Safety Update and alerts through GOV.UK) and US FDA recalls (openFDA enforcement reports).
- **Filters:** date range, author region (Europe, Asia, Middle East, Latin America, Africa, North America, Oceania, applied through OpenAlex), language, results per source, and safety-related only. Regulators are searched by the INN, not the boolean text. A source that fails or needs a key is shown as failed and does not stop the others.
- **Add to the queue:** ticked results become articles (labelled with their source and country) with one assignment in the chosen portfolio, the IRD and the usual due date. Screeners and QC add to their own queue in their own portfolios; managers' additions go through routing. Duplicates by DOI, PMID or title are skipped. EMA, Health Canada, WHO and CDSCO publish no open search service, so they are not connected; use Add document in Synchrony for their notices.
- The connectors were written against the public API formats and tested with mocked responses; they have not been run against the live services from this environment.

- **Cases panel on the Dashboard** (each of Screening, QC and Medical review): the number of serious and non-serious cases at that stage, a flow chart that divides each into listed, unlisted and not assessed (band width is the number of cases), a card per combination with its oldest IRD, next due date and how many are late or due soon, and a table of the most urgent cases with IRD, due date and holder. A person sees their own cases; a manager sees everyone's or one person's.

### Synchrony automation settings, rebuilt

- Settings > Case workflow is now one **Synchrony automation** screen that follows the order a case moves: 1 Intake, 2 Prepare drafts (Off, Shadow or Active as three cards, plus pilot portfolios and automatic assignment), 3 Enrich, 4 AI, 5 Route to QC, 6 Release (sender and E2B identifiers). A status banner at the top says the mode, whether AI is connected and how many automation steps are on, with buttons to run preparation and the safety-reference check. Switches save when flipped. The old separate panels (Synchrony automation, Synchrony ICSR workbench, Case automation, AI event check) are gone.
- **OpenAI connection:** a four-step checklist (key saved, switch on, monthly limit above 0, not paused) names exactly what is missing. "Connect and turn on" saves the key, switches AI on, sets the monthly limit and runs a live test in one step. A first key pasted by any route now switches AI on with a 500,000-token monthly limit unless a manager has already chosen otherwise. Key checks accept any normal key format and explain a bad paste instead of failing silently.

### Deleting cases to free space

- **Delete permanently** (managers) works on a case at any stage: Data entry, QC, Medical review, signed, sent or archived. It is in a case's Actions menu, the case form's More menu and the Synchrony and Archive bulk bars, and opens one dialog.
- The dialog lists each case with its stage, whether it was signed or approved, and how much is stored for it, then says how much will be freed. What is removed: the stored version snapshots and any release packages for those cases. Optionally the article's files (full text, screenshot) go too, when no other case needs them; the citation stays and the full text can be fetched again.
- **Safeguards:** a reason is required (10 characters if any case was signed or approved), the case number or "DELETE n" must be typed, and signed or approved records need a separate "I understand" tick. A tombstone keeps the number, stage, who signed it and when, the content hash, who deleted it, when, why and how much was freed; it is listed under Archive > Deleted cases with the total freed. The audit log records every deletion.
- **Not recreated:** Synchrony will not prepare the same article again unless "Let Synchrony prepare this article again" is ticked. Links from other cases to a deleted one are kept and marked.

## AI errors

When OpenAI refuses a request, the app now says why instead of only "HTTP 400". The message names the cause (bad or revoked key, no credit or quota, rate limit, model not available to the key, or a parameter the model does not accept) and quotes OpenAI's own wording with any key text removed. Models that need `max_completion_tokens` and no `temperature` (gpt-5 and o-series) are handled automatically, and an unsupported-parameter reply is retried once with the shape the model wants. `/api/ai-models` (manager only) lists the chat models the key can use; Test connection shows them when the model name is the problem.

## Start pulling from a date

Settings > Automatic PubMed pull has a "Start pulling from" date. From that day on, every day not yet covered is pulled for every molecule (including days before the first pull), in the usual weekly windows. A future date holds the pull back until it arrives. Clearing it restores the default (from the first day already covered, or yesterday for a new molecule). The setting is `autoPullFrom` on `/api/settings`.

## Clearing pulled articles (and cases)

Batches > Clear pulled articles (manager only) deletes pulled articles in bulk: all of them, or those of one portfolio, molecule, or pulled before a date. It removes their full texts, screenshots and queue items. By default cases stay and so does any article a case was made from. Tick "Also delete the cases" to remove cases too (every case when no scope is chosen); signed or approved cases need an extra acknowledgement, and a tombstone and audit entry record each one. Tick "forget which days were covered" if the automatic pull should fetch those days again. Settings, people and the AI key are untouched. Routes: `/api/pulled-purge-preview`, `/api/pulled-purge`.

## Quicker case deletion

Tick any number of cases (or "Select all shown") and press Delete. For cases that are not signed, approved or exported, the dialog needs no reason and no typed confirmation: one button deletes them all and the reason is recorded as "Removed to free space" unless you write one. Signed or approved cases still need a reason, the typed confirmation and an acknowledgement.

## Add molecule, client-focused queue and dashboard

- **Add molecule** (Clients page: the Add a molecule panel, and a button on every client card that preselects that client; managers and users allowed to manage clients): choose the client and portfolio (or a new portfolio), type the molecule and optional brands; the PubMed query is built from the names and the molecule is pulled automatically from then on. Route: `/api/molecule-add`.
- **My Queue > By client** groups the queue by client then molecule, most overdue client first, with open, overdue, due-soon and serious counts and the next deadline. "By deadline" keeps the week view.
- **Dashboard > Clients and molecules** shows a card per client (open, overdue, high priority, serious, next due, and each molecule), with a client filter that applies to the whole dashboard (`/api/dashboard` takes `client`).

The Add molecule dialog's portfolio defaults to **Auto**: the portfolio the chosen client already uses most, else the client's name, else "General". A portfolio can still be picked or typed.

### Portfolio by drug class

With the portfolio left on Auto, Add molecule classifies the molecule by its WHO ATC class and files it under the matching therapeutic area (for example valsartan, an angiotensin II receptor blocker, goes to Cardiovascular). A built-in table of drug-name endings and common drugs answers instantly; RxNorm's ATC classes are asked when the name is not in the table. If a portfolio that covers the area already exists ("Cardiovascular", "Hypertension Products", "CNS"), it is reused instead of creating a new one. If the molecule cannot be classified, the client's usual portfolio, the client's name or "General" is used. Picking a portfolio yourself always wins, and the confirmation says how it was classified.

## Pulling by client

The Watchlists page is organised by client. Each client has its own card: its molecules with articles, last pulled and status, a **Pause client / Resume client** switch, **+ Molecule**, and **Pull this client now**. Molecules with no client are listed last with a prompt to assign them. The automatic pull takes the waiting day-ranges of all clients in turn, so one client's backlog cannot hold up the others; a paused client is skipped (a manual pull still works for it). The add-watchlist and bulk forms start with the client. Routes: `/api/client-auto`; `/api/scheduled` accepts `client` (an id, or `none`); `/api/scheduler-status` returns `perClient`.

## Batches and Search & Pull by client

- **Batches** has a client filter bar at the top. The scheduler's missed windows, the import coverage table and the batch archive are grouped by client (the letter badge shows the client, and the filter narrows every table). The old single-molecule backfill form is replaced by **Backfill a client**: choose a client, tick the molecules, set the date range and press Pull this client.
- **Search & Pull** starts with **Pull for a client** (managers pull any client; data-entry and QC people pull only the client's molecules in their own portfolios, into their own queue). The single-molecule search is kept below it and now has an optional **Client** field, so a molecule pulled there is filed under that client.
- Route: `/api/pull-client` (client, optional molecule list, dates, date field, and the humans / case reports / English / no reviews filters); up to 25 molecules per pull, one year at most.

### Several molecules at once

The Add molecule dialog takes one molecule per line (brands and other names after commas), up to 100 at a time, for one client. With the portfolio on Auto each molecule is filed under its own drug-class portfolio; a chosen portfolio applies to all. Repeated or already-present molecules are skipped and reported, and one bad line does not stop the others. `/api/molecule-add` accepts `list`; the single `molecule` field still works.

## Watchlists, redone: client first, then molecule

The Watchlists page opens with the global automatic pull, then a **By client | By molecule** switch (client first).

- **By client**: each client card has its automatic switch (Pause / Resume), **Start pulling from** and **Stop pulling after** dates, **+ Molecules**, **Pull new now**, and **Pull custom dates for this client** (any date range, publication or create date) for all its molecules at once. Below, each molecule shows its articles, last pulled, status and pulling window, with **Auto on/off** and **Dates…**.
- **By molecule**: a searchable table of every molecule with its client, portfolio and the same controls.
- **Dates…** on a molecule sets its own start and stop dates (they win over the client's, which win over the global start date; an empty date follows the next level up) and can pull any custom range for just that molecule.
- Days before the start date, and after the stop date, are never pulled or reported as missed. Routes: `/api/client-auto` and `/api/watch-auto` take `on`, `startFrom` and `until`; `/api/pull-client` does the custom-date pulls.
- The dictionaries, query versions, add-a-watchlist, bulk, assign-by-employee and assign-by-number panels remain below, unchanged.

Every molecule row on the Watchlists page now has a switch for its automatic pull: flip it and the change is saved at once, with no page reload.

A stop date is optional. With no stop date, pulling continues every day until a manager pauses the client or the molecule; the page says "continuing until paused". Pause and Resume on a client card are saved immediately and the card shows its Paused state.

## Articles pulled per client, per week

The top of the Clients page shows a table of how many articles each client received in each week (4, 8, 12 or 26 weeks; an article counts in the week it reached the queue, its IRD), with a total per client for the period, an all-time figure, and a totals row; busier weeks are shaded darker. **Export CSV** downloads the same numbers with the client name and the number side by side (`Client, Articles pulled (period), Week of ..., All time`, plus a Total row). Routes: `/api/client-pull-stats` and `/api/client-pull-export` (managers and users allowed to manage clients).

## Faster pulls that miss nothing

- **Several at once.** The windows of one import run four at a time, and a client pull works on three molecules at a time. NCBI's shared request gate still spaces the requests, so the allowed rate is never exceeded; only the waiting is overlapped. Windows are tracked by their dates, so a window that splits in two while others run is handled safely.
- **Instant on the host.** Full texts and screenshots take much longer than the citations, so on the server (`DEFER_EVIDENCE=1`, the default there) a pull answers as soon as every citation is stored and gathers the evidence right behind it, and again on every scheduler tick.
- **Checked against PubMed.** Every window compares PubMed's count with what came back. A client pull re-runs any window that did not reconcile (up to two more times) before answering, shows "Complete: N of N" or "Incomplete, will retry" per molecule, and an incomplete window stays on the retry list. Articles are stored once and never assigned twice in a portfolio.
- **Live Search & Pull.** Pull for a client now pulls molecule by molecule, three at a time, and each row appears as it finishes with the running totals.
- **Dashboard.** Each client card on the Dashboard shows how many articles were pulled for the client (all time) and in the last 7 days, even when nothing is open.

## Search & Pull for a client: fixes

- **A manual pull always fetches again.** Pulling dates that were pulled before used to reuse the old run, so after pulled articles were cleared a repeat pull brought nothing back. Manual pulls (client, single molecule, my own) now always go to PubMed; an old finished import is only replayed when its articles are still there.
- **Create date is the default** for Search & Pull (articles are found when PubMed received them, so nothing new is skipped); publication date is still one click away, and the Batches backfill keeps publication date as its default.
- **Results stay on screen.** The per-molecule results table used to disappear when the page refreshed at the end of a pull; it now stays until the next pull.

## Client pulls search every name (recall fix)

A pull for a client used each molecule's stored query, which usually held only the name it was added with, so it found a fraction of what a single-molecule pull (with the INN, generics, salts and brands) finds. It now searches the stored query OR every other known name: the portfolio's product dictionary and the drug name list (INN, salts, synonyms, up to 40 brands; the name list is asked online when the molecule is not in it yet). Each result row says how many extra names were searched, a manager's pull saves the broader query as the molecule's search so the automatic daily pull is equally thorough, and new molecules added from the Clients page start from the broad search. One-off filters (humans, case reports, English, no reviews) apply on top and are never saved.

## Broad search and "Compare with PubMed"

The PubMed website searches a bare word in every field and maps it to MeSH, which finds several times more than the app's precise search (title, abstract and MeSH only). For a client:

- **Search style** (Watchlists, on each client card): *Precise* or *Broad, like PubMed*. Switching rewrites each molecule's search (a new query version from today) so the automatic daily pull follows it.
- **Search & Pull > Pull for a client** has a **Broad search** box (on by default) and **Compare with PubMed**, which shows for each molecule what the precise search finds, what the website style finds, the website style with no date limit, how many are stored here, and a link that opens the same search on pubmed.ncbi.nlm.nih.gov. A pull's result rows also say when the website style would have found noticeably more.
- Routes: `/api/client-compare`; `/api/client-auto` takes `searchMode`; `/api/pull-client` takes `searchMode`.

## "Failed to execute 'json'" fix: background pulls

A long pull could outlast the time limit of the web server in front of the app, which then answered with an empty or HTML page and the browser showed "Failed to execute 'json' on 'Response'". On the server, a client pull now returns at once with a job number (`/api/pull-client` with `background: true`) and the page asks `/api/pull-job` for progress every 1.5 seconds, so no single request is long. The page also reads every answer safely: an empty or non-JSON reply now says what happened (for example "The server took too long to answer (HTTP 504)") instead of the raw browser message. Jobs are kept in memory for an hour; the pulled articles themselves are stored as usual, so a restart never loses them.

## Pull everything PubMed has, add NCBI PubMed Central, calcium acetate

- **No date field.** The Create date / Publication date choice is gone from Search & Pull, Batches backfill and the Watchlists custom-date pulls. A client pull now pulls **every article PubMed has for the molecule, whatever its dates**: one search with no date limit, which the app splits only where PubMed would cut the list short, so none is dropped. Tick **Only articles from a date range** to limit it; a limited pull matches articles created in PubMed *or* published in those dates. A molecule with more than 10,000 articles is reported with its count rather than pulled by accident (pull it with dates).
- **NCBI PubMed Central** is added: a source in the worldwide Search (PubMed Central, with the full-text archive) and a **Also search NCBI PubMed Central** option on the client pull, which finds articles whose full text names the drug and feeds those that have a PMID back through the PubMed pipeline.
- **Two-word names such as calcium acetate**: the broad search quoted the phrase bare, which finds nothing when PubMed does not know the phrase. It now searches the phrase in All Fields, MeSH terms and supplementary concepts.

## Search & Pull, reworked

One page, one engine. At the top, choose what to pull: **By client**, **One molecule**, **PMID list**, **Other sources** (Europe PMC, OpenAlex, trials, regulators, PubMed Central), **Patient posts**. For client and molecule pulls the settings card is shared and kept while you switch:

- **Dates**: All dates (the default), Last 30 days, Last 3 months, Last 12 months, or your own From / Through. There is no date-field choice any more: with dates, an article counts if it was added to PubMed or published in them; with no dates, every article PubMed has is pulled, whatever its dates (a molecule with more than 10,000 articles is reported instead of pulled whole).
- **Search**: Broad (like the PubMed website, the default) or Precise (title, abstract and MeSH). Every known name is searched either way.
- **NCBI sources**: PubMed, plus PubMed Central for drugs named only in full texts.
- **Filters**: humans, case reports, English, no reviews (and safety articles only for one molecule).

**By client** pulls the ticked molecules three at a time in the background, with a per-molecule check against PubMed's count, and **Compare with PubMed** shows the precise, broad and any-date counts. **One molecule** (managers) saves the molecule to its client, reusing it if it is already watched and adding any new names, sets the owner, then pulls it with the same engine; for data-entry and QC people it pulls into their own queue in their portfolio without creating a watchlist. Every pull writes one results table that stays on the page.

## Pulls finish in one go, faster, with live progress

- **No more 12-window stop.** An import used to process at most 12 search windows per request and leave the rest for the scheduler, so a long Search & Pull (or a Batches import of a long range) came back with only part of the articles. Manual pulls (Search & Pull, Batches, single molecule, PMID-free imports) now run every window to the end, and re-run any that did not reconcile.
- **Fewer requests.** Citations are fetched 200 at a time instead of 100, and a dated pull searches a quarter at a time instead of two weeks (windows still split automatically when PubMed would cut a list short). An NCBI API key in Settings raises PubMed's limit from 3 to 10 requests a second; Search & Pull says so when no key is set.
- **Live progress.** While a molecule is pulling, its row shows the stage and the running count ("Pulling: 45 articles · 21 of 23 search windows"), then "Complete: N of N" checked against PubMed.
- **Kept after a restart.** A finished pull's answer is stored, so the page still gets it if the server restarted; a pull interrupted by a restart says so, and everything pulled before is kept.
- Large literatures: a molecule with more than 25,000 articles is reported with its count; choose Last 12 months or your own dates for it.

## Searched by the molecule and its own names only

A molecule is searched by its name and by the other names someone gave it (typed when it was added, in the One molecule pull, or in **Watchlists > Dates…**, which now has an editable "Other names searched with it" field). It is never searched by its portfolio, and nothing is added automatically from the portfolio's product dictionary or the drug name list. Molecules added earlier keep the names they were created with; names that the app had appended for them are dropped, and a manager's next pull brings the daily search back in line. A hand-written PubMed query is searched exactly as written. This applies to client pulls, single-molecule pulls, personal pulls, Compare with PubMed, the search-style switch and the automatic daily pull.

## Search & Pull fixes (end-to-end checked as manager and as data entry)

- **Data-entry and QC users** saw "No client has molecules yet": the page never received their clients' molecules. It now receives the molecule names (never the queries) of their own portfolios, so By client works for them, and **Compare with PubMed** works for them too (their own portfolios' molecules only).
- **A busy PubMed** answer (HTTP 429, an HTML page, a cut-off reply, or an "ERROR" inside the JSON) is treated as temporary and tried again, up to five times, for searches, citations, details, PubMed Central and the comparison counts. Before, a busy details reply was read as "no details" and left the molecule incomplete.
- **Clearer incomplete rows**: they say what is still missing ("2 citations still to fetch" or "1 search window failed"), and that it is retried automatically.
- **A running pull** is saved as it goes, so its progress can be read even from another server process or after a restart; one cut off by a restart says so after 20 minutes without progress.

## Same pull, same result

Pulls gave different numbers from one try to the next because a busy PubMed made some search windows fail, and the pull gave up after a fixed number of tries, at a different point each time. Now:

- **A pull you start is finished only when every search window matches PubMed's own count.** Windows that failed or came back short are reset and run again with a growing pause, for up to six rounds; then PubMed is asked for its total for the whole search, and if more articles exist than were stored, the whole range is searched once more.
- **Requests are paced to what PubMed allows**: without an NCBI API key two molecules and two windows run at a time (with a key, three and four), so PubMed refuses far fewer requests.
- **The results table shows the same columns every time**: *In PubMed* (PubMed's own total for the search), *Stored here* (all of them for this molecule), *New this time*, and a check that reads "All N stored" only when the two match. A repeat pull shows the same In PubMed and Stored numbers with 0 new.
- A test pulls the same client five times against a PubMed that randomly fails a third of its requests and gets the identical, complete result each time.

## No more "retried automatically": concrete, complete pulls

- **Book chapters are read.** PubMed returns NCBI Bookshelf records (for drugs, typically LiverTox chapters) as `<PubmedBookArticle>`, not `<PubmedArticle>`. They were not read, so every search that matched one stayed "incomplete" forever. They are now stored like articles.
- **Records without an English title** (only a vernacular or book title) are stored instead of being counted as missing.
- **PMIDs PubMed lists but cannot supply** (withdrawn, merged, not yet released) are asked for again once; if PubMed still has no record, they are counted as such and no longer hold the pull open.
- **Concrete results.** Each row shows *In PubMed*, *Stored here*, *New this time* and a check: "All N stored" (plus how many PubMed listed but could not supply), or "X of N not stored" with the PMIDs concerned and a **Try again** button for that molecule only. Each row links to **Same search on PubMed**: the exact query and dates the app used, to compare on the website.

## Accuracy over speed

Pulls are deliberately careful now; they take longer and are checked to the PMID.

- **One stream at a time.** A pull works on one molecule and one search window at a time, at a pace a little under what PubMed allows (2.5 requests a second without a key, 8 with one), so PubMed has no reason to refuse requests. Citations are fetched 100 at a time, and every request is tried up to seven times.
- **Checked PMID by PMID.** After every window matches PubMed's count, the app asks PubMed for the exact list of PMIDs for the whole search and compares it with what was stored. Anything missing is fetched there and then, added to the same pull and the same queue, and the row says "Checked PMID by PMID against PubMed" (and how many the check filled in). Searches of up to 9,999 articles are checked this way; above that, the per-window counts are the check.
- The progress line shows each stage, including "Checking every PMID against PubMed…".


## PubMed query tab and Excel export (ideas from TLDWTutorials/PubmedAPI)

- **Search & Pull > PubMed query**: paste any PubMed expression, exactly as on the PubMed website, or build one from **authors** (`[Author]`) and **topics** searched in title and abstract (`[Title/Abstract]`). Choose a portfolio and a label. The dates, date basis and filters of the settings card are added; nothing else changes the expression. It runs through the same engine as every other pull: date windows, retries, the run snapshot and the PMID-by-PMID check. Managers pull into any portfolio; others into their own portfolios and own queue.
- **Excel (.xlsx)** next to Reconciliation (CSV) on every pull result: one row per stored article with PMID, Title, Abstract, Authors, Journal, Keywords (MeSH), URL, Affiliations (now every author's, not only the first), then molecule, portfolio, publication date and DOI.
- Routes: `/api/pull-query`, `/api/build-query`, `/api/pull-xlsx`.

## Clients replace portfolios

The client is now the only grouping. On first load the stored data is migrated once: every molecule is filed under its client (or a client named after its former portfolio), queues, the Library, roles, runs and cases follow, and duplicate assignments are merged keeping the furthest-along review. Renaming, deleting or moving a client regroups automatically. A client, portfolio or drug class never enters a PubMed query.

## Saved searches (Search & Pull)

Every molecule has exactly one saved search: its own names (brands, salts, spellings), a mode (PubMed default, Precise or Custom) and its filters (Humans, Case reports, English, No reviews, Safety articles only).

- **Search & Pull → Saved searches** lists them per client, with the exact PubMed query. *Count in PubMed* gives a live count for the chosen dates. Managers can *Edit* a saved search, *Preview and count* the draft, and *Save search*.
- Saving creates a new query version effective from today. Past pulls keep the version they ran with (audit trail).
- *Pull this client* and *Compare with PubMed* send only the dates, the date basis and the PubMed Central option. Each molecule runs its saved search. The daily automatic pull runs the same saved search, so manual and automatic pulls cannot differ.
- **Own dates per molecule:** on a saved-search card, *Own dates for this molecule* sets From/Through (or Past week, 30 days, 3 months, 12 months) for that molecule only. Count, Compare and Pull use them; the other molecules use the shared dates. *Use the dates above* removes them.
- Routes: `/api/saved-searches` (list for a client), `/api/saved-search` (preview/count, or `save:true` for managers).

## Automatic pull schedule

- The automatic pull goes by publication date [dp], day by day, with a daily 60-day late-arrival sweep for articles PubMed indexes after their publication date.
- Each client has a schedule (Clients tab, inside the client): every day, or every week on one weekday, at a time of day (India time). Default: every day at 06:00.
- A client is pulled at the first scheduler tick (about hourly) after its slot; the pull brings in every day not yet pulled. Each client row shows its next pull. "Run now" (force) ignores the schedule.
- **Count like PubMed alerts** (per client, Clients tab → schedule row): the client's automatic pull and its default counts use the date articles are added to PubMed (Create date [crdt]), as My NCBI "What's new" alert emails do. Other clients use publication date with the 60-day late-arrival sweep. In the paste box: `schedule | every: weekly | day: Sunday | time: 06:00 | count: alerts`.
- **IRD = weekly receipt day** (per client, Clients tab → schedule row): an article's IRD is the client's scheduled weekday after the week it was found in (the day the weekly email reaches the mailbox), never later than the day it was pulled; screening due dates follow. When switched on, open unscreened items can be updated too. Paste line: `schedule | every: weekly | day: Sunday | time: 06:00 | count: alerts | ird: receipt`.

## Screened articles and the QC re-check

- **Every rejection goes to QC.** When a DE excludes an article, it moves to "Awaiting QC". To go back to sampling rejections at the QC rate, use Settings: "Send every rejected article to QC".
- **Screened tab** (DE, QC and managers). It has two lists:
  - **Rejected**: excluded articles.
  - **Safety present**: potential ICSRs and aggregate safety.
- Both lists are grouped by client. Each row shows the IRD, the title (with a PubMed link), the DE reason and comment highlighted yellow, the QC status and the QC comment.
- People see only articles they may access: the DE sees their own, and QC sees the items routed to QC for their clients.
- **QC re-check.** Use the filter chips All / Waiting for QC / QC agreed / Sent back. On an item waiting for you, type a comment and press **Agree**, or press **Send back**, which needs a comment of at least 5 characters. A sent-back item returns to the DE's queue; the DE's new decision goes to QC again.
- **Word document.** "Download Word" builds a `.docx` with the current filters (client, IRD range, QC status). It has a section per client; under each article are its IRD and PMID, the DE comment highlighted yellow, and the QC comment. Every download is recorded in the audit trail.
- **QC sees all safety present articles** of their clients, whether or not they were routed to QC. QC can comment on any of them.
- **Bulk comments.** Tick articles, or use "Select all shown", and type one comment. Then choose:
  - **Add as DE comment**: DE only, on their own articles. It replaces the DE comment; the rejection reason stays.
  - **Add as QC comment**: QC only, never on their own articles.
  - **QC agree all** or **Send back all**: acts only on the selected items that are waiting for QC.

  Articles that can't take the action are skipped, and the app lists them. Every bulk action is recorded in the audit trail and in each article's history. Comments added in bulk appear in the Word document.

## Overlapping searches

One article can be found by two searches of a client: an article about calcium chloride matches both "Calcium" and "Calcium chloride". The app always keeps it as **one** work item. DE screens it once, QC checks it once, and medical review sees it once.

Each client has a setting for how such an article is **counted**:
- **Under every drug** (the default): it counts under each drug whose search found it, the way the client's separate alert emails count it.
- **Once, under the most specific drug**: it counts only under the drug whose name contains the others (calcium chloride rather than calcium). If neither name contains the other, the first alphabetically is used.

Where to set it:
- Clients tab: the schedule row, "Overlapping searches".
- Watchlists: the "Count overlaps once" / "Count overlaps under every drug" button.
- Paste box: add `overlap: once` or `overlap: each` to the schedule line.

Where it shows:
- DE, QC and medical queues, and the Screened tab: an "also …" tag naming the other drugs that found the article. The queue groups the article under its counted drug.
- Watchlists: each drug's count, with how many articles it shares and with which drugs.
- Search & Pull: each drug's result notes how many articles another drug also found, and the summary line shows the unique total.
- Drug counts on the Clients tab: each drug's count follows the setting, and the number shared is shown.

## Pulled articles (Search & Pull → Pulled articles)

This is a table of every pulled article you can see, filtered by IRD dates, client, and whether you pulled it, it is in your queue, or anyone pulled it. Managers can also filter by person.

Columns: number, client, drug (following the overlap setting), also found by, PMID, title, journal, published date, IRD, pulled by, screener, status.

Ways to export it:
- **Copy table**: copies it as a table you can paste into Excel, Outlook or Word.
- **Save as image**: a PNG of up to 400 rows.
- **Excel** and **CSV**: every row.

## Sending the Word file to QC

1. In **Screened**, the DE sets the filters (client, IRD dates) and presses **Send to QC**, adding an optional note. Only the DE's own articles in the list are sent.
2. QC sees the document under **Word documents sent to QC** at the top of the Screened tab and presses **Open for QC**. Only that document's articles are listed.
3. QC types a comment under each DE comment:
   - for articles waiting for QC: **Agree** or **Send back**;
   - for any other article: **Save QC comment**.
   Bulk comments work here too.
4. **Word** (or "Download Word with QC comments") gives the file with each DE comment highlighted yellow and the QC comment on the line right below it. The header says who sent it and when, and whether QC is done.
5. QC presses **Mark QC done**, and **Reopen** reverses it. The DE sees the status change on their copy of the list. The DE cannot mark their own document done.

The document keeps its list of articles; the comments are always the current ones. Sending, downloading and marking done are all recorded in the audit trail.

### Safety present articles go to the medical reviewer

This works the same way as the rejected list going to QC:
- On the **Safety present** tab, the DE presses **Send to medical reviewer**.
- The medical reviewer sees all safety present articles of their clients, along with the documents sent to them.
- They **Open for review** and type a **medical review comment** under each DE comment. Bulk "Add as medical comment" also works.
- They press **Mark review done** when finished.

In the Word file, each article has:
1. the DE comment (yellow);
2. "Medical reviewer comment (name)" on the line right below;
3. the QC comment, if the article also went through QC.

A medical reviewer who has neither the QC nor the screener role opens the Screened tab on Safety present.

## Mass rejection and mass QC (My Queue)

- **DE (Screening queue):** each article has a tick box, and there is a **Select all shown** box, which follows the search and client filters. Choose the **rejection reason** and type one **DE comment**, then press **Reject selected**.
  - "Other" needs a comment.
  - Each article goes through the same rules as a single rejection: only your own articles (or any, for a manager), and each goes to QC for a re-check.
  - Articles that can't be rejected are skipped and listed.
- **QC (QC queue):** use the same tick boxes and Select all, type one QC comment, then press **QC agree selected** or **Send back selected**. Send back needs a comment of at least 5 characters.
- The Screened tab also has Select all and bulk actions for DE, QC and the medical reviewer.
- Every bulk action is recorded in the audit trail and in each article's history.

## Article counts per client (image)

**Counts per client (image)** is available in two places:
- **Search & Pull → Pulled articles**, which also shows the table on screen;
- the **Screened** tab, using its IRD dates and client.

It saves a PNG with one row per client and its drugs underneath, plus a total row. The columns are:
- Articles
- Not screened
- Rejected
- Safety present
- Waiting for QC
- QC agreed
- Sent back

The header shows the IRD range, who made it, and the date. The DE sees their articles. QC and medical reviewers see every article of the clients they work on.
