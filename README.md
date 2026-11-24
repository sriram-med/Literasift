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

Screenshots on the VPS are a rendered "record card" built from the stored PubMed data. NCBI answers automated browsers on pubmed.ncbi.nlm.nih.gov with `403 Forbidden`, so scraping the live page is off by default; set `SCREENSHOT_SOURCE=pubmed` to try the live page first (any non-200 response falls back to the card, and an error page is never saved). When no reviewers exist yet, new citations are assigned to the manager.

## Molecule search to full text

Search & Pull now drives the whole chain. After a pull, a "Full-text extraction" panel starts working through the new articles automatically (PubMed Central, then Europe PMC, then Unpaywall, stored only under open licences) and shows live progress: abstracts, Unpaywall open-access checks, retraction checks, full texts stored by source, open-access link-only, closed access, and key passages. "Extract full text now" restarts it, "Download full texts (ZIP)" bundles the stored PDFs/XML, their extracted text and a `manifest.csv` (source, licence, URL per article), and queues have a "Full text" filter plus a ZIP button for the filtered list. ZIPs are split into parts of 40 articles. The server-side scheduler keeps going in the background if the browser tab is closed.

## Molecule ownership and restricted-licence full text

**Assigning a molecule.** On Watchlists, "Assign a molecule to an employee" gives one person every pulled article for that molecule that is not yet complete (tick "Also move articles already assigned to someone else" to take them over), and every article pulled for it afterwards. Search & Pull and the bulk molecule form can set the owner up front. Owners ignore the open-article limit. My Queue shows each person's coverage by molecule, and the Team tab shows screened / assigned per person.

**Restricted licences.** Settings has "Store open-access copies under restrictive licences" (on by default). When on, free-to-read copies found by PubMed Central, Europe PMC and Unpaywall are stored even under CC BY-NC, publisher terms, or no stated licence (permissive copies are still preferred). They are badged "Restricted licence", ZIPs include a `NOTICE.txt`, and they are meant for internal screening only. Only copies a publisher or repository offers free and legally are fetched; paywalled articles are never bypassed. Turning the setting on retries articles that only had a link.

## More sources (synonyms, safety context, citations)

On Search & Pull, "Suggest synonyms & brands" proposes names from RxNorm and PubChem (tap a chip to add it), and after a pull a panel shows the most-reported FDA FAERS reactions for the molecule as context. Articles also get PubTator3 "Conditions mentioned" (used as extra highlight terms), and any list can be exported as RIS or BibTeX for reference managers. See `docs/OPEN_SOURCE.md` for sources, what was considered and left out, and what is unverified.

## Articles with no free full text

Full text is fetched from PubMed Central, Europe PMC, Unpaywall and Semantic Scholar, in that order. Many articles (closed journals) have no legal free copy, and the app never bypasses paywalls. For those: a missing DOI is looked up in Europe PMC and OpenAlex and the article is re-checked; each article shows a "Publisher page" link; "Retrieval list (CSV)" exports the listed articles without stored full text (DOI links, PubMed links, access status) for a library or document-delivery request; and "Flag for manual retrieval" sets them to "Full text needed" so reviewers can see what is outstanding. When a new source is added, earlier "not found" results are retried once automatically.
