# PV Nexus integration (ICSR case processing)

LiteraSift screens published literature; [PV Nexus](https://github.com/sriram-med/pv_nexus) processes individual case safety reports (ICSRs).
This integration lets a screened article become an ICSR case inside LiteraSift, using PV Nexus's own data shape and rules.

## What is built

- **Create from an article.** In an article's Review dialog, "Create ICSR case" opens case `LS-YYYY-NNNN` pre-filled with the citation and abstract,
  the first author as reporter (qualification "Health professional (published literature)"), the molecule as suspect product, the top
  PubTator condition as the event, and likely special situations (pregnancy, neonate, paediatric, elderly, overdose, misuse, lack of effect,
  off-label, interaction, medication error) found in the abstract. All of these are marked **proposed** and carry the source excerpt.
- **Case editor.** Patient, reporter, products (suspect, concomitant, interacting), events with seriousness flags, medical history, special
  situations, source summary and reviewer notes. Fields touched by a person become `edited`.
- **Assessment**, shown beside the form and refreshed on Assess/Save: the four minimum criteria (identifiable patient, identifiable reporter,
  suspect product, adverse event), QC score and findings, causality suggestion (always "reviewer confirmation required") and follow-up questions.
- **Workflow.** Draft, Ready for medical review (only when QC says it is ready), Sent to PV Nexus, Closed: not a valid ICSR (needs a note).
  Case numbers are never reused. Create, save, export and delete are written to the audit trail.
- **Hand-over.** "Download ICSR JSON" is a PV Nexus `ICSRExtraction` document (usable as an intake source or against its `/icsr/*` endpoints);
  "Download package" adds the citation, the assessment and the stored source full text as a ZIP.

## How the rules match PV Nexus

`worker/index.js` contains a JavaScript port of `backend/app/services.py` (`validate_minimum_criteria`, `run_qc`, `suggest_causality`,
`build_follow_up`). It was checked against the real Python code on six test cases (empty, partial, complete, dechallenge, rechallenge,
concomitant-only, whitespace values): validity, QC score, findings, causality and follow-up questions were identical. If PV Nexus's rules
change, re-run that comparison and update the port.

## Optional: use a running PV Nexus backend

Settings, "PV Nexus (ICSR processing)": enter the address of a PV Nexus backend (FastAPI: `/icsr/validate`, `/icsr/qc`,
`/icsr/causality/suggest`, `/icsr/follow-up`) and, if a gateway needs it, a Bearer token. The checks then run there; if it is unreachable or
rejects the request, LiteraSift falls back to its local rules and says so. This was tested against a stand-in server that serves the real
`services.py` code, not against a deployed PV Nexus, so check it once against yours. `PV_NEXUS_URL` / `PV_NEXUS_TOKEN` environment variables work too.
Case data (including any patient details typed in) is sent to that address, so point it only at a system you control.

## Not built yet

- **Pushing cases straight into PV Nexus's database.** Its cases live in Supabase behind per-user login (`/api/cases`, `/api/documents`), so a
  machine-to-machine endpoint would have to be added to PV Nexus itself (for example a token-protected route that creates the case, product,
  event and source document for a chosen user). That means changing the `pv_nexus` repository; I have only read it so far.
- **AI extraction of patient details from the full text** (PV Nexus's `/icsr/extract`, which needs an OpenAI key).
- **E2B(R3) export, MedDRA coding, expectedness against a reference safety document, duplicate detection**: PV Nexus lists these as planned.

PV Nexus describes itself as development/training software that is not a validated safety database. The same applies to this integration:
it supports case intake and review, and must not be the system of record for regulatory reporting without formal validation.
