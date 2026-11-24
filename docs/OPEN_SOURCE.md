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
| [Semantic Scholar API](https://api.semanticscholar.org/) | Extra source of open-access PDF copies (repository copies others miss) | Last full-text tier; optional `SEMANTIC_SCHOLAR_KEY` for higher limits; response shape checked only against third-party docs |
| [PubTator 3](https://www.ncbi.nlm.nih.gov/research/pubtator3/) (NCBI) | Text-mined diseases and chemicals per article ("Conditions mentioned", extra highlight terms) | `publications/export/biocjson` per PMID, best-effort |
| [RxNorm / RxNav](https://lhncbc.nlm.nih.gov/RxNav/APIs/RxNormAPIs.html) (NLM) | Brand names and ingredient names for a molecule | "Suggest synonyms & brands" on Search & Pull |
| [PubChem PUG REST](https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest) | Chemical synonyms (INN/USAN spellings, trade names) | Same button; names with digits or codes are filtered out |
| [openFDA drug event API](https://open.fda.gov/apis/drug/event/) (FAERS) | Most-reported reactions for the molecule, as context | Panel on Search & Pull; spontaneous reports only, not incidence or causality |
| RIS and BibTeX (open formats) | Citations for EndNote, Zotero, Mendeley, LaTeX tools | "Citations (RIS)" / "BibTeX" buttons |
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

## Considered but not integrated

| Tool / source | Why not |
|---|---|
| Semantic Scholar TLDR summaries | Not needed; only the open-access PDF field is used |
| CORE API (open-access full-text aggregator) | Needs a registered API key; Unpaywall, PMC and Europe PMC already cover most open copies |
| bioRxiv / medRxiv APIs, Europe PMC preprints | Preprints use non-PMID identifiers, which the data model does not support yet |
| scispaCy and other Python NLP models | Would need a Python runtime and model downloads; PubTator3 provides entity extraction as a service |
| MedDRA | Licensed, not open source (FAERS reaction terms are shown as openFDA returns them) |
| Sci-Hub-style sources | Not legitimate; only copies offered free by publishers or repositories are fetched |

## Not verified

The exact response shapes of PubTator3, RxNorm (`drugs.json`), PubChem synonyms and openFDA counts were checked only against third-party documentation, so the parsers are defensive and fail quietly. Europe PMC's text-mined annotations API and its exact per-article `license` field were not confirmed against official docs in
this environment; the code only stores Europe PMC full text when the record reports `isOpenAccess: "Y"` and a permissive
`license`, and otherwise falls through to Unpaywall. None of these services were reachable from the build sandbox, so the
integrations are tested against mocked responses only; check a few real articles after deploying.
