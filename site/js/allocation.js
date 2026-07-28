/**
 * The four allocation strategies, ported from the workbook's strategy sheets.
 * See docs/spec-strategies.md for the verbatim formulas each function mirrors.
 */

import { impactOf, sameText } from "./engine.js";

/* ------------------------------------------------------------------ sorting */

/**
 * Google Sheets orders numbers before text when sorting ascending. Risk
 * category mixes both (1.1, 1.2, 1.3, 2, 3, "Not Classified"), so unclassified
 * geographies land last, which is the intended priority order.
 */
function compareMixed(a, b) {
  const na = typeof a === "number" ? a : Number(a);
  const nb = typeof b === "number" ? b : Number(b);
  const aNum = a !== null && a !== "" && !Number.isNaN(na);
  const bNum = b !== null && b !== "" && !Number.isNaN(nb);
  if (aNum && bNum) return na - nb;
  if (aNum) return -1;
  if (bNum) return 1;
  return String(a).localeCompare(String(b));
}

/**
 * Sort by a list of {key, asc} specs. Ties fall back to the row's original
 * index, which keeps the result stable and matches the source order the
 * workbook's SORT() spills from.
 */
function sortBy(rows, specs) {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((x, y) => {
      for (const { key, asc } of specs) {
        const c = compareMixed(key(x.row), key(y.row));
        if (c !== 0) return asc ? c : -c;
      }
      return x.i - y.i;
    })
    .map((w) => w.row);
}

const KEY = {
  state: (r) => r.state,
  u5mr: (r) => r.u5mr,
  stunting: (r) => r.stunting,
  risk: (r) => r.riskCategory,
  meets: (r) => (r.meetsThreshold ? "Y" : "N"),
};

/** Sort specs per strategy, as read off the SORT() calls in the workbook. */
const SORTS = {
  mortality: {
    byState: [{ key: KEY.state, asc: true }, { key: KEY.u5mr, asc: false }, { key: KEY.stunting, asc: false }],
    global: [{ key: KEY.u5mr, asc: false }, { key: KEY.stunting, asc: false }],
  },
  stunting: {
    byState: [{ key: KEY.state, asc: true }, { key: KEY.stunting, asc: false }, { key: KEY.u5mr, asc: false }],
    global: [{ key: KEY.stunting, asc: false }, { key: KEY.u5mr, asc: false }],
  },
  threshold: {
    byState: [{ key: KEY.state, asc: true }, { key: KEY.risk, asc: true }, { key: KEY.u5mr, asc: false }],
    global: [{ key: KEY.meets, asc: false }, { key: KEY.risk, asc: true }, { key: KEY.u5mr, asc: false }],
  },
};

/* ------------------------------------------------------------- the strategies */

/**
 * Does a row clear all three user thresholds?
 * `Threshold-based strategy Ward l`!I3, a conjunction, unlike the
 * risk-category rule which is u5mr AND (stunting OR wasting).
 */
export function meetsThreshold(row, thresholds) {
  return (
    row.u5mr >= thresholds.u5mr &&
    row.stunting >= thresholds.stunting &&
    row.wasting >= thresholds.wasting
  );
}

/**
 * Step 1: hand out each state's manual allocation down that state's priority
 * order. Mirrors column I: MIN(need, MAX(0, stateManual - sum of *needs* above
 * within the same state)).
 */
function allocateManual(rows, specs, manualByState, gated) {
  const manual = new Map();
  const consumed = new Map(); // state -> cumulative cartons *needed* above
  for (const row of sortBy(rows, specs)) {
    const stateManual = manualByState.get(row.state.toLowerCase()) ?? 0;
    const already = consumed.get(row.state) ?? 0;
    let give = 0;
    if (stateManual !== 0 && (!gated || row.meetsThreshold)) {
      give = Math.min(row.cartonsNeeded, Math.max(0, stateManual - already));
    }
    manual.set(row, give);
    consumed.set(row.state, already + row.cartonsNeeded);
  }
  return manual;
}

/**
 * Step 2: fill the remaining pool greedily down the global priority order.
 * Pool is total supply minus cartons allocated manually (F5 - F13).
 */
function allocatePool(rows, specs, manual, pool, gated) {
  const final = new Map();
  let spent = 0;
  for (const row of sortBy(rows, specs)) {
    const manualHere = manual.get(row) ?? 0;
    const remainingNeed = row.cartonsNeeded - manualHere;
    let optimal = 0;
    if (!gated || row.meetsThreshold) {
      optimal = Math.min(remainingNeed, Math.max(0, pool - spent));
    }
    spent += optimal;
    final.set(row, manualHere + optimal);
  }
  return final;
}

/**
 * Run one strategy over the derived rows.
 *
 * @param rows     derived rows from engine.deriveRow
 * @param strategy "mortality" | "stunting" | "threshold" | "equal"
 * @param inputs   { totalCartons, cartonsAllocatedManually, thresholds, manualByState }
 * @returns Map of row -> cartons allocated
 */
export function allocate(rows, strategy, inputs) {
  const { totalCartons, cartonsAllocatedManually, manualByState } = inputs;

  // Equal distribution ignores the manual allocation and the thresholds, and
  // spreads the whole supply in proportion to cartons needed.
  if (strategy === "equal") {
    const totalNeed = rows.reduce((s, r) => s + r.cartonsNeeded, 0);
    const out = new Map();
    for (const row of rows) {
      out.set(row, totalNeed > 0 ? (totalCartons * row.cartonsNeeded) / totalNeed : 0);
    }
    return out;
  }

  const specs = SORTS[strategy];
  if (!specs) throw new Error(`unknown strategy: ${strategy}`);
  const gated = strategy === "threshold";

  if (gated) {
    for (const row of rows) row.meetsThreshold = meetsThreshold(row, inputs.thresholds);
  }

  const manual = allocateManual(rows, specs.byState, manualByState, gated);
  const pool = totalCartons - cartonsAllocatedManually;
  return allocatePool(rows, specs.global, manual, pool, gated);
}

/**
 * Run every strategy and attach per-row impact.
 * @returns { [strategyId]: { rows: [{row, ...impact}], totals } }
 */
export function allocateAll(rows, inputs) {
  const out = {};
  for (const strategy of ["mortality", "stunting", "threshold", "equal"]) {
    const alloc = allocate(rows, strategy, inputs);
    const detail = rows.map((row) => ({ row, ...impactOf(row, alloc.get(row) ?? 0) }));
    out[strategy] = { detail, totals: totalsOf(detail, inputs.level) };
  }
  return out;
}

/** National totals for one strategy, matching the Strategy Comparison table. */
export function totalsOf(detail, level) {
  const t = {
    cartons: 0, deathsAverted: 0, stuntingAverted: 0, samAverted: 0,
    anemiaAverted: 0, dalysAverted: 0, childrenTargeted: 0,
    lgasTargeted: 0, wardsTargeted: 0,
  };
  const lgaKeys = new Set();
  for (const d of detail) {
    if (d.cartons <= 0) continue;
    t.cartons += d.cartons;
    t.deathsAverted += d.deathsAverted;
    t.stuntingAverted += d.stuntingAverted;
    t.samAverted += d.samAverted;
    t.anemiaAverted += d.anemiaAverted;
    t.dalysAverted += d.dalysAverted;
    t.childrenTargeted += d.childrenTargeted;
    lgaKeys.add(`${d.row.state}||${d.row.lga}`);
    // At ward level each targeted row is one ward. At LGA level the workbook
    // credits the LGA's whole ward count ('LGA Data & Calcs'!AD3 = if(Y3>0,$C3,0)).
    t.wardsTargeted += level === "wards" ? 1 : d.row.nWards ?? 0;
  }
  t.lgasTargeted = lgaKeys.size;
  return t;
}

/**
 * Cost per case averted, from 'Allocation Strategy Comparison'!D47.
 * Cost is total product cost plus a per-geography delivery cost.
 */
export function costEffectiveness(totals, constants, level, deliveryCostPer) {
  const productCostUsd =
    constants.pricePerSachetUsd * totals.cartons * constants.sachetsPerCarton;
  const units = level === "wards" ? totals.wardsTargeted : totals.lgasTargeted;
  const totalUsd = productCostUsd + units * deliveryCostPer;
  const per = (n) => (n > 0 ? totalUsd / n : null);
  return {
    totalUsd,
    perDeathUsd: per(totals.deathsAverted),
    perStuntingUsd: per(totals.stuntingAverted),
    perSamUsd: per(totals.samAverted),
    perAnemiaUsd: per(totals.anemiaAverted),
    perDalyUsd: per(totals.dalysAverted),
  };
}
