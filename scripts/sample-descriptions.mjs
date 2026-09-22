#!/usr/bin/env node
// Forty of two thousand one hundred and seventy-six, chosen so the forty mean something.
//
// A person will check about forty descriptions. Drawn uniformly, thirty-nine of them would be from the long tail nobody can verify quickly and one would be MMLU, and the result would be a number with an interval so wide it could not tell a good pass from a bad one. Drawn only from what the audit flagged, the result would measure the audit rather than the pass.
//
// So the sample is two samples in one envelope. Thirty entries are drawn at random inside six strata that partition the whole registry, which makes them reweightable: an unbiased estimate of the population error rate falls out of them even though the hard cohort is deliberately over-drawn. Ten more are drawn on purpose from what the audit found most suspicious, which measures the audit's own precision and is excluded from the estimate, because a purposive draw cannot be reweighted into a population claim and pretending otherwise is how a sample starts lying.
//
// The worksheet is blind by default. It shows the registry's facts, which are ground truth, and hides the stratum and the audit's flags, which are hints. Telling a reviewer that an entry came from the cohort where invention is expected is telling them what to find, and it would also destroy the one thing the ten purposive entries are there to measure: if the reviewer knows which entries the audit flagged, agreement between them says nothing.
//
// Runs with no API key and no network. Verdicts append to data/description-review.jsonl, the same append-only shape research.mjs already uses for alias and category decisions, so a second reviewer adds to the record rather than overwriting it.
//
// Usage: node scripts/sample-descriptions.mjs [path] [--n 40] [--seed 1] [--worksheet] [--show-flags] [--resume] [--summary]

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  DATA, DEFAULT_PATH, RECENT_CUTOFF, cohortOf, loadDescriptions, loadLabs, loadRegistry, pct, readSource, readText,
  rng, shuffled, wilson,
} from "./description-checks.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const num = (f, d) => (args.indexOf(f) >= 0 ? Number(args[args.indexOf(f) + 1]) : d);
const FLAGGED = ["--n", "--seed", "--log"];
const PATH = args.find((a, i) => !a.startsWith("--") && !FLAGGED.includes(args[i - 1])) ?? DEFAULT_PATH;
const N = num("--n", 40);
const SEED = num("--seed", 1);
// Append-only, and overridable, because two reviewers disagreeing is the most useful thing a review of forty entries can produce and that only works if the second one can record without overwriting the first.
const LOG = args.indexOf("--log") >= 0 ? args[args.indexOf("--log") + 1] : join(DATA, "description-review.jsonl");

// Six strata that partition the registry, so what is reviewed inside them can be weighted back up to the whole.
//
// The allocation is not proportional and is not meant to be. hard-confident is where a wrong description would come from, so it takes the largest share; head-confident is small because it is a calibration check rather than a measurement, and four entries are enough to notice that the pass gets MMLU wrong; head-refused is smaller still and is there for one question that two entries can answer, which is whether the pass refuses things it had no business refusing.
const STRATA = [
  {
    id: "hard-confident", want: 12, projectable: true, confident: true,
    why: "One lab, first cited after the cutoff, and the pass answered anyway. If anything here was invented this is where it is, and it is also where the audit has the least to say.",
    test: (r) => r.cohort.difficulty === "hard" && !r.t.refused,
  },
  {
    id: "hard-refused", want: 6, projectable: true, confident: false,
    why: "The same cohort, refused. This is the stratum that stops a pass gaming the refusal lift by declining the hard cohort wholesale without reading anything: if a good page exists for several of these, the refusals were a rule and not a finding.",
    test: (r) => r.cohort.difficulty === "hard" && r.t.refused,
  },
  {
    id: "head-confident", want: 4, projectable: true, confident: true,
    why: "Three or more labs, cited before the cutoff, described. Calibration. A pass that gets these wrong is broken in a way that needs no statistics, and the review should stop and say so.",
    test: (r) => r.cohort.difficulty === "head" && !r.t.refused,
  },
  {
    id: "head-refused", want: 2, projectable: true, confident: false,
    why: "A refusal on a benchmark a dozen labs cite is not caution, it is a bug in the refusal logic, and it costs the reader a description that was easy to write.",
    test: (r) => r.cohort.difficulty === "head" && r.t.refused,
  },
  {
    id: "middle-confident", want: 4, projectable: true, confident: true,
    why: "Everything in between, described. Carries roughly half the registry and would otherwise be invisible to the review.",
    test: (r) => r.cohort.difficulty === "middle" && !r.t.refused,
  },
  {
    id: "middle-refused", want: 2, projectable: true, confident: false,
    why: "Everything in between, refused.",
    test: (r) => r.cohort.difficulty === "middle" && r.t.refused,
  },
];

// Drawn on purpose rather than at random, so they measure the audit and never the population.
const PROBES = [
  {
    id: "probe-source", want: 4,
    why: "The entries whose source the audit doubts most. Checking a source takes one click, so this is the cheapest minute in the review, and a clean verdict here is a false positive the audit needs to hear about.",
  },
  {
    id: "probe-duplicate", want: 3,
    why: "One representative from each of the largest near-duplicate clusters. A human settles in a minute what the shingle count cannot: whether a shared sentence is a family of splits or one sentence stretched over unrelated benchmarks.",
  },
  {
    id: "probe-flagged", want: 3,
    why: "The remaining highest-severity findings in the hard cohort, which is where a true positive costs the most to miss.",
  },
];

// ---------------------------------------------------------------------------

const registry = loadRegistry();
const labs = loadLabs();
const { entries, shape } = loadDescriptions(PATH);
if (shape.container === "missing") {
  console.log(`${shape.path} does not exist yet, so there is nothing to sample.`);
  process.exit(0);
}

const rows = [];
for (const e of entries) {
  const fact = e.id ? registry.byId.get(e.id) : null;
  if (!fact) continue;
  rows.push({ e, fact, t: readText(e, fact), src: readSource(e.source_url, fact, labs), cohort: cohortOf(fact) });
}

// The audit's own findings, read from description-audit.json when it is there. Recomputing them here would be a second implementation of every check, and two implementations of a check are two answers to the same question.
const auditPath = "description-audit.json";
const auditJson = existsSync(auditPath) ? JSON.parse(readFileSync(auditPath, "utf8")) : null;
const findingsById = new Map();
for (const f of auditJson?.findings ?? []) {
  if (!findingsById.has(f.id)) findingsById.set(f.id, []);
  findingsById.get(f.id).push(f);
}
const severity = (id) => {
  const list = findingsById.get(id) ?? [];
  return list.filter((f) => f.severity === "high").length * 10 + list.filter((f) => f.severity === "medium").length;
};

const reviewed = new Map();
if (existsSync(LOG)) {
  for (const l of readFileSync(LOG, "utf8").split("\n").filter(Boolean)) {
    try { const v = JSON.parse(l); reviewed.set(v.id, v); } catch { /* a half-written line is not worth failing over */ }
  }
}

const sha = (s) => createHash("sha1").update(s ?? "").digest("hex").slice(0, 12);

// ---------------------------------------------------------------------------

if (has("--summary")) { summary(); process.exit(0); }

const rand = rng(SEED);
const pool = has("--resume") ? rows.filter((r) => !reviewed.has(r.fact.id)) : rows;
const scale = N / STRATA.concat(PROBES).reduce((a, s) => a + s.want, 0);

const chosen = [];
const taken = new Set();
for (const s of STRATA) {
  const members = pool.filter(s.test);
  s.size = rows.filter(s.test).length;              // the population size, which is what the weighting needs
  const want = Math.max(members.length ? 1 : 0, Math.round(s.want * scale));
  for (const r of shuffled(members, rand).slice(0, want)) {
    taken.add(r.fact.id);
    chosen.push({ r, stratum: s.id });
  }
}

const probePool = pool.filter((r) => !taken.has(r.fact.id));
const probeSets = {
  "probe-source": probePool
    .filter((r) => (findingsById.get(r.fact.id) ?? []).some((f) => f.check.startsWith("source") || f.check.startsWith("arxiv")))
    .sort((a, b) => severity(b.fact.id) - severity(a.fact.id)),
  // One per cluster rather than several from the biggest, because the question a cluster asks is answered once.
  "probe-duplicate": (auditJson?.clusters ?? [])
    .map((c) => probePool.find((r) => c.members.includes(r.fact.id)))
    .filter(Boolean),
  "probe-flagged": probePool
    .filter((r) => r.cohort.difficulty === "hard" && severity(r.fact.id) > 0)
    .sort((a, b) => severity(b.fact.id) - severity(a.fact.id)),
};
for (const p of PROBES) {
  const want = Math.round(p.want * scale);
  for (const r of (probeSets[p.id] ?? []).filter((r) => !taken.has(r.fact.id)).slice(0, want)) {
    taken.add(r.fact.id);
    chosen.push({ r, stratum: p.id });
  }
}

// A probe stratum can come up empty, either because description-audit.json was never written or because the audit genuinely found nothing of that kind. Either way the reviewer's forty minutes are budgeted, so the shortfall goes to the stratum that most needs the depth rather than being quietly given back.
if (chosen.length < N) {
  const top = STRATA.find((s) => s.id === "hard-confident");
  const spare = shuffled(pool.filter((r) => top.test(r) && !taken.has(r.fact.id)), rand).slice(0, N - chosen.length);
  for (const r of spare) {
    taken.add(r.fact.id);
    chosen.push({ r, stratum: top.id });
  }
  if (!auditJson) {
    console.error(`# description-audit.json is not here, so the ${PROBES.reduce((a, p) => a + p.want, 0)} purposive entries could not be chosen and the sample cannot measure the audit's precision.`);
    console.error(`# Run: node scripts/audit-descriptions.mjs ${PATH} --json\n`);
  }
}

// Shuffled so the reviewer cannot read the stratum off the running order and grade to it.
const order = shuffled(chosen, rng(SEED ^ 0x5bf03635));

// ---------------------------------------------------------------------------

const factLine = (r) => {
  const f = r.fact;
  return `${f.categories.join(" + ") || "uncategorised"} · ${f.suite ? `suite ${f.suite}` : "no suite"} · ` +
    `${f.lab_count} lab${f.lab_count === 1 ? "" : "s"} (${[...f.labs].join(", ")}) · first cited ${f.first_seen} · last ${f.last_seen} · in ${pct(f.recent_share / 100)} of recent releases`;
};

const sourceLine = (r) => {
  if (!r.src.url) return "    source     none given";
  const notes = [];
  if (r.src.kind !== "other") notes.push(r.src.kind);
  if (r.src.isReleasePage) notes.push("already in release-log.json as a release page");
  if (r.src.labMismatch) notes.push(`host belongs to ${r.src.labClaims.join(", ")}`);
  return `    source     ${r.src.url}${notes.length ? `\n               (${notes.join("; ")})` : ""}`;
};

function render(i, { r, stratum }) {
  const out = [];
  out.push(`[${String(i + 1).padStart(2)}/${order.length}] ${r.fact.name}   (${r.fact.id})`);
  out.push(`    registry   ${factLine(r)}`);
  out.push(sourceLine(r));
  out.push(`    ${r.t.refused ? "REFUSED" : "text   "}    ${r.t.text ? JSON.stringify(r.t.text) : "(empty)"}`);
  if (has("--show-flags")) {
    out.push(`    stratum    ${stratum}`);
    for (const f of findingsById.get(r.fact.id) ?? []) out.push(`    flag       ${f.severity} ${f.check}: ${f.detail}`);
  }
  out.push(r.t.refused
    ? "    ask        Search this name yourself for two minutes. If a page by its authors comes up, the refusal was a rule rather than a finding."
    : "    ask        Open the source. Does that page define this benchmark, and does the text match what it says?");
  return out.join("\n");
}

const VERDICTS = {
  o: ["ok", "the source supports the description"],
  u: ["unsupported", "plausible, but the source does not say it"],
  w: ["wrong", "the source or your own knowledge contradicts it"],
  r: ["refusal-ok", "refused, and there really is nothing good to cite"],
  f: ["refusal-wrong", "refused, but a good page plainly exists"],
  s: ["skip", "cannot judge in a reasonable time"],
};

if (has("--worksheet") || !stdin.isTTY) {
  if (!stdin.isTTY && !has("--worksheet")) console.log("# not a terminal, printing the worksheet instead of asking\n");
  console.log(`# Description review, seed ${SEED}, ${order.length} entries`);
  console.log(`# ${PATH}, registry of ${registry.facts.length}, ${reviewed.size} already reviewed`);
  console.log(`# Verdicts: ${Object.entries(VERDICTS).map(([k, v]) => `${k}=${v[0]}`).join("  ")}`);
  console.log(`# Record them with: node scripts/sample-descriptions.mjs --seed ${SEED}\n`);
  order.forEach((c, i) => console.log(render(i, c) + "\n"));
  process.exit(0);
}

const rl = createInterface({ input: stdin, output: stdout });
console.log(`Description review, seed ${SEED}. ${order.length} entries, ${reviewed.size} already in ${LOG}.`);
console.log(`Verdicts: ${Object.entries(VERDICTS).map(([k, v]) => `[${k}] ${v[0]} (${v[1]})`).join("\n          ")}`);
console.log(`Enter alone skips. A note after the letter is kept, as in "w wrong benchmark entirely".\n`);
for (const [i, c] of order.entries()) {
  console.log(render(i, c));
  let answer = "";
  while (true) {
    answer = (await rl.question("    verdict>   ")).trim();
    if (!answer) { answer = "s"; break; }
    if (VERDICTS[answer[0].toLowerCase()]) break;
    console.log(`    one of ${Object.keys(VERDICTS).join(" ")}`);
  }
  const [verdict] = VERDICTS[answer[0].toLowerCase()];
  appendFileSync(LOG, JSON.stringify({
    at: new Date().toISOString(),
    id: c.r.fact.id,
    name: c.r.fact.name,
    stratum: c.stratum,
    seed: SEED,
    verdict,
    note: answer.slice(1).trim(),
    refused: c.r.t.refused,
    source_url: c.r.src.url ?? null,
    // The text as reviewed. A later run can then tell a verdict about this description from a verdict about whatever replaced it, rather than carrying an old approval forward onto new prose.
    text_sha: sha(c.r.t.text),
  }) + "\n");
  console.log("");
}
rl.close();
console.log(`Written to ${LOG}. Read it back with --summary.`);

// ---------------------------------------------------------------------------

/** What the review proved, and what it did not.
 *
 *  Two rates rather than one, because the two failures are not the same failure and averaging them hides both. A wrong description publishes a falsehood in the site's own voice. A wrong refusal publishes nothing where something was available, which is a smaller harm and a different fix.
 *
 *  Each is a stratified estimate: the rate measured inside a stratum, weighted by how much of the population that stratum is. That is what makes an over-drawn hard cohort legitimate rather than alarmist. The interval is the thing to read, and it will be wide: two reviewed entries out of a stratum of four hundred rule out a catastrophe and nothing finer, and the summary says so rather than printing a point estimate that looks precise. */
function summary() {
  const verdicts = [...reviewed.values()];
  if (!verdicts.length) { console.log(`No verdicts in ${LOG} yet.`); return; }

  const current = new Map(rows.map((r) => [r.fact.id, r]));
  const stale = verdicts.filter((v) => current.has(v.id) && v.text_sha && v.text_sha !== sha(current.get(v.id).t.text));
  const byStratum = new Map();
  for (const v of verdicts) {
    if (!byStratum.has(v.stratum)) byStratum.set(v.stratum, []);
    byStratum.get(v.stratum).push(v);
  }
  for (const s of STRATA) s.size = rows.filter(s.test).length;

  console.log(`${verdicts.length} verdict(s) in ${LOG}`);
  if (stale.length) console.log(`  ${stale.length} were recorded against text that has since changed and are not counted below.`);
  console.log("");
  console.log("by stratum");
  const fresh = (v) => !stale.some((s) => s.id === v.id);
  for (const s of [...STRATA, ...PROBES]) {
    const list = (byStratum.get(s.id) ?? []).filter(fresh);
    if (!list.length) continue;
    const counts = {};
    for (const v of list) counts[v.verdict] = (counts[v.verdict] ?? 0) + 1;
    const of = s.size ? `of ${s.size}` : "purposive";
    console.log(`  ${s.id.padEnd(18)}${String(list.length).padStart(3)} reviewed ${of.padEnd(11)}${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  }

  const estimate = (strata, errorOf, label, universe) => {
    const total = strata.reduce((a, s) => a + s.size, 0);
    if (!total) return;
    let point = 0;
    let variance = 0;
    let anyReviewed = 0;
    let widest = null;
    const thin = [];
    for (const s of strata) {
      const list = (byStratum.get(s.id) ?? []).filter(fresh).filter((v) => v.verdict !== "skip");
      if (!list.length) { thin.push(`${s.id} (${s.size} entries, none reviewed)`); continue; }
      anyReviewed += list.length;
      const bad = list.filter(errorOf).length;
      const p = bad / list.length;
      const w = s.size / total;
      point += w * p;
      // Agresti-Coull for the width, and the plain proportion for the estimate.
      //
      // A stratum where nothing failed has an estimated variance of exactly zero under the textbook formula, so six clean reviews out of eight hundred would print "0.0% to 0.0%" and claim a certainty that six observations cannot buy. Adding two notional failures and two notional passes fixes that, and it is the same reason wilson() is used everywhere else in these scripts instead of the normal approximation.
      const tilde = (bad + 2) / (list.length + 4);
      const contribution = w * w * (tilde * (1 - tilde)) / (list.length + 4);
      variance += contribution;
      if (!widest || contribution > widest.contribution) widest = { id: s.id, size: s.size, reviewed: list.length, contribution };
      if (list.length < 5) thin.push(`${s.id} (${s.size} entries, ${list.length} reviewed)`);
    }
    if (!anyReviewed) return;
    const half = 1.96 * Math.sqrt(variance);
    console.log("");
    console.log(`${label}`);
    console.log(`  ${pct(point)} of ${total} ${universe}, 95% ${pct(Math.max(0, point - half))} to ${pct(Math.min(1, point + half))}`);
    if (widest) console.log(`  Most of that width is ${widest.id}, where ${widest.reviewed} of ${widest.size} were opened.`);
    if (thin.length) console.log(`  Thin: ${thin.join("; ")}. Those strata bound a catastrophe and nothing finer.`);
  };

  estimate(STRATA.filter((s) => s.confident), (v) => v.verdict === "wrong" || v.verdict === "unsupported",
    "false content rate, projected", "descriptions the pass wrote");
  estimate(STRATA.filter((s) => !s.confident), (v) => v.verdict === "refusal-wrong",
    "false refusal rate, projected", "refusals the pass made");

  const probes = [...PROBES].flatMap((p) => (byStratum.get(p.id) ?? []).filter(fresh)).filter((v) => v.verdict !== "skip");
  if (probes.length) {
    const hit = probes.filter((v) => v.verdict === "wrong" || v.verdict === "unsupported" || v.verdict === "refusal-wrong").length;
    const w = wilson(hit, probes.length);
    console.log("");
    console.log("audit precision, measured on the entries it singled out");
    console.log(`  ${hit}/${probes.length} of the flagged entries were genuinely wrong, ${pct(w.p)}, 95% ${pct(w.lo)} to ${pct(w.hi)}`);
    console.log(`  These are excluded from the two rates above, because they were chosen for being suspicious and cannot be weighted back into a population.`);
  }

  console.log("");
  console.log("what this cannot tell you");
  console.log(`  Nothing about the ${rows.filter((r) => r.cohort.difficulty === "hard" && !r.t.refused).length} confident descriptions in the hard cohort beyond the ${((byStratum.get("hard-confident") ?? []).filter(fresh)).length} that were opened.`);
  console.log(`  Nothing about whether a refusal was honest on a benchmark where no page exists, since the reviewer cannot prove a page absent either.`);
  console.log(`  Nothing at all if the reviewer read the descriptions instead of the sources: the cohort past ${RECENT_CUTOFF} is exactly where a fluent invention reads as true.`);
}
