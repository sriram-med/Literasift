# Third-party notices

## argus-auditable-rag

The audit-trail and electronic-signature design in LiteraSift (hash-chained append-only log with contiguous
sequence numbers, canonical-JSON hashing, chain verification, content-bound signatures, review binding,
supersede-never-overwrite, and the validation dossier structure) follows the design of
https://github.com/iamyashwanth99/argus-auditable-rag. LiteraSift is a separate implementation in JavaScript;
the hash definition is byte-compatible with Argus's Python `AuditEntry` (checked with test vectors).

MIT License. Copyright (c) 2026 Yashwanth Ravva.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of
the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## negspacy

The negation trigger lists (pseudo-negation, preceding, following and termination terms for English clinical text) used by `isNegated`
in `worker/index.js` come from https://github.com/jenojp/negspacy (`src/negspacy/termsets.py`, `en_clinical`). LiteraSift re-implements the NegEx
scope rules in JavaScript; no negspacy code is run.

MIT License. Copyright (c) 2019 Jeno Pizarro

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, subject to the above copyright notice and this permission notice being included in all copies or substantial
portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

## pdf.js (optional, installed separately)

`deploy/enable-pdf-text.sh` installs `pdfjs-dist` from npm (Mozilla pdf.js, Apache License 2.0, https://github.com/mozilla/pdf.js). It is not copied into this repository.

## pharmacovigilance-verified-safety-report-agent

The trend rule in `robustHikes` (median plus two scaled median absolute deviations, MAD x 1.4826, instead of mean and standard deviation) follows
https://github.com/niharnandala/pharmacovigilance-verified-safety-report-agent (`src/analysis.py`). It is re-implemented in JavaScript.

MIT License. Copyright (c) 2026 NiharNandala. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files, to deal in the Software without restriction, subject to the above copyright notice and this permission notice being included in all copies
or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

## ICH E2B(R3) schemas (test use only)

The E2B(R3) XML is checked in the test suite against the ICH ICSR XSD files as bundled in https://github.com/devopam/icsrmaker (Apache-2.0, `schemas/`). The schema files
are not copied into this repository; the test skips when they are absent. That project's own generator was read for orientation only.

## paperscraper

The design of the Wiley, Elsevier and bioRxiv retrieval tiers follows https://github.com/jannisborn/paperscraper (`paperscraper/pdf/fallbacks.py`), re-implemented in JavaScript.

MIT License. Copyright (c) 2020 PhosphorylatedRabbits. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files, to deal in the Software without restriction, subject to the above copyright notice and this permission notice being included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

## Pubmed-Batch-Download

The batch-by-PMID input format and the unfetched-list idea follow https://github.com/billgreenwald/Pubmed-Batch-Download, re-implemented in JavaScript.

MIT License. Copyright 2023 Bill Young Greenwald. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files, to deal in the Software without restriction, subject to the above copyright notice and this permission notice being included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

## Lixplore (MIT)

The multi-source search (PubMed, Europe PMC, Crossref, DOAJ request shapes and field mapping), the DOI / PMID / title de-duplication, the BibTeX, RIS and CSV exports and the Unpaywall open-access lookup used by the Discover tab (`DISCOVER_FETCH`, `mergeDiscovered`, `discoverExport` in `worker/index.js`) follow https://github.com/pryndor/Lixplore_cli, re-implemented in JavaScript. Lixplore's optional Sci-Hub downloader is **not** used and not supported.

MIT License. Copyright (c) 2024 Lixplore Contributors. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: the above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## pv-case-triage-agents (MIT)

The rule-based PHI redaction patterns and leak check (`redactPhi`, `phiLeaks`), the negation-aware seriousness evidence with the emergency-department rule, the list of important medical events, and the triage priority labels (`triageFor`) follow https://github.com/gopipamulapati/pv-case-triage-agents, re-implemented in JavaScript.

MIT License. Copyright (c) 2026 Gopi Pamulapati. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: the above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## drug-adverse-event-explorer (MIT)

The proportional reporting ratio method over openFDA adverse-event reports and its signal rule (reports >= 3, PRR >= 2, chi-square >= 4) in `prrStats` and the `/api/faers-context` route follow https://github.com/rajnomani/drug-adverse-event-explorer, re-implemented in JavaScript with a confidence interval and a cache added.

MIT License. Copyright (c) 2026 Dr. Raj Akil Nomani. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: the above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## drug-causality-bert-v2 (Apache License 2.0)

The Naranjo scale scoring and categories, the WHO-UMC rule set (`naranjoScore`, `whoUmcCategory`) and the optional BioBERT inference service in `services/causality/` follow https://github.com/PrashantRGore/drug-causality-bert-v2 (Copyright its authors). The model weights are not included; the service loads them from the Hugging Face model named in the project. Licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). Changes: the scoring was re-implemented in JavaScript and extended with "unknown" answers as in the published Naranjo scale; the service is a new, smaller wrapper.

## PubmedAPI (TLDWTutorials/PubmedAPI, MIT per its README)

Ideas adopted, not code: the author + Title/Abstract topic query shape (authors ORed with `[Author]`, topics ORed with `[Title/Abstract]`, the two groups ANDed) in `buildAuthorTopicQuery`, and the Excel export columns (PMID, Title, Abstract, Authors, Journal, Keywords, URL, Affiliations) in `/api/pull-xlsx`. The repository is a Python tutorial script using Biopython and pandas; LiteraSift implements these in its own JavaScript, with its own search engine (date windows, retries, PMID-by-PMID reconciliation) instead of the script's single 11-result search. The repository has no LICENSE file; its README states the MIT License. Source: https://github.com/TLDWTutorials/PubmedAPI

## Not incorporated

https://github.com/Nidhish-Balasubramanya/AI-Powered-Pharmacovigilance-via-Literature-Monitoring is licensed CC BY-NC-ND 4.0 (non-commercial, no derivatives). Its code and text are not used in LiteraSift.
