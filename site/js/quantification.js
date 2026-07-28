/**
 * Quantification Tool: how much product does a given target require?
 *
 * Ported from the `Quantification Tool` sheet. That sheet runs on its own
 * program inputs, independent of `Allocation Inputs`, so callers derive rows
 * with a separate params object. The row math itself is identical.
 *
 * Note the sheet's own inconsistency, reproduced here: the target-by-threshold
 * mode uses SUMIFS(">"&value), a *strict* inequality, while the threshold-based
 * allocation strategy and the risk categories both use >=. See `strictThreshold`.
 */

import { impactOf } from "./engine.js";

/** Sum a set of rows at full coverage of their own need. */
function summarize(rows, level) {
  const t = {
    cartons: 0, childrenTargeted: 0, deathsAverted: 0, stuntingAverted: 0,
    samAverted: 0, anemiaAverted: 0, dalysAverted: 0,
    lgasTargeted: 0, wardsTargeted: 0,
  };
  const lgaKeys = new Set();
  for (const row of rows) {
    const i = impactOf(row, row.cartonsNeeded);
    t.cartons += row.cartonsNeeded;
    t.childrenTargeted += i.childrenTargeted;
    t.deathsAverted += i.deathsAverted;
    t.stuntingAverted += i.stuntingAverted;
    t.samAverted += i.samAverted;
    t.anemiaAverted += i.anemiaAverted;
    t.dalysAverted += i.dalysAverted;
    lgaKeys.add(`${row.state}||${row.lga}`);
    t.wardsTargeted += level === "wards" ? 1 : row.nWards ?? 0;
  }
  t.lgasTargeted = lgaKeys.size;
  return t;
}

/**
 * Mode 1: target by risk category.
 * `Quantification Tool`!E31, a sum over the selected categories within one state.
 */
export function byRiskCategory(rows, { state, levels, level }) {
  const wanted = new Set(levels);
  const hit = rows.filter(
    (r) => (!state || r.state === state) && wanted.has(String(r.riskCategory))
  );
  return { ...summarize(hit, level), rows: hit };
}

/**
 * Mode 2: target by threshold.
 * `Quantification Tool`!E53. The workbook uses strict `>` here; pass
 * strictThreshold false to use `>=` and line up with the allocation strategy.
 */
export function byThreshold(rows, { thresholds, level, state, strictThreshold = true }) {
  const gt = strictThreshold ? (a, b) => a > b : (a, b) => a >= b;
  const hit = rows.filter(
    (r) =>
      (!state || r.state === state) &&
      gt(r.u5mr, thresholds.u5mr) &&
      gt(r.stunting, thresholds.stunting) &&
      gt(r.wasting, thresholds.wasting)
  );
  return { ...summarize(hit, level), rows: hit };
}

const METRIC_FIELD = {
  "Deaths averted": "deathsAverted",
  "Stunting cases averted": "stuntingAverted",
  "SAM cases averted": "samAverted",
  "Anemia cases averted": "anemiaAverted",
  "DALYs averted": "dalysAverted",
};

/**
 * Mode 3: target by impact.
 *
 * `Quantification Tool`!E70 is XLOOKUP(target, cumulativeImpact, cumulativeCartons, , 1),
 * match mode 1 meaning "next larger". So: walk the geographies in the strategy's
 * priority order, accumulating impact and cartons, and report the cumulative
 * cartons at the first point where cumulative impact reaches the target.
 *
 * @param ordered rows already sorted into the chosen strategy's priority order
 */
export function byImpactTarget(ordered, { metric, target, level }) {
  const field = METRIC_FIELD[metric];
  if (!field) throw new Error(`unknown target metric: ${metric}`);
  if (!(target > 0)) return { ...summarize([], level), rows: [], targetMet: false };

  const taken = [];
  let cumulative = 0;
  for (const row of ordered) {
    taken.push(row);
    cumulative += impactOf(row, row.cartonsNeeded)[field];
    if (cumulative >= target) {
      return { ...summarize(taken, level), rows: taken, targetMet: true };
    }
  }
  // Target exceeds what full national coverage would achieve.
  return { ...summarize(ordered, level), rows: ordered, targetMet: false };
}

/**
 * Budget for a carton count.
 * `Quantification Tool`!E32, E33, E36.
 */
export function costing(cartons, { costPerCartonNgn, markup, constants, sachetsPerChild }) {
  const ngn = cartons * costPerCartonNgn * (1 + markup);
  return {
    cartons,
    budgetNgn: ngn,
    budgetUsd: ngn / constants.ngnPerUsd,
    childrenTargeted: (cartons * constants.sachetsPerCarton) / sachetsPerChild,
  };
}
