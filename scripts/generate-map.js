// Builds js/world-map-data.js from:
//  - scripts/countries_raw.json (French name, capital, ISO 3166-1 alpha-2)
//  - Natural Earth 1:10m admin-0 countries (downloaded and cached on first run)
//
// Also derives an extended "click hitbox" marker for small/scattered countries
// (micro-states, island nations) so they stay easy to click even at low zoom:
//  - a padded circle for compact, point-like countries (Monaco, Vatican-style)
//  - a padded convex hull for countries spread across many small islands
//
// Run: npm run generate-map
const fs = require("fs");
const path = require("path");
const https = require("https");

const topojsonServer = require("topojson-server");
const topojsonSimplify = require("topojson-simplify");
const topojsonClient = require("topojson-client");

const SOURCE_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson";
const CACHE_PATH = path.join(__dirname, ".cache", "ne_10m_admin_0_countries.geojson");
const SIMPLIFY_WEIGHT = 0.001;
const WIDTH = 1000; // geographic width: -180..180deg maps to 0..WIDTH, never changes
const HEIGHT = 500;
// The rendered canvas is wider than the geographic width: that extra strip of
// blank ocean past longitude 180deg gives the crowded Pacific cluster
// (Fiji/Tonga/Samoa...) real room to be laid out without fighting over the
// last few pixels before the true map edge. Antimeridian wrapping/regrouping
// still operates on true WIDTH (=360deg); only the canvas-edge clamps in the
// separation pass and the final viewBox use CANVAS_WIDTH.
const CANVAS_WIDTH = 1120;

// A country whose total projected area falls below this gets an extended marker.
const MARKER_AREA_THRESHOLD = 7;
// Countries made of MANY separate islands (true archipelagos) stay eligible up to
// this larger area. The ring-count bar is high on purpose: a mainland with a
// couple of coastal islands (Kuwait, Equatorial Guinea) has 3-4 rings and should
// NOT count as scattered; real archipelagos (Bahamas, Vanuatu...) have dozens.
const MARKER_ARCHIPELAGO_MIN_RINGS = 10;
const MARKER_ARCHIPELAGO_AREA_THRESHOLD = 20;
// Below this hull radius, a country is considered point-like and gets a plain circle.
const MARKER_CIRCLE_THRESHOLD = 7;
// Radius of that circle marker.
const MARKER_CIRCLE_RADIUS = 1.8;
// Spread-out countries (archipelagos) get their convex hull padded outward by this much.
const MARKER_HULL_PAD = 1.2;

// Small island nations (Pacific, Indian Ocean, Caribbean): their real landmass is
// often a handful of pixels, so we deliberately inflate each island's on-map
// footprint (unrealistic but necessary for it to be visible/clickable at
// world-view zoom), sourced from their unsimplified original geometry so there's
// still a real outline left to enlarge. The two that straddle the antimeridian
// also get their far-flung islands regrouped into one cluster instead of being
// split across the left/right edges of the map.
// Fiji is deliberately NOT in this set: its two main islands are already big
// enough to see on their own, so enlarging would instead inflate its dozens of
// tiny outlying reefs/islets into a cluttered mess of "extra islands" nobody
// associates with Fiji. It still needs ANTIMERIDIAN_REGROUP_ISOS below though.
const SCATTERED_ISLAND_ISOS = new Set([
  "KI", "MH", "FM", "NR", "PW", "WS", "SB", "TO", "TV", "VU",
  "MV", "SC", "MU", "KM", "BS", "VC",
]);
const MIN_RING_RADIUS = 0.6;
// Doesn't get enlarged (its main islands are big enough already), but still
// needs to take part in the crowded-Pacific separation pass below so its
// neighbors (Tonga...) know to avoid it, and it stays pinned at its true
// position instead of being the one shoved aside to make room.
const PINNED_ISOS = new Set(["FJ"]);
// New Zealand (Chatham/Kermadec Islands), the US (Aleutian tail) and Russia
// (Chukotka) all have a small piece of their own territory wrap to the far
// left edge while their mainland sits on the right - same fix as Kiribati/Fiji.
const ANTIMERIDIAN_REGROUP_ISOS = new Set(["KI", "FJ", "NZ", "US", "RU"]);

// Samoa and Tonga sit just past -180° longitude, which our fixed seam maps to
// the far LEFT edge (x~15-22) while the rest of Oceania sits near the far
// RIGHT edge - isolating them on the opposite side of the map from their
// actual Pacific neighbors, even though they're really immediately next door.
// Unwrap by a full turn (+WIDTH, i.e. +360deg) rather than snapping to an
// arbitrary spot - that's their true longitude, just expressed the other way
// round, so it preserves real relative position/order/spacing.
const PACIFIC_UNWRAP_ISOS = new Set(["WS", "TO"]);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return download(res.headers.location, dest).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          reject(new Error("Download failed: " + res.statusCode));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", reject);
  });
}

async function loadSourceGeojson() {
  if (!fs.existsSync(CACHE_PATH)) {
    console.log("Downloading Natural Earth 10m countries dataset...");
    await download(SOURCE_URL, CACHE_PATH);
  }
  return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
}

function project([lon, lat]) {
  const x = (lon + 180) * (WIDTH / 360);
  const y = (90 - lat) * (HEIGHT / 180);
  return [Number(x.toFixed(1)), Number(y.toFixed(1))];
}

function ringPointsToPath(points) {
  return points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join("") + "Z";
}

// Projects a geometry to its rings (each still closed), one array per ring.
function geometryToRings(geometry) {
  const polys =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
      ? geometry.coordinates
      : [];
  const rings = [];
  for (const poly of polys) {
    for (const ring of poly) {
      rings.push(ring.map(project));
    }
  }
  return rings;
}

function ringCentroid(ring) {
  const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  return [cx, cy];
}

// A regular polygon of the given radius, used as a stand-in shape for islands so
// tiny/degenerate they have no real spread to scale up (all points nearly coincide
// after simplification - scaling a zero-radius ring leaves it a zero-radius ring).
// Deterministic pseudo-random in [0,1), seeded from the island's own position so
// re-running the generator gives the same island shape every time.
function seededRandom(seed) {
  const x = Math.sin(seed) * 43758.5453;
  return x - Math.floor(x);
}

function syntheticPolygon(cx, cy, radius, sides = 9) {
  const pts = [];
  for (let i = 0; i < sides; i++) {
    // Jitter both the angle and the radius so the result reads as a small rough
    // island outline rather than a perfectly round "dot".
    const seed = cx * 1000 + cy * 37 + i * 91.7;
    const angle = (i / sides) * Math.PI * 2 + (seededRandom(seed) - 0.5) * ((Math.PI * 2) / sides) * 0.8;
    const r = radius * (0.55 + seededRandom(seed + 13.1) * 0.75);
    pts.push([Number((cx + Math.cos(angle) * r).toFixed(1)), Number((cy + Math.sin(angle) * r).toFixed(1))]);
  }
  return pts;
}

// Scales a ring outward from its own centroid so tiny islands read as a visible
// blob instead of a sub-pixel dot. No-op once the ring is already big enough.
function enlargeRing(ring, minRadius) {
  const [cx, cy] = ringCentroid(ring);
  const radius = Math.max(...ring.map(([x, y]) => Math.hypot(x - cx, y - cy)));
  if (radius >= minRadius) return ring;
  // Below this, the ring has effectively no shape left to scale (every point
  // collapsed onto the centroid) - draw a small stand-in polygon instead.
  if (radius < 0.15) return syntheticPolygon(cx, cy, minRadius);
  const scale = minRadius / radius;
  return ring.map(([x, y]) => [Number((cx + (x - cx) * scale).toFixed(1)), Number((cy + (y - cy) * scale).toFixed(1))]);
}

// Countries straddling the antimeridian get some islands projected near x=0 and
// others near x=WIDTH. Rather than leave the minority group stranded at the far
// edge (easy to miss, and previously invisible), regroup it into a small packed
// cluster right next to the main group.
function regroupAntimeridianRings(rings) {
  const allXs = rings.flat().map((p) => p[0]);
  const span = Math.max(...allXs) - Math.min(...allXs);
  if (span <= WIDTH * 0.6) return rings;

  const withSide = rings.map((ring) => {
    const [cx] = ringCentroid(ring);
    return { ring, side: cx < WIDTH / 2 ? "left" : "right" };
  });
  const leftPts = withSide.filter((r) => r.side === "left").reduce((s, r) => s + r.ring.length, 0);
  const rightPts = withSide.filter((r) => r.side === "right").reduce((s, r) => s + r.ring.length, 0);
  const primarySide = rightPts >= leftPts ? "right" : "left";

  const primaryRings = withSide.filter((r) => r.side === primarySide).map((r) => r.ring);
  const minorityRings = withSide.filter((r) => r.side !== primarySide).map((r) => r.ring);
  if (minorityRings.length === 0) return rings;

  const primaryPts = primaryRings.flat();
  const anchorX = primarySide === "right" ? Math.min(...primaryPts.map((p) => p[0])) : Math.max(...primaryPts.map((p) => p[0]));
  const anchorY = primaryPts.reduce((s, p) => s + p[1], 0) / primaryPts.length;
  const dir = primarySide === "right" ? -1 : 1;

  const cols = Math.max(1, Math.ceil(Math.sqrt(minorityRings.length)));
  const step = MIN_RING_RADIUS * 2.4;
  const relocated = minorityRings.map((ring, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const targetX = anchorX + dir * (col + 1) * step;
    const targetY = anchorY + (row - cols / 2) * step;
    const [cx, cy] = ringCentroid(ring);
    const dx = targetX - cx;
    const dy = targetY - cy;
    return ring.map(([x, y]) => [Number((x + dx).toFixed(1)), Number((y + dy).toFixed(1))]);
  });

  return [...primaryRings, ...relocated];
}

// Unwraps a country stranded on the wrong side of the map seam by a full turn
// (+WIDTH), i.e. its true longitude expressed the other way round. Preserves
// real position/spacing - see PACIFIC_UNWRAP_ISOS.
function unwrapRingsByFullTurn(rings) {
  return rings.map((ring) => ring.map(([x, y]) => [Number((x + WIDTH).toFixed(1)), y]));
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function cross(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

// Andrew's monotone chain convex hull.
function convexHull(pointsIn) {
  const points = [...new Map(pointsIn.map((p) => [p[0] + "," + p[1], p])).values()].sort(
    (a, b) => a[0] - b[0] || a[1] - b[1]
  );
  if (points.length <= 2) return points;
  const lower = [];
  for (const p of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function buildMarker(rings) {
  let allPoints = rings.flat();

  // Countries straddling the antimeridian (Fiji, Kiribati) get projected with some
  // points near x=0 and others near x=WIDTH, which would make a naive convex hull
  // span almost the entire map. Detect that split and unwrap it before hulling.
  const rawXs = allPoints.map((p) => p[0]);
  const rawSpan = Math.max(...rawXs) - Math.min(...rawXs);
  const wrapsAntimeridian = rawSpan > WIDTH * 0.6;
  if (wrapsAntimeridian) {
    allPoints = allPoints.map(([x, y]) => [x < WIDTH / 2 ? x + WIDTH : x, y]);
  }

  const hull = convexHull(allPoints);
  const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
  const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
  const radius = Math.max(...hull.map(([x, y]) => Math.hypot(x - cx, y - cy)));

  // A hull polygon can't be rendered sanely once it's been unwrapped past the map
  // edge, so antimeridian countries always fall back to a simple circle marker.
  if (radius < MARKER_CIRCLE_THRESHOLD || wrapsAntimeridian) {
    // Only wrap cx back into [0,WIDTH) when *this function* did the unwrapping
    // above - a cx past WIDTH that got there some other way (e.g. Samoa/Tonga,
    // already unwrapped by the caller before this ever ran) is a real, valid
    // position that the later separation/edge-clamp pass will translate back
    // on-canvas together with its path. Wrapping it here would silently teleport
    // it back to the wrong side of the map.
    const finalCx = wrapsAntimeridian ? ((cx % WIDTH) + WIDTH) % WIDTH : cx;
    return { type: "circle", cx: Number(finalCx.toFixed(1)), cy: Number(cy.toFixed(1)), r: MARKER_CIRCLE_RADIUS };
  }

  const padded = hull.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.hypot(dx, dy) || 1;
    const scale = (dist + MARKER_HULL_PAD) / dist;
    return [Number((cx + dx * scale).toFixed(1)), Number((cy + dy * scale).toFixed(1))];
  });
  return { type: "polygon", points: padded };
}

async function main() {
  const countries = require("./countries_raw.json"); // [name, capital, iso]
  const geo = await loadSourceGeojson();

  const wanted = new Map(countries.map(([name, capital, iso]) => [iso, { name, capital, iso }]));

  // Match each Natural Earth feature to our ISO list (prefer the "fixed" ISO_A2_EH field,
  // which corrects the well-known -99 bug for France, Norway, etc.).
  const matched = new Map();
  for (const f of geo.features) {
    const p = f.properties;
    const iso = p.ISO_A2_EH && p.ISO_A2_EH !== "-99" ? p.ISO_A2_EH : p.ISO_A2;
    if (wanted.has(iso) && !matched.has(iso)) matched.set(iso, f);
  }

  // Natural Earth's CONTINENT field, with a couple of Indian Ocean nations it
  // dumps into "Seven seas (open ocean)" reassigned to a sensible continent
  // (matching their own REGION_UN value) so every country lands in one of the
  // six continent game modes.
  const CONTINENT_OVERRIDES = { SC: "Africa", MU: "Africa", MV: "Asia" };
  const continentByIso = new Map();
  for (const [iso, f] of matched) {
    continentByIso.set(iso, CONTINENT_OVERRIDES[iso] || f.properties.CONTINENT);
  }

  // Somaliland is its own feature in Natural Earth (ISO_A2 "-99", unrecognized by
  // any UN member as independent), so it was never matched to "SO" above - leaving
  // a visible gap where northern Somalia should be. Kept as a separate "SO_LAND"
  // entry below so topojson-server dedupes their shared border into a common arc,
  // then dissolved back into Somalia with topojson.merge (a plain coordinate
  // concat would leave that internal border visibly stroked on the map).
  const somaliland = geo.features.find((f) => f.properties.NAME === "Somaliland");

  console.log("Matched", matched.size, "/", wanted.size, "countries");
  for (const iso of wanted.keys()) {
    if (!matched.has(iso)) console.log("  MISSING:", iso, wanted.get(iso).name);
  }

  const fc = {
    type: "FeatureCollection",
    features: [
      ...[...matched.entries()].map(([iso, f]) => ({
        type: "Feature",
        properties: { iso },
        geometry: f.geometry,
      })),
      ...(somaliland ? [{ type: "Feature", properties: { iso: "SO_LAND" }, geometry: somaliland.geometry }] : []),
    ],
  };

  // Topology-preserving simplification: dedupes shared borders then drops low-weight
  // vertices, while guaranteeing every ring keeps enough points to stay closed
  // (so tiny countries like Monaco or Vatican survive as small but real polygons).
  const topology = topojsonServer.topology({ countries: fc }, 1e5);
  const presimplified = topojsonSimplify.presimplify(topology);
  const simplified = topojsonSimplify.simplify(presimplified, SIMPLIFY_WEIGHT);
  const simplifiedFc = topojsonClient.feature(simplified, simplified.objects.countries);

  // Dissolve Somalia + Somaliland's now-shared border into one seamless geometry.
  let somaliaMerged = null;
  if (somaliland) {
    const geoms = simplified.objects.countries.geometries.filter((g) => g.properties.iso === "SO" || g.properties.iso === "SO_LAND");
    somaliaMerged = topojsonClient.merge(simplified, geoms);
  }

  const mapPaths = {};
  const mapMarkers = {};
  const isoBounds = {};
  const scatteredRings = {};
  let markerCount = 0;
  for (const f of simplifiedFc.features) {
    const iso = f.properties.iso;
    if (iso === "SO_LAND") continue; // merged into "SO" below, not a country of its own

    // Oceania's islands are so small that the global simplification pass collapses
    // most of their rings to a single point, leaving nothing real to scale up when
    // enlarging for visibility. Use the untouched original geometry for these
    // instead, so "enlarged" still means "the island's actual outline, just bigger".
    const geometry =
      iso === "SO" && somaliaMerged
        ? somaliaMerged
        : SCATTERED_ISLAND_ISOS.has(iso)
        ? matched.get(iso).geometry
        : f.geometry;
    const rawRings = geometryToRings(geometry);
    if (rawRings.length === 0) {
      console.log("  EMPTY GEOMETRY:", iso);
      continue;
    }
    // Marker eligibility is decided from the true (pre-enlarge) geometry, so that
    // inflating dozens of tiny islets for visibility doesn't inflate the summed
    // area past the archipelago threshold and disqualify the country.
    const area = rawRings.reduce((s, r) => s + ringArea(r), 0);

    let rings = rawRings;
    if (SCATTERED_ISLAND_ISOS.has(iso)) rings = rings.map((r) => enlargeRing(r, MIN_RING_RADIUS));
    if (ANTIMERIDIAN_REGROUP_ISOS.has(iso)) rings = regroupAntimeridianRings(rings);
    if (PACIFIC_UNWRAP_ISOS.has(iso)) rings = unwrapRingsByFullTurn(rings);

    if (SCATTERED_ISLAND_ISOS.has(iso) || PINNED_ISOS.has(iso)) scatteredRings[iso] = rings;

    const d = rings.map(ringPointsToPath).join("");
    mapPaths[iso] = d;

    // For continent-zoom purposes, use only the country's largest ring (its
    // mainland). Several countries bundle far-flung overseas territories into
    // the same multipolygon (French Guiana/Réunion inside "France", Chukotka
    // stretching Russia across the antimeridian to x=0..1000...) - including
    // those would make the continent's default zoom absurdly wide.
    const mainRing = rings.reduce((a, b) => (ringArea(b) > ringArea(a) ? b : a));
    isoBounds[iso] = {
      minX: Math.min(...mainRing.map((p) => p[0])),
      maxX: Math.max(...mainRing.map((p) => p[0])),
      minY: Math.min(...mainRing.map((p) => p[1])),
      maxY: Math.max(...mainRing.map((p) => p[1])),
    };

    // A country with several rings isn't necessarily "scattered": Kuwait has a
    // couple of small coastal islands right next to its mainland and doesn't need
    // help. Only treat it as an archipelago if its hull actually spreads wide
    // (i.e. buildMarker would draw a padded hull, not collapse to a small circle).
    let marker = null;
    if (area < MARKER_AREA_THRESHOLD) {
      marker = buildMarker(rings);
    } else if (rings.length >= MARKER_ARCHIPELAGO_MIN_RINGS && area < MARKER_ARCHIPELAGO_AREA_THRESHOLD) {
      const candidate = buildMarker(rings);
      if (candidate.type === "polygon") marker = candidate;
    }
    if (marker) {
      mapMarkers[iso] = marker;
      markerCount++;
    }
  }

  // Scattered-island nations that are geographically close (Fiji/Vanuatu/Tonga/
  // Samoa/Solomon..., or Seychelles/Comoros/Maldives) end up with overlapping
  // enlarged islands and dashed zones. Resolve this by placing them one at a
  // time, in true west-to-east order, only ever nudging the one currently
  // being placed away from ones already locked in. That guarantees a final
  // layout with zero overlaps (each country is only ever checked - and only
  // ever moved - once, against neighbors that never move again afterwards),
  // unlike a global relaxation which can settle into a stuck equilibrium.
  const SEPARATION_MIN_GAP = 5;
  const EDGE_MARGIN = 3;
  const boxes = {};
  for (const [iso, rings] of Object.entries(scatteredRings)) {
    const pts = rings.flat();
    boxes[iso] = {
      minX: Math.min(...pts.map((p) => p[0])),
      maxX: Math.max(...pts.map((p) => p[0])),
      minY: Math.min(...pts.map((p) => p[1])),
      maxY: Math.max(...pts.map((p) => p[1])),
    };
  }

  // (PINNED_ISOS declared above, near SCATTERED_ISLAND_ISOS.)

  const scatteredIsos = Object.keys(boxes).sort((a, b) => {
    if (PINNED_ISOS.has(a) !== PINNED_ISOS.has(b)) return PINNED_ISOS.has(a) ? -1 : 1;
    return (boxes[a].minX + boxes[a].maxX) / 2 - (boxes[b].minX + boxes[b].maxX) / 2;
  });
  const offsets = {};
  const placed = [];

  for (const iso of scatteredIsos) {
    const box = boxes[iso];
    const o = { dx: 0, dy: 0 };

    if (PINNED_ISOS.has(iso)) {
      // Still keep it on-canvas, just never move it to dodge a neighbor.
      if (box.minX + o.dx < EDGE_MARGIN) o.dx = EDGE_MARGIN - box.minX;
      if (box.maxX + o.dx > CANVAS_WIDTH - EDGE_MARGIN) o.dx = CANVAS_WIDTH - EDGE_MARGIN - box.maxX;
      if (box.minY + o.dy < EDGE_MARGIN) o.dy = EDGE_MARGIN - box.minY;
      if (box.maxY + o.dy > HEIGHT - EDGE_MARGIN) o.dy = HEIGHT - EDGE_MARGIN - box.maxY;
      offsets[iso] = o;
      placed.push(iso);
      continue;
    }

    for (let tries = 0; tries < 60; tries++) {
      let changed = false;

      // Keep it on the canvas first...
      if (box.minX + o.dx < EDGE_MARGIN) {
        o.dx = EDGE_MARGIN - box.minX;
        changed = true;
      }
      if (box.maxX + o.dx > CANVAS_WIDTH - EDGE_MARGIN) {
        o.dx = CANVAS_WIDTH - EDGE_MARGIN - box.maxX;
        changed = true;
      }
      if (box.minY + o.dy < EDGE_MARGIN) {
        o.dy = EDGE_MARGIN - box.minY;
        changed = true;
      }
      if (box.maxY + o.dy > HEIGHT - EDGE_MARGIN) {
        o.dy = HEIGHT - EDGE_MARGIN - box.maxY;
        changed = true;
      }
      if (changed) continue;

      // ...then push clear of every zone already locked in.
      const minX = box.minX + o.dx - SEPARATION_MIN_GAP / 2;
      const maxX = box.maxX + o.dx + SEPARATION_MIN_GAP / 2;
      const minY = box.minY + o.dy - SEPARATION_MIN_GAP / 2;
      const maxY = box.maxY + o.dy + SEPARATION_MIN_GAP / 2;
      for (const otherIso of placed) {
        const other = boxes[otherIso];
        const oo = offsets[otherIso];
        const oMinX = other.minX + oo.dx - SEPARATION_MIN_GAP / 2;
        const oMaxX = other.maxX + oo.dx + SEPARATION_MIN_GAP / 2;
        const oMinY = other.minY + oo.dy - SEPARATION_MIN_GAP / 2;
        const oMaxY = other.maxY + oo.dy + SEPARATION_MIN_GAP / 2;
        const overlapX = Math.min(maxX, oMaxX) - Math.max(minX, oMinX);
        const overlapY = Math.min(maxY, oMaxY) - Math.max(minY, oMinY);
        if (overlapX > 0 && overlapY > 0) {
          const cx = (minX + maxX) / 2;
          const cy = (minY + maxY) / 2;
          const oCx = (oMinX + oMaxX) / 2;
          const oCy = (oMinY + oMaxY) / 2;
          const xDir = cx >= oCx ? 1 : -1;
          // A push along X that would immediately be undone by the edge clamp
          // (no room left in that direction - e.g. Tonga already pinned against
          // the canvas edge by Fiji) can't actually resolve anything. Fall back
          // to Y in that case, even if it's the larger overlap, since there's
          // real room to move there instead.
          const xBlockedByEdge =
            (xDir > 0 && box.maxX + o.dx + xDir * overlapX > CANVAS_WIDTH - EDGE_MARGIN) ||
            (xDir < 0 && box.minX + o.dx + xDir * overlapX < EDGE_MARGIN);
          if (overlapX < overlapY && !xBlockedByEdge) {
            o.dx += xDir * overlapX;
          } else {
            o.dy += (cy >= oCy ? 1 : -1) * overlapY;
          }
          changed = true;
          break; // re-check edges and all neighbors from scratch after any move
        }
      }
      if (!changed) break;
    }

    // Guarantee it's on-canvas no matter how the loop above exited - a shape
    // that's still off the edge because neighbor-avoidance and edge-clamping
    // couldn't both be satisfied in the try budget is worse (invisible) than
    // one that's back on canvas but touching a neighbor.
    if (box.minX + o.dx < EDGE_MARGIN) o.dx = EDGE_MARGIN - box.minX;
    if (box.maxX + o.dx > CANVAS_WIDTH - EDGE_MARGIN) o.dx = CANVAS_WIDTH - EDGE_MARGIN - box.maxX;
    if (box.minY + o.dy < EDGE_MARGIN) o.dy = EDGE_MARGIN - box.minY;
    if (box.maxY + o.dy > HEIGHT - EDGE_MARGIN) o.dy = HEIGHT - EDGE_MARGIN - box.maxY;

    offsets[iso] = o;
    placed.push(iso);
  }

  let separatedCount = 0;
  for (const iso of scatteredIsos) {
    const { dx, dy } = offsets[iso];
    if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) continue;
    separatedCount++;

    const rings = scatteredRings[iso].map((ring) =>
      ring.map(([x, y]) => [Number((x + dx).toFixed(1)), Number((y + dy).toFixed(1))])
    );
    mapPaths[iso] = rings.map(ringPointsToPath).join("");

    const mainRing = rings.reduce((a, b) => (ringArea(b) > ringArea(a) ? b : a));
    isoBounds[iso] = {
      minX: Math.min(...mainRing.map((p) => p[0])),
      maxX: Math.max(...mainRing.map((p) => p[0])),
      minY: Math.min(...mainRing.map((p) => p[1])),
      maxY: Math.max(...mainRing.map((p) => p[1])),
    };

    if (mapMarkers[iso]) {
      const m = mapMarkers[iso];
      mapMarkers[iso] =
        m.type === "circle"
          ? { type: "circle", cx: Number((m.cx + dx).toFixed(1)), cy: Number((m.cy + dy).toFixed(1)), r: m.r }
          : { type: "polygon", points: m.points.map(([x, y]) => [Number((x + dx).toFixed(1)), Number((y + dy).toFixed(1))]) };
    }
  }
  console.log("Separated overlapping scattered-island zones:", separatedCount);

  const countryList = countries.map(([name, capital, iso]) => ({
    name,
    capital,
    iso,
    hasMap: !!mapPaths[iso],
    continent: continentByIso.get(iso) || null,
  }));

  // Default zoom box per continent, used when entering a continent-specific game
  // mode: the union of its countries' bounds, padded and stretched to the map's
  // 2:1 aspect ratio so the continent fills the view with no letterboxing.
  // Russia's mainland alone spans from the Baltic to the Bering Strait, so
  // including it would zoom "Europe" out to cover most of Asia too. It's still
  // playable as part of Europe - just excluded from sizing that default zoom.
  const CONTINENT_BOUNDS_EXCLUDE = new Set(["RU"]);
  const continentBounds = {};
  for (const c of countryList) {
    if (!c.hasMap || !c.continent || CONTINENT_BOUNDS_EXCLUDE.has(c.iso)) continue;
    const b = isoBounds[c.iso];
    const acc = continentBounds[c.continent] || { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    acc.minX = Math.min(acc.minX, b.minX);
    acc.maxX = Math.max(acc.maxX, b.maxX);
    acc.minY = Math.min(acc.minY, b.minY);
    acc.maxY = Math.max(acc.maxY, b.maxY);
    continentBounds[c.continent] = acc;
  }

  const CONTINENT_PADDING = 0.1; // 10% breathing room on each side
  const targetAspect = CANVAS_WIDTH / HEIGHT;
  const continentViewBoxes = {};
  for (const [continent, b] of Object.entries(continentBounds)) {
    const padX = (b.maxX - b.minX) * CONTINENT_PADDING;
    const padY = (b.maxY - b.minY) * CONTINENT_PADDING;
    let minX = b.minX - padX;
    let maxX = b.maxX + padX;
    let minY = b.minY - padY;
    let maxY = b.maxY + padY;

    const w = maxX - minX;
    const h = maxY - minY;
    if (w / h > targetAspect) {
      const newH = w / targetAspect;
      const cy = (minY + maxY) / 2;
      minY = cy - newH / 2;
      maxY = cy + newH / 2;
    } else {
      const newW = h * targetAspect;
      const cx = (minX + maxX) / 2;
      minX = cx - newW / 2;
      maxX = cx + newW / 2;
    }

    // Clamp to the world map's own bounds (can't pan/zoom past the edge anyway).
    minX = Math.max(0, minX);
    minY = Math.max(0, minY);
    maxX = Math.min(CANVAS_WIDTH, maxX);
    maxY = Math.min(HEIGHT, maxY);

    continentViewBoxes[continent] = [
      Number(minX.toFixed(1)),
      Number(minY.toFixed(1)),
      Number((maxX - minX).toFixed(1)),
      Number((maxY - minY).toFixed(1)),
    ];
  }

  const out =
    "window.COUNTRIES = " + JSON.stringify(countryList) + ";\n" +
    `window.MAP_VIEWBOX = "0 0 ${CANVAS_WIDTH} ${HEIGHT}";\n` +
    "window.MAP_PATHS = " + JSON.stringify(mapPaths) + ";\n" +
    "window.MAP_MARKERS = " + JSON.stringify(mapMarkers) + ";\n" +
    "window.CONTINENT_BOUNDS = " + JSON.stringify(continentViewBoxes) + ";\n";

  const outPath = path.join(__dirname, "..", "js", "world-map-data.js");
  fs.writeFileSync(outPath, out);
  console.log("Written", outPath, "(" + (out.length / 1024).toFixed(0) + " KB)");
  console.log(
    "Countries with a map shape:",
    countryList.filter((c) => c.hasMap).length,
    "/",
    countryList.length
  );
  console.log("Countries with an extended click marker:", markerCount);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
