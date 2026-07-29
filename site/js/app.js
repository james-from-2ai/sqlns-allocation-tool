/**
 * UI controller. All calculation lives in engine.js / allocation.js /
 * quantification.js; this file only reads inputs, calls those, and renders.
 */

import { programParams, deriveRow } from "./engine.js";
import { allocate, totalsOf, costEffectiveness, meetsThreshold } from "./allocation.js";
import { byRiskCategory, byThreshold, byImpactTarget, costing } from "./quantification.js";
import { barChart, groupedBars, stackedBar, legend, fmt } from "./charts.js";
import { choropleth, categoryChoropleth } from "./maps.js";
import { heroMap } from "./hero.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];
const RISK_COLOR = {
  "1.1": "var(--risk-1-1)", "1.2": "var(--risk-1-2)", "1.3": "var(--risk-1-3)",
  "2": "var(--risk-2)", "3": "var(--risk-3)", "Not Classified": "var(--axis)",
};

/**
 * The hero sits on a fixed dark navy panel, so it cannot borrow the themed risk
 * ramp: in light mode those steps are dark blues, and the worst category
 * (#0d366b) resolves to 1.31:1 against the hero background, rendering the
 * highest-risk states nearly invisible. This ramp runs light to dark so severity
 * increases with prominence, and holds regardless of page theme.
 */
const HERO_RISK = {
  "1.1": "#dbe9fc",
  "1.2": "#a8cbf6",
  "1.3": "#74a9ee",
  "2": "#4585dc",
  "3": "#2b62a8",
  "Not Classified": "rgba(255,255,255,0.13)",
};

let DATA;          // base.json
let GEO = null;    // geo.json, loaded separately so the app works without it
let STRATEGIES;    // constants.strategies
let state = {};    // current inputs
const cache = {};  // derived rows + allocations, invalidated on input change

/* ------------------------------------------------------------------- boot */

async function boot() {
  const res = await fetch("data/base.json");
  if (!res.ok) throw new Error(`could not load base.json (${res.status})`);
  DATA = await res.json();
  STRATEGIES = DATA.constants.strategies;

  state = {
    totalCartons: 10000,
    ageRange: "6 to 23",
    duration: 6,
    enrollmentPeriod: 6,
    coverageCap: 0.75,
    level: "lgas",
    useThreshold: false,
    thresholds: { u5mr: 0, stunting: 0, wasting: 0 },
    useManual: false,
    manual: {},                 // state name -> cartons
    // true reproduces the workbook exactly, including the risk-1.3 defect;
    // false applies the intended rule. See docs/FINDINGS.md.
    bugCompat: true,
    strategy: "mortality",
    stateSelected: DATA.states[0],
    currency: "USD",
    quant: {
      ageRange: "6 to 18", duration: 6, enrollmentPeriod: 6, coverageCap: 0.75,
      level: "wards", costPerCartonNgn: 80000, markup: 0.2, currency: "NGN",
      mode: "risk", riskLevels: new Set(["1.1", "1.2", "1.3", "2"]),
      qState: "", thresholds: { u5mr: 90, stunting: 50, wasting: 10 },
      metric: "Stunting cases averted", target: 10000, strategy: "mortality",
    },
    mapMetric: "cartons",
    stMapMetric: "cartons",
  };

  // Boundaries are a progressive enhancement: if geo.json is missing or fails,
  // every table and chart still works, so this must not be fatal.
  loadGeo();

  $("#boot").remove();
  buildStaticControls();
  wireEvents();
  $("#scope-line").textContent =
    `Nigeria · ${DATA.wards.length.toLocaleString()} wards · ${DATA.lgas.length} LGAs · ${DATA.states.length} states`;
  show("inputs");
  recompute();
}

/** Fetch boundaries in the background and redraw once they arrive. */
async function loadGeo() {
  try {
    const res = await fetch("data/geo.json");
    if (!res.ok) throw new Error(String(res.status));
    GEO = await res.json();
    // index by state, and by state+LGA, for quick joins
    GEO.stateByName = new Map(GEO.states.map((f) => [f.state, f]));
    GEO.lgaByKey = new Map(GEO.lgas.map((f) => [`${f.state}||${f.lga}`, f]));
    const a = GEO.attribution;
    $("#attribution").innerHTML =
      `Boundaries: <a href="${a.url}" rel="noopener">${a.name}</a>, ${a.licence}. ${a.note}`;
    dirty.add("outputs");
    dirty.add("state");
    renderScreen(currentScreen);
    renderHero();
  } catch (err) {
    $("#attribution").textContent = "";
    for (const id of ["#state-map", "#st-map"]) {
      const node = $(id);
      if (node) {
        node.innerHTML = `<p class="muted small">Map data unavailable (${err.message}). ` +
          `All figures on this page are unaffected.</p>`;
      }
    }
  }
}

/* --------------------------------------------------------------- plumbing */

/** Geographies at the active level, with the level's own field shape. */
function geographies(level) {
  return level === "wards" ? DATA.wards : DATA.lgas;
}

/** Derived rows for a given input set. Cached, since this is the hot path. */
function derivedRows(inputs, key) {
  const k = `${key}:bc${state.bugCompat}`;
  if (cache[k]) return cache[k];
  const params = programParams(DATA.constants, inputs);
  const rows = geographies(inputs.level).map((g) => deriveRow(g, DATA.constants, params, state.bugCompat));
  cache[k] = rows;
  return rows;
}

function allocationInputs() {
  return {
    totalCartons: state.totalCartons,
    ageRange: state.ageRange,
    duration: state.duration,
    enrollmentPeriod: state.enrollmentPeriod,
    coverageCap: state.coverageCap,
    level: state.level,
    thresholds: state.useThreshold ? state.thresholds : { u5mr: 0, stunting: 0, wasting: 0 },
    cartonsAllocatedManually: manualTotal(),
    manualByState: manualMap(),
  };
}

function manualTotal() {
  if (!state.useManual) return 0;
  return Object.values(state.manual).reduce((s, v) => s + (Number(v) || 0), 0);
}
function manualMap() {
  const m = new Map();
  if (state.useManual) {
    for (const [k, v] of Object.entries(state.manual)) if (v) m.set(k.toLowerCase(), Number(v));
  }
  return m;
}

const RENDERERS = {
  inputs: renderInputs, outputs: renderOutputs, comparison: renderComparison,
  state: renderStateLevel, quant: renderQuant,
};
let currentScreen = "inputs";
const dirty = new Set();

/**
 * Invalidate caches, redraw the visible screen, and mark the rest stale.
 *
 * At ward level a full five-screen redraw costs well over a second, because the
 * comparison screen alone sorts 9,684 rows eight times. Rendering only what is
 * on screen keeps typing responsive; the others catch up when selected.
 */
function recompute() {
  for (const k of Object.keys(cache)) delete cache[k];
  for (const name of Object.keys(RENDERERS)) dirty.add(name);
  renderScreen(currentScreen);
}

function renderScreen(name) {
  RENDERERS[name]();
  dirty.delete(name);
}

function currentAllocation(strategy) {
  const inputs = allocationInputs();
  const rows = derivedRows(inputs, `alloc:${inputs.level}:${inputs.ageRange}:${inputs.duration}:${inputs.enrollmentPeriod}:${inputs.coverageCap}`);
  const alloc = allocate(rows, strategy, inputs);
  const detail = rows.map((row) => {
    const cartons = alloc.get(row) ?? 0;
    const share = row.cartonsNeeded > 0 ? Math.min(cartons / row.cartonsNeeded, 1) : 0;
    return {
      row, cartons, share,
      childrenTargeted: row.popEligible * share,
      deathsAverted: row.deathsAverted * share,
      stuntingAverted: row.stuntingAverted * share,
      samAverted: row.samAverted * share,
      anemiaAverted: row.anemiaAverted * share,
      dalysAverted: row.dalysAverted * share,
    };
  });
  return { rows, detail, totals: totalsOf(detail, inputs.level) };
}

/* -------------------------------------------------------- static controls */

function buildStaticControls() {
  for (const sel of ["#out-strategy", "#st-strategy"]) {
    $(sel).replaceChildren(...STRATEGIES.map((s) => new Option(s.label, s.id)));
  }
  $("#st-state").replaceChildren(...DATA.states.map((s) => new Option(s, s)));
  $("#in-cartons").value = state.totalCartons;
  $("#in-age").value = state.ageRange;
  $("#in-duration").value = state.duration;
  $("#in-enrol").value = state.enrollmentPeriod;
  $("#in-cap").value = state.coverageCap;
  $("#in-level").value = state.level;
  const q = state.quant;
  $("#q-age").value = q.ageRange; $("#q-duration").value = q.duration;
  $("#q-enrol").value = q.enrollmentPeriod; $("#q-cap").value = q.coverageCap;
  $("#q-level").value = q.level; $("#q-cost").value = q.costPerCartonNgn;
  $("#q-markup").value = q.markup; $("#q-currency").value = q.currency;

  // manual allocation table, one row per state
  const tbody = $("#manual-table tbody");
  tbody.replaceChildren(...DATA.states.map((s) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${s}</td>
      <td class="num"><input type="number" min="0" step="100" data-manual="${s}" value="0" style="min-width:96px"></td>
      <td class="num muted" data-need="${s}">-</td>`;
    return tr;
  }));
}

function wireEvents() {
  $$("nav.tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.screen)));

  const num = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);

  $("#in-cartons").addEventListener("input", (e) => { state.totalCartons = num(e.target.value, 0); recompute(); });
  $("#in-age").addEventListener("change", (e) => { state.ageRange = e.target.value; recompute(); });
  $("#in-duration").addEventListener("input", (e) => { state.duration = num(e.target.value, 0); recompute(); });
  $("#in-enrol").addEventListener("input", (e) => { state.enrollmentPeriod = num(e.target.value, 1); recompute(); });
  $("#in-cap").addEventListener("input", (e) => { state.coverageCap = num(e.target.value, 0); recompute(); });
  $("#in-level").addEventListener("change", (e) => { state.level = e.target.value; recompute(); });

  $("#use-threshold").addEventListener("change", (e) => {
    state.useThreshold = e.target.checked;
    $("#fs-threshold").dataset.active = String(e.target.checked);
    recompute();
  });
  for (const [id, key] of [["#th-u5mr", "u5mr"], ["#th-stunt", "stunting"], ["#th-wast", "wasting"]]) {
    $(id).addEventListener("input", (e) => { state.thresholds[key] = num(e.target.value, 0); recompute(); });
  }

  $("#bug-compat").addEventListener("change", (e) => { state.bugCompat = e.target.checked; recompute(); });

  $("#use-manual").addEventListener("change", (e) => {
    state.useManual = e.target.checked;
    $("#fs-manual").dataset.active = String(e.target.checked);
    recompute();
  });
  $("#manual-table").addEventListener("input", (e) => {
    const s = e.target.dataset.manual;
    if (!s) return;
    state.manual[s] = num(e.target.value, 0);
    recompute();
  });
  $("#man-clear").addEventListener("click", () => {
    state.manual = {};
    $$("[data-manual]").forEach((i) => (i.value = 0));
    recompute();
  });

  // The outputs and state screens share state.strategy, so changing it on one
  // stales the other.
  $("#out-strategy").addEventListener("change", (e) => {
    state.strategy = e.target.value;
    dirty.add("state");
    renderScreen("outputs");
  });
  $("#out-csv").addEventListener("click", downloadStateCsv);
  $("#cmp-currency").addEventListener("change", (e) => { state.currency = e.target.value; renderComparison(); });
  $("#st-state").addEventListener("change", (e) => {
    state.stateSelected = e.target.value;
    state.stateTouched = true;
    renderStateLevel();
  });
  $("#st-strategy").addEventListener("change", (e) => {
    state.strategy = e.target.value;
    $("#out-strategy").value = e.target.value;
    dirty.add("outputs");
    renderScreen("state");
  });
  $("#st-only-funded").addEventListener("change", renderStateLevel);
  $("#map-metric").addEventListener("change", (e) => { state.mapMetric = e.target.value; renderScreen("outputs"); });
  $("#st-map-metric").addEventListener("change", (e) => { state.stMapMetric = e.target.value; renderScreen("state"); });
  $("#st-csv").addEventListener("click", downloadDetailCsv);

  const q = state.quant;
  $("#q-age").addEventListener("change", (e) => { q.ageRange = e.target.value; renderQuant(); });
  $("#q-duration").addEventListener("input", (e) => { q.duration = num(e.target.value, 0); renderQuant(); });
  $("#q-enrol").addEventListener("input", (e) => { q.enrollmentPeriod = num(e.target.value, 1); renderQuant(); });
  $("#q-cap").addEventListener("input", (e) => { q.coverageCap = num(e.target.value, 0); renderQuant(); });
  $("#q-level").addEventListener("change", (e) => { q.level = e.target.value; renderQuant(); });
  $("#q-cost").addEventListener("input", (e) => { q.costPerCartonNgn = num(e.target.value, 0); renderQuant(); });
  $("#q-markup").addEventListener("input", (e) => { q.markup = num(e.target.value, 0); renderQuant(); });
  $("#q-currency").addEventListener("change", (e) => { q.currency = e.target.value; renderQuant(); });
  $("#q-mode").addEventListener("change", (e) => { q.mode = e.target.value; renderQuant(); });

  window.addEventListener("resize", debounce(() => {
    for (const name of Object.keys(RENDERERS)) if (name !== currentScreen) dirty.add(name);
    renderScreen(currentScreen);
  }, 180));
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function show(name) {
  currentScreen = name;
  $$("nav.tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.screen === name)));
  $$("section.screen").forEach((s) => (s.hidden = s.id !== `screen-${name}`));
  // Charts size themselves off clientWidth, which reads 0 while hidden, so a
  // stale screen must be drawn after it becomes visible, not before.
  if (dirty.has(name)) renderScreen(name);
}

/* --------------------------------------------------------- screen: inputs */

function renderInputs() {
  const inputs = allocationInputs();
  const rows = derivedRows(inputs, `alloc:${inputs.level}:${inputs.ageRange}:${inputs.duration}:${inputs.enrollmentPeriod}:${inputs.coverageCap}`);
  const unit = inputs.level === "wards" ? "wards" : "LGAs";

  renderFidelityNote(rows, unit);

  const totalNeed = rows.reduce((s, r) => s + r.cartonsNeeded, 0);
  const totalChildren = rows.reduce((s, r) => s + r.popEligible, 0);
  const covered = totalNeed > 0 ? state.totalCartons / totalNeed : 0;

  tiles("#input-tiles", [
    { label: "Total supply", value: fmt.int(state.totalCartons), sub: "cartons", hero: true },
    { label: "National need", value: fmt.compact(totalNeed), sub: `cartons, all ${rows.length.toLocaleString()} ${unit}` },
    { label: "Supply covers", value: fmt.pct(Math.min(covered, 1), 1), sub: "of national need" },
    { label: "Children eligible", value: fmt.compact(totalChildren), sub: "at full national coverage" },
    { label: "Cartons per child", value: fmt.dec(programParams(DATA.constants, inputs).cartonsPerChild, 3), sub: `${programParams(DATA.constants, inputs).sachetsPerChild} sachets` },
  ]);

  // threshold panel feedback
  const u5 = rows.map((r) => r.u5mr), st = rows.map((r) => r.stunting), wa = rows.map((r) => r.wasting);
  $("#th-range").textContent =
    `Observed across ${unit}: U5MR ${Math.floor(Math.min(...u5))} to ${Math.ceil(Math.max(...u5))}, ` +
    `stunting ${Math.floor(Math.min(...st))} to ${Math.ceil(Math.max(...st))}%, ` +
    `wasting ${Math.floor(Math.min(...wa))} to ${Math.ceil(Math.max(...wa))}%.`;
  if (state.useThreshold) {
    const hit = rows.filter((r) => meetsThreshold(r, state.thresholds));
    const need = hit.reduce((s, r) => s + r.cartonsNeeded, 0);
    $("#th-count").innerHTML = hit.length
      ? `<strong>${hit.length.toLocaleString()}</strong> of ${rows.length.toLocaleString()} ${unit} qualify, needing <strong>${fmt.compact(need)}</strong> cartons.`
      : `<span style="color:var(--critical)">No ${unit} clear all three thresholds. The threshold-based strategy would allocate nothing.</span>`;
  } else {
    $("#th-count").textContent = "";
  }

  // manual allocation panel
  const supply = state.totalCartons, alloc = manualTotal();
  $("#man-supply").textContent = fmt.int(supply);
  $("#man-alloc").textContent = fmt.int(alloc);
  $("#man-remain").textContent = fmt.int(supply - alloc);
  $("#manual-warn").innerHTML = alloc > supply
    ? `<div class="note bad">Manual allocation exceeds total supply by <strong>${fmt.int(alloc - supply)}</strong> cartons.
       The strategy pool is empty and the manual figures will over-commit.</div>`
    : alloc === supply && alloc > 0
      ? `<div class="note warn">All supply is committed manually, so the strategy pool is empty.
         Every strategy will return the same manual allocation.</div>`
      : "";
  const needByState = {};
  for (const r of rows) needByState[r.state] = (needByState[r.state] ?? 0) + r.cartonsNeeded;
  for (const [s, v] of Object.entries(needByState)) {
    const cell = $(`[data-need="${CSS.escape(s)}"]`);
    if (cell) cell.textContent = fmt.compact(v);
  }

  // risk mix
  const byRisk = new Map();
  for (const r of rows) {
    const k = String(r.riskCategory);
    const e = byRisk.get(k) ?? { n: 0, cartons: 0, children: 0 };
    e.n++; e.cartons += r.cartonsNeeded; e.children += r.popEligible;
    byRisk.set(k, e);
  }
  const order = [...DATA.constants.riskThresholds.map((t) => t.level), "Not Classified"];
  const labelOf = Object.fromEntries(DATA.constants.riskThresholds.map((t) => [t.level, t.label]));
  const segs = order.filter((k) => byRisk.has(k)).map((k) => ({
    label: labelOf[k] ?? k, value: byRisk.get(k).cartons, color: RISK_COLOR[k],
  }));
  legend($("#risk-legend"), segs.map((s) => ({ label: s.label, color: s.color })));
  stackedBar($("#risk-stack"), segs);

  const tb = $("#risk-table tbody");
  tb.replaceChildren(...order.filter((k) => byRisk.has(k)).map((k) => {
    const e = byRisk.get(k);
    const t = DATA.constants.riskThresholds.find((x) => x.level === k);
    // In bug-compatible mode the workbook's level 1.3 test ignores stunting, so
    // label the rule that actually ran rather than the one that was intended.
    const stuntingIgnored = state.bugCompat && k === "1.3";
    const crit = t
      ? stuntingIgnored
        ? `U5MR &ge; ${t.u5mr} <span class="muted">(stunting criterion dropped by the source defect)</span>`
        : `U5MR &ge; ${t.u5mr} and (stunting &ge; ${t.stunting}% or wasting &ge; ${t.wasting}%)`
      : "Meets no category";
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><span class="swatch-inline" style="background:${RISK_COLOR[k]}"></span>${labelOf[k] ?? k}</td>
      <td class="small muted">${crit}</td><td class="num">${fmt.int(e.n)}</td>
      <td class="num">${fmt.int(e.cartons)}</td><td class="num">${fmt.compact(e.children)}</td>`;
    return tr;
  }));
  $("#risk-table tfoot").innerHTML =
    `<tr><td>Total</td><td></td><td class="num">${fmt.int(rows.length)}</td>
     <td class="num">${fmt.int(totalNeed)}</td><td class="num">${fmt.compact(totalChildren)}</td></tr>`;
}

/* -------------------------------------------------------- screen: outputs */

function renderOutputs() {
  $("#out-strategy").value = state.strategy;
  const meta = STRATEGIES.find((s) => s.id === state.strategy);
  $("#out-strategy-desc").textContent = meta.description;
  $("#out-level-pill").textContent = state.level === "wards" ? "Ward level" : "LGA level";

  const { detail, totals } = currentAllocation(state.strategy);

  tiles("#out-tiles", [
    { label: "Cartons allocated", value: fmt.int(totals.cartons), hero: true },
    { label: "Children targeted", value: fmt.compact(totals.childrenTargeted) },
    { label: "LGAs targeted", value: fmt.int(totals.lgasTargeted) },
    { label: "Wards targeted", value: fmt.int(totals.wardsTargeted) },
    { label: "Deaths averted", value: fmt.int(totals.deathsAverted) },
    { label: "Stunting averted", value: fmt.int(totals.stuntingAverted) },
    { label: "SAM averted", value: fmt.int(totals.samAverted) },
    { label: "DALYs averted", value: fmt.compact(totals.dalysAverted) },
  ]);

  renderStateMap(detail);

  // by zone
  const zones = aggregate(detail, (d) => DATA.zones[d.row.state] ?? "Unknown");
  const zoneList = [...zones.entries()].sort((a, b) => b[1].cartons - a[1].cartons);
  barChart($("#zone-chart"), zoneList.map(([z, v]) => ({
    label: z, value: v.cartons, color: "var(--series-1)",
    tip: `<div class="tt-title">${z}</div>${fmt.int(v.cartons)} cartons<br>${fmt.compact(v.childrenTargeted)} children`,
  })), { valueFormat: fmt.compact, labelWidth: 128 });
  barChart($("#zone-deaths-chart"), zoneList
    .map(([z, v]) => ({ label: z, value: v.deathsAverted, color: "var(--series-3)" }))
    .sort((a, b) => b.value - a.value), { valueFormat: (v) => fmt.int(v), labelWidth: 128 });

  // by state
  const byState = aggregate(detail, (d) => d.row.state);
  const list = [...byState.entries()].filter(([, v]) => v.cartons > 0).sort((a, b) => b[1].cartons - a[1].cartons);
  const tb = $("#state-table tbody");
  tb.replaceChildren(...list.map(([s, v]) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${s}</td><td class="muted">${DATA.zones[s] ?? ""}</td>
      <td class="num">${fmt.int(v.cartons)}</td><td class="num">${fmt.pct(v.cartons / (totals.cartons || 1), 1)}</td>
      <td class="num">${fmt.int(v.lgas.size)}</td><td class="num">${fmt.int(v.wards)}</td>
      <td class="num">${fmt.compact(v.childrenTargeted)}</td><td class="num">${fmt.int(v.deathsAverted)}</td>
      <td class="num">${fmt.int(v.stuntingAverted)}</td><td class="num">${fmt.int(v.samAverted)}</td>
      <td class="num">${fmt.int(v.anemiaAverted)}</td><td class="num">${fmt.compact(v.dalysAverted)}</td>`;
    return tr;
  }));
  $("#state-table tfoot").innerHTML = list.length
    ? `<tr><td>Total</td><td></td><td class="num">${fmt.int(totals.cartons)}</td><td class="num">100%</td>
       <td class="num">${fmt.int(totals.lgasTargeted)}</td><td class="num">${fmt.int(totals.wardsTargeted)}</td>
       <td class="num">${fmt.compact(totals.childrenTargeted)}</td><td class="num">${fmt.int(totals.deathsAverted)}</td>
       <td class="num">${fmt.int(totals.stuntingAverted)}</td><td class="num">${fmt.int(totals.samAverted)}</td>
       <td class="num">${fmt.int(totals.anemiaAverted)}</td><td class="num">${fmt.compact(totals.dalysAverted)}</td></tr>`
    : `<tr><td colspan="12" class="muted">Nothing allocated under these settings.</td></tr>`;
}

/**
 * Explain the fidelity switch, and count live how many geographies the
 * risk-1.3 defect actually moves at the current settings.
 */
function renderFidelityNote(rows, unit) {
  const t13 = DATA.constants.riskThresholds.find((x) => x.level === "1.3");
  // Reclassify under the opposite rule and count the disagreements.
  let moved = 0;
  for (const r of rows) {
    const buggy13 = r.u5mr >= t13.u5mr;
    const proper13 = r.u5mr >= t13.u5mr && (r.stunting >= t13.stunting || r.wasting >= t13.wasting);
    // Only rows that fall through to the 1.3 test can differ, so check that the
    // row is not already claimed by 1.1 or 1.2.
    const higher = DATA.constants.riskThresholds
      .filter((x) => x.level === "1.1" || x.level === "1.2")
      .some((x) => r.u5mr >= x.u5mr && (r.stunting >= x.stunting || r.wasting >= x.wasting));
    if (!higher && buggy13 !== proper13) moved++;
  }

  $("#bug-note").innerHTML = state.bugCompat
    ? `<div class="note warn">
         Running <strong>as the source workbook does</strong>, so figures here match it.
         A dangling cell reference in the sheet drops the stunting criterion from risk
         level 1.3, reducing that test to under-5 mortality alone. At these settings it
         promotes <strong>${moved.toLocaleString()}</strong> ${unit} into "Very High, Level 3"
         that do not meet its stunting or wasting criteria. This defect is live in the
         Google Sheet, not just the exported file.
       </div>`
    : `<div class="note">
         Running the <strong>intended</strong> rule: level 1.3 requires
         U5MR &ge; ${t13.u5mr} and (stunting &ge; ${t13.stunting}% or wasting &ge; ${t13.wasting}%).
         <strong>${moved.toLocaleString()}</strong> ${unit} are classified differently from the
         source workbook. Figures on these screens will not match it.
       </div>`;
}

/**
 * Hero graphic. Runs once when boundaries arrive; it is a landing visual rather
 * than a live view, so it does not re-render on every input change.
 */
function renderHero() {
  if (!GEO) return;

  // Worst (lowest-numbered) risk category present in each state, at the
  // workbook's own default program inputs.
  const inputs = allocationInputs();
  const rows = derivedRows(inputs, `alloc:${inputs.level}:${inputs.ageRange}:${inputs.duration}:${inputs.enrollmentPeriod}:${inputs.coverageCap}`);
  const worst = {};
  for (const r of rows) {
    const v = String(r.riskCategory);
    if (!worst[r.state] || rankRisk(v) < rankRisk(worst[r.state])) worst[r.state] = v;
  }

  heroMap($("#hero-map"), GEO.states, (s) => worst[s] ?? "Not Classified",
    (level) => HERO_RISK[level] ?? HERO_RISK["Not Classified"]);

  const totalNeed = rows.reduce((s, r) => s + r.cartonsNeeded, 0);
  const children = rows.reduce((s, r) => s + r.popEligible, 0);
  const highRisk = rows.filter((r) => String(r.riskCategory).startsWith("1")).length;
  $("#hero-stats").innerHTML = [
    [fmt.int(DATA.wards.length), "wards"],
    [fmt.int(DATA.lgas.length), "LGAs"],
    [fmt.compact(children), "children eligible"],
    [fmt.compact(totalNeed), "cartons of need"],
    [fmt.int(highRisk), `very high risk ${inputs.level === "wards" ? "wards" : "LGAs"}`],
  ].map(([n, k]) => `<div class="hero-stat"><div class="n">${n}</div><div class="k">${k}</div></div>`).join("");

  // Legend, so the shading means something rather than just looking like a map.
  const present = new Set(Object.values(worst));
  const order = [...DATA.constants.riskThresholds, { level: "Not Classified", label: "Unclassified" }];
  const swatches = order
    .filter((t) => present.has(t.level))
    .map((t) => `<span class="hero-key"><i style="background:${HERO_RISK[t.level]}"></i>${t.label}</span>`)
    .join("");
  $("#hero-caption").innerHTML =
    `<span class="hero-caption-label">Highest risk category present, by state</span>` +
    `<span class="hero-keys">${swatches}</span>`;

  // Show the logo only if the asset is actually there, so a missing file leaves
  // no broken image.
  const logo = $("#hero-logo");
  if (logo && logo.hidden) {
    logo.addEventListener("load", () => { logo.hidden = false; }, { once: true });
    logo.addEventListener("error", () => { logo.remove(); }, { once: true });
    logo.src = logo.getAttribute("src");
  }
}

/** National choropleth by state, on the outputs screen. */
function renderStateMap(detail) {
  if (!GEO) return;
  const byState = aggregate(detail, (d) => d.row.state);
  const needByState = {};
  for (const d of detail) needByState[d.row.state] = (needByState[d.row.state] ?? 0) + d.row.cartonsNeeded;
  // worst (lowest-numbered) risk category present in each state
  const riskByState = {};
  for (const d of detail) {
    const cur = riskByState[d.row.state];
    const v = String(d.row.riskCategory);
    if (!cur || rankRisk(v) < rankRisk(cur)) riskByState[d.row.state] = v;
  }

  const feats = GEO.states;
  const nameOf = (f) => f.state;
  const detailOf = (f) => {
    const v = byState.get(f.state);
    const need = needByState[f.state] ?? 0;
    if (!v) return `No allocation<br>Need ${fmt.compact(need)} cartons`;
    return `${fmt.int(v.cartons)} of ${fmt.compact(need)} cartons needed ` +
      `(${fmt.pct(need ? v.cartons / need : 0, 1)})<br>` +
      `${fmt.int(v.deathsAverted)} deaths averted · ${DATA.zones[f.state] ?? ""}`;
  };
  const goToState = (f) => {
    state.stateSelected = f.state;
    state.stateTouched = true;
    dirty.add("state");
    show("state");
  };

  const metric = state.mapMetric;
  if (metric === "risk") {
    categoryChoropleth($("#state-map"), feats, (f) => riskByState[f.state] ?? "Not Classified",
      RISK_COLOR, {
        label: nameOf, detail: detailOf, onClick: goToState,
        legendInto: $("#map-legend"), height: 620,
        order: [...DATA.constants.riskThresholds.map((t) => t.level), "Not Classified"],
      });
    return;
  }

  const valueOf = (f) => {
    const v = byState.get(f.state);
    if (!v) return 0;
    if (metric === "coverage") {
      const need = needByState[f.state] ?? 0;
      return need ? v.cartons / need : 0;
    }
    return v[metric] ?? 0;
  };
  const format = metric === "coverage" ? (n) => fmt.pct(n, 1) : fmt.compact;
  choropleth($("#state-map"), feats, valueOf, {
    label: nameOf, detail: detailOf, onClick: goToState, format,
    legendInto: $("#map-legend"), height: 620,
    unit: metric === "cartons" ? "cartons" : "",
  });
}

/** Lower is worse, so 1.1 sorts first and "Not Classified" last. */
function rankRisk(level) {
  const n = Number(level);
  return Number.isNaN(n) ? 99 : n;
}

/** LGA choropleth for the selected state, on the state screen. */
function renderStateLgaMap(mine) {
  if (!GEO) return;
  const feats = [];
  const byKey = new Map();
  for (const d of mine) {
    // At ward level several rows share an LGA, so aggregate up to it first.
    const key = `${d.row.state}||${d.row.lga}`;
    const e = byKey.get(key) ?? { cartons: 0, cartonsNeeded: 0, u5mr: 0, stunting: 0, n: 0, risk: null };
    e.cartons += d.cartons;
    e.cartonsNeeded += d.row.cartonsNeeded;
    e.u5mr += d.row.u5mr;
    e.stunting += d.row.stunting;
    e.n++;
    const v = String(d.row.riskCategory);
    if (!e.risk || rankRisk(v) < rankRisk(e.risk)) e.risk = v;
    byKey.set(key, e);
  }
  for (const key of byKey.keys()) {
    const f = GEO.lgaByKey.get(key);
    if (f) feats.push(f);
  }

  const missing = byKey.size - feats.length;
  $("#st-map-note").textContent = missing
    ? `${missing} of ${byKey.size} LGAs in this state have no boundary match and are not drawn.`
    : "";

  const stats = (f) => byKey.get(`${f.state}||${f.lga}`) ?? { cartons: 0, cartonsNeeded: 0, n: 1, u5mr: 0, stunting: 0, risk: "Not Classified" };
  const label = (f) => f.lga;
  const detailOf = (f) => {
    const e = stats(f);
    return `${fmt.int(e.cartons)} of ${fmt.int(e.cartonsNeeded)} cartons ` +
      `(${fmt.pct(e.cartonsNeeded ? e.cartons / e.cartonsNeeded : 0, 0)})<br>` +
      `U5MR ${fmt.dec(e.u5mr / e.n)} · stunting ${fmt.dec(e.stunting / e.n)}% · risk ${e.risk}`;
  };

  const metric = state.stMapMetric;
  if (metric === "risk") {
    categoryChoropleth($("#st-map"), feats, (f) => stats(f).risk, RISK_COLOR, {
      label, detail: detailOf, legendInto: $("#st-map-legend"), height: 560,
      order: [...DATA.constants.riskThresholds.map((t) => t.level), "Not Classified"],
    });
    return;
  }
  const valueOf = (f) => {
    const e = stats(f);
    if (metric === "coverage") return e.cartonsNeeded ? e.cartons / e.cartonsNeeded : 0;
    if (metric === "u5mr") return e.u5mr / e.n;
    if (metric === "stunting") return e.stunting / e.n;
    if (metric === "cartonsNeeded") return e.cartonsNeeded;
    return e.cartons;
  };
  const format = metric === "coverage" ? (n) => fmt.pct(n, 0)
    : (metric === "u5mr" || metric === "stunting") ? (n) => fmt.dec(n, 1) : fmt.compact;
  choropleth($("#st-map"), feats, valueOf, {
    label, detail: detailOf, format, legendInto: $("#st-map-legend"), height: 560,
  });
}

function aggregate(detail, keyFn) {
  const m = new Map();
  for (const d of detail) {
    if (d.cartons <= 0) continue;
    const k = keyFn(d);
    const e = m.get(k) ?? {
      cartons: 0, childrenTargeted: 0, deathsAverted: 0, stuntingAverted: 0,
      samAverted: 0, anemiaAverted: 0, dalysAverted: 0, lgas: new Set(), wards: 0,
    };
    e.cartons += d.cartons;
    e.childrenTargeted += d.childrenTargeted;
    e.deathsAverted += d.deathsAverted;
    e.stuntingAverted += d.stuntingAverted;
    e.samAverted += d.samAverted;
    e.anemiaAverted += d.anemiaAverted;
    e.dalysAverted += d.dalysAverted;
    e.lgas.add(`${d.row.state}||${d.row.lga}`);
    e.wards += state.level === "wards" ? 1 : d.row.nWards ?? 0;
    m.set(k, e);
  }
  return m;
}

/* ----------------------------------------------------- screen: comparison */

function renderComparison() {
  const results = STRATEGIES.map((s) => ({ meta: s, ...currentAllocation(s.id) }));
  const colors = Object.fromEntries(STRATEGIES.map((s, i) => [s.id, SERIES[i]]));

  legend($("#cmp-legend"), STRATEGIES.map((s) => ({ label: s.label, color: colors[s.id] })));

  const METRICS = [
    ["Deaths averted", "deathsAverted"], ["Stunting cases averted", "stuntingAverted"],
    ["SAM cases averted", "samAverted"], ["Anemia cases averted", "anemiaAverted"],
    ["DALYs averted", "dalysAverted"], ["Children targeted", "childrenTargeted"],
  ];
  groupedBars($("#cmp-chart"), METRICS.map(([label, field]) => ({
    label,
    bars: results.map((r) => ({ series: r.meta.label, value: r.totals[field], color: colors[r.meta.id] })),
  })));

  $("#cmp-table tbody").replaceChildren(...results.map((r) => {
    const t = r.totals;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><span class="swatch-inline" style="background:${colors[r.meta.id]}"></span>${r.meta.label}</td>
      <td class="num">${fmt.int(t.cartons)}</td><td class="num">${fmt.int(t.lgasTargeted)}</td>
      <td class="num">${fmt.int(t.wardsTargeted)}</td><td class="num">${fmt.compact(t.childrenTargeted)}</td>
      <td class="num">${fmt.int(t.deathsAverted)}</td><td class="num">${fmt.int(t.stuntingAverted)}</td>
      <td class="num">${fmt.int(t.samAverted)}</td><td class="num">${fmt.int(t.anemiaAverted)}</td>
      <td class="num">${fmt.compact(t.dalysAverted)}</td>`;
    return tr;
  }));

  // cost-effectiveness
  const c = DATA.constants;
  const perGeo = c.deliveryCostPerChildUsd *
    (state.level === "wards" ? avgChildrenPerWard() : avgChildrenPerLga());
  const cur = state.currency;
  const conv = (usd) => (usd == null ? null : cur === "NGN" ? usd * c.ngnPerUsd : usd);
  const money = (usd) => (usd == null ? "n/a" : fmt.money(conv(usd), cur));

  $("#cea-table tbody").replaceChildren(...results.map((r) => {
    const ce = costEffectiveness(r.totals, c, state.level, perGeo);
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><span class="swatch-inline" style="background:${colors[r.meta.id]}"></span>${r.meta.label}</td>
      <td class="num">${money(ce.totalUsd)}</td><td class="num">${money(ce.perDeathUsd)}</td>
      <td class="num">${money(ce.perStuntingUsd)}</td><td class="num">${money(ce.perSamUsd)}</td>
      <td class="num">${money(ce.perAnemiaUsd)}</td><td class="num">${money(ce.perDalyUsd)}</td>`;
    return tr;
  }));
}

/** Workbook 'Hard-coded Inputs' C17/C18: average children in the selected age range. */
function avgChildrenPerLga() {
  const share = DATA.constants.ageRangeShare[state.ageRange] / DATA.constants.ageRangeShare["6 to 23"];
  const total = DATA.wards.reduce(
    (s, w) => s + w.popTotal * DATA.constants.u5ShareOfPopulation *
      DATA.constants.ageRangeShare["6 to 23"] * (1 - w.sam / 100), 0);
  return (total / DATA.constants.nLgas) * share;
}
function avgChildrenPerWard() {
  return (avgChildrenPerLga() * DATA.constants.nLgas) / DATA.constants.nWards;
}

/* --------------------------------------------------- screen: state detail */

function renderStateLevel() {
  $("#st-strategy").value = state.strategy;
  const { detail, totals } = currentAllocation(state.strategy);

  // Opening on a state that receives nothing reads as a broken screen, so if
  // the user has not chosen one yet, land on the largest recipient.
  if (!state.stateTouched) {
    const byState = aggregate(detail, (d) => d.row.state);
    const top = [...byState.entries()].sort((a, b) => b[1].cartons - a[1].cartons)[0];
    if (top) state.stateSelected = top[0];
  }
  $("#st-state").value = state.stateSelected;
  const mine = detail.filter((d) => d.row.state === state.stateSelected);
  const unit = state.level === "wards" ? "wards" : "LGAs";

  const st = totalsOf(mine, state.level);
  const need = mine.reduce((s, d) => s + d.row.cartonsNeeded, 0);
  tiles("#st-tiles", [
    { label: "Cartons allocated", value: fmt.int(st.cartons), hero: true },
    { label: "Share of national", value: fmt.pct(totals.cartons ? st.cartons / totals.cartons : 0, 1) },
    { label: "State need", value: fmt.compact(need), sub: "cartons" },
    { label: "Need covered", value: fmt.pct(need ? st.cartons / need : 0, 1) },
    { label: `${unit === "wards" ? "Wards" : "LGAs"} funded`, value: fmt.int(mine.filter((d) => d.cartons > 0).length), sub: `of ${mine.length}` },
    { label: "Deaths averted", value: fmt.int(st.deathsAverted) },
    { label: "DALYs averted", value: fmt.compact(st.dalysAverted) },
  ]);

  renderStateLgaMap(mine);

  const top = mine.filter((d) => d.cartons > 0).sort((a, b) => b.cartons - a.cartons).slice(0, 15);
  barChart($("#st-chart"), top.map((d) => ({
    label: state.level === "wards" ? `${d.row.ward}` : d.row.lga,
    value: d.cartons,
    color: RISK_COLOR[String(d.row.riskCategory)] ?? "var(--series-1)",
    tip: `<div class="tt-title">${d.row.lga}${d.row.ward ? " · " + d.row.ward : ""}</div>
      ${fmt.int(d.cartons)} of ${fmt.int(d.row.cartonsNeeded)} cartons (${fmt.pct(d.share, 0)})<br>
      Risk ${d.row.riskCategory} · U5MR ${fmt.dec(d.row.u5mr)} · stunting ${fmt.dec(d.row.stunting)}%`,
  })), { valueFormat: fmt.compact, labelWidth: 168 });

  $("#st-table-title").textContent =
    `${state.stateSelected}: ${state.level === "wards" ? "ward" : "LGA"} detail`;
  $$(".ward-col").forEach((th) => (th.hidden = state.level !== "wards"));

  const onlyFunded = $("#st-only-funded").checked;
  const shown = (onlyFunded ? mine.filter((d) => d.cartons > 0) : mine)
    .sort((a, b) => b.cartons - a.cartons || b.row.u5mr - a.row.u5mr);

  $("#st-table tbody").replaceChildren(...shown.map((d) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${d.row.lga}</td>
      ${state.level === "wards" ? `<td>${d.row.ward}${d.row.estimated ? ' <span class="muted" title="Ward-level data unavailable; LGA-level estimate used">*</span>' : ""}</td>` : '<td hidden></td>'}
      <td class="num"><span class="swatch-inline" style="background:${RISK_COLOR[String(d.row.riskCategory)]}"></span>${d.row.riskCategory}</td>
      <td class="num">${fmt.dec(d.row.u5mr)}</td><td class="num">${fmt.dec(d.row.stunting)}</td>
      <td class="num">${fmt.dec(d.row.wasting)}</td><td class="num">${fmt.int(d.row.cartonsNeeded)}</td>
      <td class="num">${fmt.int(d.cartons)}</td><td class="num">${fmt.pct(d.share, 0)}</td>
      <td class="num">${fmt.dec(d.deathsAverted, 1)}</td><td class="num">${fmt.dec(d.dalysAverted, 0)}</td>`;
    return tr;
  }));
  $("#st-table tfoot").innerHTML = shown.length
    ? `<tr><td>Total</td>${state.level === "wards" ? "<td></td>" : "<td hidden></td>"}<td></td><td></td><td></td><td></td>
       <td class="num">${fmt.int(shown.reduce((s, d) => s + d.row.cartonsNeeded, 0))}</td>
       <td class="num">${fmt.int(shown.reduce((s, d) => s + d.cartons, 0))}</td><td></td>
       <td class="num">${fmt.dec(shown.reduce((s, d) => s + d.deathsAverted, 0), 1)}</td>
       <td class="num">${fmt.dec(shown.reduce((s, d) => s + d.dalysAverted, 0), 0)}</td></tr>`
    : `<tr><td colspan="11" class="muted">No geographies to show.</td></tr>`;

  const nEst = mine.filter((d) => d.row.estimated).length;
  $("#st-estimated-note").textContent = nEst
    ? `* ${nEst} ward${nEst === 1 ? "" : "s"} in this state had no ward-level match in the source data; the LGA-level estimate was used.`
    : "";
}

/* -------------------------------------------------- screen: quantification */

function renderQuant() {
  const q = state.quant;
  const inputs = {
    ageRange: q.ageRange, duration: q.duration, enrollmentPeriod: q.enrollmentPeriod,
    coverageCap: q.coverageCap, level: q.level,
  };
  const params = programParams(DATA.constants, inputs);
  const rows = derivedRows(inputs, `quant:${q.level}:${q.ageRange}:${q.duration}:${q.enrollmentPeriod}:${q.coverageCap}`);

  // mode-specific controls
  const ctl = $("#q-controls");
  const extra = $("#q-mode-extra");
  extra.replaceChildren();
  ctl.replaceChildren();

  let result;
  if (q.mode === "risk") {
    const stateSel = document.createElement("select");
    stateSel.append(new Option("All of Nigeria", ""));
    for (const s of DATA.states) stateSel.append(new Option(s, s));
    stateSel.value = q.qState;
    stateSel.addEventListener("change", (e) => { q.qState = e.target.value; renderQuant(); });
    extra.append(Object.assign(document.createElement("label"), { textContent: "State" }), stateSel);

    const box = document.createElement("div");
    box.innerHTML = `<p class="small muted">Select risk categories to cover:</p>`;
    for (const t of DATA.constants.riskThresholds) {
      const line = document.createElement("label");
      line.className = "checkline";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = q.riskLevels.has(t.level);
      cb.addEventListener("change", () => {
        cb.checked ? q.riskLevels.add(t.level) : q.riskLevels.delete(t.level);
        renderQuant();
      });
      line.append(cb,
        Object.assign(document.createElement("span"), {
          className: "swatch-inline", style: `background:${RISK_COLOR[t.level]}`,
        }),
        document.createTextNode(`${t.label} (${t.level})`));
      box.append(line);
    }
    ctl.append(box);
    result = byRiskCategory(rows, { state: q.qState || null, levels: [...q.riskLevels], level: q.level });

  } else if (q.mode === "threshold") {
    const box = document.createElement("div");
    box.innerHTML = `<p class="small muted">
      The workbook uses a strict greater-than here, unlike the allocation
      thresholds which use greater-or-equal. Reproduced as-is.</p>`;
    for (const [key, label, step] of [["u5mr", "Under-5 mortality &gt; (per 1,000)", 1],
                                      ["stunting", "Stunting prevalence &gt; (%)", 1],
                                      ["wasting", "Wasting prevalence &gt; (%)", 1]]) {
      const f = document.createElement("div");
      f.className = "field";
      f.innerHTML = `<label>${label}</label><input type="number" step="${step}" min="0" value="${q.thresholds[key]}">`;
      f.querySelector("input").addEventListener("input", (e) => {
        q.thresholds[key] = parseFloat(e.target.value) || 0;
        renderQuant();
      });
      box.append(f);
    }
    ctl.append(box);
    result = byThreshold(rows, { thresholds: q.thresholds, level: q.level });

  } else {
    const metricSel = document.createElement("select");
    for (const m of ["Deaths averted", "Stunting cases averted", "SAM cases averted", "Anemia cases averted", "DALYs averted"]) {
      metricSel.append(new Option(m, m));
    }
    metricSel.value = q.metric;
    metricSel.addEventListener("change", (e) => { q.metric = e.target.value; renderQuant(); });

    const targetIn = document.createElement("input");
    targetIn.type = "number"; targetIn.min = "0"; targetIn.step = "1000"; targetIn.value = q.target;
    targetIn.addEventListener("input", (e) => { q.target = parseFloat(e.target.value) || 0; renderQuant(); });

    const stratSel = document.createElement("select");
    stratSel.append(...STRATEGIES.filter((s) => s.id !== "equal").map((s) => new Option(s.label, s.id)));
    stratSel.value = q.strategy === "equal" ? "mortality" : q.strategy;
    stratSel.addEventListener("change", (e) => { q.strategy = e.target.value; renderQuant(); });

    extra.append(
      Object.assign(document.createElement("label"), { textContent: "Metric" }), metricSel,
      Object.assign(document.createElement("label"), { textContent: "Target" }), targetIn,
      Object.assign(document.createElement("label"), { textContent: "Priority order" }), stratSel);

    const ordered = orderByStrategy(rows, stratSel.value);
    result = byImpactTarget(ordered, { metric: q.metric, target: q.target, level: q.level });
    if (!result.targetMet && q.target > 0) {
      $("#q-notice").innerHTML =
        `<div class="note warn">A target of <strong>${fmt.int(q.target)}</strong> ${q.metric.toLowerCase()}
         is beyond what full national coverage achieves under these program inputs.
         Figures below show full national coverage.</div>`;
    } else {
      $("#q-notice").replaceChildren();
    }
  }
  if (q.mode !== "impact") $("#q-notice").replaceChildren();

  const cost = costing(result.cartons, {
    costPerCartonNgn: q.costPerCartonNgn, markup: q.markup,
    constants: DATA.constants, sachetsPerChild: params.sachetsPerChild,
  });
  const money = (n) => (q.currency === "NGN" ? fmt.ngn(n) : fmt.usd(n));
  const budget = q.currency === "NGN" ? cost.budgetNgn : cost.budgetUsd;

  tiles("#q-tiles", [
    { label: "Cartons needed", value: fmt.int(result.cartons), hero: true },
    { label: "Budget required", value: money(budget) },
    { label: "Children targeted", value: fmt.compact(result.childrenTargeted) },
    { label: "LGAs targeted", value: fmt.int(result.lgasTargeted) },
    { label: "Wards targeted", value: fmt.int(result.wardsTargeted) },
    { label: "Deaths averted", value: fmt.int(result.deathsAverted) },
    { label: "Stunting averted", value: fmt.int(result.stuntingAverted) },
    { label: "DALYs averted", value: fmt.compact(result.dalysAverted) },
  ]);

  const byState = new Map();
  for (const r of result.rows) byState.set(r.state, (byState.get(r.state) ?? 0) + r.cartonsNeeded);
  const list = [...byState.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  barChart($("#q-chart"), list.map(([s, v]) => ({
    label: s, value: v, color: "var(--series-1)",
    tip: `<div class="tt-title">${s}</div>${fmt.int(v)} cartons`,
  })), { valueFormat: fmt.compact, labelWidth: 128 });
}

/** Priority order used by a strategy, for the impact-target walk. */
function orderByStrategy(rows, strategy) {
  const copy = [...rows];
  if (strategy === "stunting") {
    copy.sort((a, b) => b.stunting - a.stunting || b.u5mr - a.u5mr);
  } else if (strategy === "threshold") {
    const rank = (r) => (Number(r.riskCategory) || 99);
    copy.sort((a, b) => rank(a) - rank(b) || b.u5mr - a.u5mr);
  } else {
    copy.sort((a, b) => b.u5mr - a.u5mr || b.stunting - a.stunting);
  }
  return copy;
}

/* --------------------------------------------------------------- utilities */

function tiles(sel, items) {
  $(sel).replaceChildren(...items.map((t) => {
    const d = document.createElement("div");
    d.className = "tile" + (t.hero ? " hero" : "");
    d.innerHTML = `<div class="label">${t.label}</div><div class="value">${t.value}</div>` +
      (t.sub ? `<div class="sub">${t.sub}</div>` : "");
    return d;
  }));
}

function downloadCsv(name, header, rows) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

function downloadStateCsv() {
  const { detail } = currentAllocation(state.strategy);
  const byState = aggregate(detail, (d) => d.row.state);
  downloadCsv(`sqlns-${state.strategy}-by-state.csv`,
    ["State", "Zone", "Cartons", "LGAs", "Wards", "Children", "Deaths averted", "Stunting averted", "SAM averted", "Anemia averted", "DALYs averted"],
    [...byState.entries()].sort((a, b) => b[1].cartons - a[1].cartons).map(([s, v]) =>
      [s, DATA.zones[s] ?? "", Math.round(v.cartons), v.lgas.size, v.wards,
       Math.round(v.childrenTargeted), v.deathsAverted.toFixed(2), v.stuntingAverted.toFixed(2),
       v.samAverted.toFixed(2), v.anemiaAverted.toFixed(2), v.dalysAverted.toFixed(2)]));
}

function downloadDetailCsv() {
  const { detail } = currentAllocation(state.strategy);
  const mine = detail.filter((d) => d.row.state === state.stateSelected);
  downloadCsv(`sqlns-${state.stateSelected}-${state.strategy}.csv`,
    ["State", "LGA", "Ward", "Risk category", "U5MR", "Stunting %", "Wasting %", "Cartons needed", "Cartons allocated", "Coverage", "Deaths averted", "DALYs averted", "LGA-level estimate"],
    mine.sort((a, b) => b.cartons - a.cartons).map((d) =>
      [d.row.state, d.row.lga, d.row.ward ?? "", d.row.riskCategory, d.row.u5mr.toFixed(2),
       d.row.stunting.toFixed(2), d.row.wasting.toFixed(2), d.row.cartonsNeeded,
       Math.round(d.cartons), d.share.toFixed(4), d.deathsAverted.toFixed(3),
       d.dalysAverted.toFixed(2), d.row.estimated ? "yes" : "no"]));
}

boot().catch((err) => {
  const p = $("#boot") ?? document.body;
  p.innerHTML = `<div class="note bad"><strong>Could not start.</strong> ${err.message}<br>
    <span class="small">If you opened this file directly, run a local server instead:
    <code>python -m http.server</code> in the <code>site</code> folder, then open
    <code>http://localhost:8000</code>. Browsers block module and fetch loads from <code>file://</code>.</span></div>`;
});

