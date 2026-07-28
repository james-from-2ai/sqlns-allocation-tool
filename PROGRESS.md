# Progress

Rebuild of the SQ-LNS Allocation Tool as a static site for GitHub Pages.

Source workbook: `C:\Users\G09jb\Downloads\SQ-LNS Allocation Tool.xlsx`
Google Sheet: https://docs.google.com/spreadsheets/d/1o8bjdsJaukcX3SJtSfSjXLb6MIjaWapLZhi7FOK2hd8/edit

## Decisions taken

- **Port the calculation to JavaScript**, rather than keeping Excel as the runtime
  engine. Forced by the audit: the xlsx cannot recalculate (see `docs/FINDINGS.md`),
  and a static site cannot drive a Google Sheet. The workbook stays the
  *specification* and its cached values are the regression target.
- **Repeatable build script** (`tools/build_data.py`) regenerates the JSON from the
  workbook, rather than a one-time hand extraction.
- Both workbook defects are reproduced behind a `bugCompat` flag so parity is
  provable and the corrected numbers are available. Which to publish is still an
  open decision for James.

## Done

- `tools/xlsxpeek.py` streams sheet XML from the 58 MB workbook. openpyxl is
  unusable here (~495 MB of XML, many minutes per load).
  Caveat found: it does not resolve **shared formulas** (`<f t="shared" si="N"/>`),
  which appear 87,154 times. Cells using them look value-only. Do not conclude a
  column is hardcoded from this tool alone.
- `docs/FINDINGS.md` records four audited findings, each verified by recompute.
- `tools/build_data.py` runs clean and produces:
  - `site/data/base.json` (1.8 MB): constants, 37 states, zone map, 774 LGAs,
    9,684 wards, 523 wards flagged as using LGA-level estimates.
  - `site/data/fixtures.json` (4.2 MB): the workbook's saved inputs and cached
    outputs, including every derived column for all ward and LGA rows.
- `site/js/engine.js`: constants handling, program parameters, risk
  categorization, derived columns D through X, impact proration. No DOM access,
  so it runs under Node for the parity test.

## Next, in order

1. **Allocation mechanism for the 4 strategies.** The critical unknown. Three
   subagents were mapping this and produced nothing before the process exited, so
   do it directly. Sheets: `Prioritize preventing U2 deaths`, `Prioritize
   preventing stunting ` (trailing space), `Threshold-based strategy Ward l`,
   `Threshold-based strategy LGA le`, `Equal distribution Ward level`, `Equal
   distribution LGA level`, plus helpers `Sheet57` and `Sheet58`.
   What is known already: each strategy allocates exactly 10,000 cartons at the
   saved settings, equal to `Allocation Inputs`!F5. The three prioritization
   strategies concentrate it in 3 to 4 LGAs (35 wards); equal distribution
   spreads it across all 774 LGAs / 9,684 wards, max 165.01 per LGA. Documented
   sort keys are on `Hard-coded Inputs` rows 97 to 100.
2. Aggregation layer: `State summary Ward level` / `LGA level`, row 113 is the
   national total. `Allocation Strategy Comparison` reads row 113 in per-strategy
   column blocks (C/N..R, S/AD..AH, AI/AT..AX, AY/BJ..BN). The "LGAs targeted"
   and "wards targeted" cells use Google's `COUNTUNIQUEIFS` and are frozen, so
   the counting rule must be reconstructed from the preserved formula text.
3. Layouts for `Allocation Strategy Outputs` (651 rows, national/zone/state) and
   `State-level Allocation` (157 rows, LGA and ward, state selector at D8,
   strategy selector at D8 per the AC-column formula). 404 frozen cells on the
   latter, including 148 `SPARKLINE` cells that need to become real charts.
4. Quantification Tool: three targeting modes, by risk category, by threshold,
   and by impact target.
5. Parity test (`tools/parity_test.mjs`), then the UI, then GitHub Pages deploy.

## Gotchas to carry forward

- Excel `MATCH`/`SUMIF`/`COUNTIF` are **case-insensitive**; JavaScript is not.
  The ward sheet spells the capital territory `Fct`, the LGA sheet and the manual
  allocation list use `FCT`. `build_data.py` canonicalizes to `FCT`. Any new
  state-keyed join needs the same treatment.
- `Ward Data & Calcs` column AL broadcasts the **whole state figure** to every
  ward in that state (287 Jigawa wards each holding 10,000), so it is a lookup
  column, not a per-ward allocation. Do not sum it.
- Averted stunting contributes **no DALYs** in the workbook: column X sums only
  deaths, SAM, and anemia. Reproduced as-is.
- At the saved settings `F13` (cartons allocated manually) is 10,000 and `F14`
  (manual allocation %) is 1.0, with all 10,000 on Jigawa, yet the strategy
  columns still allocate a full 10,000 each. How the manual allocation and the
  strategy pool interact is not yet resolved. Resolve it in step 1.
