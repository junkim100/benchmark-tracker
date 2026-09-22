# Data contract

Everything in this repo is built from one idea: **which benchmarks does a frontier lab put in front of the public when it ships a model?** We record the citation, never the score. A lab choosing to report SWE-bench is the signal; how well it did is out of scope.

## Files and ownership

| Path | Written by | Notes |
|---|---|---|
| `data/labs.json` | maintainer | Fixed list of tracked labs. Rarely changes. |
| `data/aliases.json` | maintainer | Maps the many spellings of a benchmark onto one canonical id. |
| `data/releases/<lab-id>.json` | one researcher per lab | The only files researchers write. One lab per file, so two researchers never touch the same file. |
| `data/benchmarks.json` | `scripts/normalize.mjs` | Generated. The readable registry: every benchmark with everything known about it. Never edit by hand. |
| `data/timeline.json` | `scripts/normalize.mjs` | Generated. The benchmark registry as the site draws it. Never edit by hand. |
| `data/release-log.json` | `scripts/normalize.mjs` | Generated. The release records as the site draws them. Never edit by hand. |
| `data/descriptions.json` | `scripts/describe.mjs` | One sourced sentence per benchmark, or a record that none was found. A maintainer may correct an entry by hand; the pass never overwrites one. |
| `data/descriptions-site.json` | `scripts/normalize.mjs` | Generated. The descriptions the site shows. Never edit by hand. |
| `data/dedupe-queue.json` | `npm run dedupe` | Proposed benchmark merges awaiting a person. Written by the scan, read by nobody automatic, and applied by hand. |

Researchers record benchmark names **exactly as the lab wrote them**, in `benchmarks_raw`. Normalisation happens later, in the build. This keeps the raw record faithful, and it means twelve researchers can work at once without ever writing to a shared file.

## The three files the site loads

`timeline.json`, `release-log.json` and `descriptions-site.json` are written for a browser rather than for a reader, and the rules are different from the rest of this document.

They carry **only the fields the interface draws**. A field nobody renders is a field the browser should not download, so `benchmarks_raw`, the release `id` and `title`, `first_seen`, `last_seen`, `labs_by_year`, the per-benchmark `labs` array, the lab `homepage` and `sources`, and the category `blurb` are all absent. Every one of them survives in full in `benchmarks.json` or in the release records themselves, which are the citable copy.

They are written **without indentation**. Pretty-printing `timeline.json` cost 658 kB of whitespace that the browser downloaded and parsed to no effect. `benchmarks.json` and the hand-written release files stay indented, because those are read by people.

They are **split by what the first screen needs**. The picker and the chart draw from the registry alone; only the release timeline, two screens down, reads the log. The log is also the part of the dataset that grows without bound, so it is fetched alongside the registry and drawn when it arrives rather than blocking anything. The descriptions go further: nothing needs them until a reader opens a detail panel, so the page is handed their content-hashed URL on `window.btData.descriptions` and fetches the file on that click. At 1,623 entries they are most of another registry's worth of bytes for a panel most visits never open.

Inside `release-log.json`, `benchmarks` holds **positions in `timeline.json`'s `benchmarks` array**, not ids:

```json
{ "lab": "openai", "model": "GPT-5", "date": "2025-08-07", "kind": "model_release",
  "source_url": "https://openai.com/index/introducing-gpt-5/", "benchmarks": [3, 41, 0] }
```

The same few thousand id strings repeated across every release came to a third of the log on their own. The two files are generated together and served under content-hashed names that the built page cites as a pair, so the positions cannot drift apart. If you change how `benchmarks` is ordered or filtered, both files change together and there is nothing to keep in step by hand.

`timeline.json` also carries `release_log: { count, first }`, which is enough for the site to date its copy and handle an empty dataset before the log has arrived.

## A release record

```json
{
  "id": "openai-gpt-5-2025-08-07",
  "lab": "openai",
  "model": "GPT-5",
  "date": "2025-08-07",
  "kind": "model_release",
  "title": "Introducing GPT-5",
  "source_url": "https://openai.com/index/introducing-gpt-5/",
  "benchmarks_raw": ["AIME 2025", "SWE-bench Verified", "GPQA Diamond"]
}
```

| Field | Rule |
|---|---|
| `id` | `<lab>-<model-slug>-<date>`, unique across the repo. |
| `lab` | Must match an `id` in `labs.json`. |
| `date` | `YYYY-MM-DD`, the publication date of the official source. |
| `kind` | One of `model_release`, `technical_report`, `system_card`, `blog_post`. |
| `title` | The official title of the page or paper. |
| `source_url` | **Official lab domain or its arXiv paper only.** No news coverage, no aggregators, no third-party leaderboards. |
| `benchmarks_raw` | Benchmark names as printed by the lab. Empty array is valid and meaningful: it means the lab shipped without citing any benchmark. |

A file is a JSON array of these records, sorted by `date` ascending.

## Not introducing the same benchmark twice

Record the lab's exact wording in `benchmarks_raw`. That never changes. The build folds spellings that differ only in punctuation, case or spacing, so `IF-Eval`, `IFEval` and `IF Eval` already arrive as one benchmark and need no help.

What the build cannot decide is whether two different names mean the same thing. The research agent is given the benchmarks already cited by two or more labs and asked to pair any name that is one of those under another name, in `alias_suggestions`. Those pairings are reported in the run summary and land in the commit message; a person then adds the confirmed ones to `data/aliases.json`.

The judgement is deliberately left to a model rather than a string metric, because the metrics fail in both directions here. Edit distance pairs `MMLU-Pro` with `MMMU-Pro` and `IFEval` with `C-Eval`, which are different benchmarks, and misses `AIME24` against `AIME 2024`, which are the same. A shared-prefix rule is worse: it reads `ARCADE` as a variant of `ARC`.

A split is its own benchmark. `IFEval (Japanese)` is not `IFEval`, and `Leetcode (hard)` is not `Leetcode`. Merging those would delete the distinction the record exists to preserve.

## A benchmark description

`data/descriptions.json` is an object keyed by benchmark id, one entry per id, written by `scripts/describe.mjs`.

```json
{
  "swe-bench-verified": {
    "text": "A 500-problem subset of SWE-bench, filtered by human annotators so every issue is solvable and its tests are correct.",
    "source_url": "https://openai.com/index/introducing-swe-bench-verified/",
    "source": "researched",
    "checked": "2026-09-22"
  },
  "internalapiinstructionfollowing": {
    "source": "none",
    "checked": "2026-09-22"
  }
}
```

| Field | Rule |
|---|---|
| key | A benchmark `id` from `benchmarks.json`. An id nothing resolves fails the build. |
| `text` | One or two sentences on what the benchmark measures and how, 40 to 300 characters, already trimmed and single-spaced. Present only when `source` is `researched`. |
| `source_url` | The https page the description was taken from. Required when `source` is `researched`. Any host: a benchmark's own page is as often a university site, a repository or a dataset card as a lab's. |
| `source` | `researched` when a page was opened and read, `none` when it was looked for and not found. |
| `checked` | `YYYY-MM-DD`, the date of the attempt, so a later pass can re-try the refusals without redoing the rest. |

**Refusing is the expected outcome for a large share of the registry, not a failure.** 75 per cent of the 2,059 benchmarks are cited by exactly one lab and 52 per cent were first cited on or after June 2025, so the long tail is both obscure and later than most training data. A description assembled from the name alone is wrong in a way no reader could detect, so `describe.mjs` writes one only when it opened a page, and `source: "none"` records the attempt so the next pass can skip it until the cutoff. A pass that describes everything it touches has stopped refusing; the refusal rate is printed after every batch and again on every build for that reason.

**No scores, ever**, as everywhere else in this repo. A percentage or an explicit `name: 88.7` in a description fails the build.

`describe.mjs` never overwrites an entry that has a description, so a hand correction is permanent. Re-running only attempts ids with no entry and refusals older than the cutoff named in `scripts/descriptions.mjs`.

## Scope rules

- **No scores, ever.** If a number appears in a record, it is a bug.
- **Official sources only.** If the only evidence is a news article, the release does not go in.
- **Benchmarks mentioned in evaluation context count.** A passing mention of a benchmark in unrelated prose does not.
- **One record per published artifact.** A model with both a blog post and a technical report gets two records only if the benchmark sets differ; otherwise prefer the technical report.
