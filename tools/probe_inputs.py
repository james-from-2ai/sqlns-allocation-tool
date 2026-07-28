"""Find every formula that reads an Allocation Inputs cell, so the rebuild's
input mapping can be checked cell by cell rather than assumed.

    python tools/probe_inputs.py <workbook.xlsx> [cell ...]

Defaults to the user-input cells on that sheet. Prints, per cell, which sheets
reference it and how many times, with a couple of examples.
"""

import re
import sys
import zipfile
from collections import Counter

sys.path.insert(0, __file__.rsplit("\\", 1)[0])
import xlsxpeek  # noqa: E402

CELLS = ["F5", "F6", "F7", "F8", "F9", "F12", "F13", "F14",
         "F21", "F22", "F23", "M46"]


def main():
    path = sys.argv[1]
    cells = sys.argv[2:] or CELLS
    book = xlsxpeek.Book(path)

    per_sheet = {}
    for s in book.sheets:
        per_sheet[s["name"]] = book.formulas(s["name"]).split("\n")

    for cell in cells:
        col, row = re.match(r"([A-Z]+)(\d+)", cell).groups()
        # match $F$5, F5, $F5, F$5 preceded by the sheet reference or bare
        pat = re.compile(r"(?<![A-Z0-9_$])\$?" + col + r"\$?" + row + r"(?![0-9])")
        hits = Counter()
        examples = []
        for name, formulas in per_sheet.items():
            for f in formulas:
                if "Allocation Inputs" not in f and name != "Allocation Inputs":
                    continue
                if pat.search(f):
                    hits[name] += 1
                    if len(examples) < 2 and name != "Allocation Inputs":
                        examples.append(f"{name}: {f[:150]}")
        total = sum(hits.values())
        top = ", ".join(f"{k}={v}" for k, v in hits.most_common(6))
        print(f"\n{cell}  total {total}")
        if top:
            print(f"   {top}")
        for e in examples:
            print(f"   ex {e}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
