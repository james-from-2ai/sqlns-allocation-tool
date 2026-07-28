# Allocation mechanism

Read directly from the workbook's strategy sheets. Formulas are quoted verbatim.

## Sheet map

Each strategy exists at both ward and LGA level. The two prioritization
strategies use unhelpfully named sheets at LGA level.

| Strategy | Ward-level sheet | LGA-level sheet |
|---|---|---|
| Prioritize preventing U2 deaths | `Prioritize preventing U2 deaths` | `Sheet57` |
| Prioritize preventing stunting cases | `Prioritize preventing stunting ` (trailing space) | `Sheet58` |
| Threshold-based strategy | `Threshold-based strategy Ward l` | `Threshold-based strategy LGA le` |
| Equal distribution | `Equal distribution Ward level` | `Equal distribution LGA level` |

`LGA Data & Calcs (Allocation)` columns Y, Z, AA, AB pull each strategy's result
back by INDEX/MATCH on state and LGA. `Ward Data & Calcs (Allocation)` does the
same on LGA and ward.

## The three prioritization strategies

All three share one layout: a left block sorted **by state, then by priority**,
which distributes the manual allocation, and a right block sorted **globally by
priority**, which distributes whatever supply is left.

### Sort keys

The source array is `{state, LGA, ward, cartonsNeeded, u5mr, stunting}`, so
column 4 is cartons needed, 5 is u5mr, 6 is stunting. At LGA level there is no
ward column, so the indices shift down by one.

| Strategy | Left block (manual) | Right block (pool) |
|---|---|---|
| U2 deaths | `SORT(..., 1, TRUE, 5, FALSE, 6, FALSE)` state asc, u5mr desc, stunting desc | `SORT(..., 5, FALSE, 6, FALSE)` u5mr desc, stunting desc |
| Stunting | `SORT(..., 1, TRUE, 6, FALSE, 5, FALSE)` state asc, stunting desc, u5mr desc | `SORT(..., 6, FALSE, 5, FALSE)` stunting desc, u5mr desc |
| Threshold | `SORT(..., 1, TRUE, 8, TRUE, 5, FALSE)` state asc, risk asc, u5mr desc | `SORT(A3:I9686, 9, FALSE, 8, TRUE, 5, FALSE)` meets-threshold desc, risk asc, u5mr desc |

Risk category sorts **ascending**, so 1.1 comes first. Values are the mixed set
1.1, 1.2, 1.3, 2, 3, and the text "Not Classified"; Google Sheets sorts numbers
before text, putting unclassified geographies last.

The threshold strategy sorts on "Meets threshold" **descending**, which puts "Y"
before "N".

### Step 1, manual allocation within each state

`Prioritize preventing U2 deaths`!H3 and I3:

    H3 = IFERROR(INDEX('Allocation Inputs'!$M$9:$M$45, MATCH(A3,'Allocation Inputs'!$L$9:$L$45,0)), 0)
    I3 = IF(H3=0, 0, MIN(D3, MAX(0, H3 - SUMIFS($D2:D$3, $A2:A$3, A3))))

`H` is the state's whole manual figure, broadcast to every row in that state.
`I` walks down the state's rows in priority order, giving each the smaller of its
own need and whatever of the state figure is left.

The `SUMIFS($D2:D$3, $A2:A$3, A3)` range is a growing window. `$D2` is
row-relative and `D$3` is row-absolute, so at row N the range spans D3 to D(N-1),
being every earlier row, filtered by `A3` to the same state. Note it accumulates
**cartons needed**, not cartons already allocated. The two agree while supply
remains, and once a state is exhausted every later row clamps to zero either way.

For the threshold strategy this is gated on the threshold test:

    L3 = if(I3="Y", IF(K3=0, 0, MIN(D3, MAX(0, K3-SUMIFS($D2:D$3,$A2:A$3,A3)))), 0)

### Step 2, the strategy pool

Right block, `Prioritize preventing U2 deaths` columns R through U:

    R3 = INDEX(I$3:I$9686, match(L3&M3, B$3:B$9686&C$3:C$9686, 0))   manual, matched across
    S3 = N3 - R3                                                     remaining need
    T3 = MIN(S3, 'Allocation Inputs'!F5 - 'Allocation Inputs'!F13)   first row
    T4 = MIN(S4, MAX(0, $F$5 - $F$13 - SUM($T$3:T3)))                subsequent rows
    U3 = R3 + T3                                                     final allocation

So the pool is **total supply minus cartons allocated manually**, that is
`F5 - F13`, filled greedily down the global priority order and capped at each
geography's remaining need. Final allocation is manual plus pool.

The threshold variant gates the pool on the threshold test as well:

    Z3 = if(V3="Y", MIN(Y3,'Allocation Inputs'!$F$5-'Allocation Inputs'!$F$13), 0)
    Z4 = if(V4="Y", MIN(Y4, MAX(0,'Allocation Inputs'!$F$5-'Allocation Inputs'!$F$13-SUM($Z$3:Z3))), 0)

### The threshold test

`Threshold-based strategy Ward l`!I3, a conjunction of all three user thresholds:

    I3 = IF(AND(E3>='Allocation Inputs'!$F$21, F3>='Allocation Inputs'!$F$22, G3>='Allocation Inputs'!$F$23), "Y", "N")

That is u5mr >= F21 **and** stunting >= F22 **and** wasting >= F23. Note this
differs from the risk-category rule, which is `u5mr AND (stunting OR wasting)`.

## Equal distribution

Much simpler, and it ignores both the manual allocation and the thresholds:

    E2 = 'Allocation Inputs'!$F$5 * D2 / sum(D$2:D10185)

Every geography gets a share of the **whole** supply proportional to its cartons
needed. Values are not rounded to whole cartons.

## Impact proration

Every strategy sheet computes averted cases the same way, for example
`Sheet57`!U3:

    U3 = if($S3>0, INDEX('LGA Data & Calcs (Allocation)'!T$3:T$776, MATCH(...))*$S3/$L3, 0)

Impact equals the geography's full-coverage figure scaled by
`finalAllocation / cartonsNeeded`. This confirms the proration in
`engine.js:impactOf`. The workbook does not clamp the ratio at 1, but the
allocation logic already caps each geography at its own need, so it cannot
exceed 1 in practice.

## Wards covered when allocating at LGA level

`LGA Data & Calcs (Allocation)`!AD3:

    AD3 = if(Y3>0, $C3, 0)

Column C is the LGA's ward count. So "wards targeted" under an LGA-level
allocation is the sum of ward counts over LGAs receiving anything, which avoids
needing Google's `COUNTUNIQUEIFS` for this figure.

## Why the saved workbook shows zero strategy allocation

At the saved settings `F5` (total supply) and `F13` (cartons allocated manually)
are both 10,000, so the pool `F5 - F13` is zero. Every `Optimal allocation`
column sums to 0, and `Final allocation` is entirely manual: 10,000 cartons on
Jigawa, spread across its highest-priority wards until exhausted, which is the
35 nonzero wards seen in `Ward Data & Calcs` column Y.

Equal distribution is the exception, since it ignores the manual allocation and
so still spreads a full 10,000 across all 9,684 wards.

This matters for the parity test: at the saved settings the greedy pool logic is
exercised only in its degenerate zero case. The within-state manual fill **is**
exercised. Pool behavior needs a separate test at a setting where `F13 < F5`,
which cannot be checked against the workbook and must instead be asserted
against the formulas above.
