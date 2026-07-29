/**
 * Hero graphic: the 37 states assemble themselves into Nigeria.
 *
 * Rather than decorative jigsaw shapes, these are the actual state polygons from
 * the same boundary file the choropleths use, shaded by the worst risk category
 * present in each state. So the ornament is also the data, and it previews what
 * the tool is for.
 *
 * Each piece starts offset radially from the country's centre and settles into
 * place on a staggered delay, then drifts very slightly so the composition stays
 * alive without becoming distracting. Motion is disabled outright under
 * prefers-reduced-motion.
 */

const SVG = "http://www.w3.org/2000/svg";
const el = (n, a = {}) => {
  const node = document.createElementNS(SVG, n);
  for (const [k, v] of Object.entries(a)) node.setAttribute(k, v);
  return node;
};

function ringsOf(geometry) {
  if (!geometry) return [];
  return geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat();
}

/**
 * Draw the assembling map.
 *
 * @param container element to render into
 * @param states    [{state, geometry}] from geo.json
 * @param riskOf    state name -> risk level string, for shading
 * @param colorOf   risk level -> CSS colour
 */
export function heroMap(container, states, riskOf, colorOf) {
  container.replaceChildren();
  if (!states.length) return;

  const W = 520;
  const H = 440;
  const pad = 12;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of states) {
    for (const ring of ringsOf(f.geometry)) {
      for (const [lon, lat] of ring) {
        if (lon < minX) minX = lon;
        if (lon > maxX) maxX = lon;
        if (lat < minY) minY = lat;
        if (lat > maxY) maxY = lat;
      }
    }
  }
  const kx = Math.cos((((minY + maxY) / 2) * Math.PI) / 180);
  const spanX = (maxX - minX) * kx;
  const spanY = maxY - minY;
  const scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanY);
  const offX = pad + (W - pad * 2 - spanX * scale) / 2;
  const offY = pad + (H - pad * 2 - spanY * scale) / 2;
  const project = ([lon, lat]) => [
    offX + (lon - minX) * kx * scale,
    offY + (maxY - lat) * scale,
  ];

  const svg = el("svg", {
    viewBox: `0 0 ${W} ${H}`,
    class: "hero-map",
    role: "img",
    "aria-label": "Map of Nigeria's 37 states, shaded by highest risk category present",
  });

  const cx = W / 2;
  const cy = H / 2;

  states.forEach((f, i) => {
    const parts = [];
    let sx = 0, sy = 0, n = 0;
    for (const ring of ringsOf(f.geometry)) {
      if (ring.length < 3) continue;
      let d = "";
      for (let j = 0; j < ring.length; j++) {
        const [x, y] = project(ring[j]);
        d += `${j === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
        sx += x; sy += y; n++;
      }
      parts.push(d + "Z");
    }
    if (!parts.length) return;

    // Offset each piece outward from the centre, so they converge inward.
    const px = n ? sx / n : cx;
    const py = n ? sy / n : cy;
    const dx = px - cx;
    const dy = py - cy;
    const dist = Math.hypot(dx, dy) || 1;
    const push = 46;
    const tx = (dx / dist) * push;
    const ty = (dy / dist) * push;

    const path = el("path", {
      d: parts.join(""),
      fill: colorOf(riskOf(f.state)),
      stroke: "rgba(255,255,255,0.22)",
      "stroke-width": 0.7,
      class: "hero-piece",
    });
    path.style.setProperty("--tx", `${tx.toFixed(1)}px`);
    path.style.setProperty("--ty", `${ty.toFixed(1)}px`);
    // Stagger by distance from the centre, so it reads as settling inward.
    path.style.setProperty("--delay", `${(80 + dist * 3.2).toFixed(0)}ms`);
    path.style.setProperty("--float-delay", `${(i * 137) % 4000}ms`);

    const title = el("title");
    title.textContent = `${f.state} (risk ${riskOf(f.state)})`;
    path.append(title);
    svg.append(path);
  });

  container.append(svg);

  // Trigger the transition once the initial state has painted.
  //
  // requestAnimationFrame does not fire in a tab that is not being composited,
  // and the pieces start at opacity 0, so relying on it alone can leave the
  // graphic permanently invisible. The timer is a guaranteed fallback and the
  // class is idempotent, so whichever runs first wins.
  const reveal = () => svg.classList.add("assembled");
  requestAnimationFrame(() => requestAnimationFrame(reveal));
  setTimeout(reveal, 120);
}
