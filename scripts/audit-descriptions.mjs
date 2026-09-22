#!/usr/bin/env node
// Whether a finished description pass is worth publishing.
//
// The pass writes a short description for each of 2,176 benchmarks, and it is told that refusing is a correct outcome and that 2,176 confident answers would be a failed run. Nothing downstream can check that. A description is valid by construction the way an alias merge is: it is a string in a string field, normalize.mjs will publish it, and the site will print it in its own voice under a footer promising the reader that nothing here came from news coverage or a leaderboard and that no score is recorded anywhere.
//
// So this reports the things a person should look at, and it is built around one idea. Invention is uniform and research is not. A pass that read pages will refuse far more often on a benchmark one lab mentioned once in August 2025 than on MMLU, will cite different hosts for different benchmarks, and will write sentences that differ because the benchmarks differ. A pass that invented will look the same everywhere. Every check below is a way of measuring sameness where there should be difference, or difference where there should be none.
//
// It reads only files already on disk. No API key, no network. `--gate` adds an optional second opinion from a model and is the only part that needs either; everything else is reported with or without it, and the gate can only add doubt, never remove it.
//
// Usage: node scripts/audit-descriptions.mjs [path] [--json] [--limit N] [--gate] [--selftest]

import { writeFileSync } from "node:fs";
import {
  DEFAULT_PATH, RECENT_CUTOFF, categoryContradictions, cohortOf, duplicateClusters, loadDescriptions, loadLabs,
  loadRegistry, nearDuplicates, pct, readSource, readText, urlMentionsName, wilson,
} from "./description-checks.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f, fallback) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : fallback);
const PATH = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--limit") ?? DEFAULT_PATH;
const SHOW = Number(valueOf("--limit", 8));

// How many benchmarks may share one source URL before it stops being a shared paper and starts being a page the pass liked. A suite's own paper legitimately covers its members, so the bar is set above the largest suite in the registry rather than at a round number.
const URL_REUSE_LIMIT = 6;
// Below this many distinct content words, once the benchmark's own name and the scaffolding are removed, the sentence has restated the name and added nothing.
const MIN_CONTENT_WORDS = 4;
const DUPLICATE_JACCARD = 0.6;

// ---------------------------------------------------------------------------

/** Every finding about every entry, plus the corpus-level statistics that no single entry can carry. */
function audit(entries, registry, labs) {
  const findings = [];
  const flag = (id, check, severity, detail) => findings.push({ id, check, severity, detail });

  const seenIds = new Set();
  const rows = [];

  for (const e of entries) {
    const fact = e.id ? registry.byId.get(e.id) : null;
    if (!e.id) { flag(`#${e.index}`, "no-id", "high", "entry carries no benchmark id"); continue; }
    if (seenIds.has(e.id)) flag(e.id, "duplicate-id", "high", "this id appears more than once in the file");
    seenIds.add(e.id);
    // An id the registry does not have is a description of a benchmark this site does not track, which on a pass told to describe a fixed list of 2,176 means a name was invented or mangled rather than looked up.
    if (!fact) { flag(e.id, "unknown-id", "high", "not a benchmark in timeline.json"); continue; }

    const t = readText(e, fact);
    const src = readSource(e.source_url, fact, labs);
    const cohort = cohortOf(fact);
    rows.push({ e, fact, t, src, cohort });

    if (t.declared && !t.prose && !t.empty && t.words > 12 && !/refus|could not|unable|no (source|page)/i.test(t.text)) {
      flag(e.id, "refused-but-describes", "medium", `status says refused, text is ${t.words} words of description`);
    }
    if (!t.declared && t.prose) {
      flag(e.id, "undeclared-refusal", "high", "text reads as a refusal but nothing marks it as one, so the site will print it as a description");
    }
    if (t.refused) continue;                      // the checks below are about confident prose

    // A description with no source is a claim the site makes and nobody can check, which is the exact shape of the risk descriptions introduce.
    if (src.kind === "none") flag(e.id, "no-source", "high", "confident description with no source_url");
    else if (src.kind === "malformed") flag(e.id, "source-malformed", "high", src.url);
    else {
      if (!src.https) flag(e.id, "source-not-https", "medium", `${src.url} (sources.mjs requires https for a link the reader is invited to click)`);
      if (src.kind === "news") flag(e.id, "source-news", "high", `${src.host} is news coverage, which the site's footer says it never uses`);
      if (src.kind === "leaderboard") flag(e.id, "source-leaderboard", "high", `${src.host} is a third-party leaderboard, which the site's footer says it never uses`);
      if (src.kind === "tertiary") flag(e.id, "source-tertiary", "medium", `${src.host} is a third-party summary rather than the benchmark's own page`);
      // A homepage is only thin provenance when the host itself does not name the benchmark. swebench.com is the project's own site and describes it on the front page, so the path being empty says nothing; example.org does not.
      if (src.kind === "bare" && !urlMentionsName(src, fact)) {
        flag(e.id, "source-bare-host", "medium", `${src.url} points at a site whose address says nothing about "${fact.name}", and at no page about it`);
      }
      if (src.labMismatch) {
        flag(e.id, "source-lab-mismatch", "high",
          `${src.host} belongs to ${src.labClaims.join(", ")}, none of which cited this benchmark (${[...fact.labs].join(", ")})`);
      }
      if (src.isReleasePage) {
        flag(e.id, "source-is-release-page", "low", `${src.url} is a release page already in release-log.json, where the benchmark is a row in a results table rather than something the page defines`);
      }
      if (src.arxiv && !src.arxiv.wellFormed) flag(e.id, "arxiv-malformed", "high", `${src.url} is not a valid arXiv identifier`);
      if (src.arxiv?.month && fact.first_seen) {
        const citedMonth = fact.first_seen.slice(0, 7);
        // A lab cannot cite a paper that has not been written. This is the one factual contradiction available with no network at all, and invented arXiv ids skew recent because a recent-looking number is what a recent-sounding benchmark seems to deserve.
        if (src.arxiv.month > citedMonth) {
          flag(e.id, "arxiv-postdates-citation", "high", `arXiv ${src.arxiv.id} is from ${src.arxiv.month} but the benchmark was first cited ${fact.first_seen}`);
        }
        const now = new Date().toISOString().slice(0, 7);
        if (src.arxiv.month > now) flag(e.id, "arxiv-in-the-future", "high", `arXiv ${src.arxiv.id} is dated ${src.arxiv.month}`);
      }
      if (!src.arxiv && !src.labClaims && !urlMentionsName(src, fact) && src.kind !== "news" && src.kind !== "leaderboard") {
        flag(e.id, "source-unlinked-to-name", "low", `nothing in ${src.host}${src.path} refers to "${fact.name}", and it is neither a paper nor a lab page`);
      }
    }

    if (t.scores.length) flag(e.id, "score-mentioned", "high", `"${t.scores[0]}" (SCHEMA.md: no scores, ever)`);
    if (t.hedges) flag(e.id, "hedged", "high", `${t.hedges} hedge(s); a hedged description is a refusal that reached the page as content`);
    if (t.contentWords < MIN_CONTENT_WORDS) {
      flag(e.id, "restates-the-name", "high", `${t.contentWords} content word(s) once the name and the scaffolding are removed: "${t.text.slice(0, 90)}"`);
    }
    if (!t.namePresent) flag(e.id, "name-absent", "low", `the text never uses "${fact.name}"`);
    if (fact.first_seen && t.years.length) {
      const earliest = Math.min(...t.years);
      // The earliest year a description mentions should not be after the year the benchmark was already being cited in.
      if (earliest > Number(fact.first_seen.slice(0, 4))) {
        flag(e.id, "date-contradiction", "high", `text mentions no year before ${earliest}, but the benchmark was first cited ${fact.first_seen}`);
      }
    }
    for (const c of categoryContradictions(t.stripped, fact)) {
      flag(e.id, "category-contradiction", "medium", `text asserts ${c.category} ("${c.word}") but the registry has ${fact.categories.join(" + ")}`);
    }
  }

  // Coverage. A registry entry with no row at all is different from a refusal: a refusal is a decision and a gap is a pass that did not finish, and only one of the two is a result.
  const covered = new Set(rows.map((r) => r.fact.id));
  const missing = registry.facts.filter((f) => !covered.has(f.id) && !seenIds.has(f.id));

  // ----- corpus statistics -----
  const confident = rows.filter((r) => !r.t.refused);

  // One URL under many benchmarks is the signature the brief names: a model settling on a page it liked. A suite's own paper is the honest version of the same shape, so a group is only reported when its members are not one family.
  const byUrl = new Map();
  for (const r of confident) {
    if (!r.src.url) continue;
    if (!byUrl.has(r.src.url)) byUrl.set(r.src.url, []);
    byUrl.get(r.src.url).push(r);
  }
  const reusedUrls = [...byUrl.entries()]
    .filter(([, group]) => group.length > URL_REUSE_LIMIT)
    .map(([url, group]) => {
      const suites = new Set(group.map((r) => r.fact.suite));
      const oneFamily = suites.size === 1 && [...suites][0] != null;
      return { url, group, oneFamily };
    })
    .sort((a, b) => b.group.length - a.group.length);
  for (const { url, group, oneFamily } of reusedUrls) {
    if (oneFamily) continue;
    for (const r of group) {
      flag(r.fact.id, "source-overused", "high", `${url} is cited for ${group.length} benchmarks across ${new Set(group.map((g) => g.fact.suite ?? g.fact.id)).size} families`);
    }
  }

  const byHost = new Map();
  for (const r of confident) if (r.src.host) byHost.set(r.src.host, (byHost.get(r.src.host) ?? 0) + 1);

  // Near-duplicates, with the benchmark's own name taken out first so that swapping the name into one sentence does not read as two sentences.
  const dupPairs = nearDuplicates(confident.map((r) => ({ stripped: r.t.stripped })), { threshold: DUPLICATE_JACCARD });
  const clusters = duplicateClusters(dupPairs, confident.length).map((idx) => ({
    members: idx.map((i) => confident[i]),
    sameSuite: new Set(idx.map((i) => confident[i].fact.suite)).size === 1 && confident[idx[0]].fact.suite != null,
  }));
  for (const c of clusters) {
    if (c.members.length < 2) continue;
    const sev = c.sameSuite ? "medium" : "high";
    for (const m of c.members) {
      flag(m.fact.id, "near-duplicate-text", sev,
        `shares its wording with ${c.members.length - 1} other description(s)${c.sameSuite ? " in the same suite" : " in unrelated families"}, e.g. ${c.members.find((x) => x !== m).fact.name}`);
    }
  }

  // The opening of a sentence is where a template shows first, and a template is what a model writes when it has nothing particular to say.
  const openings = new Map();
  for (const r of confident) {
    const key = r.t.stripped.toLowerCase().match(/[a-z]+/g)?.slice(0, 4).join(" ");
    if (key) openings.set(key, (openings.get(key) ?? 0) + 1);
  }

  // Another benchmark's name in the text and not its own is the pass describing the wrong thing, which is what happens when a name is looked up by resemblance instead of read off a page.
  const flatNames = new Map();
  for (const f of registry.facts) {
    const flat = f.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (flat.length >= 7 && !flatNames.has(flat)) flatNames.set(flat, f);
  }
  for (const r of confident) {
    const own = r.fact.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const words = r.t.text.toLowerCase().match(/[a-z0-9+#.-]+/g) ?? [];
    const hits = new Set();
    for (let i = 0; i < words.length; i++) {
      for (let n = 1; n <= 3 && i + n <= words.length; n++) {
        const flat = words.slice(i, i + n).join("").replace(/[^a-z0-9]/g, "");
        const other = flatNames.get(flat);
        if (!other || other.id === r.fact.id) continue;
        if (own.includes(flat) || flat.includes(own)) continue;       // a family member inside its own name
        if (other.suite && other.suite === r.fact.suite) continue;     // same suite, a fair thing to mention
        hits.add(other.name);
      }
    }
    if (hits.size && !r.t.text.toLowerCase().replace(/[^a-z0-9]/g, "").includes(own)) {
      flag(r.fact.id, "describes-another-benchmark", "high", `names ${[...hits].slice(0, 3).join(", ")} and never itself`);
    }
  }

  return { findings, rows, confident, missing, reusedUrls, byHost, clusters, openings, duplicatePairs: dupPairs.length };
}

// ---------------------------------------------------------------------------
// Cohort tables

const rateIn = (rows, predicate) => {
  const sub = rows.filter(predicate);
  return { ...wilson(sub.filter((r) => r.t.refused).length, sub.length), refused: sub.filter((r) => r.t.refused).length };
};

/** The number to read first.
 *
 *  A pass that actually researched refuses far more often on the recent long tail than on the well-cited head, because the tail is where no page exists. A pass that invented refuses at the same rate everywhere, and so does a pass that gave up and refused everything, which is why the overall refusal rate cannot answer this on its own: nought per cent and a hundred per cent are both failures and both have a defensible-looking headline.
 *
 *  The lift is the ratio of the two rates. Around one means the pass did not distinguish the hard cohort from the easy one, which no honest research pass could manage.
 *
 *  Two numbers rather than one, because the head cohort is 167 benchmarks and a ratio built on it is unstable. `floor` is the smallest lift the data still supports at 95 per cent, the low end of the hard cohort's interval over the high end of the head's, and it is the one to read: it cannot be inflated by a couple of lucky refusals and it stays finite when the head cohort refuses nothing at all. A pseudo-count was tried first and had to go, because adding half a refusal to a cohort of 955 and to a cohort of 167 makes the larger cohort look like it refused less, so a pass that refused nothing anywhere scored 0.18 and read as though it had done the opposite of what it did.
 *
 *  Necessary and not sufficient, and the sampler exists because of the gap: a pass could refuse the whole hard cohort by rule without reading anything and score perfectly here. That is what the hard-refused stratum in sample-descriptions.mjs is for. */
function refusalLift(rows) {
  const hard = rateIn(rows, (r) => r.cohort.difficulty === "hard");
  const head = rateIn(rows, (r) => r.cohort.difficulty === "head");
  const usable = hard.n > 0 && head.n > 0;
  const point = !usable || head.p === 0 ? null : hard.p / head.p;
  const floor = !usable ? null : hard.lo / head.hi;
  const nothingRefused = hard.refused === 0 && head.refused === 0;
  return { hard, head, point, floor, usable, nothingRefused };
}

// ---------------------------------------------------------------------------
// Optional second opinion

const GATE_SCHEMA = {
  type: "object",
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Copied exactly from the entry you were given." },
          recognised: { type: "boolean", description: "True only if you independently know this benchmark from your own training, without being told anything about it here. False is the expected answer for anything recent or obscure and is not a criticism of the description." },
          contradicts: { type: "boolean", description: "True only if you recognise the benchmark AND the description states something you know to be false. Never true when recognised is false." },
          why: { type: "string", description: "One short clause. Empty when contradicts is false." },
        },
        required: ["id", "recognised", "contradicts", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["answers"],
  additionalProperties: false,
};

/** A differently-framed model reading the descriptions cold, for the same reason alias-gate.py asks a second model about a merge: asking the writer to check itself shares the writer's errors.
 *
 *  Only a contradiction from a model that says it recognises the benchmark becomes a finding. Non-recognition is reported as a diagnostic and never as a fault, because for a benchmark first cited after June 2025 non-recognition is the expected answer and would otherwise flag half the registry for being recent.
 *
 *  It can only add findings. Nothing here clears a flag raised by the offline checks, whatever the gate says, because a model agreeing that an invented description sounds right is exactly the failure the offline checks exist to survive. */
async function runGate(rows, limit) {
  const target = rows.filter((r) => !r.t.refused).slice(0, limit);
  if (!target.length) return { ok: false, unavailable: "nothing to gate" };
  let client;
  try {
    const { assertSupported } = await import("./schema-guard.mjs");
    assertSupported(GATE_SCHEMA, "audit GATE_SCHEMA");
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    if (!process.env.ANTHROPIC_API_KEY) return { ok: false, unavailable: "no ANTHROPIC_API_KEY" };
    client = new Anthropic();
  } catch (e) {
    return { ok: false, unavailable: `sdk_unavailable: ${e.message}` };
  }

  const BATCH = 25;
  const answers = new Map();
  for (let i = 0; i < target.length; i += BATCH) {
    const chunk = target.slice(i, i + BATCH);
    const payload = chunk.map((r) => ({ id: r.fact.id, name: r.fact.name, description: r.t.text }));
    try {
      const res = await client.messages.create({
        model: "claude-opus-5",
        max_tokens: 8000,
        output_config: { effort: "high", format: { type: "json_schema", schema: GATE_SCHEMA } },
        system:
          "You are checking descriptions of AI evaluation benchmarks that somebody else wrote. Do not search and do not guess. " +
          "Most of these benchmarks are recent or obscure and you will not know them; saying so is the correct and expected answer, " +
          "and it is never evidence against the description. Say a description is contradicted only when you genuinely know the " +
          "benchmark and the description says something false about it.",
        messages: [{ role: "user", content: `Benchmarks and the descriptions written for them:\n\n${JSON.stringify(payload, null, 1)}` }],
      });
      if (res.stop_reason !== "end_turn") { console.error(`  gate batch ${i / BATCH}: stop_reason ${res.stop_reason}, skipped`); continue; }
      const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      for (const a of JSON.parse(text).answers ?? []) answers.set(a.id, a);
    } catch (e) {
      console.error(`  gate batch ${Math.floor(i / BATCH) + 1}: ${e.message}`);
    }
  }
  if (!answers.size) return { ok: false, unavailable: "no usable answers" };
  return { ok: true, answers, asked: target.length };
}

// ---------------------------------------------------------------------------
// Self-test
//
// The file this audits does not exist yet and will be written by a different pass. A quality control nobody can run until the thing it controls has already been produced is a quality control that gets debugged in the one hour it matters, so the checks are exercised here against planted defects built out of real registry entries.

function selftest() {
  const registry = loadRegistry();
  const labs = loadLabs();
  const pick = (fn, n = 1) => registry.facts.filter(fn).slice(0, n);
  const speech = pick((f) => f.categories.includes("speech") && !f.categories.includes("coding"))[0];
  const recent = pick((f) => f.first_seen >= "2025-06-01" && f.lab_count === 1, 4);
  const old = pick((f) => f.first_seen < "2024-01-01")[0];
  const openaiOnly = pick((f) => f.lab_count === 1 && f.labs.has("openai"))[0];
  const googleOnly = pick((f) => f.lab_count === 1 && f.labs.has("google"))[0];

  const cited = pick((f) => f.release_urls.size > 0 && f.lab_count === 1)[0];
  const spare = pick((f) => f.first_seen < "2024-06-01" && f.lab_count === 2, 6);

  const entries = [
    { id: "not-a-real-benchmark-id", text: "A benchmark.", source_url: "https://arxiv.org/abs/2501.00001" },
    { id: speech.id, text: `${speech.name} is a benchmark that evaluates code generation across repositories.`, source_url: "https://arxiv.org/abs/2103.00001" },
    { id: old.id, text: `${old.name} was introduced in 2030 to measure reasoning over documents.`, source_url: "https://arxiv.org/abs/2101.00002" },
    { id: recent[0].id, text: `${recent[0].name} is a benchmark called ${recent[0].name}.`, source_url: "https://arxiv.org/abs/2508.00003" },
    { id: recent[1].id, text: `${recent[1].name} appears to be an evaluation that likely measures multi-step planning in agents.`, source_url: "https://techcrunch.com/2025/09/01/ai" },
    { id: recent[2].id, text: `${recent[2].name} measures document understanding and models achieve 87% accuracy on it.`, source_url: "http://example.com" },
    { id: recent[3].id, text: `${recent[3].name} evaluates retrieval over very long inputs.`, source_url: "https://arxiv.org/abs/2712.00004" },
    { id: openaiOnly.id, text: `${openaiOnly.name} evaluates structured reasoning over tables and spreadsheets.`, source_url: "https://blog.google/technology/google-deepmind/something/" },
    { id: googleOnly.id, text: "This evaluation was built by the team behind SWE-bench Verified and covers repository repair.", source_url: "https://arxiv.org/abs/2310.06770" },
    { id: cited.id, text: `${cited.name} scores appear in a results table on the page this cites, which never says what it is.`, source_url: [...cited.release_urls][0] },
    { id: spare[0].id, text: `${spare[0].name} evaluates grounded question answering over enterprise documents.`, source_url: "https://arxiv.org/abs/2601.00005" },
    { id: spare[1].id, text: `${spare[1].name} evaluates multi-turn dialogue consistency over long conversations.`, source_url: "https://arxiv.org/abs/notanarxividatall" },
    { id: spare[2].id, text: `${spare[2].name} evaluates chart reading in scanned financial reports.`, source_url: null },
    { id: spare[3].id, text: `${spare[3].name} evaluates factual recall about world capitals.`, source_url: "https://en.wikipedia.org/wiki/Benchmark" },
    { id: spare[4].id, text: `${spare[4].name} evaluates code translation between two typed languages.`, source_url: "https://paperswithcode.com/dataset/x" },
    { id: spare[5].id, text: `${spare[5].name} evaluates instruction following under conflicting constraints.`, source_url: "https://example.org" },
    { id: spare[5].id, text: `${spare[5].name} is here a second time, which should be caught rather than averaged.`, source_url: "https://arxiv.org/abs/2201.00006" },
    { id: old.id, status: "refused", text: `${old.name} is a widely used evaluation of grade-school arithmetic word problems written for primary-school pupils.`, source_url: null },
  ];
  // Eight identical sentences on one over-used URL, which is both the near-duplicate signature and the settled-on-one-page signature.
  const filler = pick((f) => f.lab_count === 1 && f.first_seen >= "2025-01-01" && f.suite == null, 40).slice(20, 28);
  for (const f of filler) {
    entries.push({ id: f.id, text: `${f.name} is an internal evaluation used to measure the general capability of frontier language models across a broad range of realistic tasks.`, source_url: "https://vendor.example.org/evals" });
  }
  entries.push({ id: pick((f) => f.lab_count >= 3)[0].id, text: "Could not find an authoritative source for this benchmark.", source_url: null });

  const prepared = entries.map((e, index) => ({ ...e, index, status: e.status ?? null, booleanRefusal: false, record: e }));
  const { findings } = audit(prepared, registry, labs);
  const fired = new Set(findings.map((f) => f.check));
  const want = [
    "unknown-id", "duplicate-id", "category-contradiction", "date-contradiction", "restates-the-name", "hedged",
    "source-news", "score-mentioned", "source-not-https", "arxiv-in-the-future", "arxiv-postdates-citation",
    "arxiv-malformed", "source-lab-mismatch", "source-leaderboard", "source-tertiary", "source-bare-host",
    "source-is-release-page", "no-source", "describes-another-benchmark", "near-duplicate-text", "source-overused",
    "undeclared-refusal", "refused-but-describes",
  ];
  let bad = 0;
  console.log("self-test: each check against a planted defect\n");
  for (const w of want) {
    const ok = fired.has(w);
    if (!ok) bad++;
    console.log(`  ${ok ? "fires" : "SILENT"}  ${w}`);
  }
  const extra = [...fired].filter((f) => !want.includes(f));
  if (extra.length) console.log(`\n  also fired (not planted, worth knowing): ${extra.join(", ")}`);
  console.log(`\n${want.length - bad}/${want.length} checks fire. ${bad ? "A silent check is a check that will not catch anything." : ""}`);
  process.exit(bad ? 1 : 0);
}

// ---------------------------------------------------------------------------

if (has("--selftest")) selftest();

const registry = loadRegistry();
const labs = loadLabs();
const { entries, shape } = loadDescriptions(PATH);

const line = (s = "") => console.log(s);
const bar = (n, width = 28) => "#".repeat(Math.round(n * width)).padEnd(width, ".");

line(`descriptions  ${shape.path}`);
if (shape.container === "missing") {
  line("");
  line("  The file does not exist yet, so there is nothing to audit.");
  line("  Run `node scripts/audit-descriptions.mjs --selftest` to confirm the checks fire, and this once the pass has written its output.");
  process.exit(0);
}
line(`shape         ${shape.container}; text in "${shape.textKey ?? "NOT FOUND"}", source in "${shape.urlKey ?? "NOT FOUND"}", status in "${shape.statusKey ?? "NOT FOUND"}"`);
if (!shape.textKey) line("  WARNING: no field carrying prose was found, so every entry reads as empty. The numbers below are about nothing until this is fixed.");
line(`registry      ${registry.facts.length} benchmarks, ${entries.length} entries in the file`);
if (registry.drift.length) line(`  WARNING: lab_count disagrees with release-log.json for ${registry.drift.length} benchmark(s); every cohort split below is suspect.`);

const { findings, rows, confident, missing, reusedUrls, byHost, clusters, openings } = audit(entries, registry, labs);
const refused = rows.filter((r) => r.t.refused);

line("");
line("coverage");
line(`  described        ${confident.length}`);
line(`  refused          ${refused.length}  (${refused.filter((r) => r.t.refusalSource === "declared").length} declared, ${refused.filter((r) => r.t.refusalSource === "prose").length} written as prose, ${refused.filter((r) => r.t.refusalSource === "empty").length} empty)`);
line(`  not attempted    ${missing.length}  (in the registry, absent from the file)`);

// ----- the headline -----
const lift = refusalLift(rows);
const { hard, head, floor } = lift;
line("");
line("REFUSAL LIFT, the first number to read");
line(`  hard cohort   ${pct(hard.p)} refused  (${hard.refused}/${hard.n})   one lab, first cited on or after ${RECENT_CUTOFF}`);
line(`  head cohort   ${pct(head.p)} refused  (${head.refused}/${head.n})   three or more labs, first cited before ${RECENT_CUTOFF}`);
const liftText = !lift.usable ? "undefined, one cohort is empty" : lift.point == null ? "unbounded, the head cohort refused nothing" : `${lift.point.toFixed(2)}x`;
line(`  lift          ${liftText}   floor ${floor == null ? "n/a" : `${floor.toFixed(2)}x`} at 95%`);
line(!lift.usable
  ? "  One of the two cohorts is empty, so there is nothing to compare."
  : lift.nothingRefused
    ? `  The pass refused nothing in either cohort. It answered every one of ${hard.n} benchmarks that one lab mentioned once after ${RECENT_CUTOFF} as confidently as it answered MMLU, which is the result the pass was told would be a failed pass.`
    : floor >= 3
      ? "  The pass told the cohorts apart, which invention cannot do cheaply. Necessary, not sufficient: confirm with the hard-refused stratum in the sample."
      : floor >= 1.5
        ? "  Weak separation, and weak is what a partly invented pass looks like. Read the by-cohort table below before trusting any of it."
        : "  The pass treated a benchmark one lab mentioned once last August like MMLU. Either it invented uniformly or it refused uniformly, and the by-cohort table says which.");

line("");
line("refusal rate by cohort");
const table = (title, groups) => {
  line(`  ${title}`);
  for (const [label, predicate] of groups) {
    const r = rateIn(rows, predicate);
    if (!r.n) continue;
    line(`    ${label.padEnd(22)}${bar(r.p)} ${pct(r.p).padStart(6)}  ${String(r.refused).padStart(4)}/${String(r.n).padEnd(5)} 95% ${pct(r.lo)}-${pct(r.hi)}`);
  }
};
table("by first-cited year", [...new Set(rows.map((r) => r.cohort.year))].sort().map((y) => [y, (r) => r.cohort.year === y]));
table("by citing labs", [["1 lab", (r) => r.fact.lab_count === 1], ["2 labs", (r) => r.fact.lab_count === 2], ["3 to 5 labs", (r) => r.fact.lab_count >= 3 && r.fact.lab_count <= 5], ["6 or more labs", (r) => r.fact.lab_count >= 6]]);
table("by category", [...new Set(rows.map((r) => r.cohort.category))].sort().map((c) => [c, (r) => r.cohort.category === c]));

line("");
line("sources");
const tiers = new Map();
for (const r of confident) tiers.set(r.src.kind, (tiers.get(r.src.kind) ?? 0) + 1);
for (const [kind, n] of [...tiers].sort((a, b) => b[1] - a[1])) {
  line(`  ${kind.padEnd(14)}${String(n).padStart(5)}  ${pct(n / Math.max(1, confident.length))}`);
}
line(`  distinct hosts ${byHost.size}, distinct URLs ${new Set(confident.map((r) => r.src.url).filter(Boolean)).size} across ${confident.length} descriptions`);
for (const [h, n] of [...byHost].sort((a, b) => b[1] - a[1]).slice(0, SHOW)) {
  line(`    ${h.padEnd(34)}${String(n).padStart(5)}  ${pct(n / Math.max(1, confident.length))}`);
}
if (reusedUrls.length) {
  line(`  URLs cited for more than ${URL_REUSE_LIMIT} benchmarks:`);
  for (const { url, group, oneFamily } of reusedUrls.slice(0, SHOW)) {
    line(`    ${String(group.length).padStart(4)}x ${oneFamily ? "[one suite, fair]" : "[unrelated]"} ${url}`);
  }
}

line("");
line("prose");
const lengths = confident.map((r) => r.t.words).sort((a, b) => a - b);
const q = (p) => lengths[Math.min(lengths.length - 1, Math.max(0, Math.floor(p * lengths.length)))] ?? 0;
const mean = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length);
const sd = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, lengths.length));
line(`  words  min ${q(0)}  p25 ${q(0.25)}  median ${q(0.5)}  p75 ${q(0.75)}  max ${q(0.999)}   mean ${mean.toFixed(1)} sd ${sd.toFixed(1)} cv ${(sd / Math.max(1, mean)).toFixed(2)}`);
line(`  ${(sd / Math.max(1, mean)) < 0.15
  ? "A coefficient of variation under 0.15 means every description came out the same length, which is what a template does and what reading different pages does not."
  : "Length varies, which is what reading different pages looks like."}`);
const topOpenings = [...openings].sort((a, b) => b[1] - a[1]).slice(0, SHOW);
if (topOpenings.length) {
  line(`  commonest openings, with the benchmark's own name removed:`);
  for (const [k, n] of topOpenings) line(`    ${String(n).padStart(5)}  ${pct(n / Math.max(1, confident.length)).padStart(6)}  "${k} ..."`);
}
line(`  near-duplicate clusters: ${clusters.length}, covering ${clusters.reduce((a, c) => a + c.members.length, 0)} description(s); largest ${clusters[0]?.members.length ?? 0}`);
for (const c of clusters.slice(0, SHOW)) {
  line(`    ${String(c.members.length).padStart(4)}  ${c.sameSuite ? "same suite" : "UNRELATED"}  ${c.members.slice(0, 4).map((m) => m.fact.name).join(" | ")}${c.members.length > 4 ? " ..." : ""}`);
}

// ----- gate -----
if (has("--gate")) {
  line("");
  line("second opinion (--gate)");
  const gate = await runGate(rows, Number(valueOf("--gate-limit", 200)));
  if (!gate.ok) {
    line(`  unavailable: ${gate.unavailable}. Nothing above changes, and nothing is cleared: the gate can only add doubt.`);
  } else {
    const seen = [...gate.answers.values()];
    const known = seen.filter((a) => a.recognised);
    line(`  asked about ${gate.asked}, answered ${seen.length}, recognised ${known.length} (${pct(known.length / Math.max(1, seen.length))})`);
    line(`  Recognition is a diagnostic, not a verdict. For a benchmark first cited after ${RECENT_CUTOFF} the expected answer is no, so a low rate here says the offline checks and the human sample are the only instruments left.`);
    for (const a of seen.filter((x) => x.recognised && x.contradicts)) {
      findings.push({ id: a.id, check: "gate-contradiction", severity: "high", detail: a.why });
    }
  }
}

// ----- findings -----
line("");
line("findings");
const byCheck = new Map();
for (const f of findings) {
  if (!byCheck.has(f.check)) byCheck.set(f.check, []);
  byCheck.get(f.check).push(f);
}
const order = { high: 0, medium: 1, low: 2 };
const grouped = [...byCheck.entries()].sort((a, b) => order[a[1][0].severity] - order[b[1][0].severity] || b[1].length - a[1].length);
for (const [check, list] of grouped) {
  line(`  ${list[0].severity.toUpperCase().padEnd(7)}${check.padEnd(28)}${String(list.length).padStart(5)}`);
  for (const f of list.slice(0, 3)) line(`           ${f.id}: ${f.detail}`);
  if (list.length > 3) line(`           ... and ${list.length - 3} more`);
}
if (!findings.length) line("  none, which for 2,176 written descriptions is itself worth a second look");

const flaggedIds = new Set(findings.filter((f) => f.severity === "high").map((f) => f.id));
const hardConfident = confident.filter((r) => r.cohort.difficulty === "hard");
const hardClean = hardConfident.filter((r) => !flaggedIds.has(r.fact.id));
line("");
line("what is left for a person");
line(`  ${hardClean.length} confident descriptions in the hard cohort carry no automated flag at all.`);
line(`  That is the population the sample has to speak for: ${pct(hardClean.length / Math.max(1, confident.length))} of everything described, and nothing here can tell whether any of it is true.`);
line(`  Next: node scripts/sample-descriptions.mjs`);

if (has("--json")) {
  const out = {
    generated_at: new Date().toISOString(),
    path: shape.path,
    shape,
    counts: { registry: registry.facts.length, entries: entries.length, described: confident.length, refused: refused.length, missing: missing.length },
    refusal_lift: {
      point: lift.point, floor: lift.floor,
      hard: { refused: hard.refused, n: hard.n, p: hard.p },
      head: { refused: head.refused, n: head.n, p: head.p },
    },
    findings,
    clusters: clusters.map((c) => ({ same_suite: c.sameSuite, members: c.members.map((m) => m.fact.id) })),
    reused_urls: reusedUrls.map((r) => ({ url: r.url, n: r.group.length, one_family: r.oneFamily })),
  };
  writeFileSync("description-audit.json", JSON.stringify(out, null, 2) + "\n");
  line("");
  line("wrote description-audit.json");
}
