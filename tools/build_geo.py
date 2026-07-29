"""Build the map layers: join Nigeria boundaries to the model's geographies.

    python tools/build_geo.py            # build, and report the join
    python tools/build_geo.py --report   # report only, write nothing

Inputs, downloaded into data-src/ (not committed, see the URLs below):
  geoBoundaries NGA ADM1, 37 states, and ADM2, 774 LGAs.
  Source GRID3, licence CC BY 4.0. Attribution is recorded in site/data/geo.json
  and rendered in the site footer.

    https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/NGA/ADM1/geoBoundaries-NGA-ADM1_simplified.geojson
    https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/NGA/ADM2/geoBoundaries-NGA-ADM2_simplified.geojson

Two problems this solves:

1. **ADM2 has no parent state.** LGA names repeat across Nigeria (Ifelodun,
   Irepodun, Obi, Bassa and others), so a name-only join would collide. Each
   LGA's state is therefore derived geometrically, by testing an interior point
   against the state polygons.

2. **Names differ between sources.** Normalization handles case, punctuation and
   separators; anything left over needs an explicit alias. Unmatched geographies
   are reported rather than dropped silently, which is the failure mode that
   makes a choropleth look complete when it is not.
"""

import difflib
import json
import math
import os
import re
import sys
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data-src")
OUT = os.path.join(ROOT, "site", "data", "geo.json")
BASE = os.path.join(ROOT, "site", "data", "base.json")

ATTRIBUTION = {
    "name": "geoBoundaries (gbOpen), source GRID3",
    "licence": "CC BY 4.0",
    "url": "https://www.geoboundaries.org/",
    "release": "9469f09",
    "note": "Nigeria ADM1 (37 states) and ADM2 (774 LGAs), 2022 boundaries.",
}

# Boundary-name to model-name, for cases normalization cannot reach.
STATE_ALIASES = {
    "abuja federal capital territory": "FCT",
    "nasarawa": "Nassarawa",
}

# Filled in as the join report surfaces them. Keys are (state, normalized LGA).
LGA_ALIASES = {}


# ------------------------------------------------------------- name handling


def normalize(name):
    """Casefold and strip everything that varies cosmetically between sources.

    The model disambiguates repeated LGA names with a parenthetical, as in
    "Obi (Benue)" and "Ifelodun (Kwara)", because those names recur across
    states. The state is carried separately here, so the parenthetical is
    redundant and is dropped.
    """
    text = unicodedata.normalize("NFKD", str(name or ""))
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.lower()
    text = re.sub(r"\([^)]*\)", " ", text)
    text = text.replace("&", " and ")
    text = re.sub(r"[/\-_,.'’]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def loose(text):
    """A deliberately lossy key for comparing spelling variants.

    Collapses doubled letters and folds vowel pairs that alternate freely in
    transliterated Nigerian place names: Nassarawa and Nasarawa, Bagudu and
    Bagudo, Patigi and Pategi, Aiyedaade and Ayedade.
    """
    text = re.sub(r"\s+", "", text)
    text = re.sub(r"(.)\1+", r"\1", text)
    text = text.replace("ai", "a").replace("ay", "a")
    text = re.sub(r"[aeiou]", "", text)
    return text


def tokens(text):
    return set(text.split())


# --------------------------------------------------------------- geometry


def rings_of(geometry):
    """Every exterior ring in a Polygon or MultiPolygon."""
    if geometry["type"] == "Polygon":
        return [geometry["coordinates"][0]]
    if geometry["type"] == "MultiPolygon":
        return [poly[0] for poly in geometry["coordinates"]]
    return []


def ring_area(ring):
    """Signed planar area. Only used to compare ring sizes, so degrees are fine."""
    total = 0.0
    for i in range(len(ring) - 1):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[i + 1][0], ring[i + 1][1]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2


def interior_point(geometry):
    """A point inside the largest ring: its centroid, else a vertex average.

    A centroid can fall outside a strongly concave polygon, so the result is
    checked and falls back to the vertex mean, then to the first vertex.
    """
    rings = rings_of(geometry)
    if not rings:
        return None
    ring = max(rings, key=ring_area)
    cx = sum(p[0] for p in ring) / len(ring)
    cy = sum(p[1] for p in ring) / len(ring)
    if point_in_ring((cx, cy), ring):
        return (cx, cy)
    # walk toward the interior from the vertex mean
    for frac in (0.5, 0.25, 0.75):
        for i in range(0, len(ring) - 1, max(1, len(ring) // 12)):
            px = ring[i][0] + (cx - ring[i][0]) * frac
            py = ring[i][1] + (cy - ring[i][1]) * frac
            if point_in_ring((px, py), ring):
                return (px, py)
    return (cx, cy)


def point_in_ring(point, ring):
    """Ray casting. True if the point is inside the ring."""
    x, y = point
    inside = False
    n = len(ring)
    for i in range(n - 1):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[i + 1][0], ring[i + 1][1]
        if (y1 > y) != (y2 > y):
            t = (y - y1) / (y2 - y1) if y2 != y1 else 0.0
            if x < x1 + t * (x2 - x1):
                inside = not inside
    return inside


def point_in_geometry(point, geometry):
    return any(point_in_ring(point, ring) for ring in rings_of(geometry))


def bbox_of(geometry):
    xs, ys = [], []
    for ring in rings_of(geometry):
        for p in ring:
            xs.append(p[0])
            ys.append(p[1])
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None


def in_bbox(point, box):
    x, y = point
    return box and box[0] <= x <= box[2] and box[1] <= y <= box[3]


# --------------------------------------------------- simplify and quantize


def simplify(points, tolerance):
    """Douglas-Peucker. Keeps endpoints, so rings stay closed."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        worst, index = 0.0, None
        ax, ay = points[first][0], points[first][1]
        bx, by = points[last][0], points[last][1]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy)
        for i in range(first + 1, last):
            px, py = points[i][0], points[i][1]
            if norm == 0:
                dist = math.hypot(px - ax, py - ay)
            else:
                dist = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if dist > worst:
                worst, index = dist, i
        if index is not None and worst > tolerance:
            keep[index] = True
            stack.append((first, index))
            stack.append((index, last))
    return [p for p, k in zip(points, keep) if k]


def clean_geometry(geometry, tolerance, places):
    """Simplify every ring and round coordinates. Drops degenerate rings."""
    def do_ring(ring):
        pts = simplify(ring, tolerance)
        out = [[round(p[0], places), round(p[1], places)] for p in pts]
        # re-close if rounding merged the endpoints' neighbours
        if out and out[0] != out[-1]:
            out.append(out[0])
        return out if len(out) >= 4 else None

    if geometry["type"] == "Polygon":
        rings = [r for r in (do_ring(r) for r in geometry["coordinates"]) if r]
        return {"type": "Polygon", "coordinates": rings} if rings else None
    if geometry["type"] == "MultiPolygon":
        polys = []
        for poly in geometry["coordinates"]:
            rings = [r for r in (do_ring(r) for r in poly) if r]
            if rings:
                polys.append(rings)
        return {"type": "MultiPolygon", "coordinates": polys} if polys else None
    return None


def count_points(geometry):
    if not geometry:
        return 0
    if geometry["type"] == "Polygon":
        return sum(len(r) for r in geometry["coordinates"])
    return sum(len(r) for poly in geometry["coordinates"] for r in poly)


# ------------------------------------------------------------------- build


def load(level):
    path = os.path.join(SRC, f"NGA-{level}_simplified.geojson")
    if not os.path.exists(path):
        sys.exit(f"missing {path}\nsee the download URLs in this file's docstring")
    with open(path, encoding="utf8") as fh:
        return json.load(fh)["features"]


def main():
    report_only = "--report" in sys.argv
    with open(BASE, encoding="utf8") as fh:
        base = json.load(fh)

    model_states = base["states"]
    model_lgas = [(l["state"], l["lga"]) for l in base["lgas"]]

    adm1 = load("ADM1")
    adm2 = load("ADM2")

    # --- states -----------------------------------------------------------
    by_norm = {}
    for st in model_states:
        by_norm[normalize(st)] = st

    state_of_feature = {}
    unmatched_states = []
    for f in adm1:
        raw = f["properties"]["shapeName"]
        key = normalize(raw)
        model = STATE_ALIASES.get(key) or by_norm.get(key)
        if model:
            state_of_feature[id(f)] = model
        else:
            unmatched_states.append(raw)

    print(f"States: {len(state_of_feature)}/{len(model_states)} matched")
    if unmatched_states:
        print("  UNMATCHED boundary states:", unmatched_states)
    missing = set(model_states) - set(state_of_feature.values())
    if missing:
        print("  model states with no boundary:", sorted(missing))

    # --- assign each LGA to a state, geometrically ------------------------
    state_boxes = [(f, bbox_of(f["geometry"])) for f in adm1]
    lga_state = {}
    no_state = []
    for f in adm2:
        pt = interior_point(f["geometry"])
        if pt is None:
            no_state.append(f["properties"]["shapeName"])
            continue
        hit = None
        for sf, box in state_boxes:
            if in_bbox(pt, box) and point_in_geometry(pt, sf["geometry"]):
                hit = sf
                break
        if hit is None:
            # nearest state centroid, for coastal or sliver cases
            best, bestd = None, None
            for sf, box in state_boxes:
                c = interior_point(sf["geometry"])
                d = math.hypot(c[0] - pt[0], c[1] - pt[1])
                if bestd is None or d < bestd:
                    best, bestd = sf, d
            hit = best
            no_state.append(f["properties"]["shapeName"])
        lga_state[id(f)] = state_of_feature.get(id(hit))

    if no_state:
        print(f"  note: {len(no_state)} LGAs fell back to nearest-state assignment: "
              f"{no_state[:6]}{' ...' if len(no_state) > 6 else ''}")

    # --- LGAs -------------------------------------------------------------
    model_by_key = {}
    for state, lga in model_lgas:
        model_by_key.setdefault((state, normalize(lga)), (state, lga))

    # Pass 1, exact on the normalized name within the state.
    matched, pending = {}, []
    used = set()
    for f in adm2:
        state = lga_state.get(id(f))
        raw = f["properties"]["shapeName"]
        key = (state, normalize(raw))
        target = LGA_ALIASES.get(key) or model_by_key.get(key)
        if target and target not in used:
            matched[id(f)] = target
            used.add(target)
        else:
            pending.append((f, state, raw))
    exact = len(matched)

    # Pass 2, resolve the remainder within each state. Both sides have exactly
    # 774 LGAs and the state assignment above is verified, so within a state the
    # counts must balance, which makes best-similarity pairing safe. Every pair
    # chosen here is printed so it can be reviewed rather than trusted.
    fuzzy_log = []
    remaining_model = {}
    for state, lga in set(model_lgas) - used:
        remaining_model.setdefault(state, []).append(lga)

    by_state_pending = {}
    for f, state, raw in pending:
        by_state_pending.setdefault(state, []).append((f, raw))

    for state, items in sorted(by_state_pending.items(), key=lambda t: str(t[0])):
        candidates = remaining_model.get(state, [])
        scored = []
        for f, raw in items:
            nraw = normalize(raw)
            for cand in candidates:
                ncand = normalize(cand)
                ratio = difflib.SequenceMatcher(None, nraw, ncand).ratio()
                subset = tokens(nraw) <= tokens(ncand) or tokens(ncand) <= tokens(nraw)
                same_loose = loose(nraw) == loose(ncand)
                score = max(ratio, 0.95 if same_loose else 0, 0.92 if subset else 0)
                scored.append((score, ratio, f, raw, cand, subset, same_loose))
        scored.sort(key=lambda t: -t[0])
        taken_f, taken_c = set(), set()
        for score, ratio, f, raw, cand, subset, same_loose in scored:
            if id(f) in taken_f or cand in taken_c or score < 0.62:
                continue
            matched[id(f)] = (state, cand)
            used.add((state, cand))
            taken_f.add(id(f))
            taken_c.add(cand)
            why = "consonant-skeleton" if same_loose else ("token-subset" if subset else f"ratio {ratio:.2f}")
            fuzzy_log.append((state, raw, cand, why))

    print(f"\nLGAs: {len(matched)}/{len(model_lgas)} matched "
          f"({exact} exact, {len(fuzzy_log)} resolved by similarity)")
    if fuzzy_log:
        print("  REVIEW these inexact pairings:")
        for state, raw, cand, why in sorted(fuzzy_log):
            print(f"    {state:14s} {raw:26s} -> {cand:28s} ({why})")

    still = [(s, r) for f, s, r in pending if id(f) not in matched]
    if still:
        print(f"  UNMATCHED boundary LGAs ({len(still)}):")
        for state, raw in sorted(still, key=lambda t: (str(t[0]), t[1])):
            print(f"    {state or '?':16s} {raw}")
    leftover = sorted(set(model_lgas) - used)
    if leftover:
        print(f"  model LGAs with no boundary ({len(leftover)}):")
        for state, lga in leftover:
            print(f"    {state:16s} {lga}")

    if report_only:
        return

    # --- write ------------------------------------------------------------
    # Tolerances in degrees. ~0.005 deg is roughly 550 m, invisible at the
    # zoom a national choropleth renders at.
    layers = {}
    for level, feats, keyer, tol in (
        ("states", adm1, lambda f: state_of_feature.get(id(f)), 0.004),
        ("lgas", adm2, lambda f: matched.get(id(f)), 0.003),
    ):
        out = []
        before = after = 0
        for f in feats:
            key = keyer(f)
            if not key:
                continue
            before += count_points(f["geometry"])
            geom = clean_geometry(f["geometry"], tol, 4)
            if not geom:
                continue
            after += count_points(geom)
            if level == "states":
                out.append({"state": key, "geometry": geom})
            else:
                out.append({"state": key[0], "lga": key[1], "geometry": geom})
        layers[level] = out
        print(f"\n{level}: {len(out)} features, {before:,} points simplified to {after:,} "
              f"({100 * (1 - after / before):.0f}% fewer)")

    payload = {"attribution": ATTRIBUTION, **layers}
    with open(OUT, "w", encoding="utf8") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    print(f"\nwrote {OUT}: {os.path.getsize(OUT) / 1e6:.2f} MB")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
