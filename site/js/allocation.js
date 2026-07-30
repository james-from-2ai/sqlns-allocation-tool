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

/** Metrics the supply curve reports, mapped to the row field they sum. */
const CURVE_METRICS = {
  deathsAverted: "deathsAverted",
  stuntingAverted: "stuntingAverted",
  samAverted: "samAverted",
  anemiaAverted: "anemiaAverted",
  dalysAverted: "dalysAverted",
  childrenTargeted: "popEligible",
};

/**
 * Impact across many supply levels, in one pass per strategy.
 *
 * Calling allocate() once per supply level is the obvious approach and far too
 * slow: 13 levels x 4 strategies at ward level is 52 sorts of 9,684 rows, which
 * measured at 7.8 seconds of blocked UI.
 *
 * The key observation is that supply does not affect the priority order, only
 * how far down it the money reaches. So sort once, build cumulative need and
 * cumulative impact along that order, and every supply level is then a prefix
 * lookup plus one partially funded geography.
 *
 * Equal distribution is analytic rather than a prefix: it gives every geography
 * the same fraction of its need, `supply / totalNeed`, so its impact is exactly
 * linear in supply. That is also why it performs worst, since it does no
 * targeting at all.
 *
 * @param levels ascending supply values
 * @returns [{x, deathsAverted, ...}] one entry per level
 */
export function supplyCurve(rows, strategy, inputs, levels) {
  const keys = Object.keys(CURVE_METRICS);
  const zero = () => Object.fromEntries(keys.map((k) => [k, 0]));

  if (strategy === "equal") {
    const totalNeed = rows.reduce((s, r) => s + r.cartonsNeeded, 0);
    const full = zero();
    for (const r of rows) for (const k of keys) full[k] += r[CURVE_METRICS[k]];
    return levels.map((x) => {
      const share = totalNeed > 0 ? Math.min(x / totalNeed, 1) : 0;
      const out = { x };
      for (const k of keys) out[k] = full[k] * share;
      return out;
    });
  }

  const specs = SORTS[strategy];
  if (!specs) throw new Error(`unknown strategy: ${strategy}`);
  const gated = strategy === "threshold";
  if (gated) for (const row of rows) row.meetsThreshold = meetsThreshold(row, inputs.thresholds);

  // Manual allocation is fixed: it does not vary with total supply.
  const manual = allocateManual(rows, specs.byState, inputs.manualByState, gated);
  const manualImpact = zero();
  for (const row of rows) {
    const give = manual.get(row) ?? 0;
    if (give <= 0 || row.cartonsNeeded <= 0) continue;
    const share = Math.min(give / row.cartonsNeeded, 1);
    for (const k of keys) manualImpact[k] += row[CURVE_METRICS[k]] * share;
  }

  // Walk the global priority order once, accumulating fundable need and the
  // impact that funding it would buy.
  const ordered = sortBy(rows, specs.global);
  const cumNeed = [0];
  const cumImpact = [zero()];
  const perRow = [];
  for (const row of ordered) {
    const manualHere = manual.get(row) ?? 0;
    const canTake = !gated || row.meetsThreshold;
    const fundable = canTake ? Math.max(0, row.cartonsNeeded - manualHere) : 0;
    perRow.push({ row, fundable });
    const prev = cumImpact[cumImpact.length - 1];
    const next = { ...prev };
    if (fundable > 0 && row.cartonsNeeded > 0) {
      const share = fundable / row.cartonsNeeded;
      for (const k of keys) next[k] = prev[k] + row[CURVE_METRICS[k]] * share;
    }
    cumImpact.push(next);
    cumNeed.push(cumNeed[cumNeed.length - 1] + fundable);
  }

  const pool = (supply) => Math.max(0, supply - (inputs.cartonsAllocatedManually ?? 0));
  return levels.map((x) => {
    let budget = pool(x);
    // Largest prefix fully affordable. cumNeed is non-decreasing, so binary search.
    let lo = 0, hi = cumNeed.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cumNeed[mid] <= budget) lo = mid; else hi = mid - 1;
    }
    const out = { x };
    for (const k of keys) out[k] = manualImpact[k] + cumImpact[lo][k];

    // The next geography takes whatever remains.
    const leftover = budget - cumNeed[lo];
    const nextRow = perRow[lo];
    if (leftover > 0 && nextRow && nextRow.fundable > 0 && nextRow.row.cartonsNeeded > 0) {
      const share = Math.min(leftover, nextRow.fundable) / nextRow.row.cartonsNeeded;
      for (const k of keys) out[k] += nextRow.row[CURVE_METRICS[k]] * share;
    }
    return out;
  });
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
