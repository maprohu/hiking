# 🥾 Hike Route Planner

An **offline-first** hiking route planner: draw an area on a map, the app pulls
its OpenStreetMap walking network once, caches it, and then generates pleasant
**circular or A→B routes** of a target length — entirely in your browser.

**▶️ Live app: https://maprohu.github.io/hiking/**

No backend, no build step, no API keys. Routing runs locally on cached data, so
once an area is downloaded the planner works offline. Fully responsive: a
sidebar layout on desktop, a bottom-sheet layout on phones.

## Usage (wizard flow)

1. **Pick an area** — choose a saved area (or tap its polygon on the map), or
   draw a new one by tapping corners. The first selection downloads the area's
   walkable ways from Overpass and caches the parsed routing graph in
   IndexedDB; after that it never re-fetches unless you press **⟳ Update data**.
2. **Route type** — circular (loop) or linear (A→B).
3. **Points** — tap the map to drop a start (and end) point; it snaps to the
   nearest trail or road within 50 m. Points can be labelled and saved for
   reuse (e.g. "Train station").
4. **Length & options** — target length in **km or hours** (hours use a
   configurable pace; distance-only, since OSM has no elevation), number of
   candidates, and an "avoid sidewalks" toggle. Your inputs are remembered.
5. **Generate** — cycle through the candidates with arrows (or ←/→ keys); each
   shows length, estimated time, and % off-road. **Save** routes and/or
   **export GPX**.

A **📚 Saved routes** view lists everything you've saved, with preview,
re-export, and delete.

## How it works

- **Map:** [Leaflet](https://leafletjs.com/) 1.9.4 (the only runtime
  dependency, from CDN). Polygon drawing, geometry, IndexedDB access, Dijkstra,
  and the GPX writer are all small hand-rolled modules in `js/`.
- **Data:** one Overpass query per area — highways only, bbox-limited, clipped
  to your polygon client-side, with exponential backoff on 429/504 and a
  selectable Overpass instance (⚙ settings).
- **Graph:** OSM nodes/segments become a compact typed-array graph stored in
  IndexedDB. Edge cost = length × a *pleasantness multiplier* (paths/tracks
  0.8 … primary 8, trunk 20, motorways and `access=private/no`, `foot=no`
  excluded), so routes prefer trails over busy roads.
- **Generation:** circular is just linear with end = start. Via points are
  placed off the direct line (perpendicular offset for A→B; headings around
  the start for loops, including a 3-via "circle tour" for long loops in small
  areas), snapped to the graph, and routed leg-by-leg with Dijkstra. Already
  used edges cost 3× on later legs, so the way back differs from the way out.
  Candidates outside ±12% of the target are retried with adjusted offsets;
  near-duplicates (>70% shared length) are discarded. Each route stores its
  RNG seed.
- **Offline:** a service worker caches the app shell; OSM data and routes live
  in IndexedDB. Map tiles are not cached (blank basemap offline, routes still
  visible and exportable).

## Notes & limits

- Time estimates are distance ÷ pace — no elevation data, so hilly routes take
  longer than shown.
- In sparse path networks you may get fewer or best-effort candidates (the app
  says so). A single dead-end road yields an out-and-back, by design.
- Overpass is a shared free service — the app caches aggressively and backs
  off on rate limits, but very large areas are slow; it warns before
  downloading them.

## Run locally

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

(Opening `index.html` directly also works, minus the service worker.)

## Files

| File | Purpose |
|------|---------|
| `index.html` | Layout: wizard panels, map, dialogs |
| `styles.css` | Responsive styling (desktop sidebar / mobile bottom sheet) |
| `js/geo.js` | Haversine, bearings, point-in-polygon, segment distance |
| `js/db.js` | Tiny promise wrapper over IndexedDB |
| `js/overpass.js` | Overpass query + retry/backoff |
| `js/graph.js` | Overpass JSON → weighted routing graph |
| `js/router.js` | Dijkstra, snapping, via-point route generator |
| `js/gpx.js` | GPX writer + download |
| `js/app.js` | UI controller / wizard state machine |
| `sw.js` | App-shell cache for offline use |

## License

MIT — do whatever you like.

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright)
contributors, licensed under the [ODbL](https://opendatacommons.org/licenses/odbl/).
