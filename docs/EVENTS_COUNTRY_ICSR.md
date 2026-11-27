# Event detection, country, IME and case facts

All of this is computed from the article itself (title, abstract, PubMed record) and is recomputed when the inputs change. Country detection and
case-fact extraction **do not depend on the IME list**; only the "important medical event" flags do.

## Country (drives regulator, marketing authorisation, reporting clock)
- **Patient country**: only for case-report style articles, from a sentence that ties a country or nationality to the patient ("a 54-year-old Japanese man", "a patient from Brazil").
- **Author country**: the last country named in the first author's affiliation (PubMed). **Journal country**: PubMed's journal country.
- The article's country is the patient's, else the author's, else the journal's, and the basis is shown. A manager can maintain **marketing authorisations by country**
  (Settings): status per molecule and country, MAH, MA number and optional reporting days. Queues, the Library country view and ICSR cases show the status, the regulator
  and a report-due date (default 15 days serious / 90 days non-serious; confirm locally). There is no open worldwide source for marketing-authorisation status.
- Library: "Browse by Date range / Country" (Source / Country / Molecule). ZIP and PDF exports follow the chosen layout.

## Event detection and the IME list
- Candidate adverse events come from: the EMA IME list (whole-phrase match on MedDRA preferred terms, demoted PTs inherit the flag, reviewer-promoted terms), MeSH headings indexed
  as drug-induced (chemically induced / poisoning / toxicity), and PubTator conditions. Negated mentions ("no hepatic failure") and the patient's own history are skipped.
  Each event keeps its supporting sentence, and seriousness hints (died, hospitalised, life-threatening) are noted.
- The IME list is **not in this repository** (MedDRA content is licensed). A manager uploads it in Settings: PV Nexus's `frontend/data/ime-meddra.json` from the branch
  `claude/ime-v29-action-taken-o1q6ig` (EMA/211097/2026, MedDRA 29.1, 7,846 terms), or a CSV/TXT of preferred terms. It is stored with the app data and ignored by git.
- Matching uses preferred-term wording, so lay phrases ("acute liver failure") may not match a PT; MeSH, PubTator or a promoted term cover some of those. Coding a verbatim to a PT
  needs a licensed MedDRA dictionary (PV Nexus's coding workspace).

## Case facts (patient, dechallenge, rechallenge, action taken, treatment, confounding)
Deterministic extraction following PV Nexus's literature extractor (modelled on Lixplore), each value with its source sentence and marked "proposed":
- **Patient**: age and unit (or age group), sex, weight, pregnancy and gestation, medical history, number of patients (a case series needs one ICSR per patient).
- **Action taken**: drug withdrawn, dose reduced, dose increased, interrupted, dose not changed.
- **Dechallenge** (after withdrawal or dose reduction) and **rechallenge** (re-introduction: recurred / no recurrence / not done).
- **Treatment given** for the event (dialysis, antidotes, corticosteroids, ...). If the dechallenge looks positive but treatment was given, it is marked **confounded**, and a
  confounded dechallenge alone cannot support a "Probable" causality suggestion (a LiteraSift rule on top of PV Nexus's; PV Nexus's own results are unchanged).
- **Concomitant drugs** (only where the text signals co-medication) and **confounders** (concomitants, comorbidities, treatment, other causes excluded or not).
- **Minimum criteria** (ICH E2D / E2B(R3) section 3.3.1): identifiable patient, reporter, suspect product, adverse event, plus a literature-reference check. Articles that meet all four
  show an "ICSR candidate" badge and can be filtered; positive dechallenge/rechallenge and IME events raise the relevance score.

## Free repositories for the minimum criteria
A web search found no open-source validator of the ICSR minimum criteria (results were ICH/EMA/PMDA standards and commercial tools such as Oracle Argus). The rules used
are PV Nexus's `validate_minimum_criteria` (checked for identical results), its literature extractor, and the ICH E2D / E2B(R3) minimum-information text. If you know a
specific repository, point me to it and I will compare its rules.

None of this is a validated safety database; every extracted value needs human review.
