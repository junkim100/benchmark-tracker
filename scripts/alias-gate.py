#!/usr/bin/env python3
"""Second opinion on proposed benchmark alias merges.

The research agent reads a release page and proposes that a name it just saw is
a name we already track. Applying that is the one automated judgement in this
pipeline that permanently rewrites history: a merge changes lab_count,
first_seen, labs, labs_by_quarter and recent_share for BOTH benchmarks, and
normalize.mjs cannot detect a wrong one, because a merge is valid by
construction. It looks exactly like a correct merge.

So the proposal is put to a second, differently-trained model. The point is
independence rather than raw accuracy: asking the proposer to check itself
shares its errors, which is the failure mode worth avoiding.

Two questions, because one is not enough. Measured on eight pairs whose answers
are known, the categorical question alone called ARCADE a spelling of ARC at
0.77 confidence, which is exactly the trap this project's own comments warn
about. The safety question read 0.37 on that pair against 0.79 to 0.86 for
every correct merge, so the pair of gates caught what either alone would have
let through.

Fails closed. The delegation gate this borrows from fails open, because there
the cost of not delegating is only lost parallelism. Here the cost of a wrong
merge is silent data corruption, so anything unexpected, an unreachable API, a
missing key, a malformed answer, sends the candidate to review instead.

stdin:  [{"raw": str, "tracked": str, "reason": str, "lab": str}, ...]
stdout: [{..., "decision": "APPLY"|"SUITE"|"REVIEW", "gates": {...}, ...}, ...]
Always exits 0. A gate that can fail the pipeline is worse than no gate.
"""

import json
import os
import pathlib
import sys

# The choice must be this confident before a merge is written.
MIN_SAME_NAME = 0.85
# And the safety question must independently agree. ARCADE against ARC scored
# 0.77 on the choice and 0.37 here; correct merges scored 0.79 to 0.86.
MIN_MERGE_SAFE = 0.70
# A version is routed to the suite file rather than merged away.
MIN_VERSION = 0.60
REQUEST_TIMEOUT_SECONDS = 30


def review_all(candidates, reason):
    """Every candidate to review, with why. The fail-closed path."""
    return [
        {**c, "decision": "REVIEW", "unavailable": reason, "gates": {}, "probabilities": {}}
        for c in candidates
    ]


def load_key():
    """Env first, so CI only needs a secret. Falls back to the file the
    delegation gate uses, so a local run needs no setup."""
    if os.environ.get("TYPESAFE_API_KEY"):
        return True
    path = pathlib.Path.home() / ".config/typesafe/api_key"
    if path.is_file() and path.read_text().strip():
        os.environ["TYPESAFE_API_KEY"] = path.read_text().strip()
        return True
    return False


QUESTION_TEXT = {
    "same_name": (
        "The same single evaluation written two ways: abbreviation, punctuation, "
        "spacing, casing, an expanded acronym, or an abbreviated year. Merging "
        "them loses nothing."
    ),
    "version": (
        "Two versions, releases or named splits of one evaluation family, such as "
        "a numbered version or a named subset. They belong together as a suite "
        "but are not interchangeable names."
    ),
    "different": (
        "Two different evaluations that merely resemble each other, sharing a "
        "stem, prefix or naming convention. Merging them would conflate distinct "
        "benchmarks."
    ),
}


def main():
    try:
        candidates = json.load(sys.stdin)
    except Exception as exc:
        json.dump(review_all([], f"unreadable_input: {exc}"), sys.stdout)
        return
    if not candidates:
        json.dump([], sys.stdout)
        return

    try:
        from typesafe_sdk import Choice, Noul, TypeSafeClient
    except Exception as exc:
        json.dump(review_all(candidates, f"sdk_unavailable: {exc}"), sys.stdout)
        return

    if not load_key():
        json.dump(review_all(candidates, "no_api_key"), sys.stdout)
        return

    questions = {
        "relation": Choice(
            instructions=(
                "How do `candidate_name` and `tracked_name` relate, as names of AI "
                "evaluation benchmarks appearing in model release notes?"
            ),
            criteria=QUESTION_TEXT,
        ),
        "merge_is_safe": Noul(
            instructions=(
                "Would recording `candidate_name` and `tracked_name` as one "
                "benchmark be factually correct? Answer low if there is any real "
                "chance they are distinct evaluations, because a wrong merge "
                "silently corrupts every count derived from them and is very hard "
                "to notice afterwards."
            )
        ),
    }

    out = []
    try:
        with TypeSafeClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            for c in candidates:
                try:
                    r = client.system_one(
                        state={
                            "candidate_name": c.get("raw", ""),
                            "tracked_name": c.get("tracked", ""),
                            "reason_given_by_proposer": c.get("reason", ""),
                            "lab_that_published_it": c.get("lab", ""),
                            "domain": (
                                "AI model evaluation benchmarks cited in official "
                                "model releases"
                            ),
                        },
                        questions=questions,
                    )
                    rel = r.answers["relation"]
                    probs = dict(rel.probabilities)
                    safe = float(r.answers["merge_is_safe"].noul)
                    same_p = float(probs.get("same_name", 0.0))
                    ver_p = float(probs.get("version", 0.0))

                    # Each gate is reported so the summary can say which one
                    # decided, rather than leaving it to be inferred.
                    gates = {
                        "same_name_confident": same_p >= MIN_SAME_NAME,
                        "merge_is_safe": safe >= MIN_MERGE_SAFE,
                        "version_confident": ver_p >= MIN_VERSION,
                    }
                    if rel.choice == "same_name" and gates["same_name_confident"] and gates["merge_is_safe"]:
                        decision = "APPLY"
                    elif rel.choice == "version" and gates["version_confident"]:
                        decision = "SUITE"
                    else:
                        decision = "REVIEW"

                    out.append({
                        **c, "decision": decision, "relation": rel.choice,
                        "probabilities": probs, "merge_is_safe": safe, "gates": gates,
                    })
                except Exception as exc:
                    out.append({
                        **c, "decision": "REVIEW", "unavailable": f"call_failed: {exc}",
                        "gates": {}, "probabilities": {},
                    })
    except Exception as exc:
        json.dump(review_all(candidates, f"client_failed: {exc}"), sys.stdout)
        return

    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
