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

## PubMed "scraper" tools

| Tool | Licence (per its package page; check the repo) | What we did |
|---|---|---|
| [PyMed / pymed-paperscraper](https://pypi.org/project/pymed-paperscraper/) | MIT (the original is archived) | Python wrapper around E-utilities; its search/fetch is already done natively here |
| [paperscraper](https://github.com/jannisborn/paperscraper) | MIT | Search and full-text download across PubMed, arXiv and bio/medRxiv; our PMC, Europe PMC and Unpaywall tiers cover the PubMed side |
| [metapub](https://pypi.org/project/metapub/) | Apache-2.0 | E-utilities and Crossref lookups, already covered |
| [PubMed-FAST-Scrape](https://github.com/jimnoneill/PubMed-FAST-Scrape) | MIT | Bulk fetching; replaced by our paced E-utilities import |

These are Python libraries, so nothing was copied in. What we took from them is their features, built on the supported API: search filters (humans, case reports, English, exclude reviews), LinkOut full-text links and "cited by" counts through `elink`, and a registered tool name, contact email, optional API key and request pacing for every E-utilities call.

**Why no HTML scraping.** NCBI's own guidance says to avoid high-frequency hits on its web interface, forbids screen-scraping PubMed Central, and directs automated retrieval to E-utilities (an unregistered or too-fast client can be blocked); the earlier optional live-page screenshot mode was removed for that reason, and snapshots are rendered from stored data instead. See [NCBI's guidance](https://support.nlm.nih.gov/knowledgebase/article/KA-03539/en-us) and the [PMC developer page](https://pmc.ncbi.nlm.nih.gov/tools/developers).

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

## Ten GitHub repositories reviewed and cloned (November 2026)

Cloned shallowly for study into a folder outside this repository (they are large: GROBID alone is about 2 GB). Pinned commits are listed so the review can be repeated.

| Repository | Licence | Commit | Result |
|---|---|---|---|
| [jenojp/negspacy](https://github.com/jenojp/negspacy) | MIT | `39125b0` | **Integrated.** Its English clinical negation term lists drive `isNegated` (NegEx scope rules) in event detection, replacing the older six-word check. Attribution in `THIRD_PARTY_NOTICES.md`. |
| [mozilla/pdf.js](https://github.com/mozilla/pdf.js) | Apache-2.0 | `32fb05b` | **Integrated (optional).** `server/pdftext.mjs` reads the text of PDF full texts through `pdfjs-dist`, installed by `deploy/enable-pdf-text.sh`. Previously PDF-only full texts had no searchable text unless GROBID was running. Stored PDFs are read once on the next evidence run. |
| [wanasit/chrono](https://github.com/wanasit/chrono) | MIT | `59d0b2b` | **Idea used, code not copied.** Full dates ("3 March 2021", "March 3, 2021", ISO) are now picked for therapy start and event onset; ambiguous numeric dates are deliberately left to the reviewer. |
| [kermitt2/grobid](https://github.com/kermitt2/grobid) | Apache-2.0 | `10aaa14` | Already supported as an optional service (`GROBID_URL`); no change. |
| [citation-js/citation-js](https://github.com/citation-js/citation-js) | MIT | `d2d0691` | Not integrated: RIS and BibTeX export already exist natively. |
| [titipata/pubmed_parser](https://github.com/titipata/pubmed_parser) | MIT | `b493fb9` | Not integrated: built for bulk MEDLINE dumps; single-article parsing is covered. |
| [jannisborn/paperscraper](https://github.com/jannisborn/paperscraper) | MIT | `4fae7f6` | Not integrated: scrapes publisher sites; our PMC, Europe PMC and Unpaywall tiers cover the PubMed side. |
| [allenai/scispacy](https://github.com/allenai/scispacy) | Apache-2.0 | `eacccd4` | Not integrated: needs a Python runtime and model downloads. A candidate for a separate optional service. |
| [devopam/icsrmaker](https://github.com/devopam/icsrmaker) | Apache-2.0 | `4824f11` | Reference for a future E2B(R3) XML export (not built yet). |
| [KarelDO/BioDEX](https://github.com/KarelDO/BioDEX) | MIT | `f6e4f49` | Reference: a labelled corpus of adverse-event reports from articles, useful for measuring extraction accuracy later. |

## Three more repositories reviewed (November 2026)

| Repository | Licence | Commit | Result |
|---|---|---|---|
| [niharnandala/pharmacovigilance-verified-safety-report-agent](https://github.com/niharnandala/pharmacovigilance-verified-safety-report-agent) | MIT | `bc424ec` | **Integrated (idea and rule).** Count first with plain code, then check any text against the counts; the median + MAD hike rule drives the monthly trend flag in Synchrony's case series summary. No model is used. |
| [akhiranandan-04/AutoPADER-AI](https://github.com/akhiranandan-04/AutoPADER-AI) | none stated | `f99b75c` | **Ideas only; no code copied** (no licence file means all rights reserved). Used: deterministic statistics with an evidence list for every figure (each line in the series summary names the cases it counts), and expedited-versus-routine reporting clocks. |
| [soluchi07/ADE-project](https://github.com/soluchi07/ADE-project) | none stated | `ca4aa1a` | **Ideas only; no code copied.** Its finding that confidence thresholds change precision and recall, and its SIDER label check, are noted as future work for scoring detected events. |

## What is deliberately not integrated: tools that scrape paywalled articles

Shadow libraries (Sci-Hub and similar), browser extensions that fetch pirated copies, and scripts that log in with other people's institutional credentials are not integrated. They infringe publishers' copyright and licence terms, a PV system holding such copies would be hard to defend in an inspection, and an unlawful source is a poor basis for regulatory records. For closed articles use the legal routes built in: your library proxy, your own licensed download uploaded to the article, author requests, and interlibrary or document-delivery services.

## paperscraper (jannisborn/paperscraper, MIT, commit `4fae7f6`): integrated, selectively

The official-interface fallbacks of paperscraper's PDF module are integrated as optional retrieval tiers, re-implemented in JavaScript: **Wiley text-mining API** and **Elsevier text-mining API** (each only with a token or key the user holds; they return only what the user's institution is licensed to read), and the **bioRxiv/medRxiv** details API (preprint full-text XML under its stated licence). **CORE** (free API key) was added alongside. Keys are set under Settings > Publisher and aggregator access and are never sent to the page.
Not integrated: paperscraper's search over local dumps (bulk downloads), and its generic publisher page fetching, which does not respect paywalls and is the part that raises terms-of-use concerns.

## Pubmed-Batch-Download (billgreenwald/Pubmed-Batch-Download, MIT, commit `11514cf`): integrated and extended

The batch-by-PMID idea (a file or list of PMIDs with an optional name for each, a list of what could not be fetched in the same format, retries) is integrated as **Search & Pull > Batch by PMID list**.
What it adds over the original script: the articles enter the screening queue, assignment, event detection and Synchrony; full texts are looked up in every open and keyed source LiteraSift has (PMC, Europe PMC, Unpaywall, Semantic Scholar, CORE, preprints, optional Wiley/Elsevier text-mining with your keys) with pacing, retries and progress; duplicates are skipped; PMIDs PubMed does not know are reported; the **Unfetched list (TSV)** can be fed back in later.
Not integrated: the original's per-publisher page scraping (it reads each publisher's HTML to find a PDF link, which depends on the caller's campus IP address and is against many publishers' terms). Its author notes that the project is no longer maintained.
