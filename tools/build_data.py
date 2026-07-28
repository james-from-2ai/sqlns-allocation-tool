"""Extract the static base data and constants from the SQ-LNS workbook into JSON.

Rerun this whenever the source workbook is updated:

    python tools/build_data.py

Outputs, all written to site/data/:
  base.json      constants, state and zone lists, 774 LGA rows, 9684 ward rows
  fixtures.json  the workbook's own input settings and cached outputs, used by
                 the parity test to prove the JS engine reproduces the sheet

Design notes
------------
The workbook resolves its per-geography data through 'Matched Lists', which is
25 MB of PROPER()/CONCATENATE name reconciliation between four source datasets
(NTD population units, ANU mortality and stunting estimates, UNICEF wasting
data, state-level anemia). Reimplementing that fuzzy matching would add risk for
no benefit, so this script reads the *already resolved* cached values out of the
calc sheets instead. Those columns depend only on static source data and one
constant, never on user inputs, which is what makes them safe to freeze.

Verified as input-independent before freezing: columns J, K, L, M, N are pure
INDEX/MATCH lookups into source sheets, and D is such a lookup multiplied by the
constant 'Hard-coded Inputs'!C36. See docs/FINDINGS.md.
"""

import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xlsxpeek import Book  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "site", "data")

WARD_SHEET = "Ward Data & Calcs (Allocation)"
LGA_SHEET = "LGA Data & Calcs (Allocation)"
WARD_ROWS = range(3, 9687)   # 9684 wards
LGA_ROWS = range(3, 777)     # 774 LGAs

# 'Ward Data & Calcs (Allocation)' column A holds "Fct" because Matched Lists
# applies PROPER(). The LGA sheet and the Allocation Inputs manual-allocation
# list both use "FCT". Excel's MATCH and SUMIF are case-insensitive so the
# workbook never notices, but JavaScript is case-sensitive. Canonicalize here.
# "Nassarawa" is the workbook's own spelling throughout and is kept as-is so the
# manual-allocation list keys still line up.
STATE_CANON = {"fct": "FCT"}


def canon_state(name):
    name = (name or "").strip()
    return STATE_CANON.get(name.lower(), name)


def num(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def read_grid(book, sheet, rows, cols):
    """Return {row: {col: value}} for the requested cells."""
    grid = collections.defaultdict(dict)
    for row, col, _formula, value in book.cells(sheet, rows=set(rows), cols=set(cols)):
        grid[row][col] = value
    return grid


def read_cells(book, sheet, refs):
    """Return {'F5': value} for a list of A1 refs on one sheet."""
    want = collections.defaultdict(set)
    for ref in refs:
        col = "".join(c for c in ref if c.isalpha())
        row = int("".join(c for c in ref if c.isdigit()))
        want[row].add(col)
    out = {}
    allcols = set().union(*want.values()) if want else set()
    for row, col, _f, value in book.cells(sheet, rows=set(want), cols=allcols):
        if col in want.get(row, ()):
            out[f"{col}{row}"] = value
    return out


def build_constants(book):
    """Pull the constants block, keyed by meaning rather than cell reference."""
    hc = read_cells(
        book,
        "Hard-coded Inputs",
        ["C2", "C5", "C6", "C10", "C15", "C16", "C25", "C36", "C37", "C38", "C39",
         "C42", "C43", "C44", "C48", "C53", "C58", "C63", "C69", "C70", "C79",
         "C87", "C94", "C111", "C112", "C116", "C117",
         "C104", "D104", "E104", "C105", "D105", "E105", "C106", "D106", "E106",
         "C107", "D107", "E107", "C108", "D108", "E108"],
    )
    return {
        "ngnPerUsd": num(hc["C2"]),                    # 1500
        "pricePerSachetUsd": num(hc["C5"]),            # 0.10
        "sachetsPerCarton": num(hc["C6"]),             # 600
        "sachetsPerChildPerYear": num(hc["C10"]),      # 365
        "nLgas": int(num(hc["C15"])),                  # 774
        "nWards": int(num(hc["C16"])),                 # 9684
        "deliveryCostPerChildUsd": num(hc["C25"]),     # 5
        "u5ShareOfPopulation": num(hc["C36"]),         # 0.147
        # proportion of the U5 population falling in each age range
        "ageRangeShare": {
            "6 to 23": num(hc["C37"]),                 # 0.278
            "6 to 11": num(hc["C38"]),                 # 0.095
            "6 to 18": num(hc["C39"]),                 # 0.20175
        },
        # number of monthly cohorts in each age range
        "ageRangeCohorts": {
            "6 to 23": num(hc["C42"]),                 # 18
            "6 to 18": num(hc["C43"]),                 # 13
            "6 to 11": num(hc["C44"]),                 # 6
        },
        # treatment effects; the workbook divides each by a take-up of 1.0
        # ("LATE methodology"), so the adjusted effect equals the raw estimate
        "effect": {
            "anemia": num(hc["C48"]),                  # 0.16
            "sam": num(hc["C53"]),                     # 0.31
            "stunting": num(hc["C58"]),                # 0.12
            "mortality": num(hc["C63"]),               # 0.24
        },
        "impactDiscount": {
            "wastage": num(hc["C116"]),                # 0.10
            "incompleteConsumption": num(hc["C117"]),  # 0.10
        },
        # DALY values per averted case, already discounted
        "daly": {
            "discountRate": num(hc["C69"]),            # 0.04
            "lifeExpectancy": num(hc["C70"]),          # 66.8
            "yldPerAnemiaCase": num(hc["C79"]),        # 0.03518493383
            "yldPerSamCase": num(hc["C87"]),           # 0.06590738825
            "yllPerDeath": num(hc["C94"]),             # 24.03129963
        },
        # risk category thresholds: [u5mr, stunting, wasting], all inclusive
        "riskThresholds": [
            {"level": "1.1", "label": "Very High, Level 1",
             "u5mr": num(hc["C104"]), "stunting": num(hc["D104"]), "wasting": num(hc["E104"])},
            {"level": "1.2", "label": "Very High, Level 2",
             "u5mr": num(hc["C105"]), "stunting": num(hc["D105"]), "wasting": num(hc["E105"])},
            {"level": "1.3", "label": "Very High, Level 3",
             "u5mr": num(hc["C106"]), "stunting": num(hc["D106"]), "wasting": num(hc["E106"])},
            {"level": "2", "label": "High",
             "u5mr": num(hc["C107"]), "stunting": num(hc["D107"]), "wasting": num(hc["E107"])},
            {"level": "3", "label": "Medium",
             "u5mr": num(hc["C108"]), "stunting": num(hc["D108"]), "wasting": num(hc["E108"])},
        ],
        "strategies": [
            {"id": "mortality", "label": "Prioritize preventing U2 deaths",
             "description": "Product is allocated according to rank order of under-5 mortality "
                            "rate, followed by rank order of stunting prevalence"},
            {"id": "stunting", "label": "Prioritize preventing stunting cases",
             "description": "Product is allocated according to rank order of stunting prevalence, "
                            "followed by rank order of under-5 mortality"},
            {"id": "threshold", "label": "Threshold-based strategy",
             "description": "Product is allocated to all locations meeting specified thresholds "
                            "for under-5 mortality, stunting prevalence, and wasting prevalence, "
                            "in rank order of risk category"},
            {"id": "equal", "label": "Equal distribution",
             "description": "Product is allocated proportionate to population size across all "
                            "locations"},
        ],
    }


def build_zones(book):
    """State to geopolitical zone, from 'Matched Lists' columns X and O."""
    pairs = collections.defaultdict(collections.Counter)
    grid = read_grid(book, "Matched Lists", range(2, 9686), {"O", "X"})
    for cells in grid.values():
        state, zone = cells.get("X"), cells.get("O")
        if state and zone:
            pairs[canon_state(state)][zone.title()] += 1
    zones = {}
    for state, counter in pairs.items():
        if len(counter) > 1:
            raise SystemExit(f"state {state} maps to multiple zones: {dict(counter)}")
        zones[state] = counter.most_common(1)[0][0]
    return zones


def build_ward_notes(book):
    """Data-quality flag per ward from 'Matched Lists' column AF."""
    notes = {}
    grid = read_grid(book, "Matched Lists", range(2, 9686), {"X", "Y", "Z", "AF"})
    for cells in grid.values():
        note = cells.get("AF")
        if not note:
            continue
        key = (canon_state(cells.get("X")), cells.get("Y"), cells.get("Z"))
        notes[key] = note
    return notes


def build_geographies(book, constants):
    """Ward and LGA base rows, taken from the calc sheets' resolved values."""
    u5_share = constants["u5ShareOfPopulation"]
    notes = build_ward_notes(book)

    cols = {"A", "B", "C", "D", "J", "K", "L", "M", "N"}
    wards = []
    ward_grid = read_grid(book, WARD_SHEET, WARD_ROWS, cols)
    for row in sorted(ward_grid):
        c = ward_grid[row]
        state = canon_state(c.get("A"))
        lga, ward = c.get("B"), c.get("C")
        if not (state and lga and ward):
            continue
        wards.append({
            "state": state, "lga": lga, "ward": ward,
            "popTotal": num(c.get("D")) / u5_share,
            "u5mr": num(c.get("J")), "stunting": num(c.get("K")),
            "wasting": num(c.get("L")), "sam": num(c.get("M")),
            "anemia": num(c.get("N")),
            "estimated": (state, lga, ward) in notes,
        })

    lgas = []
    lga_cols = cols | {"C"}
    lga_grid = read_grid(book, LGA_SHEET, LGA_ROWS, lga_cols)
    for row in sorted(lga_grid):
        c = lga_grid[row]
        state = canon_state(c.get("A"))
        lga = c.get("B")
        if not (state and lga):
            continue
        lgas.append({
            "state": state, "lga": lga, "nWards": int(num(c.get("C"))),
            "popTotal": num(c.get("D")) / u5_share,
            "u5mr": num(c.get("J")), "stunting": num(c.get("K")),
            "wasting": num(c.get("L")), "sam": num(c.get("M")),
            "anemia": num(c.get("N")),
        })
    return wards, lgas


def build_fixtures(book):
    """The workbook's saved inputs and cached outputs, for the parity test."""
    inputs = read_cells(
        book, "Allocation Inputs",
        ["F5", "F6", "F7", "F8", "F9", "F12", "F13", "F14", "F21", "F22", "F23",
         "G21", "H21", "G22", "H22", "G23", "H23"],
    )
    manual_grid = read_grid(book, "Allocation Inputs", range(9, 46), {"L", "M"})
    manual = {}
    for cells in manual_grid.values():
        if cells.get("L"):
            manual[canon_state(cells["L"])] = num(cells.get("M"))

    quant = read_cells(
        book, "Quantification Tool",
        ["F5", "F6", "F7", "F8", "F9", "F12", "F13", "D18",
         "E23", "E24", "E25", "E26", "E27", "G47", "G48", "G49", "E64", "E65",
         "E31", "E32", "E33", "E34", "E35", "E36", "E37", "E38", "E39", "E40", "E41",
         "E53", "E54", "E55", "E56", "E57", "E58",
         "J53", "J54", "J55", "J56", "J57"],
    )

    comparison_rows = read_grid(
        book, "Allocation Strategy Comparison", list(range(6, 10)) + list(range(47, 51)),
        set("CDEFGHIJKLM"),
    )

    # Row-level expected values straight off the calc sheets. This is the
    # strongest parity target: every derived column for all 9684 wards.
    derived = {}
    for label, sheet, rows in (("ward", WARD_SHEET, WARD_ROWS), ("lga", LGA_SHEET, LGA_ROWS)):
        # D..X are the derived columns; Y..AC are the four strategies' carton
        # allocations plus the selected-strategy column.
        cols = set("DEFGHIJKLMNOPQRSTUVWXY") | {"Z", "AA", "AB", "AC"}
        grid = read_grid(book, sheet, rows, cols | {"A", "B", "C"})
        out = []
        for row in sorted(grid):
            c = grid[row]
            if not c.get("A"):
                continue
            rec = {"state": canon_state(c.get("A")), "lga": c.get("B")}
            if label == "ward":
                rec["ward"] = c.get("C")
            for col in sorted(cols):
                rec[col] = c.get(col)
            out.append(rec)
        derived[label] = out

    return {
        "note": "Cached values from the workbook at its saved input settings. "
                "Generated by tools/build_data.py; do not hand-edit.",
        "allocationInputs": inputs,
        "manualAllocation": manual,
        "quantificationTool": quant,
        "strategyComparison": {f"{c}{r}": v
                               for r, cells in comparison_rows.items()
                               for c, v in cells.items()},
        "derived": derived,
    }


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    book = Book()

    print("reading constants ...")
    constants = build_constants(book)
    print("reading zones ...")
    zones = build_zones(book)
    print("reading ward and LGA base data ...")
    wards, lgas = build_geographies(book, constants)

    if len(wards) != constants["nWards"]:
        print(f"  WARNING: {len(wards)} ward rows but constants say {constants['nWards']}")
    if len(lgas) != constants["nLgas"]:
        print(f"  WARNING: {len(lgas)} LGA rows but constants say {constants['nLgas']}")

    states = sorted({w["state"] for w in wards})
    base = {
        "note": "Static base data extracted from 'SQ-LNS Allocation Tool.xlsx'. "
                "Generated by tools/build_data.py; do not hand-edit.",
        "constants": constants,
        "states": states,
        "zones": zones,
        "lgas": lgas,
        "wards": wards,
    }
    with open(os.path.join(OUT_DIR, "base.json"), "w", encoding="utf8") as fh:
        json.dump(base, fh, separators=(",", ":"))
    print(f"  wrote base.json: {len(states)} states, {len(lgas)} LGAs, {len(wards)} wards, "
          f"{sum(1 for w in wards if w['estimated'])} wards on LGA-level estimates")

    print("reading parity fixtures ...")
    fixtures = build_fixtures(book)
    with open(os.path.join(OUT_DIR, "fixtures.json"), "w", encoding="utf8") as fh:
        json.dump(fixtures, fh, separators=(",", ":"))
    print(f"  wrote fixtures.json: {len(fixtures['derived']['ward'])} ward rows, "
          f"{len(fixtures['derived']['lga'])} LGA rows of expected values")

    for name in ("base.json", "fixtures.json"):
        size = os.path.getsize(os.path.join(OUT_DIR, name)) / 1e6
        print(f"  {name}: {size:.2f} MB")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
