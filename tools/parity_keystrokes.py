"""Print the exact cell entries to type into the Google Sheet for a scenario.

    python tools/parity_keystrokes.py <scenario_name>

Four blocks, each preceded by the Name Box target. Generated rather than
transcribed so the sheet cannot silently drift from what the Excel side was
given. Percentages go in as plain decimals: typing "75%" into F9 turns the cell
into text and the model then reads no number at all.
"""

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCEN = os.path.join(ROOT, "tools", "parity_scenarios.json")
BASE = os.path.join(ROOT, "site", "data", "base.json")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    with open(SCEN, encoding="utf8") as fh:
        scenarios = {s["name"]: s for s in json.load(fh)}
    sc = scenarios.get(sys.argv[1])
    if not sc:
        sys.exit(f"unknown scenario; have {sorted(scenarios)}")
    with open(BASE, encoding="utf8") as fh:
        states = json.load(fh)["states"]

    manual = sc.get("manual") or {}
    manual_total = sum(manual.values())

    blocks = [
        ("F5", [sc["total_cartons"], sc["age_range"], sc["duration"],
                sc["enroll"], sc["coverage_cap"]]),
        ("F12", [sc["level"], manual_total]),
        ("F21", list(sc["thresh"])),
        ("M9", [manual.get(st, 0) for st in states]),
    ]
    print(f"# {sc['name']}: {sc['note']}")
    print(f"# manual total {manual_total:,} across {len(manual)} state(s)")
    for ref, vals in blocks:
        print(f"\n--- Name Box: {ref}")
        print("\n".join(str(v) for v in vals))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
