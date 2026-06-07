// Circular Hiking Route Planner
// ------------------------------
// Draw an area, download its OpenStreetMap walking paths, drop a start point,
// and generate circular routes that follow real paths and return to the start.
//
// How routing works (the important part):
//   1. Overpass gives us ways with both `geometry` (lat/lon per vertex) and
//      `nodes` (the OSM node id per vertex). We use the node ids to build a
//      proper graph: graph nodes = OSM nodes, edges = consecutive vertices on
//      a way, weighted by real ground distance.
//   2. We snap the start marker onto the nearest graph node.
//   3. For each requested route we pick a compass bearing, find a waypoint
//      roughly half a loop away in that direction, then route start -> waypoint
//      (shortest path) and waypoint -> start again while penalising the edges we
//      already used. Two different paths sharing two endpoints = a real loop.
//   Spreading the bearing around the compass gives genuinely different routes.

// ---- Global state ----------------------------------------------------------
let map;
let drawnItems;          // single FeatureGroup that holds the polygon
let activeDrawer = null; // in-progress L.Draw.Polygon handler, if any
let drawnPolygon = null;
let startMarker = null;
let routeLayers = [];    // [{ layer, color, distanceKm }]
let selectedRouteIndex = null;
let osmGraph = null;     // { nodes: Map<id,{lat,lng}>, adj: Map<id,[{to,dist}]> }

// ---- Constants -------------------------------------------------------------
const WALKING_SPEED_KMH = 5;

// Highways you can't/shouldn't walk on — dropped entirely (cars only).
const EXCLUDED_HIGHWAYS = new Set([
    'motorway', 'motorway_link', 'trunk', 'trunk_link',
    'raceway', 'bus_guideway', 'escape', 'construction', 'proposed'
]);

// Routing-cost multiplier per highway type. Below 1 = the router prefers it
// (trails, footpaths); above 1 = avoided unless necessary (busy roads).
// This only shapes which way the route prefers — reported distance/time always
// use real ground length, so a longer scenic loop still reports honestly.
const HIGHWAY_PREFERENCE = {
    path: 0.5, footway: 0.5, bridleway: 0.55, steps: 0.6, track: 0.6,
    pedestrian: 0.7, cycleway: 0.8, living_street: 0.9, footpath: 0.5,
    service: 1.0, residential: 1.0, unclassified: 1.0, road: 1.2,
    tertiary: 1.6, tertiary_link: 1.6,
    secondary: 2.6, secondary_link: 2.6,
    primary: 4.0, primary_link: 4.0
};

// Natural/unpaved surfaces — nudge these down so dirt trails win ties.
const UNPAVED_SURFACES = new Set([
    'unpaved', 'ground', 'dirt', 'earth', 'grass', 'gravel', 'fine_gravel',
    'compacted', 'pebblestone', 'sand', 'rock', 'mud', 'woodchips', 'grass_paver'
]);

// Should this OSM way be part of the walkable network at all?
function wayIncluded(tags) {
    if (!tags.highway) return false;
    if (EXCLUDED_HIGHWAYS.has(tags.highway)) return false;
    if (tags.foot === 'no' || tags.access === 'private' || tags.access === 'no') return false;
    return true;
}

// Cost multiplier for a way, combining type + foot/trail/surface hints.
function wayPreference(tags) {
    let m = HIGHWAY_PREFERENCE[tags.highway] ?? 1.3;
    if (tags.foot === 'designated' || tags.foot === 'yes') m *= 0.8;
    if (tags.sac_scale || tags.trail_visibility) m *= 0.85; // tagged hiking trail
    if (UNPAVED_SURFACES.has(tags.surface)) m *= 0.85;       // natural surface
    return m;
}

// ===========================================================================
//  Map setup
// ===========================================================================
function initMap() {
    let center = [38.7918, -9.3906]; // Sintra, Portugal (default)
    let zoom = 14;

    try {
        const savedCenter = localStorage.getItem('hikingMapCenter');
        const savedZoom = localStorage.getItem('hikingMapZoom');
        if (savedCenter && savedZoom) {
            const c = JSON.parse(savedCenter);
            center = [c.lat, c.lng];
            zoom = parseInt(savedZoom, 10);
        }
    } catch (e) {
        /* no saved view, use default */
    }

    map = L.map('map').setView(center, zoom);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(map);

    map.on('moveend zoomend', saveMapView);

    initDrawingControl();
    setupEventListeners();
}

function saveMapView() {
    if (!map) return;
    localStorage.setItem('hikingMapCenter', JSON.stringify(map.getCenter()));
    localStorage.setItem('hikingMapZoom', String(map.getZoom()));
}

function initDrawingControl() {
    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    const drawControl = new L.Control.Draw({
        edit: { featureGroup: drawnItems, edit: {}, remove: {} },
        draw: {
            polygon: {
                // Allow self-intersections: false positives on the first touch
                // tap otherwise trigger a "shape edges cannot cross" error on
                // mobile. A simple area outline doesn't need the restriction.
                allowIntersection: true,
                shapeOptions: { color: '#27ae60', weight: 2 }
            },
            polyline: false,
            rectangle: true,   // a rectangle is the quickest way to pick an area
            circle: false,
            circlemarker: false,
            marker: false
        }
    });
    map.addControl(drawControl);

    map.on(L.Draw.Event.CREATED, (e) => {
        // Only one area at a time.
        drawnItems.clearLayers();
        drawnPolygon = e.layer;
        drawnItems.addLayer(drawnPolygon);
        invalidateOsmData();
        showStatus('Area set. Now download the OSM paths for it.', 'success');
    });

    map.on(L.Draw.Event.EDITED, (e) => {
        e.layers.eachLayer((layer) => { drawnPolygon = layer; });
        invalidateOsmData();
        showStatus('Area changed — re-download OSM paths.', 'info');
    });

    map.on(L.Draw.Event.DELETED, () => {
        drawnPolygon = null;
        invalidateOsmData();
        clearRoutes();
        showStatus('Area cleared.', 'info');
    });

    // Drawing finished or was cancelled — drop the active-drawer reference.
    map.on(L.Draw.Event.DRAWSTOP, () => { activeDrawer = null; });
}

// Cancel an unfinished polygon (if one is being drawn). Returns true if it did.
function cancelActiveDrawing() {
    if (!activeDrawer) return false;
    activeDrawer.disable(); // discards the in-progress shape, fires DRAWSTOP
    activeDrawer = null;
    return true;
}

function setupEventListeners() {
    document.getElementById('drawPolygonBtn').addEventListener('click', enablePolygonDrawing);
    document.getElementById('clearPolygonBtn').addEventListener('click', clearPolygon);
    document.getElementById('placeStartBtn').addEventListener('click', enablePlaceStartMarker);
    document.getElementById('clearStartBtn').addEventListener('click', clearStartMarker);
    document.getElementById('downloadOsmBtn').addEventListener('click', downloadOsmData);
    document.getElementById('generateBtn').addEventListener('click', generateRoutes);
    document.getElementById('downloadBtn').addEventListener('click', downloadSelectedRoute);

    const routeSelect = document.getElementById('routeSelect');
    routeSelect.addEventListener('change', () => {
        const v = routeSelect.value;
        if (v !== '') selectRoute(parseInt(v, 10));
    });

    // Desktop route cycle buttons
    document.getElementById('prevRouteBtnDesktop').addEventListener('click', () => cycleRoute(-1));
    document.getElementById('nextRouteBtnDesktop').addEventListener('click', () => cycleRoute(1));

    // Mobile drawer toggle
    document.getElementById('panelToggle').addEventListener('click', () => {
        const open = document.getElementById('sidebar').classList.contains('open');
        setPanelOpen(!open);
    });
    document.getElementById('panelBackdrop').addEventListener('click', () => setPanelOpen(false));

    // Floating route switcher (mobile)
    document.getElementById('mobileRouteSelect').addEventListener('change', (e) => {
        if (e.target.value !== '') selectRoute(parseInt(e.target.value, 10));
    });
    document.getElementById('prevRouteBtn').addEventListener('click', () => cycleRoute(-1));
    document.getElementById('nextRouteBtn').addEventListener('click', () => cycleRoute(1));
    document.getElementById('mobileDownloadBtn').addEventListener('click', downloadSelectedRoute);
}

// Open/close the mobile control drawer.
function setPanelOpen(open) {
    // Returning to the menu mid-draw discards the unfinished polygon.
    if (open && cancelActiveDrawing()) {
        showStatus('Cancelled the unfinished area.', 'info');
    }
    document.getElementById('sidebar').classList.toggle('open', open);
    document.getElementById('panelBackdrop').classList.toggle('show', open);
    document.getElementById('panelToggle').textContent = open ? '✕' : '☰';
    // Tuck the floating route bar away while the menu is open.
    document.getElementById('mobileRouteBar').classList.toggle('panel-open', open);
}

// ===========================================================================
//  Drawing the area + start marker
// ===========================================================================
function enablePolygonDrawing() {
    clearPolygon();
    setPanelOpen(false); // get the drawer out of the way on mobile
    activeDrawer = new L.Draw.Polygon(map, {
        allowIntersection: true, // avoids the false touch-tap intersection error
        shapeOptions: { color: '#27ae60', weight: 2 }
    });
    activeDrawer.enable();
    showStatus('Click on the map to add points, click the first point to finish.', 'info');
}

function clearPolygon() {
    cancelActiveDrawing(); // abandon an in-progress polygon too
    drawnItems.clearLayers();
    drawnPolygon = null;
    invalidateOsmData();
    clearRoutes();
}

function enablePlaceStartMarker() {
    setPanelOpen(false); // get the drawer out of the way on mobile
    showStatus('Click on the map to place your starting point.', 'info');
    if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
    map.once('click', handlePlaceStartMarker);
}

function handlePlaceStartMarker(e) {
    const startIcon = L.divIcon({
        className: 'custom-start-marker',
        html: `<div style="background-color:#27ae60;width:24px;height:24px;border-radius:50%;border:3px solid white;box-shadow:0 2px 5px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:bold;color:white;">S</div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
    });
    startMarker = L.marker(e.latlng, { icon: startIcon, draggable: true })
        .addTo(map)
        .bindTooltip('Starting point', { direction: 'top' });
    showStatus('Start point set.', 'success');
}

function clearStartMarker() {
    if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
    showStatus('Start point cleared.', 'info');
}

// ===========================================================================
//  Downloading OSM data + building the graph
// ===========================================================================
function invalidateOsmData() {
    osmGraph = null;
    const el = document.getElementById('osmStatus');
    el.textContent = '';
    el.className = 'osm-status';
    document.getElementById('downloadOsmBtn').disabled = false;
}

async function downloadOsmData() {
    if (!drawnPolygon) {
        showStatus('Draw an area first.', 'error');
        return;
    }

    const bounds = drawnPolygon.getBounds();
    // Overpass bbox order: south, west, north, east (lat first).
    const bbox = [
        bounds.getSouthWest().lat, bounds.getSouthWest().lng,
        bounds.getNorthEast().lat, bounds.getNorthEast().lng
    ].join(',');

    // `out geom;` gives us both the node ids and their coordinates — exactly
    // what we need to build a routable graph.
    const query = `[out:json][timeout:60];way["highway"](${bbox});out geom;`;

    const btn = document.getElementById('downloadOsmBtn');
    btn.disabled = true;
    showStatus('Downloading OSM paths…', 'info');

    try {
        const response = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            body: 'data=' + encodeURIComponent(query)
        });
        if (!response.ok) throw new Error(`Overpass returned ${response.status}`);

        const data = await response.json();
        const polygonLatLngs = getPolygonRing();
        osmGraph = buildGraph(data, polygonLatLngs);

        const osmStatusEl = document.getElementById('osmStatus');
        if (osmGraph.nodes.size === 0) {
            osmGraph = null;
            btn.disabled = false;
            osmStatusEl.textContent = '';
            showStatus('No walkable paths found here. Try "Everything" or a different area.', 'warning');
            return;
        }

        osmStatusEl.textContent = `✓ ${osmGraph.nodes.size} junctions / ${osmGraph.edgeCount} segments loaded`;
        osmStatusEl.className = 'osm-status downloaded';
        showStatus('OSM data ready. Place a start point and generate routes.', 'success');
    } catch (err) {
        console.error(err);
        btn.disabled = false;
        showStatus(`Download failed: ${err.message}`, 'error');
    }
}

// Build an undirected, distance-weighted graph from Overpass ways.
// Only keeps vertices that fall inside the drawn polygon so routes stay in area.
function buildGraph(data, polygonRing) {
    const nodes = new Map();          // id -> {lat, lng}
    const adj = new Map();            // id -> [{to, dist, weight}]
    let edgeCount = 0;

    // dist = true ground length (km); weight = routing cost after the trail
    // preference multiplier (a lower cost makes the router favour that edge).
    const addEdge = (a, b, dist, weight) => {
        if (!adj.has(a)) adj.set(a, []);
        if (!adj.has(b)) adj.set(b, []);
        adj.get(a).push({ to: b, dist, weight });
        adj.get(b).push({ to: a, dist, weight });
        edgeCount++;
    };

    for (const el of data.elements || []) {
        if (el.type !== 'way' || !el.tags) continue;
        if (!wayIncluded(el.tags)) continue;
        if (!el.geometry || !el.nodes) continue;

        const mult = wayPreference(el.tags);

        let prevId = null, prevPt = null;
        for (let i = 0; i < el.nodes.length; i++) {
            const id = el.nodes[i];
            const g = el.geometry[i];
            if (!g) continue;
            const pt = { lat: g.lat, lng: g.lon };

            // Skip vertices outside the chosen area (keeps routes inside it).
            if (polygonRing && !pointInPolygon(pt, polygonRing)) {
                prevId = null; prevPt = null;
                continue;
            }

            if (!nodes.has(id)) nodes.set(id, pt);
            if (prevId !== null) {
                const d = haversineKm(prevPt, pt);
                addEdge(prevId, id, d, d * mult);
            }
            prevId = id; prevPt = pt;
        }
    }

    return { nodes, adj, edgeCount };
}

// ===========================================================================
//  Route generation
// ===========================================================================
async function generateRoutes() {
    if (!drawnPolygon) { showStatus('Draw an area first.', 'error'); return; }
    if (!osmGraph) { showStatus('Download the OSM data first.', 'error'); return; }
    if (!startMarker) { showStatus('Place a start point first.', 'warning'); return; }

    const duration = parseFloat(document.getElementById('duration').value);
    if (isNaN(duration) || duration <= 0) {
        showStatus('Enter a valid duration.', 'warning'); return;
    }
    const routeCount = parseInt(document.getElementById('routeCount').value, 10);
    if (isNaN(routeCount) || routeCount < 1 || routeCount > 10) {
        showStatus('Number of routes must be 1–10.', 'warning'); return;
    }

    clearRoutes();
    showStatus('Generating routes…', 'info');

    const targetKm = duration * WALKING_SPEED_KMH;
    const start = startMarker.getLatLng();
    const startNode = nearestNode(start);
    if (startNode === null) {
        showStatus('Start point is too far from any path. Move it onto/near a path.', 'warning');
        return;
    }

    // Let the heavy synchronous work yield once so the status text paints.
    await new Promise(r => setTimeout(r, 20));

    const routes = buildLoops(startNode, targetKm, routeCount);
    if (routes.length === 0) {
        showStatus('Couldn\'t build loops here. Try a longer duration or a denser-path area.', 'warning');
        return;
    }

    displayRoutes(routes);
    updateRouteSelector(routes);
    selectRoute(0);
    setPanelOpen(false); // reveal the map + route switcher on mobile
    showStatus(`Generated ${routes.length} route${routes.length > 1 ? 's' : ''}.`, 'success');
}

// Create up to `count` distinct loops near `targetKm` long.
function buildLoops(startNode, targetKm, count) {
    const routes = [];
    const startPt = osmGraph.nodes.get(startNode);

    // Crow-flies radius to the far waypoint. Real paths wind, and the loop is
    // roughly twice the one-way path length, so aim shorter than targetKm/2.
    const radiusKm = targetKm * 0.32;

    const attempts = count * 4;        // extra tries to skip dead bearings
    const seenWaypoints = new Set();

    for (let a = 0; a < attempts && routes.length < count; a++) {
        const bearing = (a * 360 / attempts) + (Math.random() * 25 - 12);
        const wpTarget = destinationPoint(startPt, bearing, radiusKm);
        const wpNode = nearestNode(wpTarget);
        if (wpNode === null || wpNode === startNode) continue;
        if (seenWaypoints.has(wpNode)) continue;

        const loop = buildLoopVia(startNode, wpNode);
        if (!loop) continue;

        // Reject loops that are wildly off target (keep 50%–180% of target).
        if (loop.distanceKm < targetKm * 0.5 || loop.distanceKm > targetKm * 1.8) {
            continue;
        }

        seenWaypoints.add(wpNode);
        routes.push(loop);
    }

    // If strict filtering left us short, relax the length check and retry.
    if (routes.length === 0) {
        for (let a = 0; a < attempts && routes.length < count; a++) {
            const bearing = a * 360 / attempts;
            const wpNode = nearestNode(destinationPoint(startPt, bearing, radiusKm));
            if (wpNode === null || wpNode === startNode) continue;
            const loop = buildLoopVia(startNode, wpNode);
            if (loop) routes.push(loop);
        }
    }

    routes.forEach((r, i) => { r.color = getRouteColor(i); });
    return routes;
}

// start -> waypoint (shortest), then waypoint -> start avoiding the outbound
// edges, yielding a loop. Returns { coords, distanceKm } or null.
function buildLoopVia(startNode, wpNode) {
    const out = dijkstra(startNode, wpNode, null);
    if (!out) return null;

    const usedEdges = new Set();
    for (let i = 1; i < out.path.length; i++) {
        usedEdges.add(edgeKey(out.path[i - 1], out.path[i]));
    }

    const back = dijkstra(wpNode, startNode, usedEdges);
    if (!back) return null;

    const nodeIds = out.path.concat(back.path.slice(1));
    const coords = nodeIds.map(id => osmGraph.nodes.get(id));
    return { coords, distanceKm: out.dist + back.dist };
}

// Dijkstra over the graph. `penalizedEdges` (a Set of edge keys) multiplies the
// cost of already-used edges so the return leg prefers a different way.
function dijkstra(source, target, penalizedEdges) {
    const dist = new Map();
    const prev = new Map();
    const heap = new MinHeap();

    dist.set(source, 0);
    heap.push(source, 0);

    while (heap.size() > 0) {
        const { id: u, priority: d } = heap.pop();
        if (d > (dist.get(u) ?? Infinity)) continue;
        if (u === target) break;

        const neighbors = osmGraph.adj.get(u) || [];
        for (const { to, weight } of neighbors) {
            let cost = weight;
            if (penalizedEdges && penalizedEdges.has(edgeKey(u, to))) {
                cost = weight * 4 + 0.05; // discourage reusing the outbound path
            }
            const nd = d + cost;
            if (nd < (dist.get(to) ?? Infinity)) {
                dist.set(to, nd);
                prev.set(to, u);
                heap.push(to, nd);
            }
        }
    }

    if (!dist.has(target)) return null;

    // Reconstruct path and measure its *true* ground length (not penalised).
    const path = [];
    let cur = target;
    while (cur !== undefined) {
        path.push(cur);
        if (cur === source) break;
        cur = prev.get(cur);
    }
    path.reverse();
    if (path[0] !== source) return null;

    let realKm = 0;
    for (let i = 1; i < path.length; i++) {
        realKm += haversineKm(osmGraph.nodes.get(path[i - 1]), osmGraph.nodes.get(path[i]));
    }
    return { path, dist: realKm };
}

function edgeKey(a, b) {
    return a < b ? `${a}_${b}` : `${b}_${a}`;
}

// Nearest graph node to a {lat,lng} point (linear scan — fine for one area).
function nearestNode(pt) {
    if (!osmGraph) return null;
    let best = null, bestD = Infinity;
    for (const [id, p] of osmGraph.nodes) {
        const d = haversineKm(pt, p);
        if (d < bestD) { bestD = d; best = id; }
    }
    return best;
}

// ===========================================================================
//  Display, selection, GPX
// ===========================================================================
function displayRoutes(routes) {
    clearRoutes();
    routes.forEach((route, index) => {
        const polyline = L.polyline(route.coords, {
            color: route.color, weight: 4, opacity: 0.85
        }).addTo(map);
        polyline.on('click', () => {
            document.getElementById('routeSelect').value = String(index);
            selectRoute(index);
        });
        routeLayers.push({ layer: polyline, color: route.color, distanceKm: route.distanceKm });
    });

    const allCoords = [];
    routes.forEach(r => allCoords.push(...r.coords));
    if (allCoords.length) {
        map.fitBounds(L.latLngBounds(allCoords), { padding: [40, 40] });
    }
}

function clearRoutes() {
    routeLayers.forEach(r => map.removeLayer(r.layer));
    routeLayers = [];
    selectedRouteIndex = null;
    document.getElementById('routeSelect').innerHTML = '<option value="">— Select a route —</option>';
    document.getElementById('mobileRouteSelect').innerHTML = '';
    document.getElementById('routesList').style.display = 'none';
    document.getElementById('mobileRouteBar').classList.remove('show');
}

function updateRouteSelector(routes) {
    const sel = document.getElementById('routeSelect');
    const msel = document.getElementById('mobileRouteSelect');
    sel.innerHTML = '';
    msel.innerHTML = '';
    routes.forEach((route, index) => {
        const mins = Math.round(route.distanceKm / WALKING_SPEED_KMH * 60);
        const label = `Route ${index + 1}: ${route.distanceKm.toFixed(1)} km · ~${mins} min`;
        for (const target of [sel, msel]) {
            const opt = document.createElement('option');
            opt.value = index;
            opt.textContent = label;
            target.appendChild(opt);
        }
    });
    document.getElementById('routesList').style.display = 'block';
    document.getElementById('mobileRouteBar').classList.add('show');
}

function selectRoute(index) {
    if (index < 0 || index >= routeLayers.length) return;
    routeLayers.forEach((r, i) => {
        r.layer.setStyle({ weight: i === index ? 6 : 3, opacity: i === index ? 1 : 0.25 });
        if (i === index) r.layer.bringToFront();
    });
    selectedRouteIndex = index;

    // Keep both dropdowns in sync with the current selection.
    document.getElementById('routeSelect').value = String(index);
    document.getElementById('mobileRouteSelect').value = String(index);

    const r = routeLayers[index];
    const mins = Math.round(r.distanceKm / WALKING_SPEED_KMH * 60);
    showStatus(`Route ${index + 1}: ${r.distanceKm.toFixed(1)} km, ~${mins} min walk.`, 'info');
}

// Step to the previous/next route, wrapping around for easy previewing.
function cycleRoute(delta) {
    if (routeLayers.length === 0) return;
    const base = selectedRouteIndex == null ? 0 : selectedRouteIndex;
    const next = (base + delta + routeLayers.length) % routeLayers.length;
    selectRoute(next);
}

function downloadSelectedRoute() {
    if (selectedRouteIndex === null) { showStatus('Select a route first.', 'warning'); return; }
    const r = routeLayers[selectedRouteIndex];
    const gpx = createGPX(r.layer.getLatLngs());
    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hiking-route-${selectedRouteIndex + 1}.gpx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showStatus('GPX downloaded.', 'success');
}

function createGPX(coords) {
    const pts = coords.map(c =>
        `      <trkpt lat="${c.lat}" lon="${c.lng}"></trkpt>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Circular Hiking Route Planner"
     xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Hiking Route</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>`;
}

// ===========================================================================
//  Geometry helpers
// ===========================================================================
function haversineKm(p1, p2) {
    const R = 6371;
    const dLat = (p2.lat - p1.lat) * Math.PI / 180;
    const dLng = (p2.lng - p1.lng) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Point reached by travelling `distKm` from `pt` along compass `bearing` (deg).
function destinationPoint(pt, bearing, distKm) {
    const R = 6371;
    const d = distKm / R;
    const brng = bearing * Math.PI / 180;
    const lat1 = pt.lat * Math.PI / 180;
    const lng1 = pt.lng * Math.PI / 180;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) +
        Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
    const lng2 = lng1 + Math.atan2(
        Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return { lat: lat2 * 180 / Math.PI, lng: lng2 * 180 / Math.PI };
}

// Ray-casting point-in-polygon. `ring` is an array of {lat,lng}.
function pointInPolygon(pt, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i].lng, yi = ring[i].lat;
        const xj = ring[j].lng, yj = ring[j].lat;
        const intersect = ((yi > pt.lat) !== (yj > pt.lat)) &&
            (pt.lng < (xj - xi) * (pt.lat - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

// Outer ring of the drawn polygon as a flat [{lat,lng}] array.
function getPolygonRing() {
    if (!drawnPolygon) return null;
    let latlngs = drawnPolygon.getLatLngs();
    while (Array.isArray(latlngs[0])) latlngs = latlngs[0]; // unwrap nested rings
    return latlngs.map(ll => ({ lat: ll.lat, lng: ll.lng }));
}

function getRouteColor(index) {
    const colors = ['#e74c3c', '#3498db', '#9b59b6', '#f39c12', '#1abc9c',
        '#e67e22', '#2c3e50', '#d35400', '#16a085', '#c0392b'];
    return colors[index % colors.length];
}

function showStatus(message, type = 'info') {
    const el = document.getElementById('status');
    el.textContent = message;
    el.className = 'status ' + type;
}

// ===========================================================================
//  Minimal binary min-heap (priority queue) for Dijkstra
// ===========================================================================
class MinHeap {
    constructor() { this.items = []; }
    size() { return this.items.length; }
    push(id, priority) {
        const items = this.items;
        items.push({ id, priority });
        let i = items.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (items[parent].priority <= items[i].priority) break;
            [items[parent], items[i]] = [items[i], items[parent]];
            i = parent;
        }
    }
    pop() {
        const items = this.items;
        const top = items[0];
        const last = items.pop();
        if (items.length > 0) {
            items[0] = last;
            let i = 0;
            const n = items.length;
            while (true) {
                const l = 2 * i + 1, r = 2 * i + 2;
                let smallest = i;
                if (l < n && items[l].priority < items[smallest].priority) smallest = l;
                if (r < n && items[r].priority < items[smallest].priority) smallest = r;
                if (smallest === i) break;
                [items[smallest], items[i]] = [items[i], items[smallest]];
                i = smallest;
            }
        }
        return top;
    }
}

// ---- Boot ------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', initMap);
