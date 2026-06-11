# Build Prompt: Offline-First OSM Hike Route Planner

## Goal

Build a **single-page web application** (one self-contained HTML file, or a small static bundle — no backend, no server-side code) that generates pleasant hiking routes from OpenStreetMap data entirely in the browser. The user defines a hiking *area*, a start point (and optionally an end point), a target length, and the app generates several candidate routes for them to cycle through, pick, save, and export as GPX.

All OSM data, the parsed routing graph, saved areas, saved points, and saved routes are cached in **IndexedDB** so the app works offline after the first download of an area and does not repeatedly hammer the Overpass API.

## Hard constraints

- Pure client-side. No backend, no build step required to run (a bundler during development is fine, but the output must be statically servable / openable).
- No third-party routing API at runtime. The routing engine runs in the browser on locally cached OSM data. (Overpass is used only to *fetch* raw data for an area, then cached.)
- Must degrade gracefully when offline if the area's data is already cached.
- Respect OSM/Overpass usage policy (see "Overpass etiquette") and display ODbL attribution.

## Suggested tech stack

- **Map UI:** Leaflet.
- **Polygon / point drawing:** Leaflet.draw (or Leaflet-Geoman) for picking the area polygon and points.
- **OSM fetch:** Overpass API. Query only routable highways within the polygon, not all features.
- **Parsing:** parse the Overpass JSON directly, or use `osmtogeojson` as an intermediate.
- **Geometry helpers:** Turf.js (distance, bearing, destination, nearest-point-on-line, bbox).
- **Storage:** IndexedDB — `idb` wrapper recommended for ergonomics. Small scalar prefs (last-used length, route count, chosen Overpass instance) can live in `localStorage`.
- **GPX export:** `togpx`, or hand-roll a `<trk><trkseg>` writer (trivial and dependency-free).
- **Graph / shortest path:** hand-rolled adjacency list + binary-heap Dijkstra, or `ngraph.graph` + `ngraph.path` (A*). Hand-rolled is fine and avoids surprises around custom edge weights.

## Data model (IndexedDB object stores)

- `areas`: `{ id, label, polygonGeoJSON, bbox, createdAt }`
- `graphs`: `{ areaId, nodes, edges, fetchedAt, overpassInstance }` — the **parsed routing graph**, not just raw JSON. `fetchedAt` doubles as the staleness indicator and powers the "update" feature.
- `points`: `{ id, label, lat, lng, snappedNodeId, areaId }` — saved start/end points (e.g. "Train station — Foo").
- `routes`: `{ id, areaId, mode: 'circular'|'linear', startPointId, endPointId, lengthMeters, geometry, seed, weightProfile, createdAt, label }`
- Prefs (localStorage): `lastLength`, `lastUnit` ('km'|'hours'), `lastRouteCount`, `overpassInstance`, `pace`.

## Routing engine (the core — get this right)

### 1. Build the graph

From the cached OSM ways tagged `highway=*`:
- Nodes = OSM node IDs with lat/lng.
- Edges = consecutive node pairs along each way (bidirectional unless `oneway` matters — for walking, generally ignore `oneway`).
- Edge `length` = haversine distance between endpoints.
- Edge stores the way's relevant tags for weighting.

### 2. Edge cost = length × pleasantness multiplier

"Avoid busy roads" is a tunable cost function. Lower multiplier = more preferred. Suggested defaults (expose as an editable profile):

| highway tag                                   | multiplier |
|-----------------------------------------------|-----------|
| `path`, `footway`, `track`, `bridleway`, `steps` | 0.8       |
| `pedestrian`, `living_street`                 | 0.9       |
| `residential`, `unclassified`, `service`      | 1.2       |
| `tertiary`                                     | 2.0       |
| `secondary`                                    | 4.0       |
| `primary`                                      | 8.0       |
| `trunk`                                        | 20.0      |
| `motorway`, `motorway_link`                    | excluded  |

Also: exclude edges with `access=private` / `access=no` / `foot=no`. Optionally down-weight or refine using `surface`, `sac_scale`, `tracktype`. Optionally exclude `footway=sidewalk` if the user wants to avoid urban sidewalk-hugging (make this a toggle). Clip the graph to nodes inside the area polygon.

### 3. The unified generation routine

**Key insight: circular = linear with end point B equal to start point A.** Implement ONE routine; circular mode just sets B = A.

Given start A, end B, target length L (meters):

1. Let `d` = straight-line distance A→B. (For circular, d = 0.)
2. If L is below the shortest pleasant path from A to B, report the minimum feasible length and stop.
3. **Via-point insertion.** Pick one or more via points off the direct A–B line to inflate length toward L:
   - Single via at the A–B midpoint, offset perpendicular by `h = sqrt((L/2)² − (d/2)²)`.
   - For the circular case (d=0), pick a random heading and place the via at distance ~`L/4` along it (this is the GraphHopper round-trip trick: out in one direction, back another).
   - For wigglier / longer routes, use 2–3 vias alternating sides of the line (S-shape) — this also reduces self-overlap.
   - Snap each via to the nearest graph node before routing.
4. Route the legs (A→via₁→…→B) with Dijkstra on the weighted cost. Apply a **reuse penalty**: multiply the cost of already-used edges by ~3× on later legs so the return/onward legs differ from earlier ones. (Essential for circular — otherwise you get an out-and-back.)
5. **Measure actual routed length.** Accept if within tolerance (default ±12% of L); else adjust `h` and retry.

### 4. Variety, dedup, reproducibility

- Generate `routeCount` candidates by varying: which side the bulge goes, offset jitter, number of vias, and a seeded RNG.
- **Dedup** by path overlap ratio — discard a candidate sharing > ~70% of its edges with an already-accepted one, so cycling through 5 routes shows 5 genuinely different walks.
- **Store the seed** per route so it's reproducible.
- If after N attempts (e.g. 40) the engine can't fill `routeCount` within tolerance, return best-effort candidates and surface a "couldn't hit target exactly" note.

### 5. Out-and-back fallback

If the area is genuinely a single dead-end road (no alternative return path), the reuse penalty makes the return leg expensive but still allowed — so the result is an out-and-back on the same road. This is acceptable; do not fail.

### 6. Length input: km or hours

- Unit toggle. Hours → km via a configurable pace (default ~4 km/h walking).
- **Caveat to surface in the UI:** OSM ways carry no elevation, so time is distance-only and approximate. (Optional future extension: a DEM / elevation API for Naismith-style estimates — but that breaks pure-offline, so keep it out of v1.)

### 7. Snapping & "no road here"

- Build a spatial index over edges (a simple lat/lng grid, or Turf `nearestPointOnLine` over candidates) for fast nearest-edge lookup.
- When the user clicks to place a point, snap to the nearest walkable edge within a threshold (e.g. 50 m). If nothing is within threshold, show: *"No walkable path near here — pick a spot closer to a trail or road."*

## UI / wizard flow

Opening screen is a short wizard:

1. **Pick an area.** Show saved areas as a list AND a "View on map" button that opens a Leaflet map zoomed to fit all saved area polygons; the user can tap a polygon to select it. From either view, a **"+ New area"** button lets the user draw a polygon. Soft-warn if the polygon is very large (large areas = many ways = slow Dijkstra + high memory). On first selection of a new area, fetch from Overpass and cache the parsed graph; show a progress/spinner. An **"Update data"** action re-fetches and updates `fetchedAt`.
2. **Pick mode:** Circular or Linear.
3. **Pick point(s):** one point for circular, two for linear. Offer saved points (labeled) and "drop a new point" on the map. Snapping + no-road error as above. New points can be labeled and saved.
4. **Parameters:** target length (km or hours, prefilled from last use), number of routes to generate (prefilled), optional weight-profile toggles (e.g. avoid sidewalks). Persist these as defaults.
5. **Generate.** Show the candidates; **cycle through with arrows**; each shows total length (km) and a quick tag breakdown (e.g. % off-road). **Save** a route (with optional label) and/or **Export GPX**.

Plus a **Saved routes** view: list saved routes, cycle/preview each with its length and metadata, re-export, delete.

## Overpass etiquette

- Query only highways within the polygon's bbox (then clip to polygon), using a sensible Overpass QL query — not a full data dump.
- Exponential backoff + retry on HTTP 429 / 504.
- Let the user choose the Overpass instance (default to a public one; allow override).
- Set a descriptive `User-Agent` / referer where possible.
- Cache aggressively; never re-fetch an area that's already cached unless the user hits "Update data".

## Attribution

Display "© OpenStreetMap contributors (ODbL)" on the map and in exports as appropriate.

## MVP scope (build this first)

- One area (draw polygon → fetch → cache parsed graph in IndexedDB).
- Circular routing in that area from one start point, target length in km, generate N candidates, cycle, view length, export GPX.
- Pleasantness weighting + snapping + "no road" error.

## Extensions (mark as phase 2, behind the same engine)

- Linear mode (A→B), the via-point length inflation, and the unit=hours toggle.
- Multiple saved areas + map-view area picker (fit-bounds to all polygons).
- Saved/labeled points; saved routes view; weight-profile toggles; "Update data".

## Acceptance criteria

- Generates ≥ 3 visibly different circular routes within ±12% of a 10 km target in a ~3 km-radius area, fully offline after first fetch.
- Routes prefer paths/tracks over primary/secondary roads given the default profile.
- GPX export imports cleanly into a standard mapping app (valid `<trk>`/`<trkseg>`/`<trkpt>`).
- Clicking far from any road yields the "no walkable path" error, not a crash.
- Re-opening the app does not re-fetch a cached area.