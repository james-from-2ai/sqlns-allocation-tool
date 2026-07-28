# Findings from auditing `SQ-LNS Allocation Tool.xlsx`

Audited 2026-07-27 against the file at `C:\Users\G09jb\Downloads\SQ-LNS Allocation Tool.xlsx`
(58 MB on disk, ~495 MB of sheet XML, 45 sheets, 6 visible).

Every claim below was verified by recomputing from the workbook's own cached values.
Where a number is quoted, the recompute matched exactly unless stated otherwise.

## 1. The file is a Google Sheets export and does not recalculate in Excel

6,205 cells across 13 sheets hold `__xludf.DUMMYFUNCTION("...")`, which is what Google
writes on xlsx export for functions Excel does not have. These cells carry a frozen
cached value and no working formula.

| Sheet | Frozen cells | Visible to users |
|---|---|---|
| `MDF_Allocation_Wards_KSZ` | 2,262 | no |
| `MDF_Allocation_Wards_BAY` | 2,154 | no |
| `State-level Allocation` | 404 | **yes** |
| `State summary LGA level` | 388 | feeds Strategy Comparison |
| `State summary Ward level` | 388 | feeds Strategy Comparison |
| `LGA summary Ward level` | 270 | no |
| `LGA summary LGA level` | 270 | no |
| `Source UNICEF wasting data` | 36 | no |
| `CEA inputs` | 20 | no |
| `Jan 7 plan` | 9 | no |
| `Allocation Strategy Outputs` | 2 | **yes** |
| `NEW UNICEF_Allocation_Wards` | 1 | no |
| `NEW ANRiN_Allocation_Wards` | 1 | no |

Google-only functions involved: `COUNTUNIQUEIFS` (308 cells), `SPARKLINE` (148),
plus `AVERAGE` (105), `TRANSPOSE` (45), `FILTER` (4), `REDUCE` (1) in wrapped forms.

Consequence: the authoritative artifact is the Google Sheet, not this file. The xlsx is a
lossy snapshot. It is still a valid *specification*, and its cached values are a valid
regression target, which is how this rebuild uses it.

## 2. The Quantification Tool is broken in the export (not in the Google Sheet)

All 705 cross-sheet ranges on `Quantification Tool` are bounded to rows `3:92`. The real
data extent is rows 3 to 9686 (9,684 wards) and 3 to 776 (774 LGAs). Rows 3 to 92 of
`Ward Data & Calcs (Quantificati` contain Abia wards only.

Verified against two cells, with the state selector on Jigawa:

| Cell | Meaning | Cached | Full-range recompute | As-written `3:92` |
|---|---|---|---|---|
| `E31` | cartons needed, by risk category | 69,594 | **69,594** | 0 |
| `E53` | cartons needed, by threshold | 184,868 | **184,868** | 0 |

The cached values equal the full-range answer, so the live Google Sheet evaluates these
over the full column. The bounded ranges are an export artifact. Recalculate this file in
Excel and the entire Quantification Tool collapses to zero.

This sheet is the only one in the workbook with the `:92` truncation signature.

## 3. Risk category 1.3 is misclassified, and this bug is live in the Google Sheet

The risk-category formula (`Ward Data & Calcs (Allocation)` column O and its three
siblings) contains a dangling relative reference. Intended:

    IF(AND(J3>='Hard-coded Inputs'!$C$106, OR(K3>='Hard-coded Inputs'!$D$106, L3>=...$E$106)), 1.3, ...)

Actual, in row 3:

    IF(AND(J3>='Hard-coded Inputs'!$C$106, OR(K3>='Hard-coded Inputs'!$D506,  L3>=...$E$106)), 1.3, ...)

`$D$106` (the value 30, the stunting threshold for level 1.3) was written as `$D506`. The
missing row anchor makes it walk down one row per data row: row 3 reads `D506`, row 4
reads `D507`, row 5 reads `D508`, and so on. Every one of those target cells is empty.

An empty cell in a numeric comparison evaluates as zero, so `K >= <empty>` becomes
`K >= 0`, which is always true for a prevalence. The level 1.3 test therefore degrades
from

    U5MR >= 100 AND (stunting >= 30 OR wasting >= 15)

to

    U5MR >= 100

Scope: 10,458 affected cells, being every risk-category cell in the workbook. There are
zero uses of the correct `$D$106`.

| Sheet | Dangling refs | Correct refs |
|---|---|---|
| `Ward Data & Calcs (Allocation)` | 9,684 | 0 |
| `Ward Data & Calcs (Quantificati` | 9,684 | 0 |
| `LGA Data & Calcs (Allocation)` | 774 | 0 |
| `LGA Data & Calcs (Quantificatio` | 774 | 0 |

Unlike finding 2, this one is **not** an export artifact. The cached risk categories match
the buggy rule in 100% of rows (0 mismatches out of 10,458), which proves the live Google
Sheet computes it this way too.

Impact, recomputed both ways:

| Level | Misclassified | Share | Detail |
|---|---|---|---|
| Ward | 232 of 9,684 | 2.4% | 155 rows should be "Medium", 77 should be "High" |
| LGA | 14 of 774 | 1.8% | 7 should be "Medium", 7 should be "High" |

All errors run one direction: geographies are promoted **into** "Very High, Level 3" that
do not meet its stunting or wasting criteria. At ward level those rows hold 51,671 cartons
of estimated need.

This propagates to the threshold-based strategy, which allocates in rank order of risk
category, and to the Quantification Tool's target-by-risk-category screen.

## 4. A legacy sheet cluster is held in by nine cells

Nine cells on `Allocation Inputs` reference a dormant ANRiN/UNICEF modeling cluster:

| Cell | State | Points at | Value |
|---|---|---|---|
| `M11` | Akwa Ibom | `'ANRiN-UNICEF allocation inputs'!B6` | 0 |
| `M12` | Anambra | `!B7` | 0 |
| `M14` | Bayelsa | `!B9` | 0 |
| `M17` | Cross River | `!B12` | 0 |
| `M18` | Delta | `!B13` | 0 |
| `M20` | Edo | `!B15` | 0 |
| `M21` | Ekiti | `!B16` | 0 |
| `M22` | Enugu | `!B17` | 0 |
| `M23` | FCT | `!B18` | 0 |

These are 9 of the 37 per-state manual allocation cells. The other 28 states are plain
numbers. All nine currently evaluate to 0.

Dependency closure from the 6 visible sheets: 9 of 45 sheets are already unreachable.
Rewriting those 9 cells as literal `0` detaches 13 sheets totaling 165 MB of the 495 MB of
sheet XML, about 33%.

The remaining 32 sheets are load-bearing while Excel is the engine, and the largest are
exactly where the math lives: `Ward Data & Calcs` x2 at 125 MB, the four strategy sheets at
87 MB, `Matched Lists` at 25 MB.

## Handling in the rebuild

Findings 2 and 3 are genuine defects rather than modeling choices, so the engine
implements both rules behind a flag:

- `bugCompat: true` reproduces the workbook exactly, and is what the parity test asserts
  against the cached values.
- `bugCompat: false` applies the intended rule.

That keeps parity demonstrable while making the corrected numbers available, and leaves the
decision on which to publish as an explicit choice rather than an accident.
