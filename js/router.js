'use strict';

// Routing engine: weighted Dijkstra over the cached graph, edge snapping,
// and the unified via-point route generator (circular = linear with B = A).
const Router = (() => {
  const REUSE_PENALTY = 3;      // cost multiplier for edges already used by earlier legs
  const TOLERANCE = 0.12;       // accept routes within ±12% of the target length
  const OVERLAP_LIMIT = 0.7;    // discard candidates sharing >70% of their length
  const CELL = 0.0015;          // snap-grid cell size in degrees (~165 m of latitude)

  class MinHeap {
    constructor() { this.c = []; this.n = []; }
    get size() { return this.c.length; }
    push(cost, node) {
      const c = this.c, n = this.n;
      let i = c.length;
      c.push(cost); n.push(node);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (c[p] <= c[i]) break;
        [c[p], c[i]] = [c[i], c[p]];
        [n[p], n[i]] = [n[i], n[p]];
        i = p;
      }
    }
    pop() {
      const c = this.c, n = this.n;
      const topC = c[0], topN = n[0];
      const lastC = c.pop(), lastN = n.pop();
      if (c.length) {
        c[0] = lastC; n[0] = lastN;
        let i = 0;
        for (;;) {
          let m = i;
          const l = 2 * i + 1, r = l + 1;
          if (l < c.length && c[l] < c[m]) m = l;
          if (r < c.length && c[r] < c[m]) m = r;
          if (m === i) break;
          [c[m], c[i]] = [c[i], c[m]];
          [n[m], n[i]] = [n[i], n[m]];
          i = m;
        }
      }
      return [topC, topN];
    }
  }

  // CSR adjacency of incident edge indices; the profile can drop sidewalk edges.
  function buildAdjacency(graph, profile) {
    const nNodes = graph.nodeLat.length, nEdges = graph.edgeA.length;
    const avoidSw = profile && profile.avoidSidewalks;
    const active = new Uint8Array(nEdges);
    const deg = new Uint32Array(nNodes);
    for (let e = 0; e < nEdges; e++) {
      if (avoidSw && (graph.edgeFlags[e] & Graph.FLAG_SIDEWALK)) continue;
      active[e] = 1;
      deg[graph.edgeA[e]]++;
      deg[graph.edgeB[e]]++;
    }
    const start = new Uint32Array(nNodes + 1);
    for (let i = 0; i < nNodes; i++) start[i + 1] = start[i] + deg[i];
    const list = new Uint32Array(start[nNodes]);
    const fill = start.slice(0, nNodes);
    for (let e = 0; e < nEdges; e++) {
      if (!active[e]) continue;
      list[fill[graph.edgeA[e]]++] = e;
      list[fill[graph.edgeB[e]]++] = e;
    }
    return { start, list };
  }

  // Spatial grid over edges for nearest-walkable-edge snapping.
  function buildSnapIndex(graph) {
    const cells = new Map();
    for (let e = 0; e < graph.edgeA.length; e++) {
      const a = graph.edgeA[e], b = graph.edgeB[e];
      const r0 = Math.floor(Math.min(graph.nodeLat[a], graph.nodeLat[b]) / CELL);
      const r1 = Math.floor(Math.max(graph.nodeLat[a], graph.nodeLat[b]) / CELL);
      const c0 = Math.floor(Math.min(graph.nodeLng[a], graph.nodeLng[b]) / CELL);
      const c1 = Math.floor(Math.max(graph.nodeLng[a], graph.nodeLng[b]) / CELL);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const key = r + ':' + c;
          let arr = cells.get(key);
          if (!arr) cells.set(key, arr = []);
          arr.push(e);
        }
      }
    }
    return cells;
  }

  // Snap a clicked location to the nearest walkable edge within maxM meters.
  // Returns the closer endpoint of the best edge, or null if nothing is near.
  function snap(graph, cells, lat, lng, maxM) {
    const ringsLat = Math.ceil((maxM / 111320) / CELL) + 1;
    const ringsLng = Math.ceil(ringsLat / Math.max(0.2, Math.cos(lat * Math.PI / 180)));
    const r = Math.floor(lat / CELL), c = Math.floor(lng / CELL);
    let best = -1, bestDist = maxM;
    for (let dr = -ringsLat; dr <= ringsLat; dr++) {
      for (let dc = -ringsLng; dc <= ringsLng; dc++) {
        const arr = cells.get((r + dr) + ':' + (c + dc));
        if (!arr) continue;
        for (const e of arr) {
          const a = graph.edgeA[e], b = graph.edgeB[e];
          const { dist, t } = Geo.distToSegment(lat, lng,
            graph.nodeLat[a], graph.nodeLng[a], graph.nodeLat[b], graph.nodeLng[b]);
          if (dist <= bestDist) {
            bestDist = dist;
            best = t < 0.5 ? a : b;
          }
        }
      }
    }
    if (best < 0) return null;
    return { node: best, lat: graph.nodeLat[best], lng: graph.nodeLng[best], dist: bestDist };
  }

  // Dijkstra on cost = length × pleasantness × (reuse penalty for used edges).
  function dijkstra(graph, adj, src, dst, usedEdges) {
    if (src === dst) return { nodes: [src], edges: [], lengthM: 0 };
    const n = graph.nodeLat.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prevEdge = new Int32Array(n).fill(-1);
    const prevNode = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    const heap = new MinHeap();
    dist[src] = 0;
    heap.push(0, src);
    while (heap.size) {
      const [c, u] = heap.pop();
      if (done[u]) continue;
      done[u] = 1;
      if (u === dst) break;
      for (let i = adj.start[u]; i < adj.start[u + 1]; i++) {
        const e = adj.list[i];
        const v = graph.edgeA[e] === u ? graph.edgeB[e] : graph.edgeA[e];
        if (done[v]) continue;
        let w = graph.edgeLen[e] * graph.edgeMult[e];
        if (usedEdges && usedEdges[e]) w *= REUSE_PENALTY;
        const nd = c + w;
        if (nd < dist[v]) {
          dist[v] = nd;
          prevEdge[v] = e;
          prevNode[v] = u;
          heap.push(nd, v);
        }
      }
    }
    if (!done[dst]) return null;
    const nodes = [], edges = [];
    for (let v = dst; v !== -1; v = prevNode[v]) {
      nodes.push(v);
      if (prevEdge[v] >= 0) edges.push(prevEdge[v]);
    }
    nodes.reverse();
    edges.reverse();
    let lengthM = 0;
    for (const e of edges) lengthM += graph.edgeLen[e];
    return { nodes, edges, lengthM };
  }

  // Route A→via₁→…→B; later legs pay the reuse penalty on already-used edges.
  function routeLegs(graph, adj, waypoints) {
    const used = new Uint8Array(graph.edgeA.length);
    const nodes = [], edges = [];
    let lengthM = 0;
    for (let i = 0; i < waypoints.length - 1; i++) {
      const leg = dijkstra(graph, adj, waypoints[i], waypoints[i + 1], used);
      if (!leg) return null;
      lengthM += leg.lengthM;
      for (const e of leg.edges) used[e] = 1;
      for (let j = nodes.length ? 1 : 0; j < leg.nodes.length; j++) nodes.push(leg.nodes[j]);
      for (const e of leg.edges) edges.push(e);
    }
    return { nodes, edges, lengthM };
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Via targets that inflate the route toward the target length.
  // Circular: vias along a (golden-angle varied) heading at ~L/4.
  // Linear: perpendicular offset h = sqrt((L/2)² − (d/2)²), 1 via or an S-shape with 2.
  function planVias(rng, attempt, graph, startNode, endNode, targetM, stretch) {
    const aLat = graph.nodeLat[startNode], aLng = graph.nodeLng[startNode];
    const vias = [];
    if (startNode === endNode) {
      const heading = (attempt * 137.508 + rng() * 60) % 360;
      const variant = rng();
      if (variant < 0.35) {
        // Circle tour: three vias at 120° intervals — the only shape that fits
        // a long loop into a small area (radius ~L/2π instead of ~L/4).
        const r = targetM * 0.16 * stretch * (0.9 + rng() * 0.2);
        for (const off of [0, 120, 240]) {
          vias.push(Geo.destination(aLat, aLng, (heading + off) % 360, r));
        }
      } else if (variant < 0.75) {
        // When the area clamps the via radius, a wider angle between the two
        // vias still lengthens the loop — couple the spread to the stretch.
        const spread = Math.min(210, (25 + rng() * 35) * Math.max(1, stretch));
        const r = targetM * 0.21 * stretch * (0.9 + rng() * 0.2);
        vias.push(Geo.destination(aLat, aLng, (heading - spread / 2 + 360) % 360, r));
        vias.push(Geo.destination(aLat, aLng, (heading + spread / 2) % 360, r));
      } else {
        vias.push(Geo.destination(aLat, aLng, heading, targetM * 0.27 * stretch * (0.9 + rng() * 0.2)));
      }
    } else {
      const bLat = graph.nodeLat[endNode], bLng = graph.nodeLng[endNode];
      const d = Geo.haversine(aLat, aLng, bLat, bLng);
      const brg = Geo.bearing(aLat, aLng, bLat, bLng);
      const side = rng() < 0.5 ? 90 : -90;
      const h = Math.sqrt(Math.max(0, (targetM / 2) ** 2 - (d / 2) ** 2)) * stretch;
      if (h < 50) return vias; // target ≈ direct distance: just route straight
      if (rng() < 0.5 && targetM > d * 1.6) {
        for (const [frac, s] of [[1 / 3, side], [2 / 3, -side]]) {
          const p = Geo.destination(aLat, aLng, brg, d * frac);
          vias.push(Geo.destination(p[0], p[1], brg + s, h * 0.55 * (0.85 + rng() * 0.3)));
        }
      } else {
        const mid = Geo.destination(aLat, aLng, brg, d / 2);
        vias.push(Geo.destination(mid[0], mid[1], brg + side, h * (0.85 + rng() * 0.3)));
      }
    }
    return vias;
  }

  function makeCandidate(graph, result, seed) {
    const latlngs = result.nodes.map(n => [graph.nodeLat[n], graph.nodeLng[n]]);
    const edgeSet = new Set(result.edges);
    let off = 0;
    for (const e of edgeSet) if (graph.edgeFlags[e] & Graph.FLAG_OFFROAD) off += graph.edgeLen[e];
    return {
      latlngs,
      lengthM: result.lengthM,
      offroadPct: result.lengthM ? Math.min(100, Math.round(100 * off / result.lengthM)) : 0,
      seed,
      edgeSet,
    };
  }

  function isDuplicate(graph, cand, accepted) {
    for (const other of accepted) {
      let shared = 0;
      for (const e of cand.edgeSet) if (other.edgeSet.has(e)) shared += graph.edgeLen[e];
      if (shared / Math.min(cand.lengthM, other.lengthM) > OVERLAP_LIMIT) return true;
    }
    return false;
  }

  // opts: { graph, adj, snapIndex, startNode, endNode, targetM, count, seed, onProgress }
  // Returns { routes, note } or { error, minMeters? }.
  async function generate(opts) {
    const { graph, adj, snapIndex, startNode, endNode, targetM, count, seed } = opts;
    const maxAttempts = Math.max(40, count * 12);
    const circular = startNode === endNode;

    if (!circular) {
      const direct = dijkstra(graph, adj, startNode, endNode, null);
      if (!direct) return { error: 'No walkable path connects the two points within this area.' };
      if (targetM < direct.lengthM * (1 - TOLERANCE)) {
        return {
          error: 'The target is shorter than the shortest pleasant path between these points.',
          minMeters: direct.lengthM,
        };
      }
    }

    const accepted = [], spare = [];
    let stretch = 1;
    for (let attempt = 0; attempt < maxAttempts && accepted.length < count; attempt++) {
      if (opts.onProgress) opts.onProgress(accepted.length, attempt);
      await new Promise(r => setTimeout(r, 0)); // keep the UI responsive
      const candSeed = (seed + attempt * 2654435761) >>> 0;
      const rng = mulberry32(candSeed);

      const viaTargets = planVias(rng, attempt, graph, startNode, endNode, targetM, stretch);
      const snapRadius = Math.min(2000, Math.max(400, targetM * 0.1));
      const waypoints = [startNode];
      let snapped = true;
      for (const [vlat, vlng] of viaTargets) {
        const s = snap(graph, snapIndex, vlat, vlng, snapRadius);
        if (!s || s.node === startNode || s.node === endNode) { snapped = false; break; }
        if (s.node !== waypoints[waypoints.length - 1]) waypoints.push(s.node);
      }
      if (!snapped) { stretch = Math.max(0.25, stretch * 0.85); continue; }
      waypoints.push(endNode);

      const result = routeLegs(graph, adj, waypoints);
      if (!result || result.lengthM === 0) continue;

      const ratio = targetM / result.lengthM;
      stretch = Math.min(3, Math.max(0.25,
        stretch * Math.pow(Math.min(1.8, Math.max(0.55, ratio)), 0.65)));

      const cand = makeCandidate(graph, result, candSeed);
      if (Math.abs(result.lengthM - targetM) / targetM <= TOLERANCE) {
        if (!isDuplicate(graph, cand, accepted)) accepted.push(cand);
      } else {
        spare.push(cand);
      }
    }

    let note = null;
    if (accepted.length < count) {
      spare.sort((a, b) => Math.abs(a.lengthM - targetM) - Math.abs(b.lengthM - targetM));
      for (const cand of spare) {
        if (accepted.length >= count) break;
        if (!isDuplicate(graph, cand, accepted)) {
          cand.approximate = true;
          accepted.push(cand);
        }
      }
      if (accepted.length) note = 'Couldn’t hit the target length exactly for every route — some are best-effort.';
    }
    if (!accepted.length) {
      return { error: 'Could not generate a route here. Try a different length or a larger area.' };
    }
    return { routes: accepted, note };
  }

  return { buildAdjacency, buildSnapIndex, snap, dijkstra, generate };
})();
