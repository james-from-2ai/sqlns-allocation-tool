/**
 * Parity test: does the JavaScript engine reproduce the workbook?
 *
 *   node tools/parity_test.mjs
 *
 * Runs the engine at the workbook's own saved input settings and compares every
 * derived column, for all 9,684 wards and 774 LGAs, against the cached values in
 * site/data/fixtures.json.
 *
 * Comparison is on relative error, because the cached values are Google's
 * printed doubles and carry roughly 10 significant figures.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { programParams, deriveRow } from "../site/js/engine.js";
import { allocate } from "../site/js/allocation.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "..", "site", "data");
const read = (f) => JSON.parse(readFileSync(join(DATA, f), "utf8"));

const base = read("base.json");
const fixtures = read("fixtures.json");
const { constants } = base;

// Google prints cached values to about 10 significant figures, so a value like
// 10.38124692 carries an absolute uncertainty near 1e-8, or ~1e-9 relative.
// Anything at or below this is the precision of the fixture, not a model
// difference. Integer and pass-through columns still match exactly.
const TOLERANCE = 1e-8;

/* --------------------------------------------- inputs, as saved in the sheet */

const ai = fixtures.allocationInputs;
const inputs = {
  totalCartons: Number(ai.F5),
  ageRange: String(ai.F6),
  duration: Number(ai.F7),
  enrollmentPeriod: Number(ai.F8),
  coverageCap: Number(ai.F9),
  level: String(ai.F12).toLowerCase(), // "wards" | "lgas"
  cartonsAllocatedManually: Number(ai.F13),
  thresholds: { u5mr: Number(ai.F21), stunting: Number(ai.F22), wasting: Number(ai.F23) },
};
const manualByState = new Map(
  Object.entries(fixtures.manualAllocation).map(([s, v]) => [s.toLowerCase(), Number(v)])
);

console.log("Workbook settings under test:");
console.log(`  total cartons ${inputs.totalCartons.toLocaleString()}, age range ${inputs.ageRange}, ` +
            `duration ${inputs.duration} mo, enrollment ${inputs.enrollmentPeriod} mo`);
console.log(`  coverage cap ${inputs.coverageCap}, level ${inputs.level}, ` +
            `manual ${inputs.cartonsAllocatedManually.toLocaleString()} cartons`);
console.log(`  thresholds u5mr>=${inputs.thresholds.u5mr}, stunting>=${inputs.thresholds.stunting}, ` +
            `wasting>=${inputs.thresholds.wasting}\n`);

/* ------------------------------------------------------------- the comparison */

// derived column letter -> engine field
const COLUMNS = {
  D: "popU5", E: "pop6to23", F: "popTargeted", G: "monthlyCohort", H: "popEligible",
  I: "cartonsNeeded", J: "u5mr", K: "stunting", L: "wasting", M: "sam", N: "anemia",
  O: "riskCategory", P: "deaths", Q: "stuntingCases", R: "samCases", S: "anemiaCases",
  T: "deathsAverted", U: "stuntingAverted", V: "samAverted", W: "anemiaAverted",
  X: "dalysAverted",
};
const STRATEGY_COLUMNS = { Y: "mortality", Z: "stunting", AA: "threshold", AB: "equal" };

function relError(got, want) {
  if (want === 0) return Math.abs(got) < 1e-6 ? 0 : Infinity;
  return Math.abs(got - want) / Math.abs(want);
}

let failures = 0;

function checkLevel(levelName, geographies, expectedRows) {
  const params = programParams(constants, inputs);
  const rows = geographies.map((g) => deriveRow(g, constants, params, /* bugCompat */ true));

  console.log(`=== ${levelName}: ${rows.length} rows ===`);

  // key expected rows so ordering differences cannot mask a mismatch
  const key = (r) => `${r.state}||${r.lga}||${r.ward ?? ""}`;
  const expected = new Map(expectedRows.map((e) => [key(e), e]));
  if (expected.size !== expectedRows.length) {
    console.log(`  note: ${expectedRows.length - expected.size} duplicate keys in fixtures`);
  }

  // derived columns
  const worst = {};
  for (const row of rows) {
    const exp = expected.get(key(row));
    if (!exp) { console.log(`  MISSING expected row: ${key(row)}`); failures++; continue; }
    for (const [col, field] of Object.entries(COLUMNS)) {
      const want = exp[col];
      if (want === null || want === undefined) continue;
      if (field === "riskCategory") {
        worst[col] ??= { n: 0, compared: 0, sample: "" };
        worst[col].compared++;
        if (String(want) !== String(row[field])) {
          worst[col].n++;
          worst[col].sample ||= `${key(row)} got ${row[field]} want ${want}`;
        }
        continue;
      }
      const e = relError(row[field], Number(want));
      if (!worst[col] || e > worst[col].err) {
        worst[col] = { err: e, n: worst[col]?.n ?? 0, sample: `${key(row)} got ${row[field]} want ${want}` };
      }
    }
  }

  for (const [col, field] of Object.entries(COLUMNS)) {
    const w = worst[col];
    if (!w) { console.log(`  ${col} ${field.padEnd(16)} no expected values`); continue; }
    if (field === "riskCategory") {
      const ok = !w.n;
      console.log(`  ${col} ${field.padEnd(16)} ${ok ? "PASS" : "FAIL"}  ` +
                  `${w.compared - w.n}/${w.compared} exact` +
                  (ok ? "" : `\n        e.g. ${w.sample}`));
      if (!ok) failures++;
      continue;
    }
    const ok = w.err <= TOLERANCE;
    console.log(`  ${col} ${field.padEnd(16)} ${ok ? "PASS" : "FAIL"}  max rel err ${w.err.toExponential(2)}` +
                (ok ? "" : `\n        e.g. ${w.sample}`));
    if (!ok) failures++;
  }

  // strategy allocations
  for (const [col, strategy] of Object.entries(STRATEGY_COLUMNS)) {
    const alloc = allocate(rows, strategy, { ...inputs, manualByState });
    let maxErr = 0, sample = "", nonzero = 0, sum = 0, expSum = 0;
    for (const row of rows) {
      const got = alloc.get(row) ?? 0;
      const exp = expected.get(key(row));
      const want = exp ? Number(exp[col] ?? 0) : 0;
      sum += got; expSum += want;
      if (got !== 0) nonzero++;
      const e = relError(got, want);
      if (e > maxErr) { maxErr = e; sample = `${key(row)} got ${got} want ${want}`; }
    }
    const ok = maxErr <= 1e-6;
    console.log(`  ${col.padEnd(2)} ${strategy.padEnd(15)} ${ok ? "PASS" : "FAIL"}  ` +
                `max rel err ${maxErr.toExponential(2)}  sum ${sum.toFixed(2)} vs ${expSum.toFixed(2)}  (${nonzero} nonzero)` +
                (ok ? "" : `\n        e.g. ${sample}`));
    if (!ok) failures++;
  }
  console.log();
}

checkLevel("Wards", base.wards, fixtures.derived.ward);
checkLevel("LGAs", base.lgas, fixtures.derived.lga);

console.log(failures === 0
  ? "ALL CHECKS PASSED: the engine reproduces the workbook at its saved settings."
  : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
