# Data contract

Everything in this repo is built from one idea: **which benchmarks does a frontier lab put in front of the public when it ships a model?** We record the citation, never the score. A lab choosing to report SWE-bench is the signal; how well it did is out of scope.

## Files and ownership

| Path | Written by | Notes |
|---|---|---|
| `data/labs.json` | maintainer | Fixed list of tracked labs. Rarely changes. |
| `data/aliases.json` | maintainer | Maps the many spellings of a benchmark onto one canonical id. |
| `data/releases/<lab-id>.json` | one researcher per lab | The only files researchers write. One lab per file, so two researchers never touch the same file. |
| `data/benchmarks.json` | `scripts/normalize.mjs` | Generated. Never edit by hand. |
| `data/timeline.json` | `scripts/normalize.mjs` | Generated. The single file the site loads. |

Researchers record benchmark names **exactly as the lab wrote them**, in `benchmarks_raw`. Normalisation happens later, in the build. This keeps the raw record faithful, and it means twelve researchers can work at once without ever writing to a shared file.

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

## Scope rules

- **No scores, ever.** If a number appears in a record, it is a bug.
- **Official sources only.** If the only evidence is a news article, the release does not go in.
- **Benchmarks mentioned in evaluation context count.** A passing mention of a benchmark in unrelated prose does not.
- **One record per published artifact.** A model with both a blog post and a technical report gets two records only if the benchmark sets differ; otherwise prefer the technical report.
