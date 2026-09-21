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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 14);

const labs = JSON.parse(readFileSync(join(DATA, "labs.json"), "utf8"));
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
        required: ["model", "date", "kind", "title", "source_url", "benchmarks_raw", "alias_suggestions"],
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
const applied = [];
const skipped = [];
for (const sug of aliasSuggestions) {
  const rawK = aliasKey(sug.raw);
  const trackedK = aliasKey(sug.tracked);
  // A name that already resolves needs nothing, and must not be overwritten:
  // a hand-made entry outranks anything decided here.
  if (rawK === trackedK || canonical.has(rawK)) { skipped.push(sug); continue; }
  const target = canonical.get(trackedK) ?? trackedK;
  aliasMap[sug.raw] = target;
  canonical.set(rawK, target);
  applied.push({ ...sug, target });
  appendFileSync(
    join(DATA, "alias-log.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), ...sug, target }) + "\n",
  );
}
if (applied.length) writeFileSync(aliasPath, JSON.stringify(aliasMap, null, 2) + "\n");

const lines = [...summary];
if (applied.length) {
  lines.push("", `Merged ${applied.length} duplicate spelling(s) into data/aliases.json:`,
    ...applied.map((x) => `  "${x.raw}" -> ${x.target} (${x.lab}: ${x.reason})`));
}
if (skipped.length) {
  lines.push("", `Already covered, no change (${skipped.length}):`,
    ...skipped.map((x) => `  "${x.raw}" ~ "${x.tracked}"`));
}
const report = lines.join("\n") || "No new releases found.";
console.log(report);
writeFileSync(join(ROOT, "research-summary.txt"), report);
process.exit(0);
