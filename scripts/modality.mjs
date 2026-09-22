// What kind of model a release shipped.
//
// The site is about which benchmarks labs cite, and it counts every release in the same denominator. That mixes things a reader may not want mixed: a Veo release citing video benchmarks sits beside a GPT release citing coding ones, and a text benchmark's share of recent releases is measured against both.
//
// Filtering that apart needs a fact nobody had. There is no model type in the data, and the two ways of guessing one both fail. Guessing from the model's NAME keeps GPT-4 and Gemini as language models and drops Veo, which sounds right until you count: 216 of the 628 releases such a rule keeps, 34 per cent, cite vision or speech benchmarks anyway, because the frontier language models read images. Guessing from the benchmarks a release CITED is worse and circular, and it was measured too: it calls GPT-4 a knowledge model and LLaMA a reasoning model, because that is whichever subject each happened to report most, and then using that label to hide benchmarks would hide the very benchmarks that produced the label.
//
// So this is recorded rather than derived. The research agent reads the source page and says what was released, the same way it says what was cited, and the value carries where it came from so a reader and a later maintainer can tell a fact from an inference.

/** The classes, in the order a chooser should offer them. */
export const MODALITIES = [
  { id: "language", name: "Language", blurb: "Generates text. Includes models that also read images or audio, because a multimodal LLM is still a language model." },
  { id: "image", name: "Image generation", blurb: "Generates or edits still images." },
  { id: "video", name: "Video generation", blurb: "Generates or edits video." },
  { id: "speech", name: "Speech and audio", blurb: "Recognition, synthesis, translation or understanding of audio. Not a language model that happens to accept audio." },
  { id: "embedding", name: "Embedding and retrieval", blurb: "Produces vectors rather than text. Includes rerankers." },
  { id: "vision", name: "Vision", blurb: "Understands images or video without generating text as its product, such as a segmentation or perception model." },
  { id: "robotics", name: "Robotics and world models", blurb: "Acts in or predicts a physical environment." },
  { id: "other", name: "Other", blurb: "None of the above, including weather, biology and protein models." },
];

export const MODALITY_IDS = MODALITIES.map((m) => m.id);
const VALID = new Set(MODALITY_IDS);

/** Where a value came from. A filter built on a guess should say so. */
export const SOURCES = new Set(["reported", "inferred"]);

/** True when `v` is a usable modality block: one or more known classes, no duplicates, and a stated provenance. A release that ships several models carries several classes, which is why this is a list rather than a single value: "Gemini 2.5 Pro and Veo 2" is one record and two kinds of model. */
export function isValidModality(v) {
  if (v == null) return true;                       // not yet classified is allowed
  if (typeof v !== "object" || Array.isArray(v)) return false;
  const { classes, source } = v;
  if (!Array.isArray(classes) || !classes.length || classes.length > 3) return false;
  if (new Set(classes).size !== classes.length) return false;
  if (!classes.every((c) => VALID.has(c))) return false;
  return SOURCES.has(source);
}

export const describeModality = () => MODALITY_IDS.join(", ");
