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
        },
        required: ["model", "date", "kind", "title", "source_url", "benchmarks_raw"],
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
      "record it with an empty benchmarks_raw. Never guess a date or a URL; omit anything you cannot confirm from the source itself.",
    messages: [{
      role: "user",
      content:
        `Find everything ${lab.name} published between ${since} and ${today} that announces a model or reports its evaluation: ` +
        `model releases, technical reports, system cards, or model-announcement blog posts.\n\n` +
        `For each one, record which benchmarks the lab cited, using the exact wording on the page ` +
        `("SWE-bench Verified", not a normalised slug). Search is restricted to ${allowed.join(", ")}, which is deliberate: ` +
        `only the lab's own publications count.\n\n` +
        `Return an empty releases array if there is nothing in that window. That is the normal result on most days.`,
    }],
  });

  if (response.stop_reason === "refusal") throw new Error(`refused: ${response.stop_details?.category}`);
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text).releases ?? [];
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
let added = 0;
const summary = [];

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

console.log(summary.length ? summary.join("\n") : "No new releases found.");
writeFileSync(join(ROOT, "research-summary.txt"), summary.join("\n") || "No new releases found.");
process.exit(0);
