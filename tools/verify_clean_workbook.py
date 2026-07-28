"""Open the rebuilt workbook in Excel, force a full recalculation, and check it.

    python tools/verify_clean_workbook.py

Requires Excel on the machine. This is the test that matters for the rebuild:
openpyxl only writes formula strings, it never evaluates them, so nothing short
of a real recalculation shows whether the file actually works.

Two scenarios are checked:

1. The original workbook's own saved settings (manual allocation on, all 10,000
   cartons reserved for Jigawa). Results must match the cached values in
   site/data/fixtures.json, which came out of the Google Sheet.
2. Manual allocation off, so the whole supply flows through the greedy pool.
   This exercises the sort-free SUMIFS reformulation, which the original's saved
   state left untested because its pool was empty.
"""

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOOK = os.path.join(ROOT, "dist", "SQ-LNS Allocation Tool (rebuilt).xlsx")
FIXTURES = os.path.join(ROOT, "site", "data", "fixtures.json")

try:
    import win32com.client as win32
except ImportError:
    sys.exit("needs pywin32: pip install pywin32")


def close(a, b, tol=1e-6):
    if b == 0:
        return abs(a) < 1e-6
    return abs(a - b) / abs(b) <= tol


def main():
    if not os.path.exists(BOOK):
        sys.exit(f"missing {BOOK}; run tools/build_clean_workbook.py first")
    with open(FIXTURES, encoding="utf8") as fh:
        fx = json.load(fh)

    # expected LGA-level allocations from the original, keyed state||lga
    expected = {}
    for row in fx["derived"]["lga"]:
        key = f'{row["state"]}||{row["lga"]}'
        expected[key] = {
            "need": float(row["I"] or 0),
            "deaths": float(row["Y"] or 0),
            "stunting": float(row["Z"] or 0),
            "threshold": float(row["AA"] or 0),
            "equal": float(row["AB"] or 0),
        }
    total_need = sum(v["need"] for v in expected.values())

    excel = win32.gencache.EnsureDispatch("Excel.Application")
    excel.Visible = False
    excel.DisplayAlerts = False
    failures = 0
    try:
        wb = excel.Workbooks.Open(BOOK)
        # Excel rejects this property until a workbook exists, so set it here.
        excel.Calculation = -4135  # xlCalculationManual
        inp = wb.Worksheets("Inputs")
        lga = wb.Worksheets("LGA model")

        def setup(use_manual, jigawa):
            inp.Range("C6").Value = 10000      # total cartons
            inp.Range("C7").Value = "6 to 23"
            inp.Range("C8").Value = 6          # duration
            inp.Range("C9").Value = 6          # enrollment
            inp.Range("C10").Value = 0.75      # coverage cap
            inp.Range("C11").Value = "LGAs"
            inp.Range("C15").Value = "No"      # thresholds off
            inp.Range("C21").Value = use_manual
            inp.Range("C26").Value = "No"      # reproduce the risk defect
            for r in range(6, 43):
                st = inp.Cells(r, 6).Value
                inp.Cells(r, 7).Value = jigawa if st == "Jigawa" else 0
            excel.CalculateFullRebuild()

        # column letters on the model sheet
        from clean_workbook_sheets import CN
        n_col, s_col, l_col = CN["need"], CN["state"], CN["lga"]
        acol = {"deaths": CN["alloc_d"], "stunting": CN["alloc_s"],
                "threshold": CN["alloc_t"], "equal": CN["alloc_e"]}

        def read(col):
            vals = lga.Range(f"{col}3:{col}776").Value
            return [float(v[0] or 0) for v in vals]

        print("Scenario 1: the original's saved settings (manual on, 10,000 to Jigawa)")
        setup("Yes", 10000)
        keys = [f"{s[0]}||{l[0]}" for s, l in
                zip(lga.Range(f"{s_col}3:{s_col}776").Value,
                    lga.Range(f"{l_col}3:{l_col}776").Value)]

        need = read(n_col)
        got_need = sum(need)
        ok = close(got_need, total_need)
        print(f"  cartons needed, national   {got_need:15,.0f} vs {total_need:15,.0f}  {'PASS' if ok else 'FAIL'}")
        failures += not ok

        for strategy, col in acol.items():
            got = read(col)
            worst, sample = 0.0, ""
            for k, g in zip(keys, got):
                want = expected.get(k, {}).get(strategy, 0.0)
                d = abs(g - want) if want == 0 else abs(g - want) / abs(want)
                if d > worst:
                    worst, sample = d, f"{k} got {g:,.2f} want {want:,.2f}"
            nz = sum(1 for g in got if g > 0)
            ok = worst <= 1e-6
            print(f"  {strategy:10s} total {sum(got):11,.2f}  {nz:4d} funded  "
                  f"worst err {worst:.2e}  {'PASS' if ok else 'FAIL  ' + sample}")
            failures += not ok

        print("\nScenario 2: manual allocation off, so the greedy pool takes all 10,000")
        setup("No", 0)
        for strategy, col in acol.items():
            got = read(col)
            nz = sum(1 for g in got if g > 0)
            total = sum(got)
            ok = close(total, 10000, 1e-6)
            # every funded geography must be capped at its own need
            over = sum(1 for g, nd in zip(got, need) if g > nd + 1e-6)
            print(f"  {strategy:10s} total {total:11,.2f}  {nz:4d} funded  "
                  f"over-need {over}  {'PASS' if ok and not over else 'FAIL'}")
            failures += (not ok) or bool(over)

        # the pool must go to the highest-priority geographies first
        rk = lga.Range("K3:K776").Value  # priority rank: deaths
        alloc = read(acol["deaths"])
        ranked = sorted(zip([float(x[0]) for x in rk], alloc), key=lambda t: t[0])
        funded_ranks = [r for r, a in ranked if a > 0]
        contiguous = funded_ranks == list(range(1, len(funded_ranks) + 1))
        print(f"  greedy order: funded ranks are 1..{len(funded_ranks)} with no gaps  "
              f"{'PASS' if contiguous else 'FAIL'}")
        failures += not contiguous

        wb.Close(SaveChanges=False)
    finally:
        excel.Quit()

    print("\n" + ("ALL CHECKS PASSED: the rebuilt workbook recalculates correctly in Excel."
                  if not failures else f"{failures} CHECK(S) FAILED"))
    sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
