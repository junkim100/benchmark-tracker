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
import { MODALITY_IDS, MODALITIES } from "./modality.mjs";
import { assertSupported } from "./schema-guard.mjs";
import { SHARED_HOSTS, isOfficialSource } from "./sources.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 14);
// Named so the truncation error can quote the limit it hit.
const MAX_TOKENS = 16000;

const labs = JSON.parse(readFileSync(join(DATA, "labs.json"), "utf8"));
const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
assertSupported(RECORD_SCHEMA, "research RECORD_SCHEMA");
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
// The shared hosts host every lab, so a bare hostname there would let anyone's
// upload count as official. web search accepts a path suffix, so those stay
// scoped to the lab's own org while everything else is a host.
//
// This is the allowlist for what the agent may READ. It is not a constraint on
// the source_url it writes, which is free text and is checked separately by
// isOfficialSource below. The shared-host set is imported rather than repeated
// so the two rules cannot drift apart.
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
          modality: {
            type: "object",
            description: "What kind of model or models this release shipped, read from the page rather than guessed from the name. A release announcing several models carries several classes.",
            properties: {
              classes: {
                // No minItems or maxItems. The structured-output API answers
                // 400 for either on an array, and this schema is the one the
                // scheduled research run depends on, so an unsupported keyword
                // here fails the cron rather than a job somebody watches. The
                // bound lives in the description and in isValidModality, which
                // is what actually decides whether a value is written.
                type: "array",
                items: { type: "string", enum: MODALITY_IDS },
                description: `One to three entries, one per kind of model announced, no duplicates. ${MODALITIES.map((m) => `${m.id}: ${m.blurb}`).join(" ")}`,
              },
            },
            required: ["classes"],
            additionalProperties: false,
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
        required: ["model", "date", "kind", "title", "source_url", "benchmarks_raw", "modality", "alias_suggestions", "category_suggestions"],
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
    max_tokens: MAX_TOKENS,
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

  // Refusal was the only stop reason handled, and it is not the only one that
  // arrives without usable text. A paused turn carries tool blocks and no final
  // message, and a truncated one stops mid-JSON; both then failed inside
  // JSON.parse with a syntax error that says nothing about what happened, and
  // allSettled turned that into one unexplained FAILED line.
  if (response.stop_reason === "refusal") throw new Error(`refused: ${response.stop_details?.category}`);
  if (response.stop_reason === "pause_turn") throw new Error("paused mid-turn: no final message to read");
  if (response.stop_reason === "max_tokens") throw new Error(`hit max_tokens (${MAX_TOKENS}): the answer is truncated`);

  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) throw new Error(`no text in the reply (stop_reason: ${response.stop_reason})`);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // Say what could not be parsed. A bare SyntaxError names a column in a
    // string nobody can see.
    throw new Error(`reply was not JSON (${e.message}); first 200 chars: ${text.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed.releases)) throw new Error("reply had no releases array");
  return parsed.releases;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
let added = 0;
const summary = [];
// Records refused because their source_url is not the lab's to publish. Dropped
// here rather than left for normalize.mjs so that one poisoned result costs one
// record: normalize fails the whole run on a contract breach, which would throw
// away the other eleven labs' findings and every alias and category decision
// alongside the bad row. They are reported rather than swallowed, because a lab
// that has genuinely started publishing somewhere new looks exactly like this
// and the fix is one line in labs.json.
const refused = [];
const aliasSuggestions = [];
const catSuggestions = [];

const results = await Promise.allSettled(labs.map(async (lab) => {
  const found = await researchLab(lab);
  const path = join(DATA, "releases", `${lab.id}.json`);
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  const seen = new Set(existing.map((r) => r.source_url));

  // Provenance is decided once, before anything is read off the record. A
  // record whose source_url is not the lab's own is a record about a page this
  // pipeline has no reason to trust, so its alias and category judgements go
  // with it: the alias gate is a second opinion, but a category override is
  // written with no gate at all, which would leave an injected page able to
  // relabel a benchmark even once its URL had been refused.
  const official = found.filter((r) => {
    if (!r.source_url) return false;
    if (isOfficialSource(lab, r.source_url)) return true;
    refused.push(`  ${lab.name}: ${r.source_url} (${r.model})`);
    return false;
  });

  const fresh = official
    .filter((r) => !seen.has(r.source_url))
    .map((r) => ({
      id: `${lab.id}-${slug(r.model)}-${r.date}`,
      lab: lab.id,
      model: r.model,
      date: r.date,
      kind: r.kind,
      title: r.title,
      source_url: r.source_url,
      benchmarks_raw: r.benchmarks_raw,
      // Stamped "reported" because the agent read it off the page it cited,
      // which is a different kind of claim from the backfill's, and the two
      // should never be indistinguishable once they are sitting in the same
      // file. Validated by normalize before anything is published, so a
      // malformed block fails the build rather than reaching the filter.
      ...(r.modality?.classes?.length ? { modality: { classes: r.modality.classes, source: "reported" } } : {}),
    }));

  for (const r of official) {
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

const failures = [];
for (const [i, r] of results.entries()) {
  if (r.status === "rejected") {
    failures.push(labs[i].name);
    summary.push(`${labs[i].name}: FAILED ${r.reason?.message ?? r.reason}`);
  }
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

// A diagnostic from a failed gate call is untrusted text on its way to a public
// place: it lands in data/alias-queue.json and in the commit message, both of
// which are committed and permanent. GitHub masks secrets in the run log, which
// is a different protection and does not cover either of those. An HTTP client
// that puts the key in a query string or echoes the auth header would otherwise
// turn one 401 into a disclosed credential nobody thought to rotate.
const SECRETS = [process.env.TYPESAFE_API_KEY, process.env.ANTHROPIC_API_KEY].filter((s) => s && s.length >= 8);
const scrub = (s) => SECRETS.reduce((acc, k) => acc.split(k).join("[redacted]"), String(s ?? ""));

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
    const why = scrub(r.error?.message ?? r.stderr?.slice(0, 200) ?? `exit ${r.status}`);
    return candidates.map((c) => ({ ...c, decision: "REVIEW", unavailable: `gate_failed: ${why}` }));
  }
  try {
    // The gate builds its own "call_failed: <exception>" strings, so its output
    // is scrubbed too rather than only the text this side writes.
    return JSON.parse(r.stdout).map((g) => (g.unavailable ? { ...g, unavailable: scrub(g.unavailable) } : g));
  } catch (e) {
    return candidates.map((c) => ({ ...c, decision: "REVIEW", unavailable: `gate_unparseable: ${scrub(e.message)}` }));
  }
}

// Reconcile what came back against what was sent. The gate is a separate
// process and its contract is "one verdict per candidate", but a contract is
// not a guarantee: unparseable input, for one, makes it return an empty list.
// Anything sent and not returned is queued rather than lost, because silently
// dropping a suggestion is the one outcome worse than holding it.
const gatedRaw = gateAliases(needGate);
const seenBack = new Set(gatedRaw.map((g) => `${aliasKey(g.raw)}|${aliasKey(g.tracked)}`));
const gated = [
  ...gatedRaw,
  ...needGate
    .filter((c) => !seenBack.has(`${aliasKey(c.raw)}|${aliasKey(c.tracked)}`))
    .map((c) => ({ ...c, decision: "REVIEW", unavailable: "gate_returned_no_verdict" })),
];
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
if (refused.length) {
  lines.push("", `Refused ${refused.length} record(s) whose source is not the lab's own domain:`, ...refused,
    "Either a page the agent read tried to redirect the citation, or the lab now publishes somewhere new. Add the host to data/labs.json if it is genuinely theirs.");
}
// Scrubbed once more at the end, because this string becomes a commit message
// and a lab failure line carries whatever the SDK put in its error.
const report = scrub(lines.join("\n")) || "No new releases found.";
console.log(report);
writeFileSync(join(ROOT, "research-summary.txt"), report);

// How many releases landed, for the workflow to branch on. It used to ask git
// whether anything under data/ changed, but normalize.mjs stamps a fresh
// generated_at into timeline.json on every run, so the answer was always yes
// and the "nothing new" branch was unreachable.
writeFileSync(join(ROOT, "research-added.txt"), String(added));

// A run where every lab failed is an outage, not a quiet week, and it must not
// report success. Promise.allSettled turns each rejection into a summary line
// and the script ended on a bare exit 0, so a wrong API key produced twelve
// FAILED lines, a green tick, and a commit that changed only a timestamp.
//
// Partial failure stays tolerated on purpose: one lab rate-limited should not
// discard the other eleven, and the seven-day lookback gives the missed one two
// or three more chances.
if (failures.length === labs.length) {
  console.error(`\nEvery lab failed (${failures.length}/${labs.length}). Treating this as an outage, not a quiet run.`);
  process.exit(1);
}
if (failures.length > labs.length / 2) {
  console.error(`\nWarning: ${failures.length} of ${labs.length} labs failed.`);
}
process.exit(0);
