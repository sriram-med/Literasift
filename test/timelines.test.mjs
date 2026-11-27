import test from "node:test";
import assert from "node:assert/strict";
import { MANAGER, SCREENER, MEDICAL, QC, fakeNcbi, withFetch, makeEnv } from "./helpers.mjs";
import worker from "../worker/index.js";

const PROFILES = [{ email: MANAGER, name: "Boss", role: "manager", active: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: QC, name: "Quinn", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: "qc2@example.org", name: "Quentin", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: MEDICAL, name: "Meera", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }];
const MEMBERS = [{ email: QC, portfolio: "Antivirals", role: "qc" }, { email: "qc2@example.org", portfolio: "Antivirals", role: "qc" }, { email: MEDICAL, portfolio: "Antivirals", role: "medical_reviewer" }];
const dAgo = n => new Date(Date.now() + 5.5 * 3600000 - n * 86400000).toISOString().slice(0, 10);

test("working days skip weekends and listed holidays", () => {
  const tl = { weekend: [0, 6], holidays: ["2026-12-01"] };
  assert.equal(worker.addWorkingDays("2026-11-26", 2, tl), "2026-11-30", "Thursday + 2 = Monday");
  assert.equal(worker.addWorkingDays("2026-11-27", 2, tl), "2026-12-02", "Friday + 2, with Tuesday a holiday = Wednesday");
  assert.equal(worker.addWorkingDays("2026-11-26", 0, tl), "2026-11-26");
  assert.equal(worker.workingDaysBetween("2026-11-26", "2026-11-30", tl), 2); assert.equal(worker.workingDaysBetween("2026-11-30", "2026-11-26", tl), -2);
});

test("new citations get an IRD and a due date of 2 working days; a molecule override and the default are manager-controlled", async () => {
  const D = dAgo(1), ncbi = fakeNcbi([{ pmid: "41", date: D }, { pmid: "42", date: D }]);
  const t = await makeEnv({ profiles: PROFILES, memberships: MEMBERS, watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q1", owner: SCREENER }, { portfolio: "Antivirals", molecule: "oseltamivir", query: "q2", owner: SCREENER, sla: { screenDays: 4 } }] });
  await withFetch(ncbi.handler, () => worker.execute(t.env, { portfolio: "Antivirals", molecule: "aciclovir", query: "q1" }, D, D));
  const s = await t.state(), a = s.assignments[0], tl = worker.timelines(s);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(a.ird), "IRD recorded"); assert.equal(a.dueAt, worker.addWorkingDays(a.ird, 2, tl), "due = IRD + 2 working days");
  assert.equal((await t.call(SCREENER, "/api/timelines-save", { screenDays: 5 })).status, 403, "only managers change timelines");
  const save = await t.call(MANAGER, "/api/timelines-save", { screenDays: 3, qcDays: 1, medicalDays: 4, holidays: "2026-12-25 2026-12-26, bad" }); assert.equal(save.status, 200); assert.deepEqual(save.body.timelines.holidays, ["2026-12-25", "2026-12-26"]);
  const D2 = dAgo(2), ncbi2 = fakeNcbi([{ pmid: "51", date: D2 }]);
  await withFetch(ncbi2.handler, () => worker.execute(t.env, { portfolio: "Antivirals", molecule: "oseltamivir", query: "q2" }, D2, D2));
  const s2 = await t.state(), b = s2.assignments.find(x => x.pmid === "51"); assert.equal(b.dueAt, worker.addWorkingDays(b.ird, 4, worker.timelines(s2)), "the molecule's own 4 days beat the new default of 3");
});

test("per-molecule owners route QC and medical review, priority orders the work, and a person sees only their own plan", async () => {
  const t = await makeEnv({ profiles: PROFILES, memberships: MEMBERS, watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }], articles: { 1: { id: "1", title: "Aciclovir rash", abstract: "x", authors: ["A"], journal: "J", date: "2026" }, 2: { id: "2", title: "Aciclovir confusion", abstract: "y", authors: ["B"], journal: "J", date: "2026" } },
    assignments: [{ id: "a1", pmid: "1", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "Pending", dueAt: dAgo(-3), ird: dAgo(2) }, { id: "a2", pmid: "2", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "Pending", dueAt: dAgo(1), ird: dAgo(5) }] });
  assert.equal((await t.call(SCREENER, "/api/watch-config", { watch: "Antivirals|aciclovir", priority: "high" })).status, 403);
  const cfg = await t.call(MANAGER, "/api/watch-config", { watch: "Antivirals|aciclovir", qc: "qc2@example.org", medical: MEDICAL, priority: "high", qcDays: 1 }); assert.equal(cfg.status, 200, JSON.stringify(cfg.body));
  assert.equal((await t.call(MANAGER, "/api/watch-config", { watch: "Antivirals|aciclovir", qc: "nobody@example.org" })).status, 400);
  const s = await t.state(), w = s.watches[0]; assert.equal(w.qcOwner, "qc2@example.org"); assert.equal(w.priority, "high"); assert.equal(w.sla.qcDays, 1);
  assert.equal(worker.timelines(s).qcDays, 2, "the molecule's days do not change the default");
  // the overdue item comes first, both are high priority molecules
  const plan = (await t.call(SCREENER, "/api/planner", {})).body; assert.deepEqual(plan.items.map(i => i.id), ["a2", "a1"], "overdue first"); assert.ok(plan.items[0].overdue && plan.items[0].priority.level === "high"); assert.equal(plan.people.length, 0, "a screener gets no people list");
  assert.ok(plan.items.every(i => i.owner === SCREENER));
  const mgr = (await t.call(MANAGER, "/api/planner", { person: "*" })).body; assert.equal(mgr.items.length, 2); assert.equal((await t.call(MANAGER, "/api/planner", { person: QC })).body.items.length, 0);
  // routing: the screener completes a1 as a potential ICSR and QC goes to the designated person, not the least loaded
  await t.call(MANAGER, "/api/settings", { qcPotentialIcsr: "on" });
  const rev = await t.call(SCREENER, "/api/disposition", { id: "a1", value: "potential_icsr", note: "case report with a patient" }); assert.equal(rev.status, 200, JSON.stringify(rev.body));
  const after = (await t.state()).assignments.find(x => x.id === "a1"); assert.equal(after.qc?.reviewer, "qc2@example.org", "QC goes to the molecule's designated checker, not the least-loaded one");
  const wi = worker.workItems(await t.state(), { email: MANAGER, role: "manager" }).find(i => i.id === "a1"); assert.equal(wi.workflow, "qc"); assert.equal(wi.owner, "qc2@example.org"); assert.equal(wi.due, worker.addWorkingDays(after.qc.requestedAt.slice(0, 10), 1, worker.timelines(await t.state())), "QC due uses the molecule's 1 day");
});

test("a manager moves one item's date; the change is recorded and the item sorts accordingly; dashboards count work by workflow", async () => {
  const t = await makeEnv({ profiles: PROFILES, memberships: MEMBERS, watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }], articles: { 1: { id: "1", title: "Aciclovir rash", abstract: "x", authors: ["A"] } }, assignments: [{ id: "a1", pmid: "1", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "Pending", dueAt: dAgo(2), ird: dAgo(5) }] });
  const before = (await t.call(SCREENER, "/api/planner", {})).body.items[0]; assert.equal(before.overdue, true);
  assert.equal((await t.call(SCREENER, "/api/timeline-set", { kind: "article", id: "a1", workflow: "screening", due: dAgo(-4) })).status, 403);
  const set = await t.call(MANAGER, "/api/timeline-set", { kind: "article", id: "a1", workflow: "screening", due: dAgo(-4), reason: "Client asked for a later date" }); assert.equal(set.status, 200);
  const item = (await t.call(SCREENER, "/api/planner", {})).body.items[0]; assert.equal(item.overdue, false); assert.equal(item.due, dAgo(-4)); assert.equal(item.override.reason, "Client asked for a later date");
  const a = (await t.state()).assignments[0]; assert.ok(a.history.some(h => /Due date for Screening set to/.test(h.action)));
  const d = (await t.call(SCREENER, "/api/dashboard", { workflow: "screening" })).body; assert.equal(d.kpi.open, 1); assert.equal(d.kpi.overdue, 0); assert.ok(d.days.length >= 5); assert.ok(d.byClient["No client"] || Object.keys(d.byClient).length);
  const m = (await t.call(MANAGER, "/api/dashboard", { workflow: "screening" })).body; assert.ok(m.people.some(p => p.email === SCREENER && p.open === 1));
});

test("a QC checker and a medical reviewer get their own workflow dashboards with only their own work", async () => {
  const t = await makeEnv({ profiles: PROFILES, memberships: MEMBERS, watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }], articles: { 1: { id: "1", title: "Aciclovir rash", abstract: "x", authors: ["A"] } },
    assignments: [{ id: "a1", pmid: "1", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "Awaiting QC", ird: dAgo(4), disposition: { value: "potential_icsr", at: dAgo(3) + "T09:00:00Z", by: SCREENER }, qc: { status: "pending", reviewer: QC, requestedAt: dAgo(3) + "T09:00:00Z" } }] });
  const qc = (await t.call(QC, "/api/dashboard", { workflow: "qc" })).body; assert.equal(qc.kpi.open, 1); assert.equal(qc.kpi.overdue, 1, "QC had 2 working days, which have passed"); assert.equal(qc.label, "QC");
  const other = (await t.call("qc2@example.org", "/api/dashboard", { workflow: "qc" })).body; assert.equal(other.kpi.open, 0, "another checker sees none of it");
  const med = (await t.call(MEDICAL, "/api/dashboard", { workflow: "medical" })).body; assert.equal(med.kpi.open, 0); assert.equal(med.label, "Medical review");
});

test("screeners and QC checkers search and pull into their own queue, in their own portfolios only, without creating a watchlist or touching others' work", async () => {
  const D = dAgo(1), ncbi = fakeNcbi([{ pmid: "61", date: D }, { pmid: "62", date: D }]);
  const t = await makeEnv({ profiles: PROFILES, memberships: MEMBERS, watches: [{ portfolio: "Antivirals", molecule: "oseltamivir", query: "q" }, { portfolio: "Oncology", molecule: "imatinib", query: "q" }],
    articles: { 61: { id: "61", title: "Existing", abstract: "x", authors: ["A"] } }, assignments: [{ id: "old", pmid: "61", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: "qc2@example.org", status: "Pending", ird: dAgo(3), dueAt: dAgo(-1) }] });
  const body = { molecule: "aciclovir", synonyms: "acyclovir, Zovirax", portfolio: "Antivirals", from: dAgo(2), to: D };
  const r = await withFetch(ncbi.handler, () => t.call(SCREENER, "/api/pull-mine", body)); assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = await t.state(); assert.equal(s.watches.length, 2, "no watchlist was created"); assert.equal(r.body.mine, 1, "only the new article is counted as mine");
  assert.equal(s.assignments.find(a => a.pmid === "62").reviewer, SCREENER, "the new article is in my queue"); assert.equal(s.assignments.find(a => a.id === "old").reviewer, "qc2@example.org", "someone else's article is not taken over");
  const dueOk = s.assignments.find(a => a.pmid === "62"); assert.equal(dueOk.dueAt, worker.addWorkingDays(dueOk.ird, 2, worker.timelines(s)));
  assert.equal((await t.call(SCREENER, "/api/pull-mine", { ...body, portfolio: "Oncology" })).status, 403, "not their portfolio");
  assert.equal((await t.call(SCREENER, "/api/pull-mine", { ...body, from: dAgo(500) })).status, 400, "a year at a time");
  const qc = await withFetch(fakeNcbi([{ pmid: "71", date: D }]).handler, () => t.call(QC, "/api/pull-mine", { ...body, molecule: "oseltamivir", synonyms: "" })); assert.equal(qc.status, 200, JSON.stringify(qc.body));
  assert.equal((await t.state()).assignments.find(a => a.pmid === "71").reviewer, QC);
});

test("the state sent to the page carries the IRD, the stage due date and working days left for articles and cases, and the line listing has IRD columns", async () => {
  const f = x => ({ value: x, state: "edited", evidence: [] });
  const t = await makeEnv({ profiles: PROFILES, memberships: MEMBERS, watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q", client: "cl1" }], clients: [{ id: "cl1", name: "Acme" }], articles: { 1: { id: "1", title: "Aciclovir rash", abstract: "x", authors: ["A"] } },
    assignments: [{ id: "a1", pmid: "1", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "Pending", ird: dAgo(1), dueAt: dAgo(1) }],
    cases: [{ id: "c1", number: "LS-1", pmid: "1", portfolio: "Antivirals", molecule: "aciclovir", status: "Draft", stage: "screening", assignee: SCREENER, createdAt: dAgo(3) + "T09:00:00Z", assignedAt: dAgo(3) + "T09:00:00Z", updatedAt: dAgo(3), history: [], versions: [], data: worker.normalizeCase({ patient: { age: f("50") }, products: [{ role: "suspect", name: f("aciclovir") }], events: [{ verbatim: f("rash") }] }) }] });
  const res = await worker.fetch(new Request("http://localhost/api/state", { headers: { "oai-authenticated-user-email": MANAGER } }), t.env), st = await res.json();
  const a = st.assignments.find(x => x.id === "a1"), m = st.caseMeta.c1; assert.equal(a.ird, dAgo(1)); assert.ok(a.wdLeft < 0 || a.wdLeft === 0, "yesterday's due date is not in the future");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(m.ird) && /^\d{4}-\d{2}-\d{2}$/.test(m.stageDue)); assert.equal(m.client, "cl1"); assert.equal(typeof m.wdLeft, "number");
  const ll = (await t.call(MANAGER, "/api/line-listing", {})).body, head = ll.head; assert.ok(head.includes("IRD") && head.includes("Stage due")); assert.equal(ll.rows[0][head.indexOf("IRD")], m.ird); assert.equal(ll.rows[0][head.indexOf("Stage due")], m.stageDue);
});

test("a manager changes the portfolio of articles, cases and a whole watchlist; holders without a role there are replaced and nothing is duplicated", async () => {
  const f = x => ({ value: x, state: "edited", evidence: [] });
  const profiles = [...PROFILES, { email: "onco@example.org", name: "Olga", role: "reviewer", portfolio: "Oncology", active: true, capacity: 50 }];
  const t = await makeEnv({ profiles, memberships: [...MEMBERS, { email: "onco@example.org", portfolio: "Oncology", role: "qc" }], watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }, { portfolio: "Oncology", molecule: "imatinib", query: "q2" }],
    articles: { 1: { id: "1", title: "A", abstract: "x", authors: ["A"] }, 2: { id: "2", title: "B", abstract: "y", authors: ["B"] } },
    assignments: [{ id: "a1", pmid: "1", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "Pending", ird: dAgo(1) }, { id: "a2", pmid: "2", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "Pending", ird: dAgo(1) }, { id: "dup", pmid: "2", portfolio: "Oncology", molecules: ["imatinib"], reviewer: "onco@example.org", status: "Pending", ird: dAgo(1) }],
    cases: [{ id: "c1", number: "LS-1", pmid: "1", portfolio: "Antivirals", molecule: "aciclovir", status: "Draft", stage: "screening", assignee: SCREENER, createdAt: dAgo(2) + "T09:00:00Z", updatedAt: dAgo(2), history: [], versions: [], data: worker.normalizeCase({ products: [{ role: "suspect", name: f("aciclovir") }], events: [{ verbatim: f("rash") }] }) }, { id: "c2", number: "LS-2", pmid: "2", portfolio: "Antivirals", molecule: "aciclovir", status: "Draft", stage: "screening", locked: true, assignee: SCREENER, createdAt: dAgo(2) + "T09:00:00Z", updatedAt: dAgo(2), history: [], versions: [], data: worker.normalizeCase({}) }] });
  assert.equal((await t.call(SCREENER, "/api/portfolio-change", { kind: "assignment", ids: ["a1"], to: "Oncology" })).status, 403, "managers only");
  const r = await t.call(MANAGER, "/api/portfolio-change", { kind: "assignment", ids: ["a1", "a2"], to: "Oncology" }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.moved, 1); assert.equal(r.body.skipped[0].id, "a2", "already in Oncology, not duplicated");
  const s = await t.state(), a1 = s.assignments.find(x => x.id === "a1"); assert.equal(a1.portfolio, "Oncology"); assert.notEqual(a1.reviewer, SCREENER, "the screener has no role in Oncology, so routing picked someone eligible"); assert.ok(a1.history.some(h => /Portfolio changed from Antivirals to Oncology/.test(h.action)));
  assert.equal(s.cases.find(x => x.id === "c1").portfolio, "Oncology", "the case made from the article moved with it"); assert.equal(s.assignments.filter(x => x.pmid === "2").length, 2);
  const c = await t.call(MANAGER, "/api/portfolio-change", { kind: "case", ids: ["c2"], to: "Oncology" }); assert.equal(c.body.moved, 0); assert.match(c.body.skipped[0].reason, /signed/);
  assert.equal((await t.call(MANAGER, "/api/portfolio-change", { kind: "watch", watch: "Antivirals|aciclovir", to: "Oncology" })).status, 200); const s2 = await t.state(); assert.ok(s2.watches.some(w => w.portfolio === "Oncology" && w.molecule === "aciclovir"));
  assert.equal((await t.call(MANAGER, "/api/portfolio-change", { kind: "watch", watch: "Oncology|aciclovir", to: "Oncology" })).status, 400);
  assert.equal((await t.call(MANAGER, "/api/portfolio-change", { kind: "assignment", ids: ["a1"], to: "" })).status, 400);
});

test("people are created with roles and portfolios in one step: a QC-only person is never given screening, a screener gets only their portfolios, guards protect the managers, and deactivating hands work back", async () => {
  const OWNER = { email: MANAGER, name: "Boss", role: "manager", active: true, owner: true };
  const t = await makeEnv({ profiles: [OWNER], memberships: [], watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }, { portfolio: "Oncology", molecule: "imatinib", query: "q2" }], articles: { 1: { id: "1", title: "A", abstract: "x", authors: ["A"] }, 2: { id: "2", title: "B", abstract: "y", authors: ["B"] } } });
  const save = (b, who = MANAGER) => t.call(who, "/api/person-save", { capacity: 20, ...b });
  assert.equal((await save({ email: "x@example.org", name: "X", roles: ["qc"] }, SCREENER)).status, 403, "managers only");
  assert.equal((await save({ email: "qc@example.org", name: "Quinn", roles: [] })).status, 400, "a role is required");
  assert.equal((await save({ email: "qc@example.org", name: "Quinn", roles: ["qc"], portfolios: ["Antivirals"] })).status, 200);
  assert.equal((await save({ email: "asha@example.org", name: "Asha", roles: ["screener"], portfolios: ["Antivirals", "Oncology"] })).status, 200);
  assert.equal((await save({ email: "sam@example.org", name: "Sam", roles: ["screener", "qc"], portfolios: ["Oncology"] })).status, 200);
  assert.equal((await save({ email: "meera@example.org", name: "Meera", roles: ["medical_reviewer"], portfolios: ["*"] })).status, 200);
  let s = await t.state(), by = e => s.profiles.find(p => p.email === e);
  assert.deepEqual(by("qc@example.org").roles, ["qc"]); assert.equal(by("meera@example.org").portfolio, ""); assert.ok(s.memberships.some(m => m.email === "meera@example.org" && m.role === "medical_reviewer" && m.portfolio === "*"));
  assert.ok(worker.rolesIn(s, "qc@example.org", "Antivirals").has("qc") && !worker.rolesIn(s, "qc@example.org", "Antivirals").has("screener"), "a QC-only person is not a screener");
  assert.ok(worker.rolesIn(s, "asha@example.org", "Oncology").has("screener") && worker.rolesIn(s, "asha@example.org", "Antivirals").has("screener")); assert.ok(!worker.rolesIn(s, "sam@example.org", "Antivirals").has("screener"), "Sam screens Oncology only");
  // routing honours it
  const D = dAgo(1), ncbi = fakeNcbi([{ pmid: "81", date: D }, { pmid: "82", date: D }, { pmid: "83", date: D }]);
  await withFetch(ncbi.handler, () => worker.execute(t.env, { portfolio: "Antivirals", molecule: "aciclovir", query: "q" }, D, D));
  s = await t.state(); const who = new Set(s.assignments.map(a => a.reviewer)); assert.ok(!who.has("qc@example.org") && !who.has("sam@example.org"), "only Asha screens Antivirals: " + [...who]); assert.ok(who.has("asha@example.org"));
  // the sign-in invite path re-saves the profile and must not flatten roles
  assert.equal((await t.call(MANAGER, "/api/profile", { email: "qc@example.org", name: "Quinn Q", capacity: 30, portfolio: "" })).status, 200); s = await t.state(); assert.deepEqual(by("qc@example.org").roles, ["qc"]); assert.equal(by("qc@example.org").name, "Quinn Q");
  // guards
  assert.equal((await save({ email: MANAGER, name: "Boss", roles: ["qc"] })).status, 409, "the owner stays a manager");
  assert.equal((await save({ email: "mgr2@example.org", name: "Second", roles: ["manager"] })).status, 200); assert.equal((await t.state()).profiles.find(p => p.email === "mgr2@example.org").role, "manager");
  assert.equal((await t.call(MANAGER, "/api/person-remove", { email: MANAGER })).status, 409);
  // deactivating Asha hands her open work back to routing (Sam is the only other screener, in Oncology; Antivirals falls to managers)
  const before = (await t.state()).assignments.filter(a => a.reviewer === "asha@example.org" && a.portfolio === "Oncology").length;
  assert.equal((await t.call(MANAGER, "/api/person-remove", { email: "asha@example.org" })).status, 200); s = await t.state();
  assert.equal(by("asha@example.org").active, false); assert.ok(!s.assignments.some(a => a.reviewer === "asha@example.org" && !["Complete", "Full text needed"].includes(a.status)), "no open work left with a deactivated person"); assert.ok(!s.memberships.some(m => m.email === "asha@example.org"));
  void before;
});

test("an older profile that was given QC or medical review is shown, and routed, as that role, not as a screener", async () => {
  const t = await makeEnv({ profiles: [{ email: MANAGER, name: "Boss", role: "manager", active: true, owner: true }, { email: SCREENER, name: "Asha", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: QC, name: "Quinn", role: "reviewer", portfolio: "Antivirals", active: true, capacity: 50 }, { email: MEDICAL, name: "Meera", role: "reviewer", active: true, capacity: 50 }],
    memberships: [{ email: QC, portfolio: "Antivirals", role: "qc" }, { email: MEDICAL, portfolio: "*", role: "medical_reviewer" }], watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }] });
  const s = await t.state(); assert.ok(worker.rolesIn(s, SCREENER, "Antivirals").has("screener")); assert.ok(!worker.rolesIn(s, QC, "Antivirals").has("screener")); assert.ok(!worker.rolesIn(s, MEDICAL, "Antivirals").has("screener"));
  const D = dAgo(1), ncbi = fakeNcbi([{ pmid: "91", date: D }, { pmid: "92", date: D }]);
  await withFetch(ncbi.handler, () => worker.execute(t.env, { portfolio: "Antivirals", molecule: "aciclovir", query: "q" }, D, D));
  assert.deepEqual([...new Set((await t.state()).assignments.map(a => a.reviewer))], [SCREENER], "only the screener is given screening");
});

test("the dashboard counts serious and non-serious cases at each stage, divides them by listedness, and carries their IRD and due dates", async () => {
  const f = x => ({ value: x, state: "edited", evidence: [] });
  const mk = (id, stage, serious, listed, assignee = SCREENER) => ({ id, number: "LS-" + id, pmid: "1", portfolio: "Antivirals", molecule: "aciclovir", status: "Draft", stage, assignee, createdAt: dAgo(4) + "T09:00:00Z", assignedAt: dAgo(4) + "T09:00:00Z", updatedAt: dAgo(4), history: [], versions: [],
    data: worker.normalizeCase({ products: [{ role: "suspect", name: f("aciclovir") }], events: [{ verbatim: f("rash"), seriousness: serious ? { serious: true, hospitalization: true } : {}, listedness: listed ? f(listed) : undefined }] }) });
  const t = await makeEnv({ profiles: PROFILES, memberships: MEMBERS, watches: [{ portfolio: "Antivirals", molecule: "aciclovir", query: "q" }], articles: { 1: { id: "1", title: "Aciclovir rash", abstract: "x", authors: ["A"] } },
    assignments: [{ id: "a1", pmid: "1", portfolio: "Antivirals", molecules: ["aciclovir"], reviewer: SCREENER, status: "Complete", ird: dAgo(6) }],
    cases: [mk("1", "screening", true, "Listed"), mk("2", "screening", true, "Unlisted"), mk("3", "screening", false, "Listed"), mk("4", "screening", false, ""), mk("5", "screening", false, "Unlisted", "other@example.org"), mk("6", "qc", true, "Listed", QC)] });
  const d = (await t.call(SCREENER, "/api/dashboard", { workflow: "screening" })).body, m = d.casesMix;
  assert.equal(m.total, 4, "only this person's cases at this stage"); assert.equal(m.serious, 2); assert.equal(m.nonSerious, 2);
  assert.deepEqual(m.flow.serious, { listed: 1, unlisted: 1, unknown: 0 }); assert.deepEqual(m.flow.nonserious, { listed: 1, unlisted: 0, unknown: 1 });
  const cell = m.cells["serious|listed"]; assert.equal(cell.n, 1); assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(cell.oldestIrd)); assert.ok(cell.overdue >= 1, "4 days in a stage with a 2 working day limit is late");
  assert.ok(m.rows.every(r => r.ird && r.due && typeof r.wd === "number")); assert.equal(m.rows[0].wd <= m.rows.at(-1).wd, true, "most urgent first");
  const mgr = (await t.call(MANAGER, "/api/dashboard", { workflow: "screening" })).body.casesMix; assert.equal(mgr.total, 5, "a manager sees everyone's");
  const qc = (await t.call(QC, "/api/dashboard", { workflow: "qc" })).body.casesMix; assert.equal(qc.total, 1); assert.equal(qc.serious, 1); assert.equal(qc.flow.serious.listed, 1);
});
