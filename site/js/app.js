/**
 * UI controller. All calculation lives in engine.js / allocation.js /
 * quantification.js; this file only reads inputs, calls those, and renders.
 */

import { programParams, deriveRow } from "./engine.js";
import { allocate, totalsOf, costEffectiveness, supplyCurve } from "./allocation.js";
import { byRiskCategory, byThreshold, byImpactTarget, costing } from "./quantification.js";
import { barChart, winnerGroups, stackedBar, lineChart, legend, fmt } from "./charts.js";
import { choropleth, categoryChoropleth } from "./maps.js";
import { heroMap, heroDots } from "./hero.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];

/** Short forms, so the comparison chart can label bars directly instead of
 *  sending the reader to a legend. */
/** Strategies shown in the interface, in display order. */
const PRESENTED = ["threshold", "equal"];

/**
 * "Threshold-based strategy" was renamed at the stakeholder's request. Of the two
 * names offered, "Burden-based" describes what it does, which is target the
 * highest-burden geographies first. "Impact-based" would have implied it
 * optimizes impact directly, which is closer to what the withdrawn mortality and
 * stunting strategies did.
 */
const RELABEL = { threshold: "Burden-based strategy" };

const SHORT_NAME = {
  mortality: "U2 deaths",
  stunting: "Stunting",
  threshold: "Burden-based",
  equal: "Equal",
};

/** Two totals within a hair of each other are a tie, after float error. */
function nearlyEqual(a, b) {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale > 0 && Math.abs(a - b) / scale < 5e-4;
}
/**
 * Risk shading: darker means more severe, the conventional reading. One ramp
 * serves every map, including the hero, because they all render on a light plate
 * regardless of page theme. See the note in styles.css.
 */
const RISK_COLOR = {
  "1.1": "var(--risk-1-1)", "1.2": "var(--risk-1-2)", "1.3": "var(--risk-1-3)",
  "2": "var(--risk-2)", "3": "var(--risk-3)", "Not Classified": "var(--risk-none)",
};

let DATA;          // base.json
let GEO = null;    // geo.json, loaded separately so the app works without it
let ALL_STRATEGIES;   // all four, kept so the engine and parity test are unchanged
let STRATEGIES;       // the subset presented to users
let state = {};    // current inputs
const cache = {};  // derived rows + allocations, invalidated on input change

/* ------------------------------------------------------------------- boot */

async function boot() {
  const res = await fetch("data/base.json");
  if (!res.ok) throw new Error(`could not load base.json (${res.status})`);
  DATA = await res.json();
  ALL_STRATEGIES = DATA.constants.strategies;
  // V2, per stakeholder feedback: only two approaches were ever presented to
  // government, so the other two are withdrawn from the interface. They stay in
  // the engine, which is what the parity test validates against the workbook.
  STRATEGIES = ALL_STRATEGIES
    .filter((s) => PRESENTED.includes(s.id))
    .map((s) => ({ ...s, label: RELABEL[s.id] ?? s.label }))
    .sort((a, b) => PRESENTED.indexOf(a.id) - PRESENTED.indexOf(b.id));

  state = {
    totalCartons: 750000,
    ageRange: "6 to 23",
    duration: 6,
    enrollmentPeriod: 6,
    coverageCap: 0.75,
    level: "lgas",
    // "" is all of Nigeria; otherwise a single state, so a state official can
    // run the same tool over their own geographies.
    scope: "",
    useManual: false,
    manual: {},                 // state name -> cartons
    // true reproduces the workbook exactly, including the risk-1.3 defect;
    // false applies the intended rule. See docs/FINDINGS.md.
    bugCompat: true,
    strategy: "threshold",
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
  // Independent of the boundary data, so the hero is never a blank panel while
  // geo.json loads, or if it fails.
  heroDots($("#hero-dots"));
  $("#scope-line").textContent =
    `Nigeria · ${DATA.wards.length.toLocaleString()} wards · ${DATA.lgas.length} LGAs · ${DATA.states.length} states`;

  renderAssumptions();
  renderChangelog();

  const screen = readUrl();
  syncControls();
  show(screen ?? "inputs");
  recompute();

  // Back and forward should move between scenarios, not just screens.
  window.addEventListener("hashchange", () => {
    const s = readUrl();
    syncControls();
    if (s) show(s);
    recompute();
  });
}

/* ------------------------------------------------------------- URL state */

/**
 * Scenarios live in the location hash, so any setup can be bookmarked, revisited
 * or pasted into an email. Without this the tool can only ever show what is on
 * one person's screen, which is a poor fit for something meant to support a
 * decision between options.
 *
 * Keys are short because the manual-allocation list can hold 37 entries. Only
 * values that differ from the defaults are written, so a default scenario has a
 * clean URL.
 */
const URL_DEFAULTS = {
  c: 750000, ar: "6 to 23", d: 6, ep: 6, cc: 0.75, lv: "lgas",
  mn: 0, bc: 1, sg: "threshold", sc: "inputs", sp: "",
};

function writeUrl() {
  const p = new URLSearchParams();
  const put = (k, v) => {
    if (String(v) !== String(URL_DEFAULTS[k])) p.set(k, v);
  };
  put("c", state.totalCartons);
  put("ar", state.ageRange);
  put("d", state.duration);
  put("ep", state.enrollmentPeriod);
  put("cc", state.coverageCap);
  put("lv", state.level);
  put("sp", state.scope);
  put("mn", state.useManual ? 1 : 0);
  if (state.useManual) {
    const entries = Object.entries(state.manual).filter(([, v]) => Number(v) > 0);
    if (entries.length) p.set("m", entries.map(([s, v]) => `${s}:${v}`).join(","));
  }
  put("bc", state.bugCompat ? 1 : 0);
  put("sg", state.strategy);
  put("sc", currentScreen);
  if (state.stateTouched) p.set("ss", state.stateSelected);

  const hash = p.toString();
  // replaceState, not pushState: typing in a number field must not fill the
  // browser's history with one entry per keystroke.
  history.replaceState(null, "", hash ? `#${hash}` : location.pathname);
}

function readUrl() {
  const raw = location.hash.replace(/^#/, "");
  if (!raw) return null;
  const p = new URLSearchParams(raw);
  const num = (k, d) => (p.has(k) && Number.isFinite(parseFloat(p.get(k))) ? parseFloat(p.get(k)) : d);
  const str = (k, d) => (p.has(k) ? p.get(k) : d);

  state.totalCartons = num("c", URL_DEFAULTS.c);
  state.ageRange = str("ar", URL_DEFAULTS.ar);
  state.duration = num("d", URL_DEFAULTS.d);
  state.enrollmentPeriod = num("ep", URL_DEFAULTS.ep);
  state.coverageCap = num("cc", URL_DEFAULTS.cc);
  state.level = str("lv", URL_DEFAULTS.lv) === "wards" ? "wards" : "lgas";
  const sp = str("sp", "");
  state.scope = DATA.states.includes(sp) ? sp : "";
  state.useManual = num("mn", 0) === 1;
  state.manual = {};
  if (p.has("m")) {
    for (const pair of p.get("m").split(",")) {
      const i = pair.lastIndexOf(":");
      if (i > 0) {
        const name = pair.slice(0, i);
        const v = parseFloat(pair.slice(i + 1));
        // Only accept names the dataset actually knows, so a mangled link cannot
        // inject phantom states.
        if (manualUnits().includes(name) && Number.isFinite(v)) state.manual[name] = v;
      }
    }
  }
  state.bugCompat = num("bc", 1) === 1;
  const sg = str("sg", URL_DEFAULTS.sg);
  if (STRATEGIES.some((s) => s.id === sg)) state.strategy = sg;
  if (p.has("ss") && DATA.states.includes(p.get("ss"))) {
    state.stateSelected = p.get("ss");
    state.stateTouched = true;
  }
  const sc = str("sc", URL_DEFAULTS.sc);
  return RENDERERS[sc] ? sc : URL_DEFAULTS.sc;
}

/** Push current state into every control, after restoring from a URL. */
function syncControls() {
  $("#in-cartons").value = state.totalCartons;
  $("#in-age").value = state.ageRange;
  $("#in-duration").value = state.duration;
  $("#in-enrol").value = state.enrollmentPeriod;
  $("#in-cap").value = state.coverageCap;
  $("#in-level").value = state.level;
  $("#in-scope").value = state.scope;
  buildManualTable();
  $("#use-manual").checked = state.useManual;
  $("#fs-manual").dataset.active = String(state.useManual);
  $("#bug-compat").checked = state.bugCompat;
  for (const input of $$("[data-manual]")) {
    input.value = state.manual[input.dataset.manual] ?? 0;
  }
  $("#out-strategy").value = state.strategy;
  $("#st-strategy").value = state.strategy;
}

async function copyScenarioLink() {
  writeUrl();
  const btn = $("#copy-link");
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = "Link copied";
  } catch {
    // Clipboard access can be refused; selecting the URL is the fallback.
    btn.textContent = "Copy from the address bar";
  }
  setTimeout(() => { btn.textContent = original; }, 2200);
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

/**
 * Geographies at the active level, restricted to the current scope.
 *
 * At national scope this is every ward or LGA. With a state selected the whole
 * model runs inside that state: needs, allocation, impact and cost are all
 * state-only, so a state official sees their own numbers rather than a slice of
 * a national run.
 */
function geographies(level, scope = state.scope) {
  const all = level === "wards" ? DATA.wards : DATA.lgas;
  return scope ? all.filter((g) => g.state === scope) : all;
}

/** The unit manual reservations are made against: states nationally, LGAs within a state. */
function manualUnitLabel() {
  return state.scope ? "LGA" : "State";
}

/** Names available for manual reservation under the current scope. */
function manualUnits() {
  if (!state.scope) return DATA.states;
  const seen = new Set();
  for (const l of DATA.lgas) if (l.state === state.scope) seen.add(l.lga);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Derived rows for a given input set. Cached, since this is the hot path. */
function derivedRows(inputs, key) {
  // Quantification has its own state selector and must not inherit the
  // allocation scope, so callers pass scope explicitly via inputs.
  const scope = inputs.scope ?? state.scope;
  const k = `${key}:bc${state.bugCompat}:sc${scope || "NG"}`;
  if (cache[k]) return cache[k];
  const params = programParams(DATA.constants, inputs);
  const rows = geographies(inputs.level, scope).map((g) => deriveRow(g, DATA.constants, params, state.bugCompat));
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
    // The allocation-side threshold control was withdrawn in V2: the
    // burden-based strategy already prioritises by the pre-determined risk
    // tiers, and a second user-set threshold on top of that read as duplicative.
    // Leaving these at zero means every geography is eligible and ranking alone
    // decides, which is what the strategy was understood to do. Thresholds
    // remain available on the Quantification screen.
    thresholds: { u5mr: 0, stunting: 0, wasting: 0 },
    cartonsAllocatedManually: manualTotal(),
    manualByState: manualMap(),
    manualKeyOf: state.scope ? (r) => r.lga : (r) => r.state,
    scope: state.scope,
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
  state: renderStateLevel, quant: renderQuant, assumptions: renderAssumptions,
  changelog: renderChangelog,
};
/** Supply-curve results, keyed by inputs. Cleared whenever inputs change. */
const curveCache = {};
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
  for (const k of Object.keys(curveCache)) delete curveCache[k];
  for (const name of Object.keys(RENDERERS)) dirty.add(name);
  renderScreen(currentScreen);
  writeUrl();
}

function renderScreen(name) {
  // An unknown name must not throw: recompute() calls this before writeUrl(),
  // so a throw here would silently discard the input the user just typed.
  if (!RENDERERS[name]) return;
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
  $("#in-scope").replaceChildren(
    new Option("All of Nigeria", ""),
    ...DATA.states.map((s) => new Option(s, s)),
  );
  const lede = document.querySelector(".hero-lede");
  if (lede) {
    lede.textContent =
      "Where should small-quantity lipid-based nutrient supplements go? Compare " +
      "allocation approaches across Nigeria's 9,684 wards and 774 LGAs, nationally " +
      "or within a single state, and see the estimated health impact of each.";
  }
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

  buildManualTable();
}

/**
 * Manual reservation table, rebuilt whenever the scope changes: states when
 * allocating nationally, LGAs when allocating inside one state.
 */
function buildManualTable() {
  const units = manualUnits();
  $("#manual-unit-head").textContent = manualUnitLabel();
  $("#manual-scope-note").textContent = state.scope
    ? `Cartons reserved for individual LGAs in ${state.scope}.`
    : "Cartons reserved for individual states.";
  $("#manual-table tbody").replaceChildren(...units.map((u) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${u}</td>
      <td class="num"><input type="number" min="0" step="100" data-manual="${u}" value="${state.manual[u] ?? 0}" style="min-width:96px"></td>
      <td class="num muted" data-need="${u}">-</td>`;
    return tr;
  }));
}

function wireEvents() {
  // Only the tabs carry data-screen. The nav also holds #copy-link, and wiring
  // show() to that button would call show(undefined), hiding every screen.
  $$("nav.tabs button[data-screen]").forEach((b) => b.addEventListener("click", () => show(b.dataset.screen)));

  const num = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);

  $("#in-cartons").addEventListener("input", (e) => { state.totalCartons = num(e.target.value, 0); recompute(); });
  $("#in-age").addEventListener("change", (e) => { state.ageRange = e.target.value; recompute(); });
  $("#in-duration").addEventListener("input", (e) => { state.duration = num(e.target.value, 0); recompute(); });
  $("#in-enrol").addEventListener("input", (e) => { state.enrollmentPeriod = num(e.target.value, 1); recompute(); });
  $("#in-cap").addEventListener("input", (e) => { state.coverageCap = num(e.target.value, 0); recompute(); });
  $("#in-level").addEventListener("change", (e) => { state.level = e.target.value; recompute(); });

  $("#in-scope").addEventListener("change", (e) => {
    state.scope = e.target.value;
    // Reservations are keyed by a different unit in each scope, so carrying them
    // across would silently attach state figures to LGA names.
    state.manual = {};
    state.stateTouched = false;
    buildManualTable();
    recompute();
  });

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
  $("#curve-metric").addEventListener("change", renderSupplyCurve);
  $("#copy-link").addEventListener("click", copyScenarioLink);
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
  writeUrl();
  $$("nav.tabs button[data-screen]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.screen === name)));
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
  $("#scope-summary").textContent = state.scope
    ? `Allocating within ${state.scope} only: ${rows.length.toLocaleString()} ${unit}.`
    : `Allocating across all of Nigeria: ${rows.length.toLocaleString()} ${unit}.`;

  const totalNeed = rows.reduce((s, r) => s + r.cartonsNeeded, 0);
  const totalChildren = rows.reduce((s, r) => s + r.popEligible, 0);
  const covered = totalNeed > 0 ? state.totalCartons / totalNeed : 0;

  tiles("#input-tiles", [
    { label: "Total supply", value: fmt.int(state.totalCartons), sub: "cartons", hero: true },
    { label: state.scope ? `${state.scope} need` : "National need",
      value: fmt.compact(totalNeed),
      sub: `cartons, all ${rows.length.toLocaleString()} ${unit}` },
    { label: "Supply covers", value: fmt.pct(Math.min(covered, 1), 1),
      sub: state.scope ? `of ${state.scope}'s need` : "of national need" },
    { label: "Children eligible", value: fmt.compact(totalChildren),
      sub: state.scope ? "at full coverage in scope" : "at full national coverage" },
    { label: "Cartons per child", value: fmt.dec(programParams(DATA.constants, inputs).cartonsPerChild, 3), sub: `${programParams(DATA.constants, inputs).sachetsPerChild} sachets` },
  ]);

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
  const needByUnit = {};
  for (const r of rows) {
    const k = state.scope ? r.lga : r.state;
    needByUnit[k] = (needByUnit[k] ?? 0) + r.cartonsNeeded;
  }
  for (const [k, v] of Object.entries(needByUnit)) {
    const cell = $(`[data-need="${CSS.escape(k)}"]`);
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

  // By zone nationally; within one state, zones collapse to a single row, so
  // break down by LGA instead, which is the useful cut at that scope.
  const byZoneCard = $("#zone-card");
  const groupLabel = state.scope ? "LGA" : "zone";
  if (byZoneCard) {
    byZoneCard.querySelector("h2").textContent = `Cartons by ${groupLabel}`;
    $("#zone-deaths-card").querySelector("h2").textContent = `Deaths averted by ${groupLabel}`;
  }
  const zones = aggregate(detail, (d) => (state.scope ? d.row.lga : DATA.zones[d.row.state] ?? "Unknown"));
  const zoneList = [...zones.entries()].sort((a, b) => b[1].cartons - a[1].cartons).slice(0, state.scope ? 15 : 6);
  barChart($("#zone-chart"), zoneList.map(([z, v]) => ({
    label: z, value: v.cartons, color: "var(--series-1)",
    tip: `<div class="tt-title">${z}</div>${fmt.int(v.cartons)} cartons<br>${fmt.compact(v.childrenTargeted)} children`,
  })), { valueFormat: fmt.compact, labelWidth: 128 });
  barChart($("#zone-deaths-chart"), zoneList
    .map(([z, v]) => ({ label: z, value: v.deathsAverted, color: "var(--series-3)" }))
    .sort((a, b) => b.value - a.value), { valueFormat: (v) => fmt.int(v), labelWidth: 128 });

  // by state
  const byState = aggregate(detail, (d) => (state.scope ? d.row.lga : d.row.state));
  const list = [...byState.entries()].filter(([, v]) => v.cartons > 0).sort((a, b) => b[1].cartons - a[1].cartons);
  // Rows are states nationally and LGAs within a state, so the headers follow.
  const head = $("#state-table thead").rows[0];
  head.cells[0].textContent = state.scope ? "LGA" : "State";
  head.cells[1].textContent = state.scope ? "State" : "Zone";
  const tb = $("#state-table tbody");
  tb.replaceChildren(...list.map(([s, v]) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${s}</td><td class="muted">${state.scope ? state.scope : DATA.zones[s] ?? ""}</td>
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
    (level) => RISK_COLOR[level] ?? RISK_COLOR["Not Classified"]);

  const totalNeed = rows.reduce((s, r) => s + r.cartonsNeeded, 0);
  const children = rows.reduce((s, r) => s + r.popEligible, 0);
  const highRisk = rows.filter((r) => String(r.riskCategory).startsWith("1")).length;
  $("#hero-stats").innerHTML = [
    [fmt.int(DATA.wards.length), "wards"],
    [fmt.int(DATA.lgas.length), "LGAs"],
    [fmt.compact(children), "children eligible"],
    [fmt.compact(totalNeed), "cartons needed"],
    [fmt.int(highRisk), `very high risk ${inputs.level === "wards" ? "wards" : "LGAs"}`],
  ].map(([n, k]) => `<div class="hero-stat"><div class="n">${n}</div><div class="k">${k}</div></div>`).join("");

  // Legend, so the shading means something rather than just looking like a map.
  const present = new Set(Object.values(worst));
  const order = [...DATA.constants.riskThresholds, { level: "Not Classified", label: "Unclassified" }];
  const swatches = order
    .filter((t) => present.has(t.level))
    .map((t) => `<span class="hero-key"><i style="background:${RISK_COLOR[t.level]}"></i>${t.label}</span>`)
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
  const byState = aggregate(detail, (d) => (state.scope ? d.row.lga : d.row.state));
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

  const METRICS = [
    ["Deaths averted", "deathsAverted"], ["Stunting cases averted", "stuntingAverted"],
    ["SAM cases averted", "samAverted"], ["Anemia cases averted", "anemiaAverted"],
    ["DALYs averted", "dalysAverted"], ["Children targeted", "childrenTargeted"],
  ];
  const groups = METRICS.map(([label, field]) => ({
    label,
    bars: results.map((r) => ({
      series: r.meta.label, short: SHORT_NAME[r.meta.id], value: r.totals[field],
    })),
  }));
  winnerGroups($("#cmp-chart"), groups);

  // Scoreboard. An outright lead and a tie are different claims, so they are
  // counted separately: crediting a tie as a lead let two strategies each appear
  // to lead the same measure, and made the counts sum to more than the number of
  // measures.
  const lead = Object.fromEntries(STRATEGIES.map((s) => [s.id, 0]));
  const tied = Object.fromEntries(STRATEGIES.map((s) => [s.id, 0]));
  let tiedMeasures = 0;
  for (const [, field] of METRICS) {
    const best = Math.max(...results.map((r) => r.totals[field]));
    const atBest = results.filter((r) => nearlyEqual(r.totals[field], best));
    if (atBest.length > 1) {
      tiedMeasures++;
      for (const r of atBest) tied[r.meta.id]++;
    } else {
      lead[atBest[0].meta.id]++;
    }
  }
  const topLead = Math.max(...Object.values(lead));
  $("#cmp-scoreboard").innerHTML = STRATEGIES.map((s) => {
    const n = lead[s.id];
    const t = tied[s.id];
    return `<div class="score${n === topLead && n > 0 ? " leader" : ""}">
      <div class="who">${s.label}</div>
      <div class="wins">${n}</div>
      <div class="of">of ${METRICS.length} measures led outright${
        t ? `<br><span class="tiedcount">+ ${t} tied</span>` : ""}</div>
    </div>`;
  }).join("");

  $("#cmp-caveat").textContent = tiedMeasures
    ? `${tiedMeasures} of ${METRICS.length} measures are tied at the top, which is expected: ` +
      `every strategy allocates the same total supply, so they differ in where it goes, not how much.`
    : "";

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

  renderSupplyCurve();

  // cost-effectiveness
  const c = DATA.constants;
  const perGeo = c.deliveryCostPerChildUsd *
    (state.level === "wards" ? avgChildrenPerWard() : avgChildrenPerLga());
  const cur = state.currency;
  const conv = (usd) => (usd == null ? null : cur === "NGN" ? usd * c.ngnPerUsd : usd);
  const money = (usd) => (usd == null ? "n/a" : fmt.money(conv(usd), cur));

  const cea = results.map((r) => ({
    meta: r.meta, ...costEffectiveness(r.totals, c, state.level, perGeo),
  }));

  // Lower is better here, the opposite of the impact chart, so the winner is
  // marked explicitly rather than left to the reader to invert.
  const COST_FIELDS = [
    ["perDeathUsd", "Per death averted"], ["perStuntingUsd", "Per stunting case"],
    ["perSamUsd", "Per SAM case"], ["perAnemiaUsd", "Per anemia case"],
    ["perDalyUsd", "Per DALY"],
  ];
  const bestOf = {};
  for (const [field] of COST_FIELDS) {
    const vals = cea.map((x) => x[field]).filter((v) => v != null && v > 0);
    bestOf[field] = vals.length ? Math.min(...vals) : null;
  }

  winnerGroups($("#cea-chart"), [
    { label: `Cost per DALY averted (${cur})`,
      bars: cea.map((x) => ({ series: x.meta.label, short: SHORT_NAME[x.meta.id], value: conv(x.perDalyUsd) ?? 0 })) },
    { label: `Cost per death averted (${cur})`,
      bars: cea.map((x) => ({ series: x.meta.label, short: SHORT_NAME[x.meta.id], value: conv(x.perDeathUsd) ?? 0 })) },
  ], { higherIsBetter: false, valueFormat: (v) => fmt.money(v, cur) });

  const cell = (x, field) => {
    const v = x[field];
    const isBest = bestOf[field] != null && v != null && nearlyEqual(v, bestOf[field]);
    return `<td class="num${isBest ? " best-cell" : ""}">${money(v)}` +
      (isBest ? ' <span class="best-mark">best</span>' : "") + "</td>";
  };

  $("#cea-table tbody").replaceChildren(...cea.map((x) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><span class="swatch-inline" style="background:${colors[x.meta.id]}"></span>${x.meta.label}</td>
      <td class="num">${money(x.totalUsd)}</td>` +
      COST_FIELDS.map(([f]) => cell(x, f)).join("");
    return tr;
  }));
}

/**
 * Supply curve: run the allocator across a range of supply levels.
 *
 * The single most decision-relevant question is what the next tranche of supply
 * buys, and that cannot be read off a single-supply view. Impact is sub-linear
 * because each strategy spends its first cartons on the highest-burden places,
 * so the curve flattening is the diminishing return made visible.
 */
function renderSupplyCurve() {
  const metric = $("#curve-metric")?.value ?? "deathsAverted";
  const inputs = allocationInputs();
  const rows = derivedRows(inputs, `alloc:${inputs.level}:${inputs.ageRange}:${inputs.duration}:${inputs.enrollmentPeriod}:${inputs.coverageCap}`);
  const nationalNeed = rows.reduce((s, r) => s + r.cartonsNeeded, 0);

  const key = `${inputs.level}:${inputs.ageRange}:${inputs.duration}:${inputs.enrollmentPeriod}:${inputs.coverageCap}:${state.bugCompat}:${inputs.cartonsAllocatedManually}:${JSON.stringify(inputs.thresholds)}`;
  if (!curveCache[key]) {
    // 25 points is affordable now that each strategy costs one sort rather than
    // one per level, and a denser curve shows the knee more clearly.
    const STEPS = 25;
    const levels = Array.from({ length: STEPS + 1 }, (_, i) => Math.round((nationalNeed * i) / STEPS));
    const series = {};
    for (const s of STRATEGIES) series[s.id] = supplyCurve(rows, s.id, inputs, levels);
    curveCache[key] = series;
  }
  const series = curveCache[key];
  const colorFor = Object.fromEntries(STRATEGIES.map((s, i) => [s.id, SERIES[i]]));

  lineChart($("#curve-chart"), STRATEGIES.map((s) => ({
    name: SHORT_NAME[s.id],
    color: colorFor[s.id],
    points: series[s.id].map((p) => ({ x: p.x, y: p[metric] })),
  })), {
    height: 320, xLabel: "cartons supplied",
    xFormat: fmt.compact, yFormat: fmt.compact,
  });
  legend($("#curve-legend"), STRATEGIES.map((s) => ({ label: s.label, color: colorFor[s.id] })));

  $("#curve-note").textContent =
    `Plotted from 0 to full national need (${fmt.compact(nationalNeed)} cartons). ` +
    `Current setting: ${fmt.int(state.totalCartons)}.`;
}

/**
 * Cross-check the supply curve against the straightforward implementation.
 *
 * supplyCurve derives every level from cumulative sums along one sorted pass.
 * That is a large speed-up over calling allocate() per level, and exactly the
 * kind of optimization that can silently change results, so it is checked
 * against the slow path rather than assumed correct. Exposed for the console;
 * not part of the render path.
 */
window.verifySupplyCurve = function verifySupplyCurve(levelsToCheck = 4) {
  const inputs = allocationInputs();
  const rows = derivedRows(inputs, `alloc:${inputs.level}:${inputs.ageRange}:${inputs.duration}:${inputs.enrollmentPeriod}:${inputs.coverageCap}`);
  const need = rows.reduce((s, r) => s + r.cartonsNeeded, 0);
  const levels = Array.from({ length: levelsToCheck }, (_, i) => Math.round((need * (i + 1)) / (levelsToCheck + 1)));
  const report = [];

  for (const s of STRATEGIES) {
    const fast = supplyCurve(rows, s.id, inputs, levels);
    levels.forEach((supply, i) => {
      const alloc = allocate(rows, s.id, { ...inputs, totalCartons: supply });
      const slow = { deathsAverted: 0, dalysAverted: 0, stuntingAverted: 0, childrenTargeted: 0 };
      for (const row of rows) {
        const cartons = alloc.get(row) ?? 0;
        if (cartons <= 0 || row.cartonsNeeded <= 0) continue;
        const share = Math.min(cartons / row.cartonsNeeded, 1);
        slow.deathsAverted += row.deathsAverted * share;
        slow.dalysAverted += row.dalysAverted * share;
        slow.stuntingAverted += row.stuntingAverted * share;
        slow.childrenTargeted += row.popEligible * share;
      }
      for (const k of Object.keys(slow)) {
        const a = fast[i][k], b = slow[k];
        const err = b === 0 ? Math.abs(a) : Math.abs(a - b) / Math.abs(b);
        report.push({ strategy: s.id, supply, metric: k, fast: a, slow: b, relErr: err });
      }
    });
  }
  const worst = report.reduce((m, r) => (r.relErr > m.relErr ? r : m), report[0]);
  return { checks: report.length, worstRelErr: worst.relErr, worst, pass: worst.relErr < 1e-9 };
};

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
  // When the allocation is already scoped to one state there is nothing to pick.
  if (state.scope) {
    state.stateSelected = state.scope;
    state.stateTouched = true;
  }
  $("#st-state").disabled = Boolean(state.scope);
  const { detail, totals } = currentAllocation(state.strategy);

  // Opening on a state that receives nothing reads as a broken screen, so if
  // the user has not chosen one yet, land on the largest recipient.
  if (!state.stateTouched) {
    const byState = aggregate(detail, (d) => (state.scope ? d.row.lga : d.row.state));
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
    { label: state.scope ? "Share of scope" : "Share of national",
      value: fmt.pct(totals.cartons ? st.cartons / totals.cartons : 0, 1) },
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

/* ------------------------------------------------------ screen: changelog */

/**
 * Version history. Kept in the tool rather than only in git, because the people
 * reviewing it are not going to read commit messages.
 */
function renderChangelog() {
  const ENTRIES = [
    {
      tag: "v1",
      when: "28 to 29 July 2026",
      who: "Built by James Bedford",
      kind: "release",
      lead: "Ported the SQ-LNS allocation model out of Excel into a static web tool.",
      items: [
        "Audited the source workbook: 45 sheets, 58 MB, 6 of them visible. Found it could not recalculate, because it is a Google Sheets export in which 6,205 cells hold Google-only functions frozen at their last cached value.",
        "Rebuilt the calculation in JavaScript so it runs in the browser with no backend, and verified it against the workbook's own cached values: every derived column for all 9,684 wards and 774 LGAs, and all four allocation strategies.",
        "Five screens matching the original's visible sheets, plus state and LGA choropleth maps joined to GRID3 boundaries.",
        "Delivered a rebuilt workbook as well, 8 visible sheets and 4.4 MB, for anyone who prefers Excel. Verified by driving real Excel and comparing to the same cached values.",
        "Reported three defects found in the source model, the most consequential being a dangling cell reference that drops the stunting criterion from risk level 1.3.",
      ],
    },
    {
      tag: "v1 feedback",
      when: "August 2026",
      who: "From Grace Hultquist",
      kind: "feedback",
      lead: "Review of v1 by the main stakeholder.",
      items: [
        "Only two of the four allocation approaches were ever presented to government stakeholders, so remove the other two to simplify. Rename “Threshold-based strategy” to something clearer.",
        "The Quantification screen lets you look at all of Nigeria or one state; do the same for the allocation mode, so the tool works for a federal official and a state official alike. In the state version, manual allocation should be to LGAs rather than states.",
        "Remove the “use thresholds” control from the allocation inputs. It was never used and reads as confusing, since the threshold-based strategy already uses pre-determined thresholds. Keep the functionality on the Quantification screen.",
      ],
    },
    {
      tag: "v2",
      when: "August 2026",
      who: "Built by James Bedford",
      kind: "release",
      lead: "Acted on the v1 feedback.",
      items: [
        "Reduced the interface to the two approaches actually used: the <strong>Burden-based strategy</strong> and <strong>Equal distribution</strong>. The withdrawn approaches remain in the calculation engine, because that is what the parity test checks against the workbook; they are simply no longer offered.",
        "Renamed “Threshold-based” to <strong>Burden-based</strong>. Of the two names suggested, this one describes the mechanism, which is to target the highest-burden geographies first. “Impact-based” would have implied it optimises impact directly, closer to what the withdrawn strategies did.",
        "Added an <strong>Allocate across</strong> control: all of Nigeria, or any single state. With a state selected the entire model runs inside it, so needs, allocation, impact and cost are all state-only rather than a slice of a national run.",
        "Manual reservations now key on the unit that matches the scope: states nationally, LGAs within a state. Switching scope clears any existing reservations, since carrying them across would attach state figures to LGA names.",
        "Removed the allocation-side threshold control. With it gone every geography is eligible and the pre-determined risk tiers alone decide the order, which is what the strategy was understood to do. Thresholds remain on the Quantification screen.",
        "Within a single state, the zone breakdowns become LGA breakdowns, since zones collapse to one row at that scope.",
        "Added this changelog.",
      ],
    },
  ];

  $("#changelog").innerHTML = ENTRIES.map((e) => `
    <section class="release release-${e.kind}">
      <div class="release-head">
        <span class="release-tag">${e.tag}</span>
        <span class="release-when">${e.when}</span>
        <span class="release-who">${e.who}</span>
      </div>
      <p class="release-lead">${e.lead}</p>
      <ul>${e.items.map((i) => `<li>${i}</li>`).join("")}</ul>
    </section>`).join("");
}

/* ---------------------------------------------------- screen: assumptions */

/**
 * Every constant, with the source the workbook cites for it.
 *
 * A tool that reports "7,251 deaths averted" without letting the reader see the
 * 0.24 effect size behind it, and where that came from, is asking to be trusted
 * rather than checked. This screen is static, so it renders once at boot.
 */
function renderAssumptions() {
  const c = DATA.constants;
  const src = DATA.sources ?? {};
  const cite = (key) => src[key]?.source ?? null;

  const pct = (v) => (v * 100).toFixed(0) + "%";
  const ROWS = [
    ["Treatment effects", null, null, null],
    ["Effect on under-2 mortality", pct(c.effect.mortality), cite("mortalityEffect")],
    ["Effect on stunting", pct(c.effect.stunting), cite("stuntingEffect")],
    ["Effect on SAM", pct(c.effect.sam), cite("samEffect")],
    ["Effect on anemia", pct(c.effect.anemia), cite("anemiaEffect")],

    ["Discounts applied to effect", null, null, null],
    ["Product wastage", pct(c.impactDiscount.wastage), cite("wastage")],
    ["Incomplete consumption", pct(c.impactDiscount.incompleteConsumption), cite("incompleteConsumption")],
    ["Share of effect retained",
      pct(1 - c.impactDiscount.wastage - c.impactDiscount.incompleteConsumption),
      "Calculated: 1 minus the two discounts above"],
    ["Prorating by supplementation duration", "duration / 12, zero below 3 months",
      "Workbook step function on 'Hard-coded Inputs' rows 120 to 131"],

    ["DALYs", null, null, null],
    ["Discount rate", pct(c.daly.discountRate), cite("dalyDiscount")],
    ["Life expectancy", `${c.daly.lifeExpectancy} years`, cite("lifeExpectancy")],
    ["Discounted YLL per death", c.daly.yllPerDeath.toFixed(3), cite("deathWeight")],
    ["Discounted YLD per SAM case", c.daly.yldPerSamCase.toFixed(4), cite("samWeight")],
    ["Discounted YLD per anemia case", c.daly.yldPerAnemiaCase.toFixed(4), cite("anemiaWeight")],

    ["Product and cost", null, null, null],
    ["Sachets per carton", fmt.int(c.sachetsPerCarton), cite("sachetsPerCarton")],
    ["Sachets per child per year", fmt.int(c.sachetsPerChildPerYear), cite("sachetsPerYear")],
    ["Price per sachet", "$" + c.pricePerSachetUsd.toFixed(2), cite("pricePerSachet")],
    ["Exchange rate", `NGN ${fmt.int(c.ngnPerUsd)} per USD`, cite("ngnPerUsd")],
    ["Delivery cost per child", "$" + c.deliveryCostPerChildUsd.toFixed(2), cite("deliveryCostPerChild")],

    ["Population", null, null, null],
    ["Under-5 share of population", pct(c.u5ShareOfPopulation), cite("u5Share")],
    ["Share of U5 aged 6 to 23 months", pct(c.ageRangeShare["6 to 23"]), cite("share6to23")],
    ["Share of U5 aged 6 to 18 months", pct(c.ageRangeShare["6 to 18"]), null],
    ["Share of U5 aged 6 to 11 months", pct(c.ageRangeShare["6 to 11"]), null],
  ];

  const tb = $("#assump-table tbody");
  tb.replaceChildren(...ROWS.map(([label, value, source, isHeading]) => {
    const tr = document.createElement("tr");
    if (value === null && source === null) {
      tr.innerHTML = `<td colspan="3" class="row-heading">${label}</td>`;
    } else {
      tr.innerHTML = `<td>${label}</td><td class="num">${value}</td>` +
        `<td class="small ${source ? "" : "muted"}">${source ?? "Not cited in the source workbook"}</td>`;
    }
    return tr;
  }));

  const uncited = ROWS.filter((r) => r[1] !== null && !r[2]).length;
  $("#assump-uncited").textContent = uncited
    ? `${uncited} of these values carry no citation in the source workbook. That is a gap in the source, not in this port.`
    : "";

  // risk thresholds
  $("#assump-risk tbody").replaceChildren(...c.riskThresholds.map((t) => {
    const tr = document.createElement("tr");
    const dropped = t.level === "1.3" && state.bugCompat;
    tr.innerHTML = `<td><span class="swatch-inline" style="background:${RISK_COLOR[t.level]}"></span>${t.label} (${t.level})</td>
      <td class="num">&ge; ${t.u5mr}</td>
      <td class="num">${dropped ? '<span class="muted">dropped by the defect</span>' : "&ge; " + t.stunting}</td>
      <td class="num">&ge; ${t.wasting}</td>`;
    return tr;
  }));

  // Only the strategies actually offered. The workbook's own wording is used,
  // indexed by position in the original four-strategy list, with a note where V2
  // changed the behaviour that wording describes.
  const defs = src._strategyDefinitions ?? [];
  $("#assump-strategies").innerHTML = STRATEGIES.map((s) => {
    const i = ALL_STRATEGIES.findIndex((a) => a.id === s.id);
    let desc = defs[i]?.description ?? s.description;
    if (s.id === "threshold") {
      desc += " <em>In V2 the user-set thresholds were removed from the allocation "
        + "inputs, so every geography is eligible and the pre-determined risk tiers "
        + "alone set the order.</em>";
    }
    return `<p style="margin:0 0 10px"><strong>${s.label}</strong><br>
      <span class="small muted">${desc}</span></p>`;
  }).join("") +
  `<p class="small muted" style="margin-top:14px">Two further approaches, ranking by
   under-5 mortality and by stunting prevalence, were built and verified against the
   workbook but withdrawn from the interface in V2, having never been presented to
   government stakeholders. See the Changelog.</p>`;

  $("#assump-defects").innerHTML = `
    <div class="note warn">
      <strong>Risk level 1.3 is over-assigned.</strong> The workbook's formula references an
      empty cell instead of the stunting threshold, so an empty-cell-equals-zero comparison
      makes that test always true and the tier collapses to under-5 mortality alone.
      It misclassifies 232 of 9,684 wards and 14 of 774 LGAs, always promoting them into the
      tier. This one is live in the Google Sheet, not just the export. Reproduced by default;
      the toggle is on the inputs screen.
    </div>
    <div class="note">
      <strong>Quantification ranges were truncated in the export.</strong> Every range on that
      sheet covered 90 of 9,684 rows. An artifact of the Google Sheets export rather than a
      fault in the Sheet, and fixed here.
    </div>
    <div class="note">
      <strong>Averted stunting contributes no DALYs.</strong> The workbook's DALY formula sums
      deaths, SAM and anemia only. Reproduced as-is, but worth knowing, since a reader would
      reasonably expect stunting to count.
    </div>`;

  const estimated = DATA.wards.filter((w) => w.estimated).length;
  $("#assump-quality").innerHTML = `
    <p class="small">Ward and LGA figures are resolved from four source datasets: NTD unit
    population estimates, ANU mortality and stunting estimates, UNICEF wasting data, and
    state-level anemia prevalence.</p>
    <ul class="small">
      <li><strong>${fmt.int(estimated)} of ${fmt.int(DATA.wards.length)} wards</strong>
      (${fmt.pct(estimated / DATA.wards.length, 1)}) had no ward-level match in the source data,
      so the LGA-level estimate was used. These are flagged with an asterisk on the
      state-level screen.</li>
      <li>Anemia prevalence is <strong>state-level only</strong>, applied uniformly to every
      ward and LGA within a state. The workbook notes it should be improved.</li>
      <li>Boundaries are joined by name, since neither source carries admin codes:
      37 of 37 states and 774 of 774 LGAs matched, 748 exactly and 26 by similarity.</li>
    </ul>`;
}

/* -------------------------------------------------- screen: quantification */

function renderQuant() {
  const q = state.quant;
  const inputs = {
    ageRange: q.ageRange, duration: q.duration, enrollmentPeriod: q.enrollmentPeriod,
    coverageCap: q.coverageCap, level: q.level,
    // Explicitly national: this screen has its own state selector and should not
    // inherit whatever scope the allocation screens are set to.
    scope: "",
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

    // Reaching a target requires an order to work down, and equal distribution
    // has none, being proportional rather than ranked. With the two ranked
    // strategies withdrawn in V2, burden-based is the only order available, so a
    // picker would be a dropdown with one entry. It is stated instead.
    const ordered = orderByStrategy(rows, "threshold");

    extra.append(
      Object.assign(document.createElement("label"), { textContent: "Metric" }), metricSel,
      Object.assign(document.createElement("label"), { textContent: "Target" }), targetIn,
      Object.assign(document.createElement("span"), {
        className: "small muted",
        textContent: "Filled in burden-based order, worst risk tier first.",
      }));
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

/**
 * Stat tiles.
 *
 * The value font is stepped down for longer strings. A tile is only ~128px of
 * usable width, and at the hero size a seven-character figure like "145,308"
 * overflowed and was clipped mid-number, which is worse than simply being
 * smaller. Sizing on character count is container-independent and predictable,
 * unlike a viewport-based clamp.
 */
function tiles(sel, items) {
  $(sel).replaceChildren(...items.map((t) => {
    const d = document.createElement("div");
    d.className = "tile" + (t.hero ? " hero" : "");
    const text = String(t.value ?? "");
    const fit = text.length > 12 ? " v-xs" : text.length > 9 ? " v-sm" : text.length > 6 ? " v-md" : "";
    d.innerHTML = `<div class="label">${t.label}</div>` +
      `<div class="value${fit}">${t.value}</div>` +
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
  const byState = aggregate(detail, (d) => (state.scope ? d.row.lga : d.row.state));
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

