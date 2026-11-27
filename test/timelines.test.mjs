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
