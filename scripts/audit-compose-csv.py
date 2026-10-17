"""Audit all CSV rows locally; never import customer data into Git or model training.

python scripts/audit-compose-csv.py <cleaned_data.csv> <report.json>
Flags are review candidates, not an accuracy score. Only counts/row numbers leave
the source file; names, phone numbers and street addresses are not copied.
"""
import collections
import csv
import hashlib
import json
import re
import sys


def flags(row):
    source = (row["Exact Customer Requirement"] + " " + row["Context"]).lower()
    message = row["Composed Message"].lower()
    ask = re.split(r"could you kindly|can you tell me", message)[-1]
    out = []
    if re.search(r"\(requirements?\)|\{[^}]+\}", message):
        out.append("placeholder")
    if re.search(r"customer needs?:|service needed:", message):
        out.append("paste_label")
    if re.search(r"what issue|what problem|what.*wrong", ask) and re.search(
        r"not (?:cooling|closing|working|circulating)|isn.t cooling|frost|leak|off.track|broken|stopped", source
    ):
        out.append("possibly_answered_problem")
    if re.search(r"brand|which make", ask) and re.search(
        r"\b(lg|whirlpool|samsung|bosch|govee|ge profile|zline|wayne dalton|sears)\b", source
    ):
        out.append("possibly_answered_brand")
    if re.search(r"availability|what time|when.*available", ask) and re.search(
        r"\b(today|tonight|tomorrow|asap|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\d\s*[ap]m", source
    ):
        out.append("possibly_answered_timing")
    if re.search(r"share.*picture|send.*photo|share.*photo", ask) and re.search(
        r"picture below|photos? attached|attached (?:photos?|pictures?)|posted pictures|see (?:the )?(?:photo|picture)|pictures? (?:included|attached)", source
    ):
        out.append("photo_already_supplied")
    if re.search(r"pickup.*drop|pick.up.*drop", ask) and re.search(
        r"backyard|50 feet|into a moving van|same (?:house|property)|within (?:my|the) house", source
    ):
        out.append("same_site_move_routing")
    if "address" in ask and re.search(
        r"\b\d{1,6}\s+(?:[a-z]+\s+){1,4}(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|blvd|court|ct)\b", source
    ):
        out.append("possibly_answered_address")
    if re.search(r"let me know the size\b(?! of)|share the size\b(?! of)", ask):
        out.append("vague_size")
    if re.search(r"free (?:estimate|visit)|no (?:charge|cost)", message):
        out.append("unverified_free_offer")
    return out


if __name__ == "__main__":
    source, target = sys.argv[1:3]
    with open(source, encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    counts = collections.Counter()
    flagged = []
    seen = set()
    for index, row in enumerate(rows, start=2):
        issues = flags(row)
        counts.update(issues)
        signature = (row["Context"], row["Exact Customer Requirement"])
        seen.add(signature)
        if issues:
            flagged.append({"csvRow": index, "flags": issues})
    report = {
        "sourceSha256": hashlib.sha256(open(source, "rb").read()).hexdigest(),
        "rows": len(rows),
        "duplicates": len(rows) - len(seen),
        "blankMessages": sum(not row["Composed Message"].strip() for row in rows),
        "addressMessages": sum("address" in row["Composed Message"].lower() for row in rows),
        "flagCounts": dict(counts),
        "flaggedRows": flagged,
        "note": "Heuristic review candidates, not ground-truth labels or a noise-free score.",
    }
    with open(target, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    print(json.dumps({k: v for k, v in report.items() if k != "flaggedRows"}, indent=2))
