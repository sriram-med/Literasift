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

Run `node --env-file=/path/to/private.env scripts/run-watchlists.mjs`. Confirm exit status zero and check the site's Batches tab before scheduling it with cron or a systemd timer. Each invocation processes up to four pending evidence records, so run it periodically to clear the evidence queue. The continuous importer searches current and overlapping India calendar dates at 15-minute intervals, with daily reconciliation and historical catch-up. Use the Batches tab for historical backfills.

Never commit runtime secrets. This runner does not move the website, authentication, or storage to the VPS.

### Start the unattended services with Docker Compose

Copy `.env.example` to `.env` and fill it on the VPS. Run `docker compose up -d --build`. The scheduler checks for new batches once per minute. The scheduler polls each minute; the Worker gates continuous searches to approximately 15 minutes and also processes reconciliation, reports, alerts and evidence.

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


### Optional alert gateway on the existing VPS

The Worker remains on its existing Sites hosting and uses its existing private R2 state. No database migration is required. Use a private .env on the VPS. Configure a strong matching ALERT_GATEWAY_TOKEN on the Site and VPS, and expose only the authenticated HTTPS /alerts route through your existing reverse proxy to 127.0.0.1:3001. Set ALERT_GATEWAY_URL on the Site to the exact HTTPS /alerts endpoint. Run:

```sh
docker compose --profile alerts up -d --build
docker compose ps
curl --fail http://127.0.0.1:3001/health
```

For browser push, configure VAPID_SUBJECT (mailto: organization contact), VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY on the VPS; only the public key belongs on the Site. Generate keys with the web-push CLI in a secure terminal. Browser support and permission are required; iOS Web Push requires an eligible Home Screen web app. This release does not add a web app manifest.

For email, set RESEND_API_KEY and ALERT_FROM_EMAIL (verified sender). For SMS set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM and MOBILE_RECIPIENTS_JSON, an admin-approved mapping of reviewer email addresses to verified E.164 phone numbers. Provider fees and regional requirements may apply; do not enable SMS without approval. The optional service uses a persistent alert-ledger volume. Gateway success means provider acceptance, not confirmed receipt. Provider or network failures may be retried; SMS duplicate delivery remains possible after an ambiguous timeout.

Reviewers must opt in from Notifications. No patient details, article titles or client names are included in outbound messages. The gateway receives recipient identifiers and generic event metadata; review provider privacy and organizational approval before enabling.

### Surveillance and reports

Existing watchlists default to a Tuesday trigger and can be saved with a different weekday. A weekly report retrieves the seven complete calendar days before the trigger; the 30-day audit retrieves the preceding 30 complete days in slices. Reports export citation rows and the current review status, not immutable signed regulatory reports. Historical jobs retry after failures. Rule-based priority detection uses title and available PubMed abstracts, and is not a valid ICSR determination or a substitute for screening all articles. No LLM is required.

Before production deployment, run the build and validation commands above, check node --check alerts/server.mjs, verify the authorized Site deployment and runtime configuration, and test a subscribed browser, verified email and approved SMS number. Check that repeated scheduler invocations do not create duplicate assignments and that reports cover the expected dates.
