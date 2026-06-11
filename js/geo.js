'use strict';

// Geometry helpers — distances in meters, coordinates in degrees [lat, lng].
const Geo = (() => {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;

  function haversine(lat1, lng1, lat2, lng2) {
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function bearing(lat1, lng1, lat2, lng2) {
    const p1 = toRad(lat1), p2 = toRad(lat2), dl = toRad(lng2 - lng1);
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function destination(lat, lng, bearingDeg, distM) {
    const d = distM / R, t = toRad(bearingDeg);
    const p1 = toRad(lat), l1 = toRad(lng);
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
    const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [toDeg(p2), ((toDeg(l2) + 540) % 360) - 180];
  }

  // ring: [[lat, lng], ...] — closing vertex optional.
  function pointInRing(lat, lng, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i][0], xi = ring[i][1];
      const yj = ring[j][0], xj = ring[j][1];
      if ((yi > lat) !== (yj > lat) &&
          lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function bbox(ring) {
    let s = 90, w = 180, n = -90, e = -180;
    for (const [lat, lng] of ring) {
      if (lat < s) s = lat;
      if (lat > n) n = lat;
      if (lng < w) w = lng;
      if (lng > e) e = lng;
    }
    return { s, w, n, e };
  }

  // Planar shoelace on a local projection — good enough for a size warning.
  function ringAreaKm2(ring) {
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * Math.cos(toRad(ring[0][0]));
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][1] * mPerDegLng, yi = ring[i][0] * mPerDegLat;
      const xj = ring[j][1] * mPerDegLng, yj = ring[j][0] * mPerDegLat;
      sum += (xj + xi) * (yj - yi);
    }
    return Math.abs(sum / 2) / 1e6;
  }

  // Distance (m) from point P to segment AB, using a local flat projection around P.
  function distToSegment(plat, plng, alat, alng, blat, blng) {
    const mLat = 111320, mLng = 111320 * Math.cos(toRad(plat));
    const ax = (alng - plng) * mLng, ay = (alat - plat) * mLat;
    const bx = (blng - plng) * mLng, by = (blat - plat) * mLat;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq ? (-ax * dx - ay * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    return { dist: Math.hypot(ax + t * dx, ay + t * dy), t };
  }

  return { haversine, bearing, destination, pointInRing, bbox, ringAreaKm2, distToSegment };
})();
