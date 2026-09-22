#!/usr/bin/env node
// Daily research pass.
//
// One request per lab, run concurrently, each with web search locked to that
// lab's own domains. "Official sources only" is therefore enforced by the API
// rather than by asking the model nicely: a blog post about a lab, on someone
// else's site, is not reachable.
//
// Writes only data/releases/<lab>.json, and only records whose source_url is
// not already present. It never edits an existing record, so a human correction
// is never silently reverted.
//
// It also maintains data/aliases.json, so a second lab spelling an existing
// benchmark a new way is folded on the run that finds it. Suggestions used to
// be printed into the commit message and nothing else, which on an unattended
// cron means nobody ever saw them and duplicates accumulated by default. An
// alias is safe to apply automatically because it is only a build-time
// mapping: benchmarks_raw keeps the lab's exact wording forever, so a wrong
// merge is undone by deleting one line and rebuilding. Every automatic entry
// is recorded in data/alias-log.jsonl with the reason and the release it came
// from, so it can be audited without reading git history.

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { CATEGORIES } from "./classify.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 14);

const labs = JSON.parse(readFileSync(join(DATA, "labs.json"), "utf8"));
const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
const client = new Anthropic();

// The benchmarks already tracked, so the agent can tell a genuinely new one
// from a new spelling of an old one.
//
// Every one of them, not just the well-cited. An earlier version sent only
// those cited by two or more labs, on the theory that the long tail was noise
// and would crowd the prompt. That had it backwards: a benchmark one lab has
// cited is exactly the one a second lab is about to spell differently, and
// there is no way to catch that if the agent cannot see it. The filter hid
// 1665 of 2194 names. The full list is about 8k tokens, which is not a
// constraint worth trading correctness for.
//
// This judgement cannot be delegated to a string metric. Edit distance pairs
// MMLU-Pro with MMMU-Pro and IFEval with C-Eval, which are different
// benchmarks, while missing AIME 2024 against AIME24, which are the same.
// Knowing which is which is a semantic question.
const known = existsSync(join(DATA, "benchmarks.json"))
  ? JSON.parse(readFileSync(join(DATA, "benchmarks.json"), "utf8")).map((b) => b.name)
  : [];

const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);
const today = new Date().toISOString().slice(0, 10);

// Domains come from the lab's own source list. arXiv is allowed for every lab
// because a lab's own paper is a primary source; news domains never appear.
// huggingface.co and github.com host every lab, so a bare hostname there would
// let anyone's upload count as official. web search accepts a path suffix, so
// those two stay scoped to the lab's own org while everything else is a host.
const SHARED_HOSTS = new Set(["huggingface.co", "github.com"]);
const domainsFor = (lab) => {
  const entries = lab.sources
    .filter((s) => s.startsWith("http"))
    .map((s) => {
      const u = new URL(s);
      const host = u.hostname.replace(/^www\./, "");
      const org = u.pathname.split("/").filter(Boolean)[0];
      return SHARED_HOSTS.has(host) && org ? `${host}/${org}` : host;
    });
  return [...new Set([...entries, "arxiv.org"])];
};

const RECORD_SCHEMA = {
  type: "object",
  properties: {
    releases: {
      type: "array",
      items: {
        type: "object",
        properties: {
          model: { type: "string" },
          date: { type: "string", description: "YYYY-MM-DD, the publication date of the official source" },
          kind: { type: "string", enum: ["model_release", "technical_report", "system_card", "blog_post"] },
          title: { type: "string" },
          source_url: { type: "string" },
          benchmarks_raw: {
            type: "array",
            items: { type: "string" },
            description: "Benchmark names exactly as the lab printed them. Never a score. Empty array is valid and means the lab cited no benchmark.",
          },
          category_suggestions: {
            type: "array",
            description: "For any benchmark you recorded that is NOT already in the tracked list, give its subject. One primary category, and a second only when the benchmark genuinely sits in two. Never three.",
            items: {
              type: "object",
              properties: {
                raw: { type: "string", description: "The benchmark name, exactly as you recorded it." },
                primary: { type: "string", enum: CATEGORY_IDS, description: "What the benchmark tests, not the medium it arrives in. Maths delivered as diagrams is math, not vision." },
                secondary: { type: "string", enum: CATEGORY_IDS, description: "Optional. Only when a second subject is genuinely present, as in SWE-bench Multilingual." },
              },
              required: ["raw", "primary"],
              additionalProperties: false,
            },
          },
          alias_suggestions: {
            type: "array",
            description: "For any benchmark you recorded that is an already-tracked benchmark under a different name, pair your spelling with the tracked one. Leave empty when everything you found is either already spelled the same way or genuinely new.",
            items: {
              type: "object",
              properties: {
                raw: { type: "string", description: "The spelling you recorded, exactly as the lab wrote it." },
                tracked: { type: "string", description: "The already-tracked benchmark it is the same as, copied exactly from the tracked list." },
                reason: { type: "string", description: "Why they are the same benchmark, in one short clause." },
              },
              required: ["raw", "tracked", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["model", "date", "kind", "title", "source_url", "benchmarks_raw", "alias_suggestions", "category_suggestions"],
        additionalProperties: false,
      },
    },
  },
  required: ["releases"],
  additionalProperties: false,
};

async function researchLab(lab) {
  const allowed = domainsFor(lab);
  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 16000,
    output_config: { effort: "high", format: { type: "json_schema", schema: RECORD_SCHEMA } },
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 12, allowed_domains: allowed }],
    system:
      "You catalogue which benchmarks AI labs cite when they ship a model. You record the citation and never the score. " +
      "A number anywhere in your output is an error. If a release cites no benchmark, that is a real and useful finding: " +
      "record it with an empty benchmarks_raw. Never guess a date or a URL; omit anything you cannot confirm from the source itself.\n\n" +
      "You also guard against the same benchmark entering the dataset twice under two names. Always record the lab's exact " +
      "wording in benchmarks_raw; that fidelity is not negotiable. Separately, check each name against the tracked list you " +
      "are given, and when your spelling is the same benchmark under a different name, pair them in alias_suggestions.\n\n" +
      "Be precise about what counts as the same. AIME24 and AIME 2024 are one benchmark. MMLU-Pro and MMMU-Pro are two, and " +
      "so are IFEval and C-Eval, despite looking alike. A language or difficulty split is its own benchmark: IFEval " +
      "(Japanese) is not IFEval, and Leetcode (hard) is not Leetcode. Spelling, punctuation and capitalisation differences " +
      "are handled downstream, so do not pair names that differ only that way.",
    messages: [{
      role: "user",
      content:
        `Find everything ${lab.name} published between ${since} and ${today} that announces a model or reports its evaluation: ` +
        `model releases, technical reports, system cards, or model-announcement blog posts.\n\n` +
        `For each one, record which benchmarks the lab cited, using the exact wording on the page ` +
        `("SWE-bench Verified", not a normalised slug). Search is restricted to ${allowed.join(", ")}, which is deliberate: ` +
        `only the lab's own publications count.\n\n` +
        `Return an empty releases array if there is nothing in that window. That is the normal result on most days.\n\n` +
        `Benchmarks already tracked, for the alias check (all ${known.length}):\n${known.join(", ")}`,
    }],
  });

  if (response.stop_reason === "refusal") throw new Error(`refused: ${response.stop_details?.category}`);
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text).releases ?? [];
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
let added = 0;
const summary = [];
const aliasSuggestions = [];
const catSuggestions = [];

const results = await Promise.allSettled(labs.map(async (lab) => {
  const found = await researchLab(lab);
  const path = join(DATA, "releases", `${lab.id}.json`);
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  const seen = new Set(existing.map((r) => r.source_url));

  const fresh = found
    .filter((r) => r.source_url && !seen.has(r.source_url))
    .map((r) => ({
      id: `${lab.id}-${slug(r.model)}-${r.date}`,
      lab: lab.id,
      model: r.model,
      date: r.date,
      kind: r.kind,
      title: r.title,
      source_url: r.source_url,
      benchmarks_raw: r.benchmarks_raw,
    }));

  for (const r of found) {
    for (const sug of r.alias_suggestions ?? []) {
      aliasSuggestions.push({ raw: sug.raw, tracked: sug.tracked, reason: sug.reason, lab: lab.name });
    }
    for (const c of r.category_suggestions ?? []) {
      catSuggestions.push({ raw: c.raw, cats: c.secondary ? [c.primary, c.secondary] : [c.primary], lab: lab.name });
    }
  }

  if (fresh.length) {
    const merged = [...existing, ...fresh].sort((a, b) => a.date.localeCompare(b.date));
    writeFileSync(path, JSON.stringify(merged, null, 2) + "\n");
    added += fresh.length;
    summary.push(`${lab.name}: +${fresh.length} (${fresh.map((f) => f.model).join(", ")})`);
  }
}));

for (const [i, r] of results.entries()) {
  if (r.status === "rejected") summary.push(`${labs[i].name}: FAILED ${r.reason?.message ?? r.reason}`);
}

// Fold the accepted suggestions into the alias map. Same key rule as the
// build: lowercase, drop separators, collapse a trailing four-digit year.
const aliasKey = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/20(\d\d)$/, "$1");
const aliasPath = join(DATA, "aliases.json");
const aliasMap = JSON.parse(readFileSync(aliasPath, "utf8"));
const canonical = new Map(
  Object.entries(aliasMap).filter(([k]) => !k.startsWith("_")).map(([k, v]) => [aliasKey(k), v]),
);

// Mechanical guards first, so no API call is spent on a name that resolves
// already or on a pair that is the same string.
const skipped = [];
const needGate = [];
for (const sug of aliasSuggestions) {
  const rawK = aliasKey(sug.raw);
  if (rawK === aliasKey(sug.tracked) || canonical.has(rawK)) { skipped.push(sug); continue; }
  needGate.push(sug);
}

// A second opinion on what remains, from a differently-trained model.
//
// Applying a merge is the one automated judgement here that permanently
// rewrites history: it changes lab_count, first_seen, labs, labs_by_quarter and
// recent_share for BOTH benchmarks, and normalize.mjs cannot detect a wrong one
// because a merge is valid by construction. Asking the proposer to check itself
// would share its errors, which is the failure mode worth avoiding, so the
// check comes from somewhere else.
//
// Anything that is not a confident merge is queued rather than dropped. The
// suggestion is still evidence; it just is not evidence enough to act on
// unattended.
function gateAliases(candidates) {
  if (!candidates.length) return [];
  const py = process.env.PYTHON ?? "python3";
  const r = spawnSync(py, [join(ROOT, "scripts", "alias-gate.py")], {
    input: JSON.stringify(candidates), encoding: "utf8", timeout: 120000,
  });
  if (r.status !== 0 || !r.stdout) {
    const why = r.error?.message ?? r.stderr?.slice(0, 200) ?? `exit ${r.status}`;
    return candidates.map((c) => ({ ...c, decision: "REVIEW", unavailable: `gate_failed: ${why}` }));
  }
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    return candidates.map((c) => ({ ...c, decision: "REVIEW", unavailable: `gate_unparseable: ${e.message}` }));
  }
}

const gated = gateAliases(needGate);
const applied = [];
const queued = [];
for (const g of gated) {
  if (g.decision === "APPLY") {
    const target = canonical.get(aliasKey(g.tracked)) ?? aliasKey(g.tracked);
    aliasMap[g.raw] = target;
    canonical.set(aliasKey(g.raw), target);
    applied.push({ ...g, target });
    appendFileSync(
      join(DATA, "alias-log.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), ...g, target }) + "\n",
    );
  } else {
    queued.push(g);
  }
}
if (applied.length) writeFileSync(aliasPath, JSON.stringify(aliasMap, null, 2) + "\n");

// The queue is a file, not a log line, because a log line in a commit message
// is read by nobody on an unattended schedule. It accumulates and dedupes, so a
// pair the agent keeps proposing appears once with its latest verdict.
if (queued.length) {
  const qPath = join(DATA, "alias-queue.json");
  const existing = existsSync(qPath) ? JSON.parse(readFileSync(qPath, "utf8")) : [];
  const byPair = new Map(existing.map((q) => [`${aliasKey(q.raw)}|${aliasKey(q.tracked)}`, q]));
  for (const q of queued) byPair.set(`${aliasKey(q.raw)}|${aliasKey(q.tracked)}`, { ...q, seen: new Date().toISOString() });
  writeFileSync(qPath, JSON.stringify([...byPair.values()], null, 2) + "\n");
}

// Categories the rules could not have known. The rules in classify.mjs cover
// the well-cited middle by pattern, but a name like Seal-0 carries no word any
// pattern could match, and the agent that just read the release page knows what
// it tests. Recorded as an override, which is exactly where a human correction
// would go, so the two are interchangeable and either can be edited out.
const catPath = join(DATA, "categories.json");
const catFile = JSON.parse(readFileSync(catPath, "utf8"));
const catApplied = [];
for (const c of catSuggestions) {
  const k = aliasKey(c.raw);
  if (catFile.overrides[k]) continue;
  const cats = c.cats.filter((x) => CATEGORY_IDS.includes(x)).slice(0, 2);
  if (!cats.length) continue;
  catFile.overrides[k] = cats;
  catApplied.push({ ...c, cats });
  appendFileSync(join(DATA, "category-log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...c, cats }) + "\n");
}
if (catApplied.length) writeFileSync(catPath, JSON.stringify(catFile, null, 2) + "\n");

const lines = [...summary];
if (applied.length) {
  lines.push("", `Merged ${applied.length} duplicate spelling(s) into data/aliases.json:`,
    ...applied.map((x) => `  "${x.raw}" -> ${x.target}  (${x.lab}; same_name ${(x.probabilities?.same_name ?? 0).toFixed(2)}, safe ${(x.merge_is_safe ?? 0).toFixed(2)})`));
}
if (queued.length) {
  lines.push("", `Held ${queued.length} suggestion(s) for review in data/alias-queue.json:`,
    ...queued.map((x) => {
      const failed = Object.entries(x.gates ?? {}).filter(([, v]) => !v).map(([k]) => k);
      const why = x.unavailable ?? `${x.relation ?? "?"}; failed ${failed.join(", ") || "none"}`;
      return `  "${x.raw}" ~ "${x.tracked}"  ${x.decision}  (${why})`;
    }));
}
if (catApplied.length) {
  lines.push("", `Categorised ${catApplied.length} new benchmark(s):`,
    ...catApplied.map((x) => `  "${x.raw}" -> ${x.cats.join(" + ")} (${x.lab})`));
}
if (skipped.length) {
  lines.push("", `Already covered, no change (${skipped.length}):`,
    ...skipped.map((x) => `  "${x.raw}" ~ "${x.tracked}"`));
}
const report = lines.join("\n") || "No new releases found.";
console.log(report);
writeFileSync(join(ROOT, "research-summary.txt"), report);
process.exit(0);
