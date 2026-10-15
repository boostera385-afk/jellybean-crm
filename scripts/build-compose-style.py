#!/usr/bin/env python3
"""Derive the CS compose house style from delivered leads.

Reads an export of delivered leads (the columns produced by the delivered-leads
export: Customer Name, Context, Exact Customer Requirement, Service, Composed
Message) and writes src/lib/compose-style.generated.json.

The composed messages are a fixed skeleton with three real variables, so this
parses them back into slots rather than treating the message as free text:

  Hi {name}, this is {sender}. I saw that you are looking for {SERVICE}.
  Could you kindly {REQ1} and {REQ2}, so I can {CLOSING}?

Sender and customer names are DISCARDED on purpose. The export contains 74
different agent names; keeping them would teach the model to invent one, and
the app already injects the real sender from the chosen template.

Usage:
  python3 scripts/build-compose-style.py <delivered-leads.csv> [out.json] [holdout.jsonl] [n]

Passing a holdout path reserves the last n parseable rows for evaluation and
excludes them from BOTH the canonical rules and the exemplar bank, so
scripts/eval-compose.ts scores against messages the prompt has never seen.
"""
import csv, json, re, sys, unicodedata
from collections import Counter, defaultdict

csv.field_size_limit(10**9)

# Message families observed in the export, most specific first.
FAMILIES = [
    re.compile(r"^Hi [^,]+, this is [^.]+?\. I saw that you are looking for (?P<svc>.+?)\. "
               r"Could you kindly (?P<reqs>.+?), so I can (?P<close>.+?)\?\s*$", re.S),
    re.compile(r"^Hi [^,]+, this is [^.]+?\. I had a conversation with you on \S+ regarding (?P<svc>.+?)\. "
               r"Could you kindly (?P<reqs>.+?), so I can (?P<close>.+?)\?\s*$", re.S),
    re.compile(r"^Hi [^,]+, we had a conversation on \S+ regarding (?P<svc>.+?)\. "
               r"Could you kindly (?P<reqs>.+?), so I can (?P<close>.+?)\?\s*$", re.S),
    re.compile(r"^Hi [^,]+, we had a conversation regarding (?P<svc>.+?)\. "
               r"Could you kindly (?P<reqs>.+?), so I can (?P<close>.+?)\?\s*$", re.S),
]

# Leading verbs the house style uses to open a requirement clause.
VERB_RE = re.compile(r"^(share|let me know|send me|send|tell me|tell|confirm|provide)\b\s*", re.I)
FILLER_RE = re.compile(r"\b(your|the|a|an|me|us)\b", re.I)


def clean(s):
    s = unicodedata.normalize("NFKC", (s or "")).replace(" ", " ")
    return re.sub(r"\s+", " ", s).strip()


def split_reqs(text):
    """Split the requirement clause on its final ' and '.

    The second clause frequently reuses the first clause's verb ("let me know X
    and your complete address"), so the raw second half is not a standalone
    phrase. intent_key() below folds those back together.
    """
    t = clean(text)
    i = t.rfind(" and ")
    if i <= 0:
        return [t]
    return [t[:i].strip(), t[i + 5:].strip()]


def intent_key(phrase):
    """Collapse surface wording to the underlying ask.

    'share your complete address' / 'your complete address' / 'complete address'
    all reduce to 'complete address', which is what lets the majority surface
    form be chosen per intent.
    """
    p = clean(phrase).lower().rstrip(".,;:")
    p = VERB_RE.sub("", p)
    p = FILLER_RE.sub(" ", p)
    return re.sub(r"[^a-z0-9 ]+", " ", p).strip()


def service_key(service):
    s = clean(service).lower()
    s = re.sub(r"\b(general|service|services|repair service)\b", " ", s)
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def main():
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else "src/lib/compose-style.generated.json"
    holdout_path = sys.argv[3] if len(sys.argv) > 3 else None
    holdout_n = int(sys.argv[4]) if len(sys.argv) > 4 else 500
    rows = list(csv.DictReader(open(src, newline="", encoding="utf-8", errors="replace")))

    parsed, skipped = [], 0
    closings, verbs = Counter(), Counter()
    intents = defaultdict(Counter)          # intent key -> surface form counts
    by_service = defaultdict(list)

    for r in rows:
        msg = clean(r.get("Composed Message"))
        ctx, exact = clean(r.get("Context")), clean(r.get("Exact Customer Requirement"))
        svc_in = clean(r.get("Service"))
        if not msg:
            continue
        g = next((m for m in (p.match(msg) for p in FAMILIES) if m), None)
        if not g:
            skipped += 1
            continue
        reqs = split_reqs(g.group("reqs"))
        closings[clean(g.group("close"))] += 1
        for p in reqs:
            if p:
                intents[intent_key(p)][p] += 1
        mv = VERB_RE.match(reqs[0] or "")
        if mv:
            verbs[mv.group(1).lower()] += 1
        rec = {"ctx": ctx, "exact": exact, "svc_in": svc_in,
               "close": clean(g.group("close")),
               "svc": clean(g.group("svc")),
               "r1": reqs[0] if reqs else "",
               "r2": reqs[1] if len(reqs) > 1 else ""}
        parsed.append(rec)
        by_service[service_key(svc_in)].append(rec)

    # Reserve the evaluation rows BEFORE deriving anything, so the exemplars and
    # the canonical rules cannot leak into the scores.
    holdout = []
    if holdout_path and holdout_n > 0 and len(parsed) > holdout_n:
        holdout = parsed[-holdout_n:]
        keep = set(id(r) for r in parsed[:-holdout_n])
        parsed = parsed[:-holdout_n]
        for k in list(by_service):
            by_service[k] = [r for r in by_service[k] if id(r) in keep]
            if not by_service[k]:
                del by_service[k]
        intents.clear(); closings.clear(); verbs.clear()
        for rec in parsed:
            for ph in (rec["r1"], rec["r2"]):
                if ph:
                    intents[intent_key(ph)][ph] += 1
            mv2 = VERB_RE.match(rec["r1"] or "")
            if mv2:
                verbs[mv2.group(1).lower()] += 1
        closings.update(rec["close"] for rec in parsed if rec["close"])

    # Majority surface form per intent, kept only where support is real.
    MIN_SUPPORT = 25
    canon = []
    for key, forms in intents.items():
        total = sum(forms.values())
        if total < MIN_SUPPORT or not key:
            continue
        # Prefer a form that carries its own verb, so the rule is usable alone.
        with_verb = {f: n for f, n in forms.items() if VERB_RE.match(f)}
        pool = with_verb or forms
        best = max(pool.items(), key=lambda kv: kv[1])[0]
        canon.append({"intent": key, "use": best, "n": total,
                      "variants": [f for f, _ in forms.most_common(6) if f != best][:5]})
    canon.sort(key=lambda c: -c["n"])

    # Exemplar bank: a few real examples for the most common services.
    TOP_SERVICES, PER_SERVICE, MAXLEN = 200, 3, 240
    ranked = sorted(by_service.items(), key=lambda kv: -len(kv[1]))[:TOP_SERVICES]
    exemplars = {}
    for key, recs in ranked:
        if not key:
            continue
        seen, picked = set(), []
        for rec in recs:
            sig = (rec["svc"], rec["r1"], rec["r2"])
            if sig in seen or not rec["ctx"]:
                continue
            seen.add(sig)
            picked.append({"context": rec["ctx"][:MAXLEN], "exact": rec["exact"][:MAXLEN],
                           "service": rec["svc_in"], "out": {"serviceContext": rec["svc"],
                                                             "requirement1": rec["r1"],
                                                             "requirement2": rec["r2"]}})
            if len(picked) >= PER_SERVICE:
                break
        if picked:
            exemplars[key] = picked

    generic = [e for k, _ in ranked[:8] if k in exemplars for e in exemplars[k][:1]]

    payload = {
        "_meta": {
            "source_rows": len(rows), "parsed_rows": len(parsed), "unparsed_rows": skipped,
            "note": "Generated by scripts/build-compose-style.py. Do not edit by hand.",
        },
        "closing": closings.most_common(1)[0][0] if closings else "",
        "closingShare": round(closings.most_common(1)[0][1] / max(len(parsed), 1), 4) if closings else 0,
        "preferredVerbs": [v for v, _ in verbs.most_common(4)],
        "canonicalRequirements": canon[:40],
        "exemplarsByService": exemplars,
        "genericExemplars": generic,
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1, sort_keys=True)

    print(f"rows={len(rows)} parsed={len(parsed)} unparsed={skipped} "
          f"({100*len(parsed)/max(len(rows),1):.1f}% parsed)")
    print(f"canonical intents={len(payload['canonicalRequirements'])} "
          f"services={len(exemplars)} closing={payload['closing']!r} "
          f"({payload['closingShare']*100:.1f}%)")
    if holdout:
        with open(holdout_path, "w", encoding="utf-8") as f:
            for rec in holdout:
                f.write(json.dumps({"context": rec["ctx"], "exact": rec["exact"],
                                    "service": rec["svc_in"],
                                    "expected": {"serviceContext": rec["svc"],
                                                 "requirement1": rec["r1"],
                                                 "requirement2": rec["r2"]}},
                                   ensure_ascii=False) + "\n")
        print(f"wrote {holdout_path} ({len(holdout)} held-out rows, excluded from the bank)")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
