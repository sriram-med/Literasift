# Literature Bench

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

Run `node --env-file=/path/to/private.env scripts/run-watchlists.mjs`. Confirm exit status zero and check the site's Batches tab before scheduling it with cron or a systemd timer. Each invocation processes up to four pending evidence records, so run it periodically to clear the evidence queue. The importer uses the last complete India calendar day and skips portfolio/date windows already imported. Use the Batches tab for historical backfills.

Never commit runtime secrets. This runner does not move the website, authentication, or storage to the VPS.

### Start the unattended services with Docker Compose

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
