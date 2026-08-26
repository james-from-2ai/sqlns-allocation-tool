/**
 * Minimal inline-SVG charts. No dependencies, so the site stays a static bundle.
 *
 * Conventions follow the data-viz method: thin marks, 4px rounded data-ends
 * anchored to the baseline, recessive grid, direct value labels (the categorical
 * palette sits below 3:1 on the light surface, so visible labels are required
 * relief), and a hover tooltip on every mark.
 */

const SVG = "http://www.w3.org/2000/svg";
const el = (name, attrs = {}) => {
  const n = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

/* ----------------------------------------------------------------- tooltip */

let tipEl = null;
function tooltip() {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "tooltip";
    document.body.append(tipEl);
  }
  return tipEl;
}

export function attachTip(node, html) {
  node.addEventListener("pointerenter", (e) => {
    const t = tooltip();
    t.innerHTML = html;
    t.dataset.show = "true";
    moveTip(e);
  });
  node.addEventListener("pointermove", moveTip);
  node.addEventListener("pointerleave", () => {
    if (tipEl) tipEl.dataset.show = "false";
  });
}

function moveTip(e) {
  const t = tooltip();
  const pad = 14;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  const r = t.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}

/**
 * Fit a category label into the gutter, since the gutter shrinks on narrow
 * viewports. Approximates 11px system sans at ~6px per character. The full
 * text stays reachable as a native tooltip.
 */
function fitLabel(text, available) {
  const maxChars = Math.max(Math.floor(available / 6), 4);
  return text.length <= maxChars ? text : text.slice(0, maxChars - 1).trimEnd() + "…";
}

function catLabel(text, x, y, available) {
  const node = el("text", { x, y, "text-anchor": "end", class: "cat-label" });
  const shown = fitLabel(text, available);
  node.textContent = shown;
  if (shown !== text) {
    const title = el("title");
    title.textContent = text;
    node.append(title);
  }
  return node;
}

/* -------------------------------------------------------------- formatting */

export const fmt = {
  int: (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "n/a"),
  dec: (n, d = 1) =>
    Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "n/a",
  usd: (n) => (Number.isFinite(n) ? "$" + Math.round(n).toLocaleString("en-US") : "n/a"),
  ngn: (n) => (Number.isFinite(n) ? "NGN " + Math.round(n).toLocaleString("en-US") : "n/a"),
  pct: (n, d = 0) => (Number.isFinite(n) ? (n * 100).toFixed(d) + "%" : "n/a"),
  /** Compact form for axis ticks and hero figures: 1.2M, 45.0k. */
  compact(n) {
    if (!Number.isFinite(n)) return "n/a";
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (a >= 1e4) return Math.round(n / 1e3) + "k";
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    if (a >= 10) return Math.round(n).toString();
    if (a >= 1) return n.toFixed(1);
    return n.toFixed(2);
  },
  money(n, currency) {
    return currency === "NGN" ? fmt.ngn(n) : fmt.usd(n);
  },
};

/* --------------------------------------------------------- horizontal bars */

/**
 * Horizontal bar chart. Best default for ranked categories with long names.
 *
 * @param items [{label, value, color, tip}]
 */
export function barChart(container, items, { valueFormat = fmt.compact, labelWidth = 150, barH = 22, gap = 10 } = {}) {
  container.replaceChildren();
  if (!items.length) {
    container.append(Object.assign(document.createElement("p"), {
      className: "muted small", textContent: "No geographies match these settings.",
    }));
    return;
  }

  const width = Math.max(container.clientWidth || 640, 320);
  const rightPad = 62;
  // On narrow viewports a fixed label gutter can leave almost no plot, so cap
  // it at 40% of the width and let long names truncate instead.
  labelWidth = Math.min(labelWidth, width * 0.4);
  const plotW = Math.max(width - labelWidth - rightPad, 80);
  const height = items.length * (barH + gap) + 10;
  const max = Math.max(...items.map((d) => d.value), 0) || 1;
  const x = (v) => (v / max) * plotW;

  const svg = el("svg", {
    class: "chart", width: "100%", height,
    viewBox: `0 0 ${width} ${height}`, role: "img",
  });

  items.forEach((d, i) => {
    const y = i * (barH + gap) + 5;

    svg.append(catLabel(d.label, labelWidth - 10, y + barH / 2 + 4, labelWidth - 10));

    const w = Math.max(x(d.value), d.value > 0 ? 2 : 0);
    // rx gives the 4px rounded data-end; the fill still meets the baseline
    const bar = el("rect", {
      x: labelWidth, y, width: w, height: barH, rx: 4, fill: d.color || "var(--series-1)", class: "bar",
    });
    attachTip(bar, d.tip || `<div class="tt-title">${d.label}</div>${valueFormat(d.value)}`);
    svg.append(bar);

    const val = el("text", { x: labelWidth + w + 8, y: y + barH / 2 + 4, class: "value-label" });
    val.textContent = valueFormat(d.value);
    svg.append(val);
  });

  svg.append(el("line", { x1: labelWidth, y1: 0, x2: labelWidth, y2: height - 5, class: "axis-line" }));
  container.append(svg);
}

/**
 * Winner-oriented comparison. One group per measure, one bar per strategy.
 *
 * Colour here would encode identity, but the question this chart answers is
 * rank, so identity moves to a direct row label and colour is spent on the
 * winner instead. Bars are sorted within each group so the best is always on
 * top, and each other bar is annotated with its shortfall, because the values
 * are close enough that bar length alone cannot carry the difference.
 *
 * @param groups [{label, bars:[{series, short, value}]}]
 * @param opts.higherIsBetter false for cost measures, where the lowest wins
 */
export function winnerGroups(container, groups, { valueFormat = fmt.compact, labelWidth = 96, barH = 17, barGap = 4, groupGap = 22, higherIsBetter = true } = {}) {
  container.replaceChildren();
  if (!groups.length) return;

  const width = Math.max(container.clientWidth || 640, 320);
  labelWidth = Math.min(labelWidth, width * 0.28);
  const rightPad = 128;
  const plotW = Math.max(width - labelWidth - rightPad, 90);
  const nBars = groups[0]?.bars.length ?? 0;
  const groupH = nBars * barH + (nBars - 1) * barGap;
  const height = groups.length * (groupH + groupGap) + 26;

  const svg = el("svg", { class: "chart", width: "100%", height, viewBox: `0 0 ${width} ${height}`, role: "img" });

  let y = 6;
  for (const g of groups) {
    const values = g.bars.map((b) => b.value);
    const best = higherIsBetter ? Math.max(...values) : Math.min(...values);
    const scaleMax = Math.max(...values) || 1;
    // Ranked, best first. A tie keeps its input order, which is stable.
    const ranked = [...g.bars].sort((a, b) => (higherIsBetter ? b.value - a.value : a.value - b.value));
    const tied = ranked.filter((b) => nearly(b.value, best)).length > 1;

    const heading = el("text", { x: 0, y: y - 6, class: "group-heading" });
    heading.textContent = g.label;
    svg.append(heading);

    ranked.forEach((b, i) => {
      const by = y + i * (barH + barGap);
      const isBest = nearly(b.value, best);
      const w = Math.max((b.value / scaleMax) * plotW, b.value > 0 ? 2 : 0);

      svg.append(catLabel(b.short ?? b.series, labelWidth - 8, by + barH / 2 + 4, labelWidth - 8));

      const bar = el("rect", {
        x: labelWidth, y: by, width: w, height: barH, rx: 4,
        fill: isBest ? "var(--accent)" : "var(--bar-muted)",
        class: "bar" + (isBest ? " bar-best" : ""),
      });
      const gap = best === 0 ? 0 : (b.value - best) / Math.abs(best);
      attachTip(bar,
        `<div class="tt-title">${b.series}</div>${g.label}: ${valueFormat(b.value)}` +
        (isBest ? `<br>best${tied ? " (tied)" : ""}` : `<br>${fmt.pct(Math.abs(gap), 1)} ${higherIsBetter ? "lower" : "higher"} than best`));
      svg.append(bar);

      const val = el("text", { x: labelWidth + w + 8, y: by + barH / 2 + 4, class: "value-label" });
      val.textContent = valueFormat(b.value);
      svg.append(val);

      const note = el("text", {
        x: width - 4, y: by + barH / 2 + 4, "text-anchor": "end",
        class: isBest ? "best-tag" : "gap-tag",
      });
      note.textContent = isBest
        ? (tied ? "tied best" : "best")
        : (Math.abs(gap) < 0.001 ? "" : `${gap > 0 ? "+" : "−"}${fmt.pct(Math.abs(gap), gap > -0.1 ? 1 : 0)}`);
      svg.append(note);
    });

    y += groupH + groupGap;
  }
  container.append(svg);
}

/** Values within a hair of each other count as tied, after float error. */
function nearly(a, b) {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale > 0 && Math.abs(a - b) / scale < 5e-4;
}

/**
 * Multi-series line chart with a shared crosshair.
 *
 * Used for the supply curve, where the question is the shape of the returns
 * rather than any single point, so lines beat bars. One y-axis only: series must
 * already share units.
 *
 * @param series [{name, color, points:[{x, y}]}]
 */
export function lineChart(container, series, { height = 300, xLabel = "", yLabel = "", xFormat = fmt.compact, yFormat = fmt.compact } = {}) {
  container.replaceChildren();
  const live = series.filter((s) => s.points.length > 1);
  if (!live.length) {
    container.append(Object.assign(document.createElement("p"), {
      className: "muted small", textContent: "Not enough points to plot.",
    }));
    return;
  }

  const width = Math.max(container.clientWidth || 640, 320);
  const padL = 62, padR = 16, padT = 12, padB = 40;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const xs = live.flatMap((s) => s.points.map((p) => p.x));
  const ys = live.flatMap((s) => s.points.map((p) => p.y));
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMax = Math.max(...ys) || 1;
  const sx = (x) => padL + ((x - xMin) / (xMax - xMin || 1)) * plotW;
  const sy = (y) => padT + plotH - (y / yMax) * plotH;

  const svg = el("svg", {
    class: "chart", width: "100%", height,
    viewBox: `0 0 ${width} ${height}`, role: "img",
    "aria-label": `${yLabel} against ${xLabel}`,
  });

  // gridlines and y ticks
  const TICKS = 4;
  for (let i = 0; i <= TICKS; i++) {
    const v = (yMax / TICKS) * i;
    const y = sy(v);
    svg.append(el("line", { x1: padL, y1: y, x2: padL + plotW, y2: y, class: "grid-line" }));
    const t = el("text", { x: padL - 8, y: y + 3.5, "text-anchor": "end" });
    t.textContent = yFormat(v);
    svg.append(t);
  }
  // x ticks at the ends and middle
  for (const frac of [0, 0.5, 1]) {
    const v = xMin + (xMax - xMin) * frac;
    const t = el("text", { x: sx(v), y: height - padB + 18, "text-anchor": frac === 0 ? "start" : frac === 1 ? "end" : "middle" });
    t.textContent = xFormat(v);
    svg.append(t);
  }
  svg.append(el("line", { x1: padL, y1: padT + plotH, x2: padL + plotW, y2: padT + plotH, class: "axis-line" }));

  if (xLabel) {
    const l = el("text", { x: padL + plotW / 2, y: height - 4, "text-anchor": "middle" });
    l.textContent = xLabel;
    svg.append(l);
  }

  for (const s of live) {
    const d = s.points
      .map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`)
      .join("");
    svg.append(el("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  }

  // Direct labels, placed where the lines are furthest apart rather than at their
  // right ends. These curves converge at both ends by construction: at zero supply
  // nothing is averted, and at full national need every strategy funds everything.
  // So end-anchored labels landed on the same point and overprinted each other.
  const span = Math.min(...live.map((s) => s.points.length));
  let at = 0;
  let widest = -1;
  for (let i = 0; i < span; i++) {
    const ys = live.map((s) => s.points[i].y);
    const spread = Math.max(...ys) - Math.min(...ys);
    if (spread > widest) {
      widest = spread;
      at = i;
    }
  }
  // Highest line labels above its own line, lowest below, so neither sits on it.
  const ranked = [...live].sort((a, b) => b.points[at].y - a.points[at].y);
  ranked.forEach((s, rank) => {
    const p = s.points[at];
    const above = rank === 0;
    const x = Math.min(Math.max(sx(p.x), padL + 34), padL + plotW - 34);
    const tag = el("text", {
      x, y: sy(p.y) + (above ? -10 : 18), "text-anchor": "middle",
      class: "line-label", fill: s.color,
      // A surface-coloured halo keeps the text readable where it crosses a
      // gridline or the other series.
      stroke: "var(--surface-1)", "stroke-width": 3.5, "paint-order": "stroke",
    });
    tag.textContent = s.name;
    svg.append(tag);
  });

  // Hover: nearest x, tooltip listing every series at that supply level.
  const hit = el("rect", { x: padL, y: padT, width: plotW, height: plotH, fill: "transparent" });
  const cross = el("line", { x1: padL, y1: padT, x2: padL, y2: padT + plotH, class: "axis-line", opacity: 0 });
  svg.append(hit, cross);
  const dots = live.map((s) => {
    const c = el("circle", { r: 4, fill: s.color, stroke: "var(--surface-1)", "stroke-width": 2, opacity: 0 });
    svg.append(c);
    return c;
  });

  hit.addEventListener("pointermove", (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    const xv = xMin + ((px - padL) / plotW) * (xMax - xMin);
    let rows = "";
    live.forEach((s, i) => {
      let best = s.points[0];
      for (const p of s.points) if (Math.abs(p.x - xv) < Math.abs(best.x - xv)) best = p;
      dots[i].setAttribute("cx", sx(best.x));
      dots[i].setAttribute("cy", sy(best.y));
      dots[i].setAttribute("opacity", 1);
      rows += `<div>${s.name}: <strong>${yFormat(best.y)}</strong></div>`;
    });
    let nearest = live[0].points[0];
    for (const p of live[0].points) if (Math.abs(p.x - xv) < Math.abs(nearest.x - xv)) nearest = p;
    cross.setAttribute("x1", sx(nearest.x));
    cross.setAttribute("x2", sx(nearest.x));
    cross.setAttribute("opacity", 0.5);
    const t = tooltip();
    t.innerHTML = `<div class="tt-title">${xFormat(nearest.x)} ${xLabel || ""}</div>${rows}`;
    t.dataset.show = "true";
    moveTip(e);
  });
  hit.addEventListener("pointerleave", () => {
    cross.setAttribute("opacity", 0);
    dots.forEach((d) => d.setAttribute("opacity", 0));
    if (tipEl) tipEl.dataset.show = "false";
  });

  container.append(svg);
}

/** Legend. Always present for two or more series. */
export function legend(container, items) {
  container.replaceChildren();
  for (const it of items) {
    const wrap = document.createElement("span");
    wrap.className = "item";
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = it.color;
    wrap.append(sw, document.createTextNode(it.label));
    container.append(wrap);
  }
}

/**
 * Stacked composition bar, one row, used for the risk-category mix.
 * Segments carry a 2px surface gap so adjacent fills never touch.
 */
export function stackedBar(container, segments, { height = 26, format = fmt.int } = {}) {
  container.replaceChildren();
  const total = segments.reduce((s, d) => s + d.value, 0);
  if (total <= 0) {
    container.append(Object.assign(document.createElement("p"), {
      className: "muted small", textContent: "Nothing allocated.",
    }));
    return;
  }
  const width = Math.max(container.clientWidth || 640, 260);
  const svg = el("svg", { class: "chart", width: "100%", height, viewBox: `0 0 ${width} ${height}`, role: "img" });
  let x = 0;
  for (const s of segments) {
    if (s.value <= 0) continue;
    const w = (s.value / total) * width;
    const rect = el("rect", { x, y: 0, width: Math.max(w - 2, 1), height, rx: 4, fill: s.color, class: "bar" });
    attachTip(rect, `<div class="tt-title">${s.label}</div>${format(s.value)} (${fmt.pct(s.value / total, 1)})`);
    svg.append(rect);
    x += w;
  }
  container.append(svg);
}
