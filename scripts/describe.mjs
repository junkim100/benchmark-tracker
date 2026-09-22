// Find out what each tracked benchmark actually is, one page at a time.
//
// The registry knows who cited a benchmark and when, and nothing else. A reader who opens a card for "Seal-0" or "FrontierCode 1.1 Extended" learns that four labs mentioned it and is no wiser about what it measures. This fills that in, from sources, or says it could not.
//
// Web search is not optional here and the numbers say why. 52 per cent of the 2,176 ids were first cited on or after June 2025, which is after most training data was collected, and 76 per cent are cited by exactly one lab, so the long tail is genuinely obscure rather than merely unfamiliar. Asked without search, a model produces a fluent description of a benchmark it has never seen, and the result is indistinguishable from a real one until a reader who knows the field arrives. So every description comes from a page the agent opened, and the page is stored beside it.
//
// Refusing is therefore the expected outcome for a large share of the registry, not a failure to be minimised. It is one field and costs one request, the refusal rate is printed after every batch and again on every build, and scripts/normalize.mjs will not let an entry claim a source it does not have. A pass that describes everything is the failure mode worth worrying about.
//
// Resumable, because it will be run more than once and a full pass takes hours. Only ids with no entry are attempted, plus refusals older than the cutoff in scripts/descriptions.mjs, and the file is written after every batch rather than at the end: an interrupted run keeps everything it had bought.
//
// Usage: ANTHROPIC_API_KEY=... node scripts/describe.mjs [--limit N] [--dry] [--prune]

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { flatKey } from "./classify.mjs";
import { assertSupported } from "./schema-guard.mjs";
import { checkEntry, isStale, tidy, MAX_TEXT, MIN_TEXT, RETRY_DAYS } from "./descriptions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const PRUNE = args.includes("--prune");
const limitArg = Number(args[args.indexOf("--limit") + 1]);
const LIMIT = args.includes("--limit") && limitArg > 0 ? Math.floor(limitArg) : Infinity;

// How many requests are in flight at once. One request per benchmark rather than a batch of benchmarks per request, because search results do not amortise: eight benchmarks in one turn means every later search in that turn re-reads every earlier one's results as input, which costs more than eight separate turns and loses the property that one bad answer spoils exactly one entry.
//
// Eight is chosen against the clock rather than the rate limit. A search turn runs 30 to 60 seconds, and a full pass at eight-way concurrency lands near four hours, inside a GitHub Actions job. Raise it with CONCURRENCY if the account's limits allow.
const BATCH = Number(process.env.CONCURRENCY) > 0 ? Number(process.env.CONCURRENCY) : 8;
// Named so the truncation error can quote the limit it hit, as in research.mjs. Generous because adaptive thinking is billed and counted here, while the JSON itself is two sentences.
const MAX_TOKENS = 8000;
const TODAY = new Date().toISOString().slice(0, 10);

const registryPath = join(DATA, "benchmarks.json");
if (!existsSync(registryPath)) {
  console.error("data/benchmarks.json is missing. Run npm run normalize first: this pass describes the registry, so it needs the registry.");
  process.exit(1);
}
const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const descPath = join(DATA, "descriptions.json");
const descriptions = existsSync(descPath) ? JSON.parse(readFileSync(descPath, "utf8")) : {};

// Sorted on write, always. The file is read by people and diffed by git on every run, and an object that comes back in insertion order turns one new benchmark into a diff that moves everything after it.
//
// Written through a temporary file and renamed, because this runs after every batch: a four-hour pass writes it a few hundred times, and the thing most likely to end that pass is a signal arriving from outside. A kill during a plain write leaves a truncated file, which is to say the whole run's work and every earlier run's, and the resume would silently start from nothing. A rename within the same directory is atomic, so the file on disk is always one complete version or the previous one.
const save = () => {
  const sorted = {};
  for (const id of Object.keys(descriptions).sort()) sorted[id] = descriptions[id];
  const tmp = `${descPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(sorted, null, 2) + "\n");
  renameSync(tmp, descPath);
};

// An id can leave the registry without anything being wrong: research.mjs applies a confident alias merge unattended, and both names collapse onto one id. The description filed under the retired name is then unreachable, and normalize.mjs fails the build over it rather than publishing a file whose keys do not all resolve. Following the merge keeps the work; there is nothing to re-research, because the merged benchmark is the same benchmark.
if (PRUNE) {
  const aliases = JSON.parse(readFileSync(join(DATA, "aliases.json"), "utf8"));
  const aliasByKey = new Map(
    Object.entries(aliases).filter(([k]) => !k.startsWith("_")).map(([k, v]) => [flatKey(k), v]),
  );
  const ids = new Set(registry.map((b) => b.id));
  const moved = [];
  const dropped = [];
  for (const id of Object.keys(descriptions)) {
    if (ids.has(id)) continue;
    const target = aliasByKey.get(id);
    if (target && ids.has(target) && !descriptions[target]) {
      descriptions[target] = descriptions[id];
      moved.push(`${id} -> ${target}`);
    } else {
      dropped.push(id);
    }
    delete descriptions[id];
  }
  if (moved.length) console.log(`followed ${moved.length} alias merge(s):\n${moved.map((m) => `  ${m}`).join("\n")}`);
  if (dropped.length) console.log(`dropped ${dropped.length} entr(ies) for ids no benchmark has:\n${dropped.map((d) => `  ${d}`).join("\n")}`);
  if (moved.length || dropped.length) save();
  else console.log("nothing to prune.");
  process.exit(0);
}

// Attempt an id when nothing has been tried, or when the last attempt found nothing and is old enough to be worth another look. A description that came off a page is never re-read: it is still true, and confirming 2,176 of them would spend the entire budget learning nothing.
const pool = registry.filter((b) => {
  const e = descriptions[b.id];
  return !e || isStale(e, TODAY);
});
const retries = pool.filter((b) => descriptions[b.id]).length;

// --limit takes a sample of the registry, not its first N.
//
// The modality backfill originally took the first 40 records off disk, which were all one lab's releases, so the trial measured one lab and proved nothing about the other eleven. The same shape is available here: benchmarks.json is sorted by lab count, so the first N are the twelve-lab household names, which are the easiest to describe and the least representative of a registry that is three quarters single-lab long tail.
//
// So every benchmark gets its position within its own category as a fraction, and the pass runs in order of that fraction. Any prefix then holds roughly the same category mix as the whole pool. Proportional rather than round-robin on purpose: "other" is 1,005 of the 2,176 ids, and taking one from each of twelve categories in turn would show a trial twelve tidy groups and hide that the uncategorised long tail is nearly half the work.
//
// Within a category the order is a deterministic shuffle rather than a sort, which fixes a second bias the fraction alone does not. Ordering each bucket by lab and then by date made the first twelve of a pass twelve benchmarks first cited by the alphabetically first lab in 2023: the first-N mistake again, wearing a hat. A hash of the id is unbiased on every axis at once, which is what representative of labs, categories and recency actually asks for, and it is stable across runs so a trial can be repeated and a resumed pass keeps its place.
//
// It orders the full pass too, not only a limited one. Four hours is long enough to be interrupted, and a run that had finished coding and not started vision is a worse place to resume from than one a third of the way through everything.
const hash = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
};
const buckets = new Map();
for (const b of pool) {
  const k = b.categories[0];
  if (!buckets.has(k)) buckets.set(k, []);
  buckets.get(k).push(b);
}
const ranked = [];
for (const [k, list] of buckets) {
  list.sort((x, y) => hash(x.id) - hash(y.id) || x.id.localeCompare(y.id));
  list.forEach((b, i) => ranked.push({ b, at: (i + 0.5) / list.length, k }));
}
ranked.sort((x, y) => x.at - y.at || x.k.localeCompare(y.k));
const todo = ranked.slice(0, LIMIT === Infinity ? ranked.length : LIMIT).map((x) => x.b);

const SCHEMA = {
  type: "object",
  properties: {
    found: {
      type: "boolean",
      description: "True only when you opened a page that describes this exact benchmark. False is a correct, expected and cheap answer, and is right for any name you could not confirm.",
    },
    text: {
      type: "string",
      // No minLength or maxLength: the structured-output API answers 400 for either, which is what scripts/schema-guard.mjs exists to catch. The bound is stated here and enforced by checkEntry before anything is written.
      description: `One or two sentences on what the benchmark measures and how it is built or scored, between ${MIN_TEXT} and ${MAX_TEXT} characters. Plain and technical. Never a score, a result, a ranking or a percentage. Omit entirely when found is false.`,
    },
    source_url: {
      type: "string",
      description: "The single https page the description was taken from, which you opened. Omit entirely when found is false.",
    },
  },
  required: ["found"],
  additionalProperties: false,
};

const SYSTEM =
  "You write one-line reference entries for AI benchmarks, for a tracker that records which benchmarks frontier labs cite when they ship a model.\n\n" +
  "Your first duty is to refuse. Most of these names are obscure, most were published after your training data was collected, and a plausible description assembled from the name is worse than none: it is wrong in a way no reader can detect. Describe a benchmark only when you have opened a page that says what it is. If search turns up nothing about this exact benchmark, answer found: false and stop. That is a correct result, it is expected for a large share of these names, and it costs nothing.\n\n" +
  "Be strict about identity. A page about a benchmark with a similar name is a different benchmark: SWE-bench is not SWE-bench Verified, MMLU is not MMLU-Pro, IFEval is not IFEval (Japanese), and version 2 is not version 1. A leaderboard row or a results table carrying the name is not a description of it, and neither is another lab's release post listing it among its evaluations. If the only thing you can find is that somebody cited it, you have found nothing: answer found: false.\n\n" +
  "When you do have a page: at most two sentences, saying what the benchmark measures and how it is built or scored. Plain and technical. No marketing and no filler adjectives, so not comprehensive, challenging, novel or state-of-the-art. Never a score, a result, a ranking or a percentage, and never how any model did on it: this project records citations and never results, so a number of that kind in your answer is an error.\n\n" +
  "source_url is the page you took it from, and one you actually opened: the paper, the project page, the repository, the dataset card. https only, one URL, no search-engine or aggregator links.";

const prompt = (b) =>
  `Benchmark: ${b.name}\n` +
  `Cited by ${b.labs.join(", ")}. First cited ${b.first_seen}, most recently ${b.last_seen}.\n\n` +
  `Search for what this benchmark is, then answer. The labs and dates are context for telling it apart from similarly named benchmarks; they are not evidence of what it measures, and a page that only repeats them is not a source.`;

// Before the client, not after. The guard exists because an unsupported schema keyword is only ever seen by the API, and the first thing that noticed last time was a scheduled run dying eighteen seconds in. Checking it above the --dry exit means a dry run catches the mistake too, which is the run somebody makes before spending anything.
assertSupported(SCHEMA, "describe SCHEMA");

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
console.log(
  `registry ${registry.length} · described ${Object.values(descriptions).filter((e) => e.source === "researched").length} · ` +
  `to attempt ${pool.length} (${pool.length - retries} never tried, ${retries} refusals older than ${RETRY_DAYS} days)`);
console.log(`doing ${todo.length} in batches of ${BATCH}`);

if (DRY) {
  const shown = todo.slice(0, 12);
  console.log(`\nfirst ${shown.length} of the plan, in order:`);
  for (const b of shown) console.log(`  ${b.name}  [${b.categories.join("+")}] ${b.labs.length} lab(s), first ${b.first_seen}`);
  const mix = new Map();
  for (const b of todo) mix.set(b.categories[0], (mix.get(b.categories[0]) ?? 0) + 1);
  console.log(`\ncategory mix of the plan: ${[...mix].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  console.log("nothing called, nothing written.");
  process.exit(0);
}

// Four retries rather than the SDK's two. A full pass is 2,176 requests at eight-way concurrency and will meet a 429 somewhere; losing a benchmark to one is not serious, but losing a batch of them to a burst is a hole in the sample the next run has no way to know about.
const client = new Anthropic({ maxRetries: 4 });

async function describeOne(b) {
  const messages = [{ role: "user", content: prompt(b) }];
  // Counted across every turn of this benchmark, not per reply.
  let searches = 0;
  const seenUrls = new Set();
  // A web search turn can stop at the server loop's iteration limit with stop_reason "pause_turn" and no final message. research.mjs treats that as a failure, which is right when a lab is one of twelve and a seven-day lookback gives it two more chances. Here it is one benchmark of 2,176, the searches have already been paid for, and the next attempt would start from nothing, so the turn is resumed instead. Resuming is only re-sending what came back: the API sees the trailing server tool block and continues, and adding a "carry on" message of our own would derail it.
  for (let resumed = 0; resumed <= 2; resumed++) {
    const res = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: MAX_TOKENS,
      output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
      system: SYSTEM,
      messages,
    });
    if (res.stop_reason === "refusal") throw new Error(`model refused: ${res.stop_details?.category}`);
    if (res.stop_reason === "max_tokens") throw new Error(`hit max_tokens (${MAX_TOKENS}): the answer is truncated`);
    if (res.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: res.content }); continue; }

    // Evidence that a page was actually read, kept rather than discarded.
    //
    // The reply was being filtered down to its text and everything else thrown
    // away, which included the search blocks. That left found: true resting on
    // the model's word: it could name a plausible URL it never opened, and the
    // only check was that the string parsed as https. This project has already
    // learned this once, in sources.mjs: restricting what the agent may SEARCH
    // is not the same as restricting what it writes down. Here there was not
    // even a search restriction.
    //
    // Counted across turns, because a paused turn's final content holds only
    // the last one, and a run that searched on turn one and answered on turn
    // three would otherwise look like it never searched at all.
    for (const block of res.content) {
      if (block.type === "server_tool_use" && block.name === "web_search") searches++;
      if (block.type === "web_search_tool_result") {
        for (const r of block.content ?? []) if (r?.url) seenUrls.add(String(r.url));
      }
    }
    const text = res.content.filter((x) => x.type === "text").map((x) => x.text).join("").trim();
    if (!text) throw new Error(`no text in the reply (stop_reason: ${res.stop_reason})`);
    try {
      return { ...JSON.parse(text), _searches: searches, _seenUrls: seenUrls };
    } catch (e) {
      // Say what could not be parsed, as research.mjs does. A bare SyntaxError names a column in a string nobody can see.
      throw new Error(`reply was not JSON (${e.message}); first 200 chars: ${text.slice(0, 200)}`);
    }
  }
  throw new Error("still paused after two continuations");
}

let researched = 0;
let refused = 0;
// Answers that claimed a description and did not survive checkEntry, and requests that never produced one. Both are held apart from a refusal because a refusal is a finding about the benchmark and these are faults in the run: neither writes an entry, so the next pass tries the id again rather than recording "looked, found nothing" on this pass's behalf.
const rejected = [];
// Answers that claimed a source without having searched, or cited a URL the search never returned. Counted apart from ordinary refusals because they say something about the run rather than about the benchmark.
const unsearched = [];
const uncited = [];
const failed = [];

for (let i = 0; i < todo.length; i += BATCH) {
  const chunk = todo.slice(i, i + BATCH);
  const results = await Promise.allSettled(chunk.map((b) => describeOne(b)));
  let batchOk = 0;
  let batchNo = 0;
  for (const [j, r] of results.entries()) {
    const b = chunk[j];
    if (r.status === "rejected") { failed.push(`${b.name}: ${r.reason?.message ?? r.reason}`); continue; }
    if (!r.value?.found) {
      descriptions[b.id] = { source: "none", checked: TODAY };
      refused++; batchNo++;
      continue;
    }
    // Two claims have to be true before a description counts as researched,
    // and neither was checked before.
    //
    // It must have searched. max_uses: 5 is a ceiling with no floor, so a turn
    // that searched nothing and answered from memory was indistinguishable
    // from one that read a page. A found: true with zero searches is an
    // invention by definition.
    //
    // And the URL it cites must be one the search actually returned. Otherwise
    // the model can name a plausible page it never opened, which is the exact
    // failure sources.mjs exists to stop on the other pipeline: constraining
    // what may be READ is not constraining what gets WRITTEN DOWN. The
    // evidence was already in the reply and was being thrown away.
    //
    // Both refuse rather than reject, because an answer with no search behind
    // it is a finding about the model, not a malformed reply, and retrying it
    // unchanged would produce the same thing.
    if (!r.value._searches) {
      descriptions[b.id] = { source: "none", checked: TODAY };
      refused++; batchNo++; unsearched.push(b.name);
      continue;
    }
    if (r.value.source_url && !r.value._seenUrls?.has(r.value.source_url)) {
      descriptions[b.id] = { source: "none", checked: TODAY };
      refused++; batchNo++; uncited.push(`${b.name}: ${r.value.source_url}`);
      continue;
    }
    const entry = { text: tidy(r.value.text), source_url: r.value.source_url, source: "researched", checked: TODAY };
    // Checked against the validator the build uses, so nothing written here can fail the build it is preparing. Dropped rather than downgraded to a refusal: a malformed answer says nothing about whether the benchmark is findable, and recording one as "looked, found nothing" would suppress the id until the cutoff on the strength of our own bug.
    const bad = checkEntry(entry, TODAY);
    if (bad) { rejected.push(`${b.name}: ${bad}`); continue; }
    descriptions[b.id] = entry;
    researched++; batchOk++;
  }
  // Written every batch, not at the end. A full pass is hours long and the thing most likely to end it is something outside this script, so the work has to be on disk before the next request is made.
  save();
  const done = researched + refused;
  console.log(
    `  batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(todo.length / BATCH)}: +${batchOk} researched, +${batchNo} refused` +
    ` (running ${researched} researched, ${refused} refused, ${pct(refused, done)}% refusal rate)`);
}

const attempted = researched + refused;
const lines = [
  `Described ${researched} and refused ${refused} of ${attempted} attempted (${pct(refused, attempted)}% refusal rate).`,
];
// Stated on every run, including a good one. A high refusal rate is the expected result and needs no explanation; a rate near zero is the one that wants investigating, because it means the agent stopped refusing rather than that the long tail got easier.
if (attempted && pct(refused, attempted) < 10) {
  lines.push("A refusal rate this low is suspicious rather than good: three quarters of the registry is single-lab long tail and much of it has no page. Check a sample against its source_url before trusting the batch.");
}
if (unsearched.length) {
  lines.push("", `Refused ${unsearched.length} answer(s) that claimed a description without searching at all:`, ...unsearched.slice(0, 20).map((x) => `  ${x}`));
}
if (uncited.length) {
  lines.push("", `Refused ${uncited.length} answer(s) citing a URL the search never returned:`, ...uncited.slice(0, 20).map((x) => `  ${x}`));
}
if (rejected.length) {
  lines.push("", `Dropped ${rejected.length} answer(s) that failed the description contract:`, ...rejected.slice(0, 20).map((x) => `  ${x}`));
}
if (failed.length) {
  lines.push("", `${failed.length} request(s) failed and wrote nothing, so they will be attempted again:`, ...failed.slice(0, 20).map((x) => `  ${x}`));
}
// Scrubbed, because this string is the commit message and a failure line carries whatever the SDK put in its error. research.mjs makes the same move and says why: Actions masks secrets in the run log, which is a different protection and does not cover a file that is committed and permanent. An HTTP client that echoed the auth header would otherwise turn one 401 into a disclosed credential nobody thought to rotate.
const SECRETS = [process.env.ANTHROPIC_API_KEY].filter((s) => s && s.length >= 8);
const scrub = (s) => SECRETS.reduce((acc, k) => acc.split(k).join("[redacted]"), String(s ?? ""));
const report = scrub(lines.join("\n"));
console.log(`\n${report}`);
writeFileSync(join(ROOT, "descriptions-summary.txt"), report + "\n");

// A run where nothing at all came back is an outage, not a registry of undescribable benchmarks, and it must not report success. The same reasoning as research.mjs: partial failure stays tolerated, because one benchmark lost to a rate limit should not discard the rest of the batch and the id is simply attempted again next time.
if (todo.length && !attempted) {
  console.error(`\nEvery one of the ${todo.length} attempted failed. Treating this as an outage, not a result.`);
  process.exit(1);
}

// A suspicious result has to fail, not just print.
//
// The low-refusal warning above was a line of text on a script that exits 0.
// This pass is hours long and runs unattended in Actions, so the only thing
// anyone sees is the tick, and a run that invented 2,176 descriptions looked
// exactly like a run that read 2,176 pages. research.mjs already recorded this
// lesson in its own words: a wrong key once produced twelve FAILED lines, a
// green tick, and a commit that changed only a timestamp.
//
// The bar is the refusal rate, and it is deliberately low. Three quarters of
// this registry is single-lab long tail and over half of it postdates most
// training data, so a pass describing more than nine in ten of what it
// attempted did not find pages, it wrote sentences. The work is still on disk
// either way, because save() runs every batch; what a non-zero exit stops is
// the workflow committing it without anyone looking.
const MIN_REFUSAL_PCT = 10;
const SAMPLE_FOR_A_VERDICT = 40;
if (attempted >= SAMPLE_FOR_A_VERDICT && pct(refused, attempted) < MIN_REFUSAL_PCT) {
  console.error(
    `\nRefused ${pct(refused, attempted)}% of ${attempted}, under the ${MIN_REFUSAL_PCT}% floor. ` +
    `Failing rather than committing: at this rate the pass is describing what it cannot have found. ` +
    `Run node scripts/audit-descriptions.mjs and check a sample against its source_url before overriding.`,
  );
  process.exit(2);
}
