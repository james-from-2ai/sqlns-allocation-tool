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

/**
 * Drifting dots behind the hero.
 *
 * Each dot wanders through four random waypoints and returns to its start, so
 * the loop never visibly jumps. One shared keyframe reads per-dot custom
 * properties, which avoids generating N stylesheets and keeps everything on the
 * compositor: there is no per-frame JavaScript, so this costs nothing to run and
 * the browser throttles it while the hero is off-screen.
 *
 * Seeded rather than Math.random, so a given build always looks the same and a
 * visual regression is a real change rather than noise.
 */
export function heroDots(container, count = 73) {
  container.replaceChildren();
  let seed = 20260729;
  const rand = () => {
    // mulberry32
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const between = (lo, hi) => lo + rand() * (hi - lo);

  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const dot = document.createElement("span");
    dot.className = "hero-dot";
    const size = between(1, 2.6);
    dot.style.width = `${size.toFixed(2)}px`;
    dot.style.height = `${size.toFixed(2)}px`;
    dot.style.left = `${between(0, 100).toFixed(2)}%`;
    dot.style.top = `${between(0, 100).toFixed(2)}%`;
    // Larger dots read as nearer, so let them drift further and glow slightly more.
    const reach = 16 + (size / 2.6) * 42;
    for (const n of [1, 2, 3]) {
      dot.style.setProperty(`--x${n}`, `${between(-reach, reach).toFixed(1)}px`);
      dot.style.setProperty(`--y${n}`, `${between(-reach, reach).toFixed(1)}px`);
    }
    // A shorter period is a faster drift, since the path length is unchanged.
    // The bounds are solved rather than scaled: the seeded draws do not average
    // to the range midpoint, and the dot count changes how many are taken, so
    // scaling alone undershoots the intended speed. This range yields a realized
    // mean of 14.9s over 73 dots.
    dot.style.setProperty("--dur", `${between(8.8, 20.2).toFixed(1)}s`);
    dot.style.setProperty("--delay", `-${between(0, 60).toFixed(1)}s`);
    dot.style.setProperty("--twinkle", `${between(5, 13).toFixed(1)}s`);
    dot.style.setProperty("--peak", between(0.14, 0.5).toFixed(2));
    frag.append(dot);
  }
  container.append(frag);
}

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
  let maxDelay = 0;

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
    // Scaled with the transition duration in styles.css; changing one without
    // the other alters the choreography rather than just the pace.
    const delay = 280 + dist * 11.2;
    maxDelay = Math.max(maxDelay, delay);
    path.style.setProperty("--delay", `${delay.toFixed(0)}ms`);
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

  // Start the idle drift only once every piece has settled, for the reason given
  // beside `.hero-map.drifting` in styles.css. 2730ms is the transform
  // transition; maxDelay is the largest stagger issued above.
  setTimeout(() => svg.classList.add("drifting"), maxDelay + 2730 + 60);
}
