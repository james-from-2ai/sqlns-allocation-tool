"""Measure the original workbook against the rebuild.

    python tools/compare_workbooks.py

Everything reported here is counted from the two files, not estimated.
"""

import collections
import json
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOWNLOADS = os.path.join(os.path.expanduser("~"), "Downloads")

# The original export, resolved by xlsxpeek so both tools agree on which file
# is the baseline and SQLNS_WORKBOOK overrides it in one place.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import xlsxpeek  # noqa: E402

ORIGINAL = xlsxpeek.resolve(required=False)
REBUILT = os.path.join(ROOT, "dist", "SQ-LNS Allocation Tool (rebuilt).xlsx")

# Native Google Sheets sizes, from the Drive API. The xlsx export is much larger
# than the native document, so file size is only comparable format to format.
GOOGLE_NATIVE_BYTES = 19_655_667


def survey(path):
    z = zipfile.ZipFile(path)
    rels = z.read("xl/_rels/workbook.xml.rels").decode("utf8", "ignore")
    # Attribute order differs between Google's export and openpyxl's writer, so
    # pull Id and Target out of each element independently.
    rmap = {}
    for m in re.finditer(r"<Relationship\b([^>]*)/?>", rels):
        attrs = m.group(1)
        rid = re.search(r'Id="([^"]+)"', attrs)
        tgt = re.search(r'Target="([^"]+)"', attrs)
        if rid and tgt:
            rmap[rid.group(1)] = tgt.group(1).lstrip("/")
    wbx = z.read("xl/workbook.xml").decode("utf8", "ignore")

    sheets = []
    for m in re.finditer(r"<sheet\b([^>]*?)/?>", wbx):
        attr = m.group(1)
        nm = re.search(r'name="([^"]*)"', attr)
        rid = re.search(r'r:id="([^"]+)"', attr)
        if not (nm and rid and rid.group(1) in rmap):
            continue
        st = re.search(r'state="(\w+)"', attr)
        target = rmap[rid.group(1)]
        sheets.append((nm.group(1), st.group(1) if st else "visible",
                       target if target.startswith("xl/") else "xl/" + target))

    infos = {i.filename: i for i in z.infolist()}
    xml = formulas = cells = dummy = 0
    gfun = collections.Counter()
    for _nm, _st, p in sheets:
        info = infos.get(p)
        if info:
            xml += info.file_size
        text = z.read(p).decode("utf8", "ignore")
        formulas += text.count("<f")
        cells += text.count("<c ")
        dummy += text.count("DUMMYFUNCTION")
        for mm in re.finditer(r"DUMMYFUNCTION\(&quot;([A-Z_]+)", text):
            gfun[mm.group(1)] += 1

    return {
        "bytes": os.path.getsize(path),
        "sheets": len(sheets),
        "visible": sum(1 for s in sheets if s[1] == "visible"),
        "hidden": sum(1 for s in sheets if s[1] != "visible"),
        "xml": xml,
        "formulas": formulas,
        "cells": cells,
        "dummy": dummy,
        "gfun": dict(gfun),
    }


def main():
    if not ORIGINAL:
        sys.exit("could not find the original workbook in Downloads")
    print(f"original: {os.path.basename(ORIGINAL)}")
    print(f"rebuilt:  {os.path.basename(REBUILT)}\n")
    a, b = survey(ORIGINAL), survey(REBUILT)
    mb = lambda n: n / 1e6

    rows = [
        ("File size on disk", f"{mb(a['bytes']):,.1f} MB", f"{mb(b['bytes']):,.1f} MB",
         1 - b["bytes"] / a["bytes"]),
        ("Sheets, total", a["sheets"], b["sheets"], 1 - b["sheets"] / a["sheets"]),
        ("  of which visible", a["visible"], b["visible"], None),
        ("  of which hidden", a["hidden"], b["hidden"], None),
        ("Uncompressed sheet XML", f"{mb(a['xml']):,.0f} MB", f"{mb(b['xml']):,.0f} MB",
         1 - b["xml"] / a["xml"]),
        ("Populated cells", f"{a['cells']:,}", f"{b['cells']:,}", 1 - b["cells"] / a["cells"]),
        ("Formula cells", f"{a['formulas']:,}", f"{b['formulas']:,}",
         1 - b["formulas"] / a["formulas"]),
        ("Cells Excel cannot recalculate", f"{a['dummy']:,}", f"{b['dummy']:,}", None),
    ]

    print(f"{'':34s} {'ORIGINAL':>14s} {'REBUILT':>14s} {'CHANGE':>9s}")
    print("-" * 76)
    for lbl, x, y, pct in rows:
        change = f"-{pct * 100:.0f}%" if pct is not None else ""
        print(f"{lbl:34s} {str(x):>14s} {str(y):>14s} {change:>9s}")

    print()
    print("Google-only functions, original:", a["gfun"] or "none")
    print("Google-only functions, rebuilt: ", b["gfun"] or "none")
    print()
    print(f"For reference, as a native Google Sheet the original is "
          f"{mb(GOOGLE_NATIVE_BYTES):,.1f} MB. File size is only comparable format to "
          f"format, so quote the xlsx-to-xlsx figure above.")

    with open(os.path.join(ROOT, "docs", "comparison.json"), "w", encoding="utf8") as fh:
        json.dump({"original": a, "rebuilt": b}, fh, indent=1)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
