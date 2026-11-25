# LiteraSift

A standalone PubMed screening website. It imports date-range batches from approved watchlists, assigns citations to eligible reviewers, and tracks decisions in a manager dashboard.

## Build and check

Requires Node.js 22 or newer and Bash.

```sh
bash scripts/build.sh
node scripts/validate-artifact.mjs
node --check scripts/run-watchlists.mjs
```

The Worker uses the Sites sign-in gateway and a private R2 bucket bound as `BUCKET`. The checked-in hosting manifest identifies the existing private deployment.

## Hostinger worker

Keep the website and storage on Sites while running the scheduler on your VPS. Configure a secret `RUN_TOKEN` on the Site, then supply the same value and the Site service-access token in a private environment file on the VPS. The two tokens are separate.

- `BENCH_URL` is the Site's HTTPS origin.
- `SITES_ACCESS_TOKEN` is the Site service-access token.
- `RUN_TOKEN` is the scheduled endpoint's secret.
- Configure `SCREENSHOT_ENDPOINT` and `SCREENSHOT_TOKEN` on the Site to turn on its Browserless-compatible screenshot integration.

- Unpaywall: a manager can enter the contact email under Settings (or set `UNPAYWALL_EMAIL` on the server, which takes precedence). Every article with a DOI then gets an open-access status shown across the site: queue badges and an access filter, an Overview breakdown, CSV columns, and a full-text fallback. Closed articles are re-checked every 30 days. Details of the fallback: set `UNPAYWALL_EMAIL` on the Site (a contact address for the [Unpaywall](https://unpaywall.org/products/api) API) to enable the full-text fallback. Articles without an eligible PMC copy are looked up by DOI. A PDF is stored only when its licence is CC0, CC BY, CC BY-SA or CC BY-ND; otherwise the open-access link is shown without being downloaded. Articles previously marked "No PMC record" are retried once.

- Retraction checks need no setup. Each article's DOI is checked against [Crossref](https://www.crossref.org/documentation/retrieve-metadata/retraction-watch/) update notices (publisher and Retraction Watch sources) and PubMed's own "Retracted Publication" flag, then re-checked every 30 days. Retracted items and expressions of concern get a red badge in the review table and a CSV column. Set `CROSSREF_EMAIL` (falls back to `UNPAYWALL_EMAIL`) to use Crossref's polite pool.

## Molecule watchlists

A portfolio can hold many watchlists, one per molecule. On the Watchlists tab, paste one molecule per line (molecule first, then synonyms, brands or salts, separated by commas or tabs) to build up to 500 PubMed queries at once. Each query matches the names in title/abstract, MeSH and supplementary concepts. Tick "Safety-related articles only" to add an adverse-effects filter. Saving a molecule again replaces its query.

- A citation matching several molecules in one portfolio is one assignment, tagged with every matching molecule.
- A search over PubMed's 9,999-record limit is split into smaller date ranges automatically.
- Each scheduled call imports up to 10 watchlists (never-attempted or least recently attempted first); the runner script repeats until none remain.
- Backfills on the Batches tab are per molecule.

Run `node --env-file=/path/to/private.env scripts/run-watchlists.mjs`. Confirm exit status zero and check the site's Batches tab before scheduling it with cron or a systemd timer. Each invocation processes up to four pending evidence records, so run it periodically to clear the evidence queue. The importer uses the last complete India calendar day and skips portfolio/date windows already imported. Use the Batches tab for historical backfills.

Never commit runtime secrets. This runner does not move the website, authentication, or storage to the VPS.

## Self-hosting on a VPS (Hostinger)

`server/` runs the same `worker/index.js` on Node 22: file storage under `/var/lib/literasift`, cookie sign-in (scrypt-hashed passwords in `users.json`), and an in-process hourly scheduler, so no cron job is needed. Caddy provides HTTPS.

```sh
DOMAIN=literasift.tech ADMIN_EMAIL=you@example.com REPO_BRANCH=main bash deploy/build-installer.sh   # writes dist/install-literasift.sh
```

Run `dist/install-literasift.sh` as root on a fresh Ubuntu VPS (or supply it as a Hostinger post-install script). It clones the repository, so the repository must be readable from the VPS during install; `literasift-update` later pulls and restarts. It installs Node, Caddy and the service, generates `SESSION_SECRET` and `RUN_TOKEN` into `/etc/literasift.env`, and writes the first password to `/root/literasift-admin.txt`. The first person to sign in becomes the manager; add reviewers on the Team tab, then give each a password with `literasift-user set reviewer@example.com`. Point the domain's A record at the VPS before the first start so Caddy can obtain its certificate.

### Automatic deploys

On the VPS, run once (as root): `curl -fsSL https://raw.githubusercontent.com/sriram-med/Literasift/claude/vigilant-planck-42pjio/deploy/enable-autoupdate.sh | bash`. It installs `literasift-update` and a systemd timer that checks the branch every 3 minutes. A new commit is syntax-checked, swapped in, restarted and health-checked; if it does not become healthy it is rolled back and not retried. Logs: `journalctl -u literasift-update`. The script also prints a read-only deploy key, so the repository can be made private again (add it under the repository's Deploy keys). `literasift-update --force` redeploys the current commit.

## PDF export with screenshots

"Export PDF" on the queue (current filter) and the "PDF" buttons on Batches and Search & Pull build a document with a cover page and, for each article, its details (PMID, journal, DOI, portfolio, molecules, reviewer, status, retraction/access status) plus a snapshot of its PubMed record. Exports are split into parts of 40 articles. Reviewers can export only their own assignments. The PDF writer is built into the Worker and needs no libraries.

Screenshots come from a Browserless-compatible endpoint (`SCREENSHOT_ENDPOINT`/`SCREENSHOT_TOKEN`) or, on the VPS, from a local Chromium: run `bash /opt/literasift-src/deploy/enable-screenshots.sh` once. Articles without a screenshot are exported with a placeholder.

## Accounts and password recovery (VPS)

Managers add reviewers on the Team tab ("Save and invite"). The reviewer gets a single-use link (valid 7 days) to set their own password; there is no need to share passwords. Every user can change their password on the Account tab, and anyone can use "Forgot your password?" on the sign-in page (link valid 1 hour, always answered the same way so accounts cannot be discovered). Resetting or changing a password signs out every other session. Managers can also send a new link or revoke a user's sign-in.

Links are emailed when SMTP is configured in `/etc/literasift.env` (`SMTP_HOST`, `SMTP_PORT` (465, implicit TLS), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`) and `PUBLIC_URL` is set; otherwise the manager is shown the link to send themselves, and the sign-in page's reset form says to ask a manager. Passwords need at least 12 characters and are stored as scrypt hashes. `literasift-user` still works for the first account or recovery from the server.

## Extraction sources

Abstracts, authors, MeSH terms and citation counts are pulled from PubMed, Europe PMC and OpenAlex; full text from PMC, Europe PMC and Unpaywall (open-licensed only); PDFs can be turned into text by a self-hosted GROBID (`GROBID_URL`). Reviewers see the abstract with the molecule and safety terms highlighted, plus key passages from the full text. See `docs/OPEN_SOURCE.md` for the full list, licences and what was deliberately not integrated.

Screenshots on the VPS are a rendered "record card" built from the stored PubMed data. Live PubMed pages are not captured: NCBI forbids automated browsing of its web pages (it answers with `403 Forbidden`) and directs automated access to E-utilities. When no reviewers exist yet, new citations are assigned to the manager.

## Molecule search to full text

Search & Pull now drives the whole chain. After a pull, a "Full-text extraction" panel starts working through the new articles automatically (PubMed Central, then Europe PMC, then Unpaywall, stored only under open licences) and shows live progress: abstracts, Unpaywall open-access checks, retraction checks, full texts stored by source, open-access link-only, closed access, and key passages. "Extract full text now" restarts it, "Download full texts (ZIP)" bundles the stored PDFs/XML, their extracted text and a `manifest.csv` (source, licence, URL per article), and queues have a "Full text" filter plus a ZIP button for the filtered list. ZIPs are split into parts of 40 articles. The server-side scheduler keeps going in the background if the browser tab is closed.

## Molecule ownership and restricted-licence full text

**Assigning a molecule.** On Watchlists, "Assign a molecule to an employee" gives one person every pulled article for that molecule that is not yet complete (tick "Also move articles already assigned to someone else" to take them over), and every article pulled for it afterwards. Search & Pull and the bulk molecule form can set the owner up front. Owners ignore the open-article limit. My Queue shows each person's coverage by molecule, and the Team tab shows screened / assigned per person.

**Restricted licences.** Settings has "Store open-access copies under restrictive licences" (on by default). When on, free-to-read copies found by PubMed Central, Europe PMC and Unpaywall are stored even under CC BY-NC, publisher terms, or no stated licence (permissive copies are still preferred). They are badged "Restricted licence", ZIPs include a `NOTICE.txt`, and they are meant for internal screening only. Only copies a publisher or repository offers free and legally are fetched; paywalled articles are never bypassed. Turning the setting on retries articles that only had a link.

## More sources (synonyms, safety context, citations)

On Search & Pull, "Suggest synonyms & brands" proposes names from RxNorm and PubChem (tap a chip to add it), and after a pull a panel shows the most-reported FDA FAERS reactions for the molecule as context. Articles also get PubTator3 "Conditions mentioned" (used as extra highlight terms), and any list can be exported as RIS or BibTeX for reference managers. See `docs/OPEN_SOURCE.md` for sources, what was considered and left out, and what is unverified.

## Articles with no free full text

Full text is fetched from PubMed Central, Europe PMC, Unpaywall and Semantic Scholar, in that order. Many articles (closed journals) have no legal free copy, and the app never bypasses paywalls. For those: a missing DOI is looked up in Europe PMC and OpenAlex and the article is re-checked; each article shows a "Publisher page" link; "Retrieval list (CSV)" exports the listed articles without stored full text (DOI links, PubMed links, access status) for a library or document-delivery request; and "Flag for manual retrieval" sets them to "Full text needed" so reviewers can see what is outstanding. When a new source is added, earlier "not found" results are retried once automatically.

## Library, audit trail and backups

**Library.** The Library tab shows a top-level folder per source (`PubMed/`, and one per government agency such as `FDA/` when enabled), then a folder per molecule, then a subfolder per pull's date range (`PubMed/Molecule/2026-10-01_to_2026-11-04/`). Each folder has ZIP (full texts in that folder structure plus `manifest.csv`), PDF (with record snapshots) and RIS buttons, and an article is filed once, in the oldest date range that imported it. On the VPS the same tree is kept on disk under `/var/lib/literasift/library/` (full text, extracted text, record snapshot, `_index.csv` per folder), refreshed after each scheduled run and every 15 minutes, so it can be copied or browsed directly.

**Audit trail.** The Audit tab (managers) lists sign-ins and failed sign-ins, review decisions, bulk status changes, molecule assignments, pulls and imports, watchlist and setting changes, account invites/resets/revocations, password changes, exports and full-text downloads, each with user and time. Entries are stored append-only in monthly files (`audit/YYYY-MM.ndjson`) and hash-chained, so an edited or removed entry shows as "Chain broken". It can be exported as CSV. This is tamper-evident, not tamper-proof: someone with full server access could rewrite the whole file, so keep off-server backups.

**Deleting a watchlist** (Watchlists tab) stops new pulls only; articles, files and past pulls stay.

**Backups (VPS).** Run once on the server: `bash /opt/literasift-src/deploy/enable-backups.sh`. It archives all data (database, files, audit trail, library, accounts) daily at 02:30 and keeps the last 14 in `/var/backups/literasift`. Copy them off the server now and then.

## Relevance ranking and assigning by number

Queues are sorted by a transparent relevance score (0-100: High 60+, Medium 30-59, Low below 30) with the reasons shown under each badge; the sort can be switched to newest or oldest. The score adds up: the molecule in the title or abstract; safety terms (matched at word starts, so "harm" does not match "pharmacokinetics"); serious-outcome terms; case reports; special populations; PubTator conditions; key passages from full text; retracted articles and expressions of concern; and a little for citations. Missing abstracts and editorials/letters score lower. It is rule-based, not learned, and meant for ordering work, not for deciding relevance.

**Assign by number** (Watchlists tab): pick a molecule, an order (most relevant, newest or oldest first) and which articles (all not yet complete, or unassigned only); then give each range to a person, for example 1-20 to one person and 21-30 to another. "Preview ranked list" shows the numbered list and who each range goes to before "Assign" applies it. Ranges must not overlap; articles outside the ranges are untouched; every assignment is written to the article history and the audit trail.

## Sources: PubMed kept separate from government agencies

Every article and pull carries a `source` (PubMed by default). Queues show a source badge and have an "All sources / PubMed only / Government agencies" filter; the Library has a top-level folder per source (on disk too: `library/PubMed/...`, `library/FDA/...`); exports carry a Source column (RIS uses `DB`); Overview shows counts per source; Settings lists the registry (`sourceRegistry` in `worker/index.js`: PubMed active; FDA, EMA, MHRA, WHO, Health Canada and CDSCO prepared but not enabled, since no agency feed is connected yet). A future agency feed only needs to create articles and runs with its own `source`; everything else already keeps it apart. Library paths now have a source level, so folders created by the previous layout stay on disk but are no longer updated.

`/healthz` returns `ok <commit>` on the server (the updater writes the deployed commit), so you can check which version is running: `curl https://literasift.tech/healthz`.

## Library numbering, PubMed search filters, NCBI compliance

**Numbering.** Every article in a Library folder has a number (`001`, `002`, … within its Source / Molecule / Date range folder, ordered by PMID so numbers never shift). It appears in the folder's article list (sortable), in file names (`001_PMID_123.pdf`), in `manifest.csv` / `_index.csv`, and on Library PDF exports ("No. 001"). Files already on disk from before numbering are renamed, not duplicated.

**PubMed search filters** (Search & Pull): Humans only, Case reports only, English only, Exclude reviews, added to the query in PubMed's own syntax.

**LinkOut and cited-by.** Each article also gets PubMed LinkOut links (free ones are highlighted for articles without stored full text, and included in the retrieval CSV) and a "cited by in PubMed" count, through the E-utilities `elink` endpoint.

**NCBI compliance.** Settings has "NCBI / PubMed access": a contact email and an optional free API key (3 requests/second without a key, 10 with one). Every E-utilities call now sends the tool name and email (and key) and goes through one pacing gate. The old optional mode that screenshotted live PubMed pages has been removed, because NCBI forbids scraping its web pages; snapshots are rendered from stored data. For a server install, `NCBI_EMAIL` and `NCBI_API_KEY` can be set in `/etc/literasift.env`.

## ICSR cases (PV Nexus)

Articles that report a patient with an adverse event can become ICSR cases: Review dialog, "Create ICSR case". The case editor pre-fills proposals from the article and assesses the four minimum criteria, QC, causality suggestion and follow-up questions with a port of PV Nexus's own rules (checked for identical results), or with a PV Nexus backend if one is configured in Settings. Cases export as PV Nexus ICSR JSON or a ZIP package. Details, limits and what is not built yet: `docs/PV_NEXUS.md`. Not a validated safety database.

## Events, country, IME and case facts

Articles get automatic event detection (IME list, MeSH drug-induced headings, PubTator), a country (patient, author or journal) with marketing-authorisation status and regulator, and case facts (patient, action taken, dechallenge, rechallenge, treatment, concomitants, confounders). The IME list must be uploaded in Settings (it is licensed MedDRA content and is not in the repo). Details and limits: `docs/EVENTS_COUNTRY_ICSR.md`.


## Audit trail and electronic signatures

The audit trail is a hash-chained, append-only log with contiguous sequence numbers (design from
[argus-auditable-rag](https://github.com/iamyashwanth99/argus-auditable-rag), MIT; see `THIRD_PARTY_NOTICES.md`).
Managers can verify the whole chain, download an anchor and later check it from the Audit tab; the server also verifies the chain daily.

Screening decisions and ICSR cases can be signed. A signature records who signed, what it means, the UTC time and a hash of
exactly what was signed; it needs the signer's password again, it is refused if the record or the article evidence changed since the
signer opened it, and a signed record is locked until a manager supersedes the signature with a reason (the old signature is kept).
Settings control who may sign approvals and a four-eyes rule. The validation documents are in `docs/dossier/`. Run the tests with `npm test`.

## Full-text intake to the ICSR workbench

Articles whose full text is stored (PMC, Europe PMC, Unpaywall, Semantic Scholar) and that have detected events become draft ICSR cases,
automatically as evidence is processed (Settings can turn this off) or with **Add to ICSR workbench** on the ICSR tab. Events and case facts are read
from the abstract plus the case section of the full text (or the sentences about the patient or drug when the paper has no such section).
The verbatim phraser records, for each event, the exact wording used in the paper, the sentence around it and the section, and these
go into the case as the reported term and its source evidence. Full texts that are PDFs without a GROBID service have no extractable text, so those cases use the abstract.

## Patient identity, dates and event coding in literature cases

Published articles do not name patients, so a case identifies the patient by age and sex (for example "54-year-old male (name withheld in the publication)"),
which satisfies the identifiable-patient criterion. Age is read from the usual wordings (54-year-old, 54 y/o, aged 54, 3-month-old, "in his 60s").
Therapy start dates and onset dates are rarely given. If the article does not give one, tick "not reported in the article (confirmed)": the gap then stops counting
against QC and follow-up, and a stated time to onset (for example "10 days after starting") is used for the temporal assessment.
The event picker adds MedDRA fields (LLT, PT, HLT, HLGT, SOC, version, status) with suggestions from the EMA IME list and from earlier reviewed codings (the PV Nexus coding-memory approach).
Always confirm codes in a licensed MedDRA source.

## Synchrony (ICSR workbench)

Synchrony is LiteraSift's case workbench (the **Synchrony** tab, linked both ways: "Send to Synchrony" in the article review dialog, "Open article in LiteraSift" in the case).

- **Intake:** articles with stored full text and detected events become draft cases, pre-filled with verbatim source sentences (see above). Full-text retrieval uses PMC, Europe PMC, Unpaywall and Semantic Scholar; scanned PDFs can be read with OCR (`deploy/enable-ocr.sh`) and PDF text with pdf.js (`deploy/enable-pdf-text.sh`).
- **Tracker and assigner:** each case is assigned automatically (molecule owner, else the reviewer with the fewest open cases and room left); managers can reassign or press "Assign unassigned now". The reporting due date comes from country, seriousness and marketing-authorisation record. Views: open, mine, unassigned, overdue, due in 3 days, ready for review, signed, closed.
- **Multi-user:** accounts, roles, per-case visibility, e-signatures and the audit trail apply to cases.
- **Exports:** E2B(R3) XML (ICH ICSR, HL7 v3; one case or a batch; the structure is checked against the ICH XSD in the tests, but run it through your gateway's validator before submitting), CIOMS I (PDF form), HL7 FHIR R4 AdverseEvent bundle, line listing (CSV), PV Nexus ICSR JSON, and a full package (ZIP with all of these and the source article).
- **Event IME matching:** upload the EMA IME list as .xlsx, .csv or .json in Settings. The .xlsx workbook is read directly (no extra software). Matches fill the PT, PT code and SOC in the event picker.
- **Case series summary:** counts by event, product, country, age and sex with the cases behind every figure, and a monthly trend flag (median + MAD).
- **Tile screenshot:** on Search & Pull, "Tile screenshot" renders a PNG of the article tiles for a pull, headed with its search query and date range (needs `deploy/enable-screenshots.sh`).

## Closed-access (paywalled) articles

LiteraSift retrieves every legal open copy (PMC, Europe PMC, Unpaywall, Semantic Scholar). For articles that remain closed it does not try to bypass paywalls. Instead, in the article's Review dialog:
**Open with your institution** (set your library's proxy address in Settings), then **Upload PDF or XML** or **paste the text**. The text is read for events and patient details, the file is stored and marked as supplied by you, and the article flows into Synchrony.
Uploads up to 40 MB need `deploy/enable-uploads.sh` on an existing server (new installs already allow it). Check your licence before sharing exported packages: they carry a notice for restricted files.

## Case details added for CIOMS and E2B

- **Age and age group:** age is read from many wordings; the E2B(R3) age group (neonate, infant, child, adolescent, adult, elderly) is derived from the age, or from words such as "elderly" and "paediatric".
- **Several events per case:** up to 12 events are picked from an article. Each keeps its own source sentence, outcome and onset date when its own sentence gives them.
- **Causality per event:** a WHO-UMC dropdown (certain, probable/likely, possible, unlikely, conditional/unclassified, unassessable/unclassifiable) with reporter causality, method, temporal relationship, alternative causes, concomitant factors, objective evidence, listedness, reference safety information, rationale and reviewer comment. LiteraSift suggests a value for each event; a medical reviewer confirms it.
- **Reporter, sender and comments:** reporter organisation, department, address, e-mail and phone; sender type, organisation and contact (defaults in Settings); the reporter's and sender's general comments.
- **CIOMS I** follows the PV Nexus export layout (sections 0 to X, one row per event, an assessment block per event). **E2B(R3) XML** carries the same data: age group, reporter and sender, comments, and one causality assessment per reaction and suspect drug.
- **Unpaywall:** up to five open locations are tried, including open landing pages that name their PDF in the standard `citation_pdf_url` tag.

## Getting closed articles, legally

Retrieval tries PMC, Europe PMC, Unpaywall (several locations, including open landing pages), Semantic Scholar and, new, an openly licensed **preprint** of the same paper (exact title match; marked as a preprint because it may differ from the published version).
What stays closed appears on **Batches > Closed articles waiting for a full text**: a link through your library proxy, a **Copy request** note for the author, and **Match and upload** for many PDFs at once (name each file with its PMID or DOI). Nothing scrapes publisher sites or shadow libraries.

## More full-text sources (optional, with your own keys)

Settings > **Publisher and aggregator access** takes a free **CORE** API key (open repository copies), a **Wiley** text-mining token and an **Elsevier** API key (plus optional institution token). Wiley and Elsevier return only what your institution is licensed to read; if your licence is tied to your campus network they may refuse requests from this server, and the article then shows "Not covered by your ... access". bioRxiv and medRxiv DOIs are read through their own API. Texts from licensed publishers are stored as restricted. Design after paperscraper (MIT); see `THIRD_PARTY_NOTICES.md`.

## Batch by PMID list

Search & Pull > **Batch by PMID list**: paste PMIDs (one per line, optionally followed by a name, or comma separated), choose a portfolio, and every article is read from PubMed, queued, assigned, and looked up for a full text. **Unfetched list (TSV)** on the pull gives the PMIDs still without a full text in the same format. Based on Pubmed-Batch-Download (MIT).

## Patient-reported posts and event confidence

Search & Pull > **Patient-reported posts**: paste a post (several: separate with a line of three dashes), choose the platform and portfolio. Personal data is masked before storage; the post is screened for events and can become a Synchrony case marked as a consumer report (CIOMS source type "social media", no literature reference in E2B). Event detection now shows a confidence and its reasons for every event. Ideas from DrishtiAI; see `docs/OPEN_SOURCE.md`.

## Deleting the coding memory

Settings > **Coding memory** lists the MedDRA codings reviewers marked as Reviewed, which the event picker suggests for similar events. A manager can delete one entry or the whole memory, with a reason. Cases keep their codings; only the suggestions stop. Each deletion is written to the audit trail (`memory.removed`, `memory.cleared`) with who, when, how many and why.

## Deleting articles from the library, and fresh snapshots in PDFs

A manager can delete articles from the library: a whole folder (Library tab, **Delete** next to ZIP, PDF and RIS) or one article (**Delete this article from the library** in its Review dialog). The article, its queue entries and its stored files and snapshots are removed, and the folder on disk is cleaned up. Articles that have an ICSR case are kept, because the case and its signatures refer to them. A reason is required, and each deletion is recorded in the audit trail with the PMIDs, titles, number of files removed and the reason.
PDF exports (and the PDFs of library folders) take a fresh snapshot of any article whose stored snapshot predates the current record-card layout, and print the search query, date range, retrieval time and snapshot time.

See [docs/WORKBENCH.md](docs/WORKBENCH.md) for the screening-to-ICSR workbench, store migration and backups.

## Sites deployment with the VPS capture service and scheduler


Copy `.env.example` to `.env` and fill it on the VPS. Run `docker compose up -d --build`. The scheduler checks for new batches once per minute. A batch is imported once per completed date window, while subsequent runs keep filling the evidence queue.

The capture service listens on VPS loopback port 3000. Give it a dedicated HTTPS hostname using your reverse proxy, forwarding `/screenshot` to `127.0.0.1:3000`. Set these runtime values on the Site:

- `SCREENSHOT_ENDPOINT`: the HTTPS URL ending in `/screenshot`
- `SCREENSHOT_AUTH`: `bearer` for the included Playwright service
- `SCREENSHOT_TOKEN`: the same capture secret as on the VPS, at least 24 characters
- `NCBI_EMAIL`: your organisation's NCBI integration contact email

For an existing Browserless integration, leave `SCREENSHOT_AUTH` unset to retain its query-token mode. The included capture service accepts canonical PubMed article URLs only.

### Extraction sources

- [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25500/) supplies search results, citation metadata, and EFetch XML, which includes abstracts when available.
- [PMC Cloud Service](https://pmc.ncbi.nlm.nih.gov/tools/cloud/) supplies eligible full text. The app saves PDF when available or JATS XML and records the source and license.
- [Playwright](https://github.com/microsoft/playwright) supplies Chromium screenshot capture. Both the npm dependency and container image use version 1.64.1. Build the container to install the pinned dependencies.

Reviewers can download evidence from their assigned articles. The batch CSV reports capture status for citation XML, full text, and screenshots.
