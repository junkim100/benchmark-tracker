// What counts as a release, decided in code rather than left to the prompt.
//
// The research prompt used to ask for anything that "announces a model or reports its evaluation", and the agent took it at its word: Anthropic's enzyme-discovery study, OpenAI's MentalHealthBench launch and a Xiaomi materials case study all went in as releases, as did "now available in the Gemini API" posts, new features for models already out, and a second copy of Kimi K2.7 Code three months after the first. Tightening the prompt helps, but a prompt is a request. The agent now has to say what each page announces, and only the answers below are written.

export const ANNOUNCES = ["new_model", "new_version", "model_report", "research_study", "benchmark_launch", "new_feature", "availability", "repost"];

// A new model, a new version of one, or that model's own technical report or system card. Everything else in ANNOUNCES is a page about a model that already shipped.
export const RELEASE_TYPES = new Set(["new_model", "new_version", "model_report"]);

export const isReleaseType = (announces) => RELEASE_TYPES.has(announces);

// The model named, spelled for comparison. Only used to point out a second announcement of a name already on file, never to drop one: measured against the 2026-09-28 data, every same-name announcement more than two weeks after the first was a real release (Grok-1's open weights, new Qwen2.5-Coder sizes, the Gemini 3 Deep Think upgrade), so a name match alone cannot tell a repost from a release. The agent, which reads the page, makes that call through ANNOUNCES; this only makes it visible.
export const modelKey = (model) => model.toLowerCase().replace(/[^a-z0-9]/g, "");

const ANNOUNCEMENT = new Set(["model_release", "blog_post"]);

export const repeatOf = (record, onFile) =>
  ANNOUNCEMENT.has(record.kind)
    ? onFile.find((r) => ANNOUNCEMENT.has(r.kind) && r.source_url !== record.source_url && modelKey(r.model) === modelKey(record.model))
    : undefined;
