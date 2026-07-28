# SQ-LNS Allocation Tool

A static web version of the SQ-LNS allocation model for Nigeria, covering 9,684
wards and 774 LGAs across 37 states. Deploys to GitHub Pages, no backend.

## Why this is a port rather than a spreadsheet viewer

The original is a Google Sheet, exported as `SQ-LNS Allocation Tool.xlsx`
(58 MB, 45 sheets, ~495 MB of sheet XML). The intent was to keep Excel as the
calculation engine and build a nicer front end on top. An audit ruled that out:

- The xlsx **cannot recalculate**. 6,205 cells hold `__xludf.DUMMYFUNCTION`,
  Google-only functions frozen at their last cached value, including 404 cells
  on the user-facing `State-level Allocation` sheet.
- The whole `Quantification Tool` sheet is broken in the export, with all 705 of
  its cross-sheet ranges truncated to 90 of 9,684 rows.
- A static site cannot drive a Google Sheet anyway.

So the workbook is treated as the **specification**, and its cached values as a
regression target. `tools/parity_test.mjs` proves the port reproduces it.

Full audit, with the verification for each claim: [`docs/FINDINGS.md`](docs/FINDINGS.md).

## Two deliverables

1. **The static site** in `site/`, for GitHub Pages.
2. **A rebuilt workbook** at `dist/SQ-LNS Allocation Tool (rebuilt).xlsx`, for
   people who want to keep working in Excel. 8 visible sheets and 4.4 MB, down
   from 45 sheets and 58 MB, with the same functionality. It recalculates
   correctly, which the original does not.

## Layout

    site/
      data/base.json        constants, states, zones, 774 LGAs, 9,684 wards
      data/fixtures.json    workbook inputs and cached outputs, for the test
      js/engine.js          constants, derived columns, risk categorization
      js/allocation.js      the four allocation strategies
    tools/
      xlsxpeek.py               stream sheet XML from the workbook
      build_data.py             regenerate site/data/*.json from the workbook
      parity_test.mjs           assert the engine matches the workbook
      build_clean_workbook.py   generate the rebuilt xlsx
      clean_workbook_sheets.py  its non-model sheets
      verify_clean_workbook.py  recalculate the rebuild in Excel and check it
      parity_scenarios.json     the seven input scenarios
      parity_excel_side.py      drive the rebuild through each, dump every row
      parity_keystrokes.py      print the cell entries for the sheet side
      claim_download.py         file a dataset pulled from the sheet
      parity_diff.py            compare the two, report residuals
      probe_inputs.py           find every formula that reads a given input cell
    docs/
      FINDINGS.md           audit results
      PARITY.md             the rebuild vs the live sheet, seven scenarios
      spec-strategies.md    the allocation mechanism, formulas quoted

## Regenerating the data

Point `WORKBOOK` in `tools/xlsxpeek.py` at the source file, then:

```bash
python tools/build_data.py
```

## Rebuilding the clean workbook

```bash
python tools/build_clean_workbook.py
```

Then verify it actually recalculates. This needs Excel and `pywin32`, because
openpyxl writes formula strings without ever evaluating them:

```bash
python tools/verify_clean_workbook.py
```

It reproduces the original's cached allocations exactly (worst relative error
0 on the three prioritization strategies, 4.8e-10 on equal distribution), and
separately exercises the greedy pool that the original's saved state left idle.

## Running the parity test

```bash
node tools/parity_test.mjs
```

Current status: all checks pass. Every derived column for all 9,684 wards and
774 LGAs, and all four strategy allocations, match the workbook at its saved
settings. Residuals on floating-point columns are ~1e-9 relative, which is the
precision of Google's 10-significant-figure cached values, not a model
difference. Integer columns, risk categories, and the three prioritization
strategies match exactly.

This test covers **one** set of inputs, the workbook's saved state. To show the
two agree when the inputs change, see below.

## Proving the rebuild matches the live Google Sheet

[`docs/PARITY.md`](docs/PARITY.md) records a seven-scenario comparison against the
live sheet, varying supply, age range, duration, enrollment, coverage cap,
allocation level, thresholds, and the per-state manual reserve.

All 14 comparisons pass, being 7 scenarios at 2 levels. Cartons needed and the
three prioritization strategies agree **exactly** on all 774 LGAs and all 9,684
wards; the floating-point columns agree to ~1e-9 relative.

```bash
python tools/parity_excel_side.py     # drive the rebuild through each scenario
python tools/parity_diff.py           # compare against the sheet, report residuals
```

The sheet side needs a browser session, since the xlsx export cannot recalculate
and the live sheet is the only oracle that can be re-driven. `docs/PARITY.md` has
the full method, including the four ways the sheet silently rejects automated
input.

## Known defects in the source model

Two are reproduced behind a `bugCompat` flag, default `true`, so parity holds and
the corrected numbers are still available:

1. **Risk category 1.3 is over-assigned.** A dangling reference (`$D506` for
   `$D$106`) drops the stunting criterion, so the test degrades to
   `u5mr >= 100` alone. This one is live in the Google Sheet, not just the
   export. It misclassifies 232 of 9,684 wards and 14 of 774 LGAs, always
   promoting them into "Very High, Level 3".
2. **Quantification Tool range truncation**, an export artifact only.

Which behavior to publish is an open decision.
