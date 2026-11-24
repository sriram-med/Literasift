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
