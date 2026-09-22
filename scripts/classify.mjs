// Benchmark categories and suites.
//
// Every benchmark gets one primary category and optionally one secondary, never
// a third. Two is the observed ceiling: of 2,188 benchmarks, 98 plausibly want
// a second category and one wanted a third, so the cap costs almost nothing and
// keeps the label readable.
//
// Two is also safe here because of what the trend measures. labs_by_quarter
// counts DISTINCT LABS, capped at twelve, not citations. A lab that cited
// SWE-bench Multilingual really did cite both a coding benchmark and a
// multilingual one, so both category lines may count it without inflating
// anything. Views that must total 100 per cent use the primary alone.
//
// Primary is what the benchmark tests, not the medium it arrives in. MathVista
// is mathematics delivered as diagrams, so Math primary and Vision secondary.
// SWE-bench Multilingual is still repo repair, so Coding primary.
//
// Rules run in order and the first match wins, so put the specific before the
// general: the coding rule must see "SWE-bench Multilingual" before the
// multilingual rule does. Anything unmatched is Other, which is a real answer
// and not a failure.

export const CATEGORIES = [
  { id: "coding",       name: "Coding",                 blurb: "Code generation, repair and repo-scale software engineering" },
  { id: "agentic",      name: "Agentic & computer use", blurb: "Tool use, browsing, GUI and OS control, multi-step work" },
  { id: "vision",       name: "Vision & documents",     blurb: "Images, charts, diagrams, OCR, video and screens" },
  { id: "math",         name: "Math",                   blurb: "Competition and formal mathematics" },
  { id: "science",      name: "Science",                blurb: "Physics, chemistry, biology and medicine" },
  { id: "knowledge",    name: "Knowledge & QA",         blurb: "Broad factual recall, exams and hallucination" },
  { id: "reasoning",    name: "Reasoning",              blurb: "Logic, commonsense and puzzles" },
  { id: "speech",       name: "Speech & audio",         blurb: "Recognition, speech translation and audio understanding" },
  { id: "multilingual", name: "Multilingual",           blurb: "Cross-language ability where the language is the point" },
  { id: "safety",       name: "Safety & security",      blurb: "Refusal, bias, jailbreaks and cyber-offence" },
  { id: "longctx",      name: "Long context",           blurb: "Retrieval and reasoning over very long inputs" },
  { id: "other",        name: "Other",                  blurb: "Does not fit the categories above" },
];

const RE = (s) => new RegExp(s, "i");

// [pattern, primary, secondary]
const RULES = [
  // Safety and security first: a hazardous-capability benchmark is about the
  // hazard even when its subject is biology or code.
  [RE("wmdp|jailbreak|\\bharm|toxic|refus|red.?team|xstest|\\bbbq\\b|stereotyp|sycoph|deception|\\bmask\\b|\\bbold\\b|csam|abuse|strongreject|advbench|agentharm|maliciou|persuas|moderation"), "safety", null],
  [RE("cyber|cybench|cyb.?scenario|cyscenario|exploit|\\bctf\\b|vulnerab|pentest|malware|\\bhack|intrusion|\\bcve\\b"), "safety", "coding"],
  [RE("\\bsafety\\b|guardrail|alignment|honest|frontier.?risk|dangerous|biorisk|bioweapon"), "safety", null],

  // Coding, before agentic and multilingual so hybrid names land here.
  [RE("swe.?bench|swebench|swe.?agent|swe.?gym|swe.?lancer|swe.?rebench|deepswe|frontierswe"), "coding", "agentic"],
  [RE("terminal.?bench|terminalbench"), "coding", "agentic"],
  [RE("humaneval|\\bmbpp|livecodebench|codeforces|leetcode|codecontest|\\bapps\\b|cruxeval|multipl.?e|polyglot|aider|bigcodebench|classeval|repobench|commitpack|ds.?1000|evalplus|mercury|bird.?sql|spider|text.?to.?sql|scicode|programbench|kernelbench|frontendbench|webdev|humanevalfim"), "coding", null],
  [RE("\\bcode\\b|coding|program(ming|bench)?\\b|compil|debug|refactor|unit.?test|pull.?request|\\brepo\\b|repositor|\\bsql\\b|\\bml.?e?.?bench|kaggle"), "coding", null],

  // Agentic and computer use.
  [RE("osworld|windowsagent|androidworld|webarena|webvoyager|mind2web|screenspot|gui.?agent|computer.?use|browser.?use|\\bosuniverse"), "agentic", "vision"],
  [RE("tau.?bench|\\btau\\d|τ|bfcl|toolbench|toolllm|toolathlon|api.?bank|gorilla|\\bmcp|function.?call|clawEval|claw.?bench"), "agentic", null],
  [RE("browsecomp|deep.?research|deep.?search|\\bgaia\\b|assistantbench|websailor|search.?arena|\\bbrowse|\\bframes\\b"), "agentic", null],
  [RE("gdpval|automationbench|officeqa|workflow|\\bcrm\\b|vending|travel.?plan|agentbench|agent.?arena|agents?.?last|agentic|\\bagent|jobbench|briefcase|apex.?agent|\\bgdp\\b"), "agentic", null],

  // Math, before multilingual and vision so MGSM and MathVista land here.
  [RE("mathvista|mathvision|mathverse|math.?vqa|geometry3k|\\bgeoqa|dynamath|we.?math"), "math", "vision"],
  [RE("\\bmgsm\\b|multilingual.?grade|\\bcmath\\b"), "math", "multilingual"],
  [RE("\\baime\\b|\\bhmmt\\b|\\bimo\\b|putnam|olympiad|matharena|frontiermath|omni.?math|minerva|\\bgsm|math.?500|\\bmath|algebra|arithmetic|geometry|calculus|number.?theor|combinatoric|theorem|\\bproof|\\blean\\b|minif2f|\\baimo"), "math", null],

  // Science and medicine.
  [RE("\\bgpqa|supergpqa|critpt|lab.?bench|scibench|scienceqa|chembench|protein|genom|astro|materials|\\bvct\\b"), "science", null],
  [RE("medqa|medmcqa|pubmed|usmle|clinic|\\bmedic|health|patient|radiolog|nursing|healthbench|\\bmmlu.?med"), "science", null],
  [RE("physic|chemistr|biolog|\\bscience|scientif|\\bstem\\b"), "science", null],

  // Long context, before knowledge and vision so long-document QA lands here.
  [RE("long.?video|longvideobench|mmlongbench|long.?doc|\\blvbench"), "longctx", "vision"],
  [RE("needle|haystack|\\bruler\\b|\\bmrcr\\b|long.?context|longbench|infinitebench|\\bloft\\b|nolima|repoqa|\\blcr\\b|128k|\\b1m\\b|graphwalks|lambada"), "longctx", null],

  // Vision, documents, video.
  [RE("mmmu|\\bai2d\\b|chartqa|charxiv|chartograph|docvqa|infovqa|omnidoc|\\bocr|infographic|\\bvqa|textvqa|okvqa|\\bgqa\\b|\\bcoco\\b|refcoco|nocaps|flickr|\\bpope\\b|blink|realworldqa|zerobench|cv.?bench|erqa|mmbench|mmstar|mmvet|\\bmme\\b|seedbench|hallusion|countbench|geneval|drawbench|\\bmmvu\\b|\\bmvbench|motionbench|vsi.?bench|embspatial|egoschema|charades|caption|visual|vision|\\bimage|\\bvideo|screen|diagram|\\bchart|document.?understand|spatial|\\bposter"), "vision", null],

  // Speech and audio.
  [RE("librispeech|fleurs|aishell|covost|voxpopuli|\\basr\\b|speech|\\baudio|voice|\\btts\\b|whisper|acoustic|\\bmusic|\\bsound|\\bmmau\\b|\\bmmsu\\b"), "speech", null],

  // Multilingual.
  [RE("mmmlu|gmmlu|global.?mmlu|multiling|\\bflores|xquad|tydi|belebele|m3exam|xcopa|xnli|\\bwmt\\b|translat|include|cluewsc|alignbench|chinese|korean|japanese|arabic|hindi|indic|african|swahili|\\bzh\\b"), "multilingual", null],

  // Instruction following folds into reasoning: 13 benchmarks and 25 citations
  // did not earn a category of their own.
  [RE("ifeval|ifbench|instruction.?follow|multichallenge|\\bcollie\\b|format.?follow"), "reasoning", null],

  // Knowledge and exams.
  [RE("\\bmmlu|\\bhle\\b|humanity.?s.?last|simpleqa|triviaqa|natural.?question|openbookqa|\\bboolq|truthfulqa|freshqa|\\bnq\\b|agieval|\\bc.?eval\\b|cmmlu|gaokao|\\bexam|\\bbar.?exam|\\bmbe\\b|arena.?hard|mt.?bench|alpacaeval|chatbot.?arena|lmarena|\\bmteb\\b|\\bquiz|knowledge|\\bqa\\b"), "knowledge", null],

  // Reasoning. The list used to end in \bbench\b, which is not a reasoning
  // word, it is the word almost every benchmark is named after. Because this is
  // the last rule, that one alternative was catching everything no earlier rule
  // had claimed and labelling it reasoning instead of letting it fall through to
  // "other": 76 of the 135 benchmarks in the category were there for no reason
  // but their own name. BioLP-Bench is biology, DPG-Bench is image generation,
  // SEC-Bench Pro is security and Reward Bench is reward models. "Other" is a
  // statement that the rules have no opinion, which is true and which the
  // category filter can show honestly. "Reasoning" was a claim, and a wrong one.
  [RE("\\bbbh\\b|big.?bench|hellaswag|winogrande|arc.?agi|\\barc\\b|arc.?c|arc.?e|ai2.?reasoning|piqa|siqa|\\bcopa\\b|commonsense|\\bdrop\\b|\\banli\\b|\\brace\\b|logiqa|zebra|\\bmusr\\b|puzzle|riddle|sudoku|planning|\\blogic|reasoning|\\bcot\\b|multi.?step"), "reasoning", null],
];

/** The one lookup key. Everything that has to decide whether two spellings name
 *  the same benchmark goes through this: aliases, exclusions, suites and the
 *  reviewed category overrides.
 *
 *  Transliteration has to happen before the strip, or the strip eats the only
 *  thing telling two benchmarks apart. It used to run without it, so tau, tau
 *  squared and tau cubed all keyed as "bench" and three separate evaluations
 *  were counted as one; "Tau squared Bench" landed on tau-bench, and
 *  "tau-voice Bench" merged into VoiceBench, which has nothing to do with it.
 *  Every one of those was a silent merge of the kind normalize.mjs cannot
 *  detect, because a merge looks the same whether or not it is right. */
export const flatKey = (s) =>
  s.toLowerCase()
    .replace(/τ/g, "tau")
    .replace(/[¹₁]/g, "1").replace(/[²₂]/g, "2").replace(/[³₃]/g, "3")
    // Labs write the same version four ways and the strip kept them apart: "DeepSWE 1.1", "DeepSWE v1.1" and "DeepSWE (v1.1)" became deepswe11, deepswe11 and deepswev11, so one benchmark sat in the registry as a three-lab row beside a five-lab row.
    //
    // The first attempt at this asked for a word boundary before the v, and that was checked only for the merges it caused. It also caused splits, which nobody looked for: "VQAv2" keeps its v because the v is glued to the A, while "VQA v2" and "VQA-v2" lose theirs, so a benchmark seven labs cite was torn into vqav2 and vqa2. Six groups went that way. A key function has to be checked in both directions, because a split is as silent as a merge and neither one announces itself.
    //
    // So: drop the v wherever a digit follows it, and also across a space, but only when the v does not continue a word. "HMMT Nov 25" needs that last clause or November becomes "no". NLVR2 is safe without it, since its v is followed by an r. Over all 2,773 spellings in the release files this merges eight groups, every one a version of itself, and splits nothing.
    .replace(/(?<![a-z])v\s+(?=\d)|v(?=\d)/g, "")
    .replace(/[^a-z0-9]/g, "")
    .replace(/20(\d\d)$/, "$1");

// A reviewed assignment beats a rule. Names like V*, Seal-0 and QuALITY carry
// no word any pattern could match, and this is also where the research agent's
// proposals land once a human has looked at them.
export function classify(name, overrides = {}) {
  const o = overrides[flatKey(name)];
  if (o) return o.slice(0, 2);
  for (const [re, primary, secondary] of RULES) {
    if (re.test(name)) return secondary ? [primary, secondary] : [primary];
  }
  return ["other"];
}

export function suiteOf(name, suites) {
  const k = flatKey(name);
  for (const s of suites) {
    if (s.not?.some((n) => k.startsWith(n))) continue;
    if (s.starts?.some((p) => k.startsWith(p))) return s.id;
    if (s.has?.some((p) => k.includes(p))) return s.id;
  }
  return null;
}
