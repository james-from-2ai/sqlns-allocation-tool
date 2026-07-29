/**
 * Choropleth maps, rendered as inline SVG paths. No mapping library and no tile
 * server, which keeps the page self-contained and offline-capable, and matches
 * how charts.js works.
 *
 * A choropleth needs no basemap: the administrative polygons *are* the picture.
 *
 * Colour follows the sequential rule, one hue light to dark, using the blue ramp
 * defined in styles.css. Zero is deliberately not part of that ramp: an
 * unfunded geography is a different kind of thing from a lightly funded one, so
 * it gets a neutral fill and its own legend entry.
 */

import { attachTip, fmt } from "./charts.js";

const SVG = "http://www.w3.org/2000/svg";
const el = (n, a = {}) => {
  const node = document.createElementNS(SVG, n);
  for (const [k, v] of Object.entries(a)) node.setAttribute(k, v);
  return node;
};

// Sequential blue, light to dark. Mirrors the --seq-* custom properties.
const RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#0d366b"];
const RAMP_DARK = ["#0d366b", "#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4"];
const NEUTRAL = "var(--grid)";

function isDark() {
  const stamped = document.documentElement.dataset.theme;
  if (stamped === "dark") return true;
  if (stamped === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/* ----------------------------------------------------------- projection */

/**
 * Equirectangular, with longitudes scaled by cos(mid-latitude) so the country
 * is not visibly stretched. Adequate for a national choropleth and it keeps the
 * maths inspectable.
 */
function bounds(features) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of features) {
    for (const ring of ringsOf(f.geometry)) {
      for (const [lon, lat] of ring) {
        if (lon < minX) minX = lon;
        if (lon > maxX) maxX = lon;
        if (lat < minY) minY = lat;
        if (lat > maxY) maxY = lat;
      }
    }
  }
  const midLat = ((minY + maxY) / 2) * (Math.PI / 180);
  const kx = Math.cos(midLat);
  return { minX, minY, maxX, maxY, kx, spanX: (maxX - minX) * kx, spanY: maxY - minY };
}

function projector(b, width, height, pad = 4) {
  const scale = Math.min((width - pad * 2) / b.spanX, (height - pad * 2) / b.spanY);
  const offX = pad + ((width - pad * 2) - b.spanX * scale) / 2;
  const offY = pad + ((height - pad * 2) - b.spanY * scale) / 2;
  return ([lon, lat]) => [
    offX + (lon - b.minX) * b.kx * scale,
    // SVG y grows downward, so latitude is inverted
    offY + (b.maxY - lat) * scale,
  ];
}

/**
 * Height that lets the shape fill the available width without distortion.
 * Clamped so a wide screen does not produce an absurdly tall map, and a narrow
 * one still gets something legible.
 */
function fittedHeight(b, width, maxHeight) {
  const ideal = width * (b.spanY / b.spanX);
  return Math.round(Math.max(220, Math.min(ideal, maxHeight)));
}

function ringsOf(geometry) {
  if (!geometry) return [];
  return geometry.type === "Polygon"
    ? geometry.coordinates
    : geometry.coordinates.flat();
}

function pathFor(geometry, project) {
  const parts = [];
  for (const ring of ringsOf(geometry)) {
    if (ring.length < 3) continue;
    let d = "";
    for (let i = 0; i < ring.length; i++) {
      const [x, y] = project(ring[i]);
      d += `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }
    parts.push(d + "Z");
  }
  return parts.join("");
}

/* ---------------------------------------------------------------- scale */

/**
 * Quantile bins over the positive values only.
 *
 * Allocation is deliberately concentrated, so most geographies sit at or near
 * zero and a linear scale would render almost everything the palest step.
 * Quantiles keep the map readable; the legend prints the actual ranges so the
 * bins are never mistaken for equal intervals.
 */
function quantileScale(values, ramp) {
  const positive = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!positive.length) return { bins: [], colorOf: () => NEUTRAL };
  const n = Math.min(ramp.length, positive.length);
  const cuts = [];
  for (let i = 1; i < n; i++) {
    cuts.push(positive[Math.floor((i / n) * positive.length)]);
  }
  const colors = ramp.slice(0, n);
  const bins = colors.map((color, i) => ({
    color,
    lo: i === 0 ? positive[0] : cuts[i - 1],
    hi: i === colors.length - 1 ? positive[positive.length - 1] : cuts[i],
  }));
  return {
    bins,
    colorOf(v) {
      if (!(v > 0)) return NEUTRAL;
      let i = 0;
      while (i < cuts.length && v >= cuts[i]) i++;
      return colors[i];
    },
  };
}

/* --------------------------------------------------------------- render */

/**
 * Draw a choropleth.
 *
 * @param container    element to draw into
 * @param features     [{geometry, ...}] already filtered to what should show
 * @param valueOf      feature -> number
 * @param opts.label   feature -> string, for the tooltip title
 * @param opts.detail  feature -> string (HTML), extra tooltip lines
 * @param opts.onClick feature -> void
 * @param opts.format  number formatter for legend and tooltip
 * @param opts.height  px
 * @param opts.legendInto element for the legend, optional
 */
export function choropleth(container, features, valueOf, opts = {}) {
  const {
    label = () => "", detail = () => "", onClick = null,
    format = fmt.compact, height = 380, legendInto = null, unit = "",
  } = opts;

  container.replaceChildren();
  if (!features.length) {
    container.append(Object.assign(document.createElement("p"), {
      className: "muted small", textContent: "No geographies to map.",
    }));
    if (legendInto) legendInto.replaceChildren();
    return;
  }

  const width = Math.max(container.clientWidth || 640, 280);
  const b = bounds(features);
  const h = fittedHeight(b, width, height);
  const project = projector(b, width, h);
  const scale = quantileScale(features.map(valueOf), isDark() ? RAMP_DARK : RAMP);

  const svg = el("svg", {
    class: "chart map", width: "100%", height: h,
    viewBox: `0 0 ${width} ${h}`, role: "img",
    "aria-label": `Choropleth of ${unit || "values"} by geography`,
  });

  for (const f of features) {
    const v = valueOf(f);
    const path = el("path", {
      d: pathFor(f.geometry, project),
      fill: scale.colorOf(v),
      stroke: "var(--surface-1)",
      "stroke-width": 0.6,
      class: "region",
    });
    const extra = detail(f);
    attachTip(path, `<div class="tt-title">${label(f)}</div>${format(v)}${unit ? " " + unit : ""}${extra ? "<br>" + extra : ""}`);
    if (onClick) {
      path.style.cursor = "pointer";
      path.addEventListener("click", () => onClick(f));
    }
    svg.append(path);
  }
  container.append(svg);

  if (legendInto) {
    legendInto.replaceChildren();
    const zero = features.filter((f) => !(valueOf(f) > 0)).length;
    if (zero) legendInto.append(swatch(NEUTRAL, `Not funded (${zero})`));
    for (const b of scale.bins) {
      const text = b.lo === b.hi ? format(b.lo) : `${format(b.lo)} to ${format(b.hi)}`;
      legendInto.append(swatch(b.color, text));
    }
  }
}

function swatch(color, text) {
  const wrap = document.createElement("span");
  wrap.className = "item";
  const sw = document.createElement("span");
  sw.className = "swatch";
  sw.style.background = color;
  wrap.append(sw, document.createTextNode(text));
  return wrap;
}

/** Categorical choropleth, for risk category rather than magnitude. */
export function categoryChoropleth(container, features, categoryOf, colorMap, opts = {}) {
  const { label = () => "", detail = () => "", onClick = null, height = 380, legendInto = null, order = [] } = opts;
  container.replaceChildren();
  if (!features.length) return;

  const width = Math.max(container.clientWidth || 640, 280);
  const b = bounds(features);
  const h = fittedHeight(b, width, height);
  const project = projector(b, width, h);
  const svg = el("svg", {
    class: "chart map", width: "100%", height: h,
    viewBox: `0 0 ${width} ${h}`, role: "img",
  });

  const seen = new Map();
  for (const f of features) {
    const cat = String(categoryOf(f));
    seen.set(cat, (seen.get(cat) ?? 0) + 1);
    const path = el("path", {
      d: pathFor(f.geometry, project),
      fill: colorMap[cat] ?? NEUTRAL,
      stroke: "var(--surface-1)", "stroke-width": 0.6, class: "region",
    });
    const extra = detail(f);
    attachTip(path, `<div class="tt-title">${label(f)}</div>${cat}${extra ? "<br>" + extra : ""}`);
    if (onClick) {
      path.style.cursor = "pointer";
      path.addEventListener("click", () => onClick(f));
    }
    svg.append(path);
  }
  container.append(svg);

  if (legendInto) {
    legendInto.replaceChildren();
    const keys = order.length ? order.filter((k) => seen.has(k)) : [...seen.keys()];
    for (const k of keys) {
      legendInto.append(swatch(colorMap[k] ?? NEUTRAL, `${k} (${seen.get(k)})`));
    }
  }
}
