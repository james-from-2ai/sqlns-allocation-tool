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
 * Grouped bars: one group per metric, one bar per series.
 * Used for the strategy comparison, where four strategies are compared across
 * several impact measures. Each metric is normalized within its own group,
 * because the measures are on different scales; the printed value carries the
 * magnitude. This avoids a second y-axis, which the method forbids.
 *
 * @param groups [{label, bars:[{series, value, color}]}]
 */
export function groupedBars(container, groups, { valueFormat = fmt.compact, labelWidth = 178, barH = 15, barGap = 3, groupGap = 20 } = {}) {
  container.replaceChildren();
  const width = Math.max(container.clientWidth || 640, 320);
  const rightPad = 74;
  labelWidth = Math.min(labelWidth, width * 0.4);
  const plotW = Math.max(width - labelWidth - rightPad, 80);
  const nBars = groups[0]?.bars.length ?? 0;
  const groupH = nBars * barH + (nBars - 1) * barGap;
  const height = groups.length * (groupH + groupGap) + 8;

  const svg = el("svg", {
    class: "chart", width: "100%", height,
    viewBox: `0 0 ${width} ${height}`, role: "img",
  });

  let y = 4;
  for (const g of groups) {
    const max = Math.max(...g.bars.map((b) => b.value), 0) || 1;

    svg.append(catLabel(g.label, labelWidth - 10, y + groupH / 2 + 4, labelWidth - 10));

    g.bars.forEach((b, i) => {
      const by = y + i * (barH + barGap);
      const w = Math.max((b.value / max) * plotW, b.value > 0 ? 2 : 0);
      const bar = el("rect", { x: labelWidth, y: by, width: w, height: barH, rx: 4, fill: b.color, class: "bar" });
      attachTip(bar, `<div class="tt-title">${b.series}</div>${g.label}: ${valueFormat(b.value)}`);
      svg.append(bar);

      const val = el("text", { x: labelWidth + w + 7, y: by + barH / 2 + 4, class: "value-label" });
      val.textContent = valueFormat(b.value);
      svg.append(val);
    });

    svg.append(el("line", { x1: labelWidth, y1: y - 4, x2: labelWidth, y2: y + groupH + 4, class: "axis-line" }));
    y += groupH + groupGap;
  }
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
