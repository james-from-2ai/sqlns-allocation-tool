/**
 * Scope test: does allocating inside a single state behave correctly?
 *
 *   node tools/scope_test.mjs
 *
 * tools/parity_test.mjs pins the engine to the workbook, but only at national
 * scope: it never selects a state and never passes `manualKeyOf`. V2 added both,
 * so this covers the paths that test cannot reach.
 *
 * These are properties rather than fixtures, because there is nothing in the
 * workbook to compare against: the sheet has no state-scoped mode. Each property
 * below would break under a plausible refactor of the scope filter or of
 * allocateManual, which is the point of having it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { programParams, deriveRow } from "../site/js/engine.js";
import { allocate } from "../site/js/allocation.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(readFileSync(join(HERE, "..", "site", "data", "base.json"), "utf8"));
const { constants } = base;

const params = programParams(constants, {
  ageRange: "6 to 23", duration: 6, enrollmentPeriod: 6, coverageCap: 0.75,
});

// A spread of sizes and burden profiles: Kano is the largest, FCT among the
// smallest, Jigawa and Yobe high-burden, Lagos low-burden and urban.
const STATES = ["Kano", "Jigawa", "Lagos", "FCT", "Yobe"];
const STRATEGIES = ["mortality", "stunting", "threshold", "equal"];
const NO_THRESHOLDS = { u5mr: 0, stunting: 0, wasting: 0 };
const EPS = 1e-6;

let failures = 0;
function check(ok, label) {
  if (!ok) {
    failures += 1;
    console.log(`  FAIL  ${label}`);
  }
  return ok;
}

function rowsFor(level, scope) {
  const all = level === "wards" ? base.wards : base.lgas;
  const sel = scope ? all.filter((g) => g.state === scope) : all;
  return sel.map((g) => deriveRow(g, constants, params, /* bugCompat */ true));
}

const total = (m) => [...m.values()].reduce((s, v) => s + v, 0);
const sumNeed = (rows) => rows.reduce((s, r) => s + r.cartonsNeeded, 0);

/* -------------------------------------------------------------------------- */
// Scoping selects rows; it must never change what a row computes. A moved value
// would mean some national aggregate had leaked into a per-row formula.
console.log("A. A geography's derived values are identical scoped and unscoped");
for (const level of ["lgas", "wards"]) {
  const national = rowsFor(level, "");
  for (const st of STATES) {
    const slice = national.filter((r) => r.state === st);
    const scoped = rowsFor(level, st);
    check(slice.length === scoped.length,
      `${st}/${level}: ${slice.length} rows nationally vs ${scoped.length} scoped`);
    const key = (r) => `${r.lga}||${r.ward ?? ""}`;
    const byKey = new Map(scoped.map((r) => [key(r), r]));
    for (const r of slice) {
      const other = byKey.get(key(r));
      if (!check(other !== undefined, `${st}/${level}: ${key(r)} missing when scoped`)) continue;
      for (const f of ["cartonsNeeded", "riskCategory", "deathsAverted", "dalysAverted"]) {
        check(r[f] === other[f], `${st}/${level}/${key(r)}: ${f} ${r[f]} vs ${other[f]}`);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
console.log("B. Scoped allocation respects supply, need and saturation");
for (const st of STATES) {
  for (const level of ["lgas", "wards"]) {
    const rows = rowsFor(level, st);
    const need = sumNeed(rows);
    const shared = {
      cartonsAllocatedManually: 0, thresholds: NO_THRESHOLDS,
      manualByState: new Map(), manualKeyOf: (r) => r.lga,
    };
    for (const strategy of STRATEGIES) {
      // Under-supplied: every carton is placed, and nobody exceeds its own need.
      const short = Math.round(need * 0.3);
      const a = allocate(rows, strategy, { ...shared, totalCartons: short });
      check(Math.abs(total(a) - short) < EPS,
        `${st}/${level}/${strategy}: allocated ${total(a)} of ${short}`);
      const over = rows.filter((r) => (a.get(r) ?? 0) > r.cartonsNeeded + EPS).length;
      check(over === 0, `${st}/${level}/${strategy}: ${over} geographies above their own need`);

      // Over-supplied: the prioritization strategies stop at total need, while
      // equal distribution keeps splitting the whole supply by construction.
      const plenty = Math.ceil(need * 1.5);
      const b = allocate(rows, strategy, { ...shared, totalCartons: plenty });
      if (strategy === "equal") {
        check(Math.abs(total(b) - plenty) < EPS,
          `${st}/${level}/equal: allocated ${total(b)} of ${plenty}`);
      } else {
        check(Math.abs(total(b) - need) < EPS,
          `${st}/${level}/${strategy}: allocated ${total(b)}, need ${need}`);
        const unfunded = rows.filter((r) => Math.abs((b.get(r) ?? 0) - r.cartonsNeeded) > EPS);
        check(unfunded.length === 0,
          `${st}/${level}/${strategy}: ${unfunded.length} not funded to need at oversupply`);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
// Nationally, reservations key on state. Inside a state they key on LGA, which
// is the unit a state official would reserve against.
console.log("C. Manual reservations key on LGA inside a state");
for (const st of ["Kano", "Jigawa"]) {
  const rows = rowsFor("lgas", st);
  const target = rows[Math.floor(rows.length / 2)];
  const reserved = Math.max(1, Math.floor(target.cartonsNeeded / 2));
  const supply = reserved + 500;
  const keyed = allocate(rows, "mortality", {
    totalCartons: supply, cartonsAllocatedManually: reserved,
    thresholds: NO_THRESHOLDS,
    manualByState: new Map([[target.lga.toLowerCase(), reserved]]),
    manualKeyOf: (r) => r.lga,
  });
  check((keyed.get(target) ?? 0) >= reserved - EPS,
    `${st}: reserved ${reserved} for ${target.lga}, it received ${keyed.get(target) ?? 0}`);
  check(Math.abs(total(keyed) - supply) < EPS,
    `${st}: allocated ${total(keyed)} of ${supply}`);

  // The whole supply must still be placed when the same name is keyed by state,
  // where it matches nothing. Reservations that miss must not strand supply.
  const missed = allocate(rows, "mortality", {
    totalCartons: supply, cartonsAllocatedManually: 0,
    thresholds: NO_THRESHOLDS,
    manualByState: new Map([[target.lga.toLowerCase(), reserved]]),
    manualKeyOf: (r) => r.state,
  });
  check(Math.abs(total(missed) - supply) < EPS,
    `${st}: state-keyed total ${total(missed)} of ${supply}`);
}

/* -------------------------------------------------------------------------- */
console.log("D. A scoped run contains only that state");
for (const st of STATES) {
  for (const level of ["lgas", "wards"]) {
    const rows = rowsFor(level, st);
    check(rows.length > 0, `${st}/${level}: no geographies in scope`);
    check(rows.every((r) => r.state === st), `${st}/${level}: another state present in scope`);
    const a = allocate(rows, "threshold", {
      totalCartons: 50000, cartonsAllocatedManually: 0, thresholds: NO_THRESHOLDS,
      manualByState: new Map(), manualKeyOf: (r) => r.lga,
    });
    check([...a.keys()].every((r) => r.state === st),
      `${st}/${level}: allocation returned another state`);
  }
}

/* -------------------------------------------------------------------------- */
// The scoped needs must add back up to the national total, so the filter cannot
// be dropping or double counting a geography.
console.log("E. State needs sum to the national need");
for (const level of ["lgas", "wards"]) {
  const national = sumNeed(rowsFor(level, ""));
  const summed = base.states.reduce((s, st) => s + sumNeed(rowsFor(level, st)), 0);
  check(Math.abs(national - summed) < EPS,
    `${level}: national ${national} vs sum of states ${summed}`);
  console.log(`  ${level}: ${national.toLocaleString()} cartons, matched across ${base.states.length} states`);
}

console.log("\n" + (failures
  ? `${failures} CHECK(S) FAILED`
  : "ALL SCOPE CHECKS PASSED: state-scoped allocation behaves correctly."));
process.exit(failures ? 1 : 0);
