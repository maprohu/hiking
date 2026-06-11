'use strict';

// Builds the compact routing graph from raw Overpass JSON, clipped to the area polygon.
// Nodes are re-indexed to 0..n-1; the result is typed arrays, cheap to store in IndexedDB.
const Graph = (() => {
  const MULTIPLIERS = {
    path: 0.8, footway: 0.8, track: 0.8, bridleway: 0.8, steps: 0.8,
    pedestrian: 0.9, living_street: 0.9, cycleway: 1.0,
    residential: 1.2, unclassified: 1.2, service: 1.2, road: 1.5,
    tertiary: 2.0, tertiary_link: 2.0,
    secondary: 4.0, secondary_link: 4.0,
    primary: 8.0, primary_link: 8.0,
    trunk: 20.0, trunk_link: 20.0,
  };
  const EXCLUDED = new Set(['motorway', 'motorway_link', 'proposed', 'construction',
    'abandoned', 'raceway', 'bus_guideway', 'elevator', 'platform']);
  const DEFAULT_MULT = 1.5;
  const FLAG_OFFROAD = 1, FLAG_SIDEWALK = 2;

  function walkable(tags) {
    if (!tags.highway || EXCLUDED.has(tags.highway)) return false;
    if (tags.access === 'private' || tags.access === 'no') return false;
    if (tags.foot === 'no') return false;
    return true;
  }

  function build(osm, ring) {
    const coords = new Map(); // OSM node id -> [lat, lng]
    for (const el of osm.elements) {
      if (el.type === 'node') coords.set(el.id, [el.lat, el.lon]);
    }

    const index = new Map(); // OSM node id -> compact index, or -1 if outside the polygon
    const lat = [], lng = [];
    function compact(id) {
      let i = index.get(id);
      if (i !== undefined) return i;
      const c = coords.get(id);
      i = (c && Geo.pointInRing(c[0], c[1], ring)) ? lat.length : -1;
      if (i >= 0) { lat.push(c[0]); lng.push(c[1]); }
      index.set(id, i);
      return i;
    }

    const ea = [], eb = [], elen = [], emult = [], eflags = [];
    for (const el of osm.elements) {
      if (el.type !== 'way' || !el.tags || !walkable(el.tags)) continue;
      const mult = MULTIPLIERS[el.tags.highway] ?? DEFAULT_MULT;
      let flags = 0;
      if (mult <= 0.8) flags |= FLAG_OFFROAD;
      if (el.tags.footway === 'sidewalk') flags |= FLAG_SIDEWALK;
      for (let i = 0; i < el.nodes.length - 1; i++) {
        const a = compact(el.nodes[i]), b = compact(el.nodes[i + 1]);
        if (a < 0 || b < 0 || a === b) continue;
        ea.push(a);
        eb.push(b);
        elen.push(Geo.haversine(lat[a], lng[a], lat[b], lng[b]));
        emult.push(mult);
        eflags.push(flags);
      }
    }

    return {
      nodeLat: Float64Array.from(lat),
      nodeLng: Float64Array.from(lng),
      edgeA: Uint32Array.from(ea),
      edgeB: Uint32Array.from(eb),
      edgeLen: Float32Array.from(elen),
      edgeMult: Float32Array.from(emult),
      edgeFlags: Uint8Array.from(eflags),
    };
  }

  return { build, FLAG_OFFROAD, FLAG_SIDEWALK };
})();
