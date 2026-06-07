# 🌲 Circular Hiking Route Planner

Draw an area on a map, pull in its OpenStreetMap walking paths, drop a start
point, and generate **circular hiking routes** that follow real paths and loop
back to where you started.

**▶️ Live app: https://maprohu.github.io/hiking/**

It's a single static page — no build step, no server, no API keys. All the
routing happens in your browser.

## Usage

1. **Draw the area** — click *Draw Polygon* (or use the rectangle tool on the
   map) and outline where you want to hike.
2. **Download OSM Data** — fetches the walking paths inside your area from
   OpenStreetMap. Pick *Walkable paths only* or *Everything (all roads)*.
3. **Place a start point** — click *Place Starting Point*, then click the map.
4. **Configure** — set the desired duration (hours) and how many routes you want.
5. **Generate Routes** — get a set of loops, each labelled with its real
   distance and estimated time.
6. **Download GPX** — select a route and export it for your GPS / phone app.

## How it works

- The map and drawing tools are **[Leaflet](https://leafletjs.com/) 1.9.4** +
  **leaflet-draw 1.0.4**, loaded from a CDN.
- Path data comes from the public
  **[Overpass API](https://overpass-api.de/)** (`out geom;`), which returns each
  way's coordinates *and* OSM node ids.
- Those node ids are used to build a real **distance-weighted graph** (graph
  nodes = OSM nodes, edges = path segments), clipped to the area you drew.
- Each route is a genuine loop: for a chosen compass bearing it finds a waypoint
  about a third of the way around, routes **start → waypoint** with Dijkstra,
  then **waypoint → start** again while penalising the segments already used —
  so the two halves take different paths. Spreading the bearing around the
  compass yields distinct routes.

## Notes & limits

- Routing is a self-contained heuristic, so loop lengths are **approximate** —
  the route list shows the actual distance/time for each one.
- In areas with **sparse paths** you may get fewer routes than requested.
- The Overpass API is a **shared free service**. If *Download OSM Data* times
  out or returns a rate-limit error, just retry — it's the data source
  throttling, not the app.

## Run locally

No tooling required — just open `index.html` in a browser. (A quick local
server avoids any browser file:// quirks:)

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page layout and controls |
| `styles.css` | Styling |
| `script.js` | Map, OSM download, graph, routing, GPX export |

## License

MIT — do whatever you like.

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
