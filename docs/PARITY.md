# Does the rebuilt workbook agree with the Google Sheet?

Yes. Across seven input scenarios, at both allocation levels, every geography
agrees. Cartons needed and the three prioritization strategies match **exactly**;
the floating-point columns match to about 1e-9 relative.

Tested 2026-07-28 against the live sheet
[`1o8bjds…2hd8`](https://docs.google.com/spreadsheets/d/1o8bjdsJaukcX3SJtSfSjXLb6MIjaWapLZhi7FOK2hd8/edit)
and `dist/SQ-LNS Allocation Tool (rebuilt).xlsx`.

## Why this test had to be built

The existing `tools/parity_test.mjs` compares against `site/data/fixtures.json`,
which holds the workbook's cached values at **one** set of inputs. That proves the
port reproduces a single frozen snapshot. It cannot show that the two agree when
the inputs change, which is the only claim that matters for a tool people will
actually adjust.

The obvious approach, recalculating the xlsx export in Excel and diffing, does not
work: the export cannot recalculate. Its strategy sheets are driven by Google's
`SORT()`, which Excel does not have, so those cells are frozen at their last cached
value (`docs/FINDINGS.md`, finding 1). The live sheet is the only oracle that can
be re-driven with new inputs.

## Method

For each scenario:

1. **Set the inputs in the sheet.** Never in Grace's original, always in a private
   copy. Google's own record confirms the original was untouched: its
   `modifiedTime` was `2026-07-27T21:13:36.916Z` before this exercise and
   unchanged after.
2. **Read the inputs back and assert they match the spec.** This is not
   ceremony. Four separate silent failures were caught this way, listed under
   "How the sheet resists automation" below. Without the read-back, three
   scenarios would have quietly tested the wrong inputs and still "passed".
3. **Pull every row from the live sheet**, both `Ward Data & Calcs (Allocation)`
   (9,684 rows) and `LGA Data & Calcs (Allocation)` (774 rows).
4. **Run the same scenario through Excel** via `tools/parity_excel_side.py`,
   which sets the Inputs sheet, forces `CalculateFullRebuild`, and dumps the same
   columns.
5. **Diff every row** with `tools/parity_diff.py`.

### Getting full precision out of the sheet

`gviz` returns *display-formatted* values for raw cells, so equal distribution
came back as `7` instead of `6.915324405293704`. The `FORMAT` clause is silently
ignored on CSV output, and `tqx=out:json`, which would carry raw values, requires
OAuth rather than session cookies.

The way through: **aggregate values are returned unformatted**. Querying
`select A, B, sum(I), sum(Y), … group by A, B` yields one row per geography at
full double precision. The sum over a single-row group is that row's value.

### Comparing 9,684 rows without them passing through the agent's context

The page fetches each scenario's full result set and hands it to Chrome's download
machinery; `tools/claim_download.py` picks it up off disk. The comparison then runs
in Python against the complete data, so nothing is summarized or sampled.

### One grouping caveat

Seven `(state, LGA, ward)` triples occur twice in the source ward list, so the
sheet-side query returns 9,677 groups for 9,684 rows. The Excel side groups
identically, so no row is dropped on either side and the totals are complete. What
is not separately verified is how those seven duplicated names split internally.

### Key folding

`MATCH`, `SUMIF` and `COUNTIF` are case-insensitive in both Excel and Google
Sheets, and the source data is inconsistent: the ward sheet writes `Fct` where the
LGA sheet writes `FCT`, and `build_data.py` canonicalizes to `FCT`. Keys are
compared case-insensitively, mirroring what the model itself can see. Without this,
62 phantom mismatches appear for a difference no formula can detect.

## Scenarios

| | Supply | Age | Duration | Enrollment | Cap | Thresholds | Manual | What it exercises |
|---|---|---|---|---|---|---|---|---|
| s0 | 10,000 | 6-23 | 6 | 6 | 75% | none | Jigawa 10,000 | The sheet's own saved state |
| s1 | 10,000 | 6-23 | 6 | 6 | 75% | none | none | Greedy pool with an empty manual reserve |
| s2 | 250,000 | 6-23 | 6 | 6 | 75% | none | 3 states, 75,000 | Manual and pool both live |
| s3 | 400,000 | 6-18 | 9 | 4 | 60% | 120/40/10 | Bauchi 15,000 | Every program parameter changed, thresholds biting |
| s4 | 75,000 | 6-11 | 2 | 12 | 100% | 10/0/0 | none | Duration below 3 months, the zero-effect branch |
| s5 | 40,000,000 | 6-23 | 12 | 6 | 75% | Yobe 5,000 | 10/0/0 | Supply far above national need |
| s6 | 120,000 | 6-23 | 6 | 6 | 75% | 160/55/12 | Sokoto 8,000, Zamfara 4,000 | Severe thresholds at row level |

s0 and s1 were chosen deliberately as a pair. At the saved settings the manual
reserve consumes the entire supply, so `F5 - F13` is zero and the greedy pool is
never exercised. s1 empties the manual table so the same 10,000 cartons flow
through the pool instead. The two produce visibly different answers, s0 funding
Jigawa LGAs and s1 funding Kano's highest-mortality LGAs, and both match.

## Results

All 14 comparisons pass. Full output in `dist/parity_runs/REPORT.txt`.

| Column | Basis | Worst residual across all scenarios |
|---|---|---|
| Cartons needed | exact | 0 |
| Allocation, prioritize U2 deaths | exact | 0 |
| Allocation, prioritize stunting | exact | 0 |
| Allocation, threshold-based | exact | 0 |
| Allocation, equal distribution | relative | 1.5e-16 |
| Deaths / stunting / SAM / anemia averted | relative | 7.6e-10 |
| DALYs averted | relative | 8.5e-10 |

The three prioritization strategies are integer-valued, being a `MIN` of integer
needs against an integer pool, so exact equality is the right bar and they clear
it on every row of every scenario.

The ~1e-9 residuals on the impact columns are not a model difference. They trace
to constants in `site/data/base.json`, which were read from Google's export at ten
significant figures. A relative error that size is what carrying a ten-digit
constant through four multiplications produces.

### Partial allocations, which are the strongest evidence

Where a scenario forces a strategy to allocate less than the full supply, the
rebuild reproduces the same partial figure. These numbers depend on the risk
categorization, the threshold gate, and the greedy fill all being right at once:

| Scenario | Threshold strategy allocates | of supply |
|---|---|---|
| s3, LGA | 226,721 | 400,000 |
| s3, ward | 238,270 | 400,000 |
| s6, LGA | 12,654 | 120,000 |
| s6, ward | 16,154 | 120,000 |
| s5, ward | 6,020,193 | need 6,021,164 |

s5 is worth reading twice. With supply far above need, all three prioritization
strategies saturate at exactly total need, while the threshold strategy stops
971 cartons short because a handful of wards fall below the 10-per-1,000 mortality
gate. Both sides land on the same 6,020,193.

### The distinctness check

A suite in which every scenario produced identical numbers would pass while
testing nothing. `parity_diff.py` therefore reports how many geographies changed
between consecutive scenarios and fails if any pair is identical on every column.
Every transition moves real numbers, up to all 774 LGAs on all ten columns.

### The user-facing summary

`Allocation Strategy Comparison` was checked separately at s6, because the
row-level diff does not cover the prorated impact arithmetic in that tab.
Deaths averted agree to 3e-12, DALYs to 1.5e-7, and LGAs-targeted and
wards-targeted match exactly. Two of its metrics have no counterpart on the
rebuild's `Strategy comparison` sheet: "LGAs targeted" when allocating at ward
level, and "children targeted".

## How the sheet resists automation

Recorded because each one silently produced wrong inputs, and anyone repeating
this will hit them.

- **`F9` (coverage cap) rejects `75%`.** Typing it leaves the cell holding text,
  and the model then reads no number at all. Enter `0.75`.
- **`F21` has data validation against its own Minimum helper; `F22` and `F23` do
  not.** `F21` accepts 10 and silently refuses 0, even though the saved workbook
  ships with 0 in it. Scenarios s4 and s5 use 10 for that reason, which gates
  nothing since `rounddown(min(u5mr))` is 10.
- **`F6` and `F12` are dropdowns that reject typed text**, raising a modal that
  then swallows every subsequent keystroke, including navigation. Use the
  dropdown.
- **Each committed edit triggers a full recalculation** of eight strategy sheets
  over 9,684 rows. During it the tab drops input and reads return stale values.
  Read back, and re-read if the answer looks wrong.

## Findings about the sheet

1. **`F14`, "Manual allocation (%)", is read by nothing.** Zero references in any
   formula on any of the 45 sheets. It is an inert input presented as a live one.
   The rebuild correctly omits it.
2. **`F13`, "Cartons allocated manually", is a typed literal, not a formula.** The
   strategy pool is `F5 - F13`, while the per-state reserve comes from `M9:M45`.
   Nothing keeps the two in agreement, so a user who edits the state table without
   updating `F13` gets a pool that does not match the reserve, silently. The
   rebuild derives it (`Inputs!C22 = SUM(ManualCartons)`), which cannot drift.
   **This is the one behavioral difference between the two, and it is a
   deliberate correction, not a parity failure.** All seven scenarios were run
   with the two consistent so the rest of the model could be compared cleanly.
3. **The selected strategy lives on `State-level Allocation!D8`**, not on
   `Allocation Inputs`, and drives column AC of both calc sheets. Column AC is
   excluded from the diff for that reason; the four explicit strategy columns are
   compared instead, which is stricter.

## Reproducing

```bash
python tools/parity_excel_side.py          # all scenarios, or name some
python tools/parity_diff.py                # compare and report
```

The sheet side needs a browser session; `tools/parity_keystrokes.py <scenario>`
prints the exact cell entries, and `tools/claim_download.py <name>` files each
pulled dataset.
