/**
 * SQ-LNS allocation model, ported from `SQ-LNS Allocation Tool.xlsx`.
 *
 * The workbook remains the specification. Every function here corresponds to a
 * named column or block in it, and the mapping is given in the comments so the
 * two can be diffed by hand. tools/parity_test.mjs asserts this reproduces the
 * workbook's cached values.
 *
 * Two defects in the workbook are reproduced deliberately, behind `bugCompat`.
 * See docs/FINDINGS.md. With `bugCompat: true` (the default) output matches the
 * sheet; with `false` the intended rule is applied instead.
 *
 * No DOM access in this file, so it can run under Node for the parity test.
 */

/* ------------------------------------------------------------------ helpers */

/** Excel ROUNDUP(x, 0): away from zero, not toward +Infinity. */
export function roundUp(x) {
  return x < 0 ? -Math.ceil(-x) : Math.ceil(x);
}

/** Excel text comparison is case-insensitive; JavaScript is not. */
export function sameText(a, b) {
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

/* ------------------------------------------------- program-level parameters */

/**
 * Values that depend only on the program inputs, not on any one geography.
 * Mirrors the derived cells on 'Hard-coded Inputs'.
 */
export function programParams(constants, inputs) {
  const { ageRange, duration, coverageCap, enrollmentPeriod } = inputs;

  // 'Hard-coded Inputs'!C11 = ROUNDUP(duration/12 * 365, 0)
  const sachetsPerChild = roundUp((duration / 12) * constants.sachetsPerChildPerYear);

  // C40: proportion of the U5 population in the selected age range
  const ageShare = constants.ageRangeShare[ageRange];
  // C42..C44: number of monthly cohorts in the selected age range
  const cohorts = constants.ageRangeCohorts[ageRange];
  if (ageShare === undefined || cohorts === undefined) {
    throw new Error(`unknown age range: ${ageRange}`);
  }

  // C118 = 1 - wastage - incomplete consumption
  const impactRetained =
    1 - constants.impactDiscount.wastage - constants.impactDiscount.incompleteConsumption;

  // C131: treatment effect is prorated by supplementation duration, and is
  // zero below three months. The workbook enumerates 3..12 as duration/12,
  // so this is that same step function stated as a formula.
  let durationScale;
  if (duration < 3) durationScale = 0;
  else if (duration >= 12) durationScale = 1;
  else durationScale = duration / 12;

  return {
    sachetsPerChild,
    ageShare,
    cohorts,
    impactRetained,
    durationScale,
    // combined multiplier applied to every averted-case figure
    effectScale: impactRetained * durationScale,
    coverageCap,
    enrollmentPeriod,
    cartonsPerChild: sachetsPerChild / constants.sachetsPerCarton,
  };
}

/* ------------------------------------------------------- risk categorization */

/**
 * 'Ward Data & Calcs (Allocation)'!O and siblings.
 *
 * Intended rule per level: u5mr >= t.u5mr AND (stunting >= t.stunting OR wasting >= t.wasting).
 *
 * The workbook's level 1.3 test references 'Hard-coded Inputs'!$D506 instead of
 * $D$106. That cell is empty, an empty cell compares as zero, and a prevalence
 * is never negative, so the stunting arm of the OR is always true and level 1.3
 * degrades to `u5mr >= 100` alone. Reproduced when bugCompat is set.
 */
export function riskCategory(geo, constants, bugCompat = true) {
  for (const t of constants.riskThresholds) {
    const stuntingMet = bugCompat && t.level === "1.3" ? true : geo.stunting >= t.stunting;
    if (geo.u5mr >= t.u5mr && (stuntingMet || geo.wasting >= t.wasting)) return t.level;
  }
  return "Not Classified";
}

/* ------------------------------------------------------- per-geography rows */

/**
 * Derived columns D through X of the ward and LGA calc sheets, which are
 * identical in both. Column letters are given against each field.
 */
export function deriveRow(geo, constants, params, bugCompat = true) {
  const popU5 = geo.popTotal * constants.u5ShareOfPopulation;               // D
  const samFree = 1 - geo.sam / 100;
  const pop6to23 = popU5 * constants.ageRangeShare["6 to 23"] * samFree;    // E
  const popTargeted = popU5 * params.ageShare * samFree;                    // F
  const monthlyCohort = popTargeted / params.cohorts;                       // G

  // H: the enrollment period lets later monthly cohorts join, so eligible
  // population is the age-range population plus one cohort per extra month.
  const popEligible = popTargeted + monthlyCohort * (params.enrollmentPeriod - 1);

  // I: cartons needed to cover the eligible population at the coverage cap
  const cartonsNeeded = roundUp(popEligible * params.cartonsPerChild * params.coverageCap);

  // P..S: annual burden in the eligible population. Deaths divide by 5 because
  // the mortality rate is an under-5 rate applied to a single-year cohort.
  const deaths = (geo.u5mr / 1000) * popEligible / 5;
  const stuntingCases = (geo.stunting / 100) * popEligible;
  const samCases = (geo.sam / 100) * popEligible;
  const anemiaCases = (geo.anemia / 100) * popEligible;

  // T..W: averted at full coverage, after wastage/consumption discounts and
  // the duration proration
  const e = constants.effect;
  const s = params.effectScale;
  const deathsAverted = deaths * e.mortality * s;
  const stuntingAverted = stuntingCases * e.stunting * s;
  const samAverted = samCases * e.sam * s;
  const anemiaAverted = anemiaCases * e.anemia * s;

  // X: note that averted stunting contributes no DALYs in the workbook's
  // formula, which sums only deaths, SAM, and anemia.
  const d = constants.daly;
  const dalysAverted =
    deathsAverted * d.yllPerDeath + samAverted * d.yldPerSamCase + anemiaAverted * d.yldPerAnemiaCase;

  return {
    state: geo.state,
    lga: geo.lga,
    ward: geo.ward,
    nWards: geo.nWards,
    estimated: geo.estimated,
    popU5,
    pop6to23,
    popTargeted,
    monthlyCohort,
    popEligible,
    cartonsNeeded,
    u5mr: geo.u5mr,
    stunting: geo.stunting,
    wasting: geo.wasting,
    sam: geo.sam,
    anemia: geo.anemia,
    riskCategory: riskCategory(geo, constants, bugCompat),
    deaths,
    stuntingCases,
    samCases,
    anemiaCases,
    deathsAverted,
    stuntingAverted,
    samAverted,
    anemiaAverted,
    dalysAverted,
  };
}

/**
 * Scale a row's averted-case figures to a partial allocation.
 *
 * The T..X columns are stated at full coverage of the eligible population, so
 * impact under an allocation of `cartons` is prorated by the share of the
 * geography's need that the allocation covers, capped at 1.
 */
export function impactOf(row, cartons) {
  const share = row.cartonsNeeded > 0 ? Math.min(cartons / row.cartonsNeeded, 1) : 0;
  return {
    cartons,
    share,
    childrenTargeted: row.popEligible * share,
    deathsAverted: row.deathsAverted * share,
    stuntingAverted: row.stuntingAverted * share,
    samAverted: row.samAverted * share,
    anemiaAverted: row.anemiaAverted * share,
    dalysAverted: row.dalysAverted * share,
  };
}
