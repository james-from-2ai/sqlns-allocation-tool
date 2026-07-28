"""Drive the rebuilt workbook through each scenario and dump its full results.

    python tools/parity_excel_side.py [scenario_name ...]

Reads tools/parity_scenarios.json, and for each scenario sets the Inputs sheet,
forces a full recalculation in Excel, and writes one row per geography to
dist/parity_runs/excel_<scenario>_<level>.csv, plus the Strategy comparison
block. tools/parity_diff.py then compares those files against the same
scenarios pulled from the live Google Sheet.

Excel is required. openpyxl only writes formula strings and never evaluates
them, so a real recalculation is the only way to learn what the file computes.
"""

import csv
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOOK = os.path.join(ROOT, "dist", "SQ-LNS Allocation Tool (rebuilt).xlsx")
SCEN = os.path.join(ROOT, "tools", "parity_scenarios.json")
OUT = os.path.join(ROOT, "dist", "parity_runs")

sys.path.insert(0, os.path.join(ROOT, "tools"))
from clean_workbook_sheets import letters, LGA_LAST, WARD_LAST  # noqa: E402

try:
    import win32com.client as win32
except ImportError:
    sys.exit("needs pywin32: pip install pywin32")

XL_MANUAL = -4135

# The Google Sheet's own column letters, for reference while reading the dumps.
# Both of its calc sheets share one layout: I need, T..X impact, Y..AC allocations.
SHEET_COLS = ["need", "risk", "deaths_av", "stunt_av", "sam_av", "anemia_av",
              "dalys", "alloc_d", "alloc_s", "alloc_t", "alloc_e", "alloc_sel"]

LEVELS = {
    "lga": {"sheet": "LGA model", "last": LGA_LAST, "ward": False},
    "ward": {"sheet": "Ward model", "last": WARD_LAST, "ward": True},
}


def col_index(ward):
    """Model-sheet header name to 1-based column index."""
    L = letters(ward)
    idx = {}
    for name, letter in L.items():
        n = 0
        for ch in letter:
            n = n * 26 + (ord(ch) - 64)
        idx[name] = n
    return idx


def apply_scenario(inp, sc, states):
    inp.Range("C6").Value = sc["total_cartons"]
    inp.Range("C7").Value = sc["age_range"]
    inp.Range("C8").Value = sc["duration"]
    inp.Range("C9").Value = sc["enroll"]
    inp.Range("C10").Value = sc["coverage_cap"]
    inp.Range("C11").Value = sc["level"]
    inp.Range("C12").Value = sc["strategy"]
    # Thresholds are always live in the Google Sheet, with zero meaning "no
    # filter", so the rebuild's toggle stays on and the values carry the test.
    inp.Range("C15").Value = "Yes"
    inp.Range("C16").Value = sc["thresh"][0]
    inp.Range("C17").Value = sc["thresh"][1]
    inp.Range("C18").Value = sc["thresh"][2]
    # Likewise the Google Sheet has no manual on/off switch: an all-zero table
    # is how manual allocation is turned off there.
    inp.Range("C21").Value = "Yes"
    inp.Range("C26").Value = "No"  # reproduce the risk-1.3 defect, as the sheet does
    manual = sc.get("manual") or {}
    unknown = set(manual) - set(states.values())
    if unknown:
        sys.exit(f"scenario {sc['name']}: unknown states {sorted(unknown)}")
    for r, st in states.items():
        inp.Cells(r, 7).Value = manual.get(st, 0)


def dump(ws, level, idx, path, ward):
    last = LEVELS[level]["last"]
    hi = max(idx.values())
    block = ws.Range(ws.Cells(3, 1), ws.Cells(last, hi)).Value

    keys = ["State", "LGA"] + (["Ward"] if ward else [])
    wanted = keys + [
        "Cartons needed", "Risk category",
        "Deaths averted", "Stunting averted", "SAM averted", "Anemia averted",
        "DALYs averted",
        "ALLOCATED: deaths", "ALLOCATED: stunting", "ALLOCATED: threshold",
        "ALLOCATED: equal", "ALLOCATED: selected strategy",
    ]
    cols = [idx[w] - 1 for w in wanted]
    out_names = keys + SHEET_COLS

    with open(path, "w", newline="", encoding="utf8") as fh:
        w = csv.writer(fh)
        w.writerow(out_names)
        for row in block:
            vals = []
            for j, c in enumerate(cols):
                v = row[c]
                if j < len(keys) or wanted[j] == "Risk category":
                    vals.append("" if v is None else str(v))
                else:
                    vals.append(repr(float(v or 0)))
            w.writerow(vals)
    return len(block)


def main():
    if not os.path.exists(BOOK):
        sys.exit(f"missing {BOOK}")
    with open(SCEN, encoding="utf8") as fh:
        scenarios = json.load(fh)
    only = set(sys.argv[1:])
    if only:
        scenarios = [s for s in scenarios if s["name"] in only]
        if not scenarios:
            sys.exit(f"no scenario matched {sorted(only)}")
    os.makedirs(OUT, exist_ok=True)

    excel = win32.gencache.EnsureDispatch("Excel.Application")
    excel.Visible = False
    excel.DisplayAlerts = False
    try:
        wb = excel.Workbooks.Open(BOOK)
        excel.Calculation = XL_MANUAL
        inp = wb.Worksheets("Inputs")
        cmp_ws = wb.Worksheets("Strategy comparison")
        out_ws = wb.Worksheets("Allocation outputs")

        states = {}
        for r in range(6, 60):
            v = inp.Cells(r, 6).Value
            if not v or str(v).strip().lower() == "total":
                break
            states[r] = str(v).strip()
        print(f"{len(states)} states on the Inputs sheet")

        idx = {"lga": col_index(False), "ward": col_index(True)}

        for sc in scenarios:
            print(f"\n=== {sc['name']}")
            t0 = time.time()
            apply_scenario(inp, sc, states)
            excel.CalculateFullRebuild()
            # A dependency-heavy rebuild can leave Excel still working; wait it out.
            while not excel.CalculationState == 0:
                time.sleep(0.5)
            print(f"  recalculated in {time.time() - t0:.1f}s")

            for level in ("lga", "ward"):
                path = os.path.join(OUT, f"excel_{sc['name']}_{level}.csv")
                n = dump(wb.Worksheets(LEVELS[level]["sheet"]), level,
                         idx[level], path, LEVELS[level]["ward"])
                print(f"  {level:4s} {n:6,d} rows -> {os.path.basename(path)}")

            block = cmp_ws.Range("B6:I9").Value
            nat = out_ws.Range("C6:C9").Value
            meta = {
                "scenario": sc,
                "comparison": [[("" if c is None else (repr(float(c))
                                 if not isinstance(c, str) else c)) for c in row]
                               for row in block],
                "comparison_columns": ["strategy", "cartons", "geographies_funded",
                                       "deaths_averted", "stunting_averted",
                                       "sam_averted", "anemia_averted", "dalys_averted"],
                "national": {
                    "cartons_allocated": float(nat[0][0] or 0),
                    "cartons_needed": float(nat[1][0] or 0),
                    "share_of_need": float(nat[2][0] or 0),
                    "geographies_funded": float(nat[3][0] or 0),
                },
            }
            with open(os.path.join(OUT, f"excel_{sc['name']}_meta.json"),
                      "w", encoding="utf8") as fh:
                json.dump(meta, fh, indent=1)
            print("  comparison block: " +
                  " | ".join(f"{row[0][:18]}={float(row[1] or 0):,.0f}" for row in block))

        wb.Close(SaveChanges=False)
    finally:
        excel.Quit()
    print("\ndone")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
