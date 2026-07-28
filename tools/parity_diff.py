"""Compare the rebuilt workbook against the live Google Sheet, scenario by scenario.

    python tools/parity_diff.py [scenario_name ...]

Expects, in dist/parity_runs/, a matched pair per scenario and level:

    excel_<scenario>_<level>.csv   from tools/parity_excel_side.py
    sheet_<scenario>_<level>.csv   pulled from the sheet through the browser

Both sides are keyed on (state, LGA[, ward]) and summed within a key. The
grouping matters: seven ward keys occur twice in the source ward list, and the
sheet-side query has to group to get full numeric precision out of `gviz`, so
the Excel side groups the same way. No row is dropped on either side.

Reports, per value column, the worst relative and absolute residual and how many
geographies exceed the tolerance, so a real disagreement is distinguishable from
floating-point noise.
"""

import csv
import json
import os
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNS = os.path.join(ROOT, "dist", "parity_runs")
SCEN = os.path.join(ROOT, "tools", "parity_scenarios.json")

# The sheet-side query selects these, in this order, after the key columns.
SHEET_ORDER = ["need", "deaths_av", "stunt_av", "sam_av", "anemia_av", "dalys",
               "alloc_d", "alloc_s", "alloc_t", "alloc_e"]

# Allocations from the three prioritization strategies are whole cartons, as is
# cartons needed, so they are held to exact equality. Everything else is a
# floating-point quantity and gets a relative tolerance.
EXACT = {"need", "alloc_d", "alloc_s", "alloc_t"}
TOL = 1e-6


def norm(key):
    """Fold keys the way the spreadsheet's own lookups do.

    `MATCH`, `SUMIF` and `COUNTIF` are case-insensitive in both Excel and Google
    Sheets, and the source data is inconsistent: the ward sheet writes the
    capital territory `Fct` where the LGA sheet writes `FCT`. build_data.py
    canonicalizes to `FCT`, so comparing raw strings would report 62 phantom
    mismatches for a difference the model itself cannot see.
    """
    return tuple(k.strip().casefold() for k in key)


def load_excel(path, nkeys):
    rows = defaultdict(lambda: defaultdict(float))
    with open(path, encoding="utf8") as fh:
        r = csv.DictReader(fh)
        names = [n for n in r.fieldnames if n in SHEET_ORDER]
        for row in r:
            key = norm(tuple(row[k] for k in r.fieldnames[:nkeys]))
            for n in names:
                rows[key][n] += float(row[n])
    return rows


def load_sheet(path, nkeys):
    rows = defaultdict(lambda: defaultdict(float))
    with open(path, encoding="utf8") as fh:
        rd = csv.reader(fh)
        first = next(rd)  # gviz emits a label row for aggregate queries
        if first and first[-1].strip().startswith("sum"):
            pass
        else:
            fh.seek(0)
            rd = csv.reader(fh)
        for row in rd:
            if not row or not any(row):
                continue
            key = norm(tuple(row[:nkeys]))
            for i, n in enumerate(SHEET_ORDER):
                v = row[nkeys + i].strip()
                rows[key][n] += float(v) if v else 0.0
    return rows


def compare(level, excel, sheet):
    nkeys = 3 if level == "ward" else 2
    e, s = load_excel(excel, nkeys), load_sheet(sheet, nkeys)
    only_e, only_s = set(e) - set(s), set(s) - set(e)

    report = {"level": level, "keys_excel": len(e), "keys_sheet": len(s),
              "only_excel": sorted(only_e)[:5], "only_sheet": sorted(only_s)[:5],
              "n_only_excel": len(only_e), "n_only_sheet": len(only_s),
              "columns": {}, "ok": not only_e and not only_s}

    shared = set(e) & set(s)
    for n in SHEET_ORDER:
        worst_rel, worst_abs, over, exact_hits, sample = 0.0, 0.0, 0, 0, None
        tot_e = tot_s = 0.0
        for k in shared:
            a, b = e[k][n], s[k][n]
            tot_e += a
            tot_s += b
            d = abs(a - b)
            rel = d / abs(b) if b else d
            if a == b:
                exact_hits += 1
            if rel > worst_rel:
                worst_rel, worst_abs = rel, d
                sample = (k, a, b)
            worst_abs = max(worst_abs, d)
            bad = (a != b) if n in EXACT else (rel > TOL)
            if bad:
                over += 1
        report["columns"][n] = {
            "worst_rel": worst_rel, "worst_abs": worst_abs,
            "n_beyond_tol": over, "n_exact": exact_hits, "n": len(shared),
            "total_excel": tot_e, "total_sheet": tot_s,
            "sample": None if sample is None else
                      {"key": " / ".join(sample[0]), "excel": sample[1], "sheet": sample[2]},
            "mode": "exact" if n in EXACT else f"rel<={TOL:g}",
        }
        if over:
            report["ok"] = False
    return report


def main():
    with open(SCEN, encoding="utf8") as fh:
        scenarios = json.load(fh)
    only = set(sys.argv[1:])
    if only:
        scenarios = [s for s in scenarios if s["name"] in only]

    all_ok = True
    summary = []
    for sc in scenarios:
        name = sc["name"]
        print(f"\n{'=' * 78}\n{name}: {sc['note']}")
        print(f"  supply {sc['total_cartons']:,}  age {sc['age_range']}  "
              f"duration {sc['duration']}  enrollment {sc['enroll']}  "
              f"cap {sc['coverage_cap']:.0%}  thresholds {sc['thresh']}  "
              f"manual {sc.get('manual') or 'none'}")
        for level in ("lga", "ward"):
            ex = os.path.join(RUNS, f"excel_{name}_{level}.csv")
            sh = os.path.join(RUNS, f"sheet_{name}_{level}.csv")
            if not (os.path.exists(ex) and os.path.exists(sh)):
                print(f"  {level:4s} SKIPPED (missing {'excel' if not os.path.exists(ex) else 'sheet'} dump)")
                continue
            rep = compare(level, ex, sh)
            keys = f"{rep['keys_sheet']:,} keys"
            if rep["n_only_excel"] or rep["n_only_sheet"]:
                keys += f"  UNMATCHED excel-only {rep['n_only_excel']} sheet-only {rep['n_only_sheet']}"
            print(f"  {level:4s} {keys}")
            for n, c in rep["columns"].items():
                flag = "ok  " if not c["n_beyond_tol"] else "FAIL"
                print(f"    {flag} {n:10s} {c['mode']:12s} "
                      f"worst rel {c['worst_rel']:9.2e}  abs {c['worst_abs']:9.2e}  "
                      f"beyond tol {c['n_beyond_tol']:5d}  exact {c['n_exact']:5d}/{c['n']:5d}  "
                      f"total {c['total_sheet']:,.2f}")
                if c["n_beyond_tol"] and c["sample"]:
                    sm = c["sample"]
                    print(f"         worst: {sm['key']}  excel {sm['excel']!r}  sheet {sm['sheet']!r}")
            all_ok &= rep["ok"]
            summary.append((name, level, rep["ok"]))

    print(f"\n{'=' * 78}")
    for name, level, ok in summary:
        print(f"  {'PASS' if ok else 'FAIL'}  {name} {level}")

    distinct_ok = distinctness([sc["name"] for sc in scenarios])
    print("\n" + ("ALL SCENARIOS MATCH" if all_ok else "DIFFERENCES FOUND")
          + ("" if distinct_ok else "  (but see the distinctness warning above)"))
    sys.exit(0 if all_ok and distinct_ok else 1)


def distinctness(names):
    """Show that each scenario actually moved the answer.

    A suite where every scenario produced the same numbers would pass while
    testing almost nothing, so this counts how many geographies changed between
    consecutive scenarios. Any pair that is identical on every column is
    reported: it means an input never reached the sheet.
    """
    print(f"\n{'=' * 78}\nScenario distinctness (LGA level, count of geographies that changed)")
    loaded, ok = {}, True
    for n in names:
        p = os.path.join(RUNS, f"sheet_{n}_lga.csv")
        if os.path.exists(p):
            loaded[n] = load_sheet(p, 2)
    got = list(loaded)
    for a, b in zip(got, got[1:]):
        ka, kb = loaded[a], loaded[b]
        shared = set(ka) & set(kb)
        counts = {c: sum(1 for k in shared if abs(ka[k][c] - kb[k][c]) > 1e-9)
                  for c in SHEET_ORDER}
        moved = {c: v for c, v in counts.items() if v}
        if not moved:
            ok = False
            print(f"  WARNING {a} -> {b}: identical on every column")
        else:
            print(f"  {a} -> {b}: " + ", ".join(f"{c} {v}" for c, v in moved.items()))
    return ok


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
