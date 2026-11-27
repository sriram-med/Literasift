# 07 Regulatory crosswalk

This maps typical electronic-records and electronic-signature expectations (for example, those in 21 CFR Part 11 and EU Annex 11)
to what LiteraSift does. It is not legal advice, does not claim compliance, and the wording of the rules should be checked at source.

| Typical expectation | What LiteraSift does | Gap or user responsibility |
| --- | --- | --- |
| Secure, time-stamped audit trail of changes | Append-only hash-chained log with UTC times and actors | Old and new values are recorded for key actions, not for every field |
| Audit trail cannot be altered | Storage guard, chain verification, daily check, anchors | Host administrators can bypass the app (F5) |
| Signature shows name, date and time, meaning | Signature records signer, UTC time and meaning text; shown with the record | |
| Signature linked to its record | Content hash binds the signature; changes are flagged | |
| Two distinct identification components | Email and password (password re-entered to sign) | No second factor yet |
| Unique, non-reusable identities | One account per email | Shared passwords are a procedural control |
| Review before signing | Evidence hash binding refuses stale reviews | |
| Access limited to authorised people | Roles and per-record visibility | |
| Validation of the system | This dossier and tests | Company qualification, SOPs and training are not provided |
| Retention and export | Exports include signatures; backups | Retention periods are the company's to set |
