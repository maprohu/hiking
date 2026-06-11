'use strict';

// Overpass fetch: highways-only bbox query, instance choice, exponential backoff.
const Overpass = (() => {
  const INSTANCES = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];

  const EXCLUDED = 'motorway|motorway_link|proposed|construction|abandoned|raceway|bus_guideway|elevator|platform';

  function buildQuery({ s, w, n, e }) {
    return `[out:json][timeout:90];` +
      `way["highway"]["highway"!~"^(${EXCLUDED})$"]` +
      `["access"!~"^(private|no)$"]["foot"!~"^no$"]` +
      `(${s},${w},${n},${e});` +
      `(._;>;);out body;`;
  }

  async function fetchArea(bbox, instance, onStatus) {
    const url = instance || INSTANCES[0];
    const body = 'data=' + encodeURIComponent(buildQuery(bbox));
    const delaysMs = [0, 4000, 12000, 30000];
    let lastErr = null;
    for (const delay of delaysMs) {
      if (delay) {
        if (onStatus) onStatus(`Overpass is busy — retrying in ${delay / 1000}s…`);
        await new Promise(r => setTimeout(r, delay));
      }
      if (onStatus) onStatus('Downloading OSM data…');
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
        });
        if (res.status === 429 || res.status === 504) {
          lastErr = new Error(`Overpass returned HTTP ${res.status}`);
          continue;
        }
        if (!res.ok) throw new Error(`Overpass returned HTTP ${res.status}`);
        if (onStatus) onStatus('Parsing OSM data…');
        return await res.json();
      } catch (err) {
        lastErr = err; // network errors are retried too
      }
    }
    throw lastErr || new Error('Overpass fetch failed');
  }

  return { INSTANCES, fetchArea };
})();
