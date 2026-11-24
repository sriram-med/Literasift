# Open-source tools and data sources used for article extraction

LiteraSift stays a single dependency-free Worker (plus a small Node host), so most tools are used through their free public
APIs rather than copied into this repository. Nothing here is vendored; licences below are what each project states, so check
the project's own LICENSE before redistributing anything.

## Integrated

| Tool / source | What it gives LiteraSift | How it is used |
|---|---|---|
| [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/) (PubMed) | Search by molecule, citations, abstracts, authors, MeSH terms, keywords, publication types | `esearch` + `esummary` + `efetch` in `worker/index.js` |
| [PubMed Central OA bucket](https://pmc.ncbi.nlm.nih.gov/tools/pmcaws/) | Full text under open licences | Stored when the licence is CC0 / CC BY / CC BY-SA / CC BY-ND |
| [Europe PMC REST API](https://europepmc.org/RestfulWebService) | Abstract fallback, keywords, MeSH, citation counts, open-access flag and licence, full-text XML (`/{PMCID}/fullTextXML`) | Second full-text tier after PMC; stored only for open-licensed articles |
| [OpenAlex API](https://docs.openalex.org/) (CC0 data) | Citation counts, topic, work type, abstract fallback (rebuilt from the inverted index) | One request per article by `pmid:` |
| [Unpaywall API](https://unpaywall.org/products/api) | Open-access status for every article; PDF fallback | See the Unpaywall section of the README |
| [Crossref API](https://www.crossref.org/documentation/retrieve-metadata/retraction-watch/) with Retraction Watch data | Retraction / correction / expression-of-concern notices | Checked at import and every 30 days |
| [GROBID](https://github.com/grobidOrg/grobid) (self-hosted, optional) | Structured text from PDFs (TEI) so key passages can be found in PDFs too | Set `GROBID_URL`, e.g. `http://127.0.0.1:8070`; calls `/api/processFulltextDocument` |
| [Playwright](https://playwright.dev/) | Screenshots of each article page for PDF exports | `deploy/enable-screenshots.sh` |

Key passages are sentences in the extracted full text that mention the molecule and a safety term (`safetyTerms` in `worker/index.js`).

## Looked at, not copied

These are Python libraries. LiteraSift does the equivalent in JavaScript, so adding them would only add a runtime.

| Tool | Why not integrated |
|---|---|
| [metapub](https://pypi.org/project/metapub/) | Wraps E-utilities and Crossref, which we already call directly |
| [pubmed_parser](https://github.com/titipata/pubmed_parser) | Built for bulk MEDLINE / OA dumps; its maintainers warn against bulk downloading; our XML parsing covers single-article needs |
| [paperscraper](https://pypi.org/project/paperscraper) | Scrapes publisher and preprint sites; its PMC BioC fallback duplicates our PMC and Europe PMC tiers, and publisher scraping raises terms-of-use risks |
| Zotero translation-server, PyMuPDF, trafilatura | Not evaluated in depth here; check their licences (some are copyleft) before bundling |

## Not verified

Europe PMC's text-mined annotations API and its exact per-article `license` field were not confirmed against official docs in
this environment; the code only stores Europe PMC full text when the record reports `isOpenAccess: "Y"` and a permissive
`license`, and otherwise falls through to Unpaywall. None of these services were reachable from the build sandbox, so the
integrations are tested against mocked responses only; check a few real articles after deploying.
