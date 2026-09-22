// Classify the modality of releases that predate the field.
//
// The research pass records modality for anything it finds from now on. The 777 records already on disk were written before the field existed, and a filter over a partly classified set is a filter that hides releases nobody decided to hide, so they have to be filled in once.
//
// It is a model that does it, not a rule. Rules were measured first and both available ones fail: matching the model's NAME keeps GPT-4 and Gemini as language models while dropping Veo, which sounds right until you count that 216 of the 628 releases such a rule keeps cite vision or speech benchmarks anyway; and inferring from the benchmarks a release CITED calls GPT-4 a knowledge model and LLaMA a reasoning model, then hides the benchmarks that produced the label. A model reading the name, the title, the source URL and the benchmark list has the context to say that Veo 2 generates video and that GPT-4 is a language model that also sees, which is the judgement being asked for.
//
// Everything it writes is stamped source: "inferred", so it never reads as the same kind of claim as a value the research agent took off the page. Re-running only touches records with no modality at all, so a reported value is never overwritten by an inferred one.
//
// Usage: ANTHROPIC_API_KEY=... node scripts/backfill-modality.mjs [--limit N] [--dry]

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MODALITY_IDS, MODALITIES, isValidModality } from "./modality.mjs";
import { assertSupported } from "./schema-guard.mjs";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const LIMIT = Number(args[args.indexOf("--limit") + 1]) || Infinity;
const BATCH = 40;

const SCHEMA = {
  type: "object",
  properties: {
    releases: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "Copied exactly from the record you were given." },
          classes: {
            type: "array",
            items: { type: "string", enum: MODALITY_IDS },
            description: `One to three entries, no duplicates. ${MODALITIES.map((m) => `${m.id}: ${m.blurb}`).join(" ")}`,
          },
        },
        required: ["id", "classes"],
        additionalProperties: false,
      },
    },
  },
  required: ["releases"],
  additionalProperties: false,
};

const PROMPT = `You are labelling what kind of model each release shipped, for a tracker of which benchmarks AI labs cite.

Judge the release, not the benchmarks. A language model that reads images is still "language": GPT-4, Gemini and Qwen-VL are all language. Use "vision" only when the model's product is not text, as with a segmentation or perception model. A release announcing several models carries one class per kind, so "Gemini 2.5 Pro and Veo 2" is language and video.

Rely on the model name, the title and the source URL. The benchmark list is context, not the answer: a release citing MMLU is not automatically language, and a language model citing speech benchmarks is still language.

Return one entry per release, with the id copied exactly.`;

const releases = [];
const files = {};
for (const f of readdirSync(DATA + "/releases")) {
  if (f.startsWith("_")) continue;
  files[f] = JSON.parse(readFileSync(join(DATA, "releases", f), "utf8"));
  for (const r of files[f]) if (!r.modality) releases.push({ file: f, r });
}
const byLab = new Map();
for (const x of releases) {
  if (!byLab.has(x.r.lab)) byLab.set(x.r.lab, []);
  byLab.get(x.r.lab).push(x);
}
const interleaved = [];
for (let i = 0; interleaved.length < releases.length; i++) {
  for (const list of byLab.values()) if (list[i]) interleaved.push(list[i]);
}
const todo = interleaved.slice(0, LIMIT);
console.log(`unclassified: ${releases.length}, doing ${todo.length} in batches of ${BATCH}`);
if (DRY) { console.log(todo.slice(0, 5).map((x) => `  ${x.r.model} (${x.r.lab})`).join("\n")); process.exit(0); }

assertSupported(SCHEMA, "backfill-modality SCHEMA");
const client = new Anthropic();
const answers = new Map();
for (let i = 0; i < todo.length; i += BATCH) {
  const chunk = todo.slice(i, i + BATCH);
  const payload = chunk.map(({ r }) => ({
    id: r.id, lab: r.lab, model: r.model, title: r.title, source_url: r.source_url,
    benchmarks: (r.benchmarks_raw ?? []).slice(0, 12),
  }));
  const res = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 8000,
    output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: `${PROMPT}\n\n${JSON.stringify(payload, null, 1)}` }],
  });
  if (res.stop_reason === "refusal") { console.error("refused, stopping"); break; }
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed;
  try { parsed = JSON.parse(text); } catch { console.error(`batch ${i / BATCH}: unparseable, skipped`); continue; }
  for (const a of parsed.releases ?? []) {
    const v = { classes: a.classes, source: "inferred" };
    // Checked against the same validator the build uses, so nothing this
    // writes can fail the build it is preparing.
    if (isValidModality(v)) answers.set(a.id, v);
  }
  console.log(`  batch ${Math.floor(i / BATCH) + 1}: ${answers.size} classified so far`);
}

let written = 0;
for (const [f, list] of Object.entries(files)) {
  let touched = false;
  for (const r of list) {
    const v = answers.get(r.id);
    if (v && !r.modality) { r.modality = v; touched = true; written++; }
  }
  if (touched) writeFileSync(join(DATA, "releases", f), JSON.stringify(list, null, 2) + "\n");
}
console.log(`wrote modality to ${written} record(s). ${releases.length - written} still unclassified.`);
