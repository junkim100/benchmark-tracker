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

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 14);

const labs = JSON.parse(readFileSync(join(DATA, "labs.json"), "utf8"));
const client = new Anthropic();

// The benchmarks already tracked, so the agent can tell a genuinely new one
// from a new spelling of an old one. Only those cited by two or more labs: the
// long tail of single-citation names is mostly noise and would crowd the prompt.
//
// This judgement cannot be delegated to a string metric. Edit distance pairs
// MMLU-Pro with MMMU-Pro and IFEval with C-Eval, which are different
// benchmarks, while missing AIME 2024 against AIME24, which are the same.
// Knowing which is which is a semantic question.
const known = existsSync(join(DATA, "benchmarks.json"))
  ? JSON.parse(readFileSync(join(DATA, "benchmarks.json"), "utf8"))
      .filter((b) => b.lab_count >= 2)
      .map((b) => b.name)
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
        `Benchmarks already tracked, for the alias check (${known.length} cited by two or more labs):\n${known.join(", ")}`,
    }],
  });

  if (response.stop_reason === "refusal") throw new Error(`refused: ${response.stop_details?.category}`);
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text).releases ?? [];
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
let added = 0;
const summary = [];
const aliasNotes = [];

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
      aliasNotes.push(`${lab.name}: "${sug.raw}" looks like the tracked "${sug.tracked}" (${sug.reason})`);
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

const lines = [...summary];
if (aliasNotes.length) {
  lines.push("", `Possible duplicate spellings (${aliasNotes.length}), add to data/aliases.json if correct:`, ...aliasNotes.map((n) => `  ${n}`));
}
const report = lines.join("\n") || "No new releases found.";
console.log(report);
writeFileSync(join(ROOT, "research-summary.txt"), report);
process.exit(0);
