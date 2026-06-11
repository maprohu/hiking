'use strict';

// UI controller: wizard flow, map interactions, persistence wiring.
(() => {
  const $ = id => document.getElementById(id);
  const tick = () => new Promise(r => setTimeout(r));
  const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const slug = s => String(s).trim().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'route';

  const Prefs = {
    get(k, d) {
      const v = localStorage.getItem('hrp.' + k);
      if (v === null) return d;
      try { return JSON.parse(v); } catch { return d; }
    },
    set: (k, v) => localStorage.setItem('hrp.' + k, JSON.stringify(v)),
  };

  // ---------- map ----------
  const map = L.map('map').setView([38.787, -9.39], 12); // Sintra
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL)',
  }).addTo(map);

  // Leaflet only watches window resize; observe the container directly so
  // layout changes (sheet collapse, rotation, emulation) are picked up too.
  new ResizeObserver(() => map.invalidateSize()).observe(document.getElementById('map'));

  const areaLayer = L.layerGroup().addTo(map);   // saved area polygons
  const drawLayer = L.layerGroup().addTo(map);   // polygon being drawn
  const pointLayer = L.layerGroup().addTo(map);  // start/end markers
  const routeLayer = L.layerGroup().addTo(map);  // current route line

  // ---------- state ----------
  const state = {
    view: 'areas',
    areas: [], points: [], savedRoutes: [],
    area: null, graph: null, adj: null, snapIndex: null, profileKey: null,
    mode: 'circular',
    start: null, end: null, // { lat, lng, node, label? }
    armedSlot: null,
    drawing: null,          // [[lat, lng], ...]
    candidates: [], current: 0, note: null,
    returnView: 'areas',
  };

  // ---------- chrome ----------
  // ms = 0 keeps the toast until replaced; onClick makes it tappable.
  let toastTimer = null;
  function toast(msg, ms = 3500, onClick = null) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    t.classList.toggle('clickable', !!onClick);
    t.onclick = onClick;
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
  }

  function overlay(msg) {
    if (msg == null) {
      $('overlay').classList.add('hidden');
    } else {
      $('overlayText').textContent = msg;
      $('overlay').classList.remove('hidden');
    }
  }

  function showErr(err) {
    console.error(err);
    overlay(null);
    toast(err && err.message ? err.message : String(err), 6000);
  }

  function fitPad() {
    if (isMobile() && !$('panel').classList.contains('collapsed')) {
      return { paddingTopLeft: [24, 24], paddingBottomRight: [24, Math.round(window.innerHeight * 0.45)] };
    }
    return { padding: [32, 32] };
  }

  function setSheet(collapsed) {
    $('panel').classList.toggle('collapsed', collapsed);
    $('sheetToggle').textContent = collapsed ? '▴' : '▾';
  }

  // Crosshair cursor whenever a map click means "place something":
  // while drawing the polygon, or while a start/end slot is armed.
  function updateMapCursor() {
    const picking = state.view === 'draw' || (state.view === 'points' && !!state.armedSlot);
    document.getElementById('map').classList.toggle('picking', picking);
  }

  // ---------- views ----------
  const VIEWS = ['areas', 'draw', 'mode', 'points', 'params', 'results', 'saved'];
  function show(view) {
    state.view = view;
    for (const v of VIEWS) $('view-' + v).classList.toggle('hidden', v !== view);
    if (view === 'areas') {
      pointLayer.clearLayers();
      routeLayer.clearLayers();
      renderAreas();
    }
    if (view === 'points') renderPoints();
    if (view === 'results') renderRoute();
    if (view === 'saved') renderSavedRoutes();
    updateMapCursor();
    setSheet(false);
  }

  // ---------- areas ----------
  async function loadAll() {
    state.areas = await DB.all('areas');
    state.points = await DB.all('points');
    state.savedRoutes = await DB.all('routes');
  }

  function drawAreaPolygons() {
    areaLayer.clearLayers();
    for (const area of state.areas) {
      const poly = L.polygon(area.ring, { color: '#1f6b43', weight: 2, fillOpacity: 0.08 });
      poly.on('click', e => {
        if (state.view !== 'areas') return;
        L.DomEvent.stop(e);
        selectArea(area).catch(showErr);
      });
      poly.addTo(areaLayer);
    }
  }

  function fitAllAreas() {
    if (!state.areas.length) { toast('No saved areas yet.'); return; }
    let bounds = null;
    for (const a of state.areas) {
      const b = L.polygon(a.ring).getBounds();
      bounds = bounds ? bounds.extend(b) : b;
    }
    map.fitBounds(bounds, fitPad());
  }

  function renderAreas() {
    drawAreaPolygons();
    const ul = $('areaList');
    ul.innerHTML = '';
    if (!state.areas.length) {
      ul.innerHTML = '<li class="empty">No saved areas yet — draw one to get started.</li>';
      return;
    }
    for (const area of state.areas) {
      const li = document.createElement('li');
      li.className = 'card';
      const meta = area.fetchedAt
        ? 'data from ' + new Date(area.fetchedAt).toLocaleDateString()
        : 'no data downloaded yet';
      li.innerHTML =
        `<div class="card-main"><div class="card-title">${esc(area.label)}</div>` +
        `<div class="card-meta">${meta}</div></div>` +
        `<div class="card-actions">` +
        `<button data-act="update" title="Update data">⟳</button>` +
        `<button data-act="delete" title="Delete">🗑</button></div>`;
      li.querySelector('.card-main').onclick = () => selectArea(area).catch(showErr);
      li.querySelector('[data-act=update]').onclick = e => {
        e.stopPropagation();
        fetchAreaData(area).then(renderAreas).catch(showErr);
      };
      li.querySelector('[data-act=delete]').onclick = async e => {
        e.stopPropagation();
        if (!confirm(`Delete area "${area.label}" and its cached data?`)) return;
        await DB.del('areas', area.id);
        await DB.del('graphs', area.id);
        await loadAll();
        renderAreas();
      };
      ul.appendChild(li);
    }
  }

  // Show just the selected area's outline while moving through the wizard.
  // Non-interactive so map clicks fall through to point placement.
  function drawSelectedArea(area) {
    areaLayer.clearLayers();
    L.polygon(area.ring, {
      color: '#1f6b43', weight: 2, fillOpacity: 0.06, interactive: false,
    }).addTo(areaLayer);
  }

  async function selectArea(area) {
    // Draw and frame the area before any await, so it's visible immediately
    // (e.g. right after finishing a fresh polygon, while data downloads).
    state.area = area;
    drawSelectedArea(area);
    map.fitBounds(L.polygon(area.ring).getBounds(), fitPad());
    let g = await DB.get('graphs', area.id);
    if (!g) g = await fetchAreaData(area);
    state.start = state.end = null;
    state.armedSlot = null;
    state.candidates = [];
    setGraph(g);
    pointLayer.clearLayers();
    routeLayer.clearLayers();
    show('mode');
  }

  async function fetchAreaData(area) {
    if (!navigator.onLine) throw new Error('You are offline and this area has no cached data yet.');
    overlay('Contacting Overpass…');
    try {
      const instance = Prefs.get('overpassInstance', Overpass.INSTANCES[0]);
      const osm = await Overpass.fetchArea(area.bbox, instance, overlay);
      overlay('Building routing graph…');
      await tick();
      const g = Graph.build(osm, area.ring);
      if (!g.edgeA.length) throw new Error('No walkable ways found in this area.');
      const rec = { areaId: area.id, ...g, fetchedAt: Date.now(), overpassInstance: instance };
      await DB.put('graphs', rec);
      area.fetchedAt = rec.fetchedAt;
      await DB.put('areas', area);
      if (state.area && state.area.id === area.id) setGraph(rec);
      return rec;
    } finally {
      overlay(null);
    }
  }

  function setGraph(g) {
    state.graph = g;
    state.snapIndex = Router.buildSnapIndex(g);
    state.adj = null;
    state.profileKey = null;
  }

  function getAdjacency() {
    const avoid = $('avoidSidewalksChk').checked;
    const key = avoid ? 'nosw' : 'all';
    if (state.profileKey !== key) {
      state.adj = Router.buildAdjacency(state.graph, { avoidSidewalks: avoid });
      state.profileKey = key;
    }
    return state.adj;
  }

  // ---------- polygon drawing ----------
  function startDrawing() {
    state.drawing = [];
    $('areaLabel').value = '';
    drawLayer.clearLayers();
    show('draw');
    renderDrawing();
    if (isMobile()) toast('Tap the map to add corners');
  }

  function renderDrawing() {
    drawLayer.clearLayers();
    const pts = state.drawing;
    for (const p of pts) {
      L.circleMarker(p, { radius: 6, color: '#d2691e', fillColor: '#d2691e', fillOpacity: 1 }).addTo(drawLayer);
    }
    if (pts.length >= 3) {
      L.polygon(pts, { color: '#d2691e', weight: 2, dashArray: '6 4', fillOpacity: 0.06 }).addTo(drawLayer);
    } else if (pts.length === 2) {
      L.polyline(pts, { color: '#d2691e', weight: 2, dashArray: '6 4' }).addTo(drawLayer);
    }
    $('drawFinishBtn').disabled = pts.length < 3;
  }

  async function finishDrawing() {
    const ring = state.drawing;
    if (!ring || ring.length < 3) return;
    const km2 = Geo.ringAreaKm2(ring);
    if (km2 > 120 && !confirm(
      `This area is about ${Math.round(km2)} km² — downloading and routing may be slow and memory-hungry. Continue?`)) return;
    const label = $('areaLabel').value.trim() || `Area ${state.areas.length + 1}`;
    const area = {
      id: 'area-' + Date.now(),
      label, ring,
      bbox: Geo.bbox(ring),
      createdAt: Date.now(),
      fetchedAt: null,
    };
    await DB.put('areas', area);
    state.drawing = null;
    drawLayer.clearLayers();
    await loadAll();
    await selectArea(area);
  }

  function cancelDrawing() {
    state.drawing = null;
    drawLayer.clearLayers();
    show('areas');
  }

  // ---------- points ----------
  function renderPoints() {
    $('endBlock').classList.toggle('hidden', state.mode !== 'linear');
    if (state.armedSlot == null) {
      if (!state.start) state.armedSlot = 'start';
      else if (state.mode === 'linear' && !state.end) state.armedSlot = 'end';
    }
    updateArmedUI();
    renderSavedPoints();
    renderPointMarkers();
    $('pointsNextBtn').disabled = !(state.start && (state.mode === 'circular' || state.end));
  }

  function updateArmedUI() {
    for (const slot of ['start', 'end']) {
      const pt = state[slot];
      const status = $(slot + 'Status');
      if (pt) status.textContent = pt.label || `${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}`;
      else status.textContent = state.armedSlot === slot ? 'tap the map…' : 'not set';
      $(slot + 'SaveBtn').classList.toggle('hidden', !pt);
      $(slot + 'PickBtn').classList.toggle('armed', state.armedSlot === slot);
    }
    updateMapCursor();
  }

  function armSlot(slot) {
    state.armedSlot = slot;
    updateArmedUI();
    if (isMobile()) {
      setSheet(true);
      toast(`Tap the map to place the ${slot} point`);
    }
  }

  function placePoint(latlng) {
    const s = Router.snap(state.graph, state.snapIndex, latlng.lat, latlng.lng, 50);
    if (!s) {
      toast('No walkable path near here — pick a spot closer to a trail or road.');
      return;
    }
    assignSlot(state.armedSlot, { lat: s.lat, lng: s.lng, node: s.node });
    if (isMobile()) setSheet(false);
  }

  function assignSlot(slot, pt) {
    state[slot] = pt;
    state.armedSlot = null;
    renderPoints();
  }

  function renderSavedPoints() {
    const ul = $('savedPointList');
    ul.innerHTML = '';
    const pts = state.points.filter(p => state.area && p.areaId === state.area.id);
    if (!pts.length) {
      ul.innerHTML = '<li class="empty">No saved points in this area.</li>';
      return;
    }
    for (const p of pts) {
      const li = document.createElement('li');
      li.className = 'card';
      li.innerHTML =
        `<div class="card-main"><div class="card-title">${esc(p.label)}</div>` +
        `<div class="card-meta">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</div></div>` +
        `<div class="card-actions"><button data-act="del" title="Delete">🗑</button></div>`;
      li.querySelector('.card-main').onclick = () => useSavedPoint(p);
      li.querySelector('[data-act=del]').onclick = async e => {
        e.stopPropagation();
        await DB.del('points', p.id);
        await loadAll();
        renderPoints();
      };
      ul.appendChild(li);
    }
  }

  function useSavedPoint(p) {
    // Re-snap by coordinates: node ids may have shifted after an "Update data".
    const s = Router.snap(state.graph, state.snapIndex, p.lat, p.lng, 100);
    if (!s) {
      toast('This saved point is no longer near a walkable path.');
      return;
    }
    const slot = state.armedSlot || (!state.start ? 'start'
      : (state.mode === 'linear' && !state.end ? 'end' : 'start'));
    assignSlot(slot, { lat: s.lat, lng: s.lng, node: s.node, label: p.label });
  }

  async function savePoint(slot) {
    const pt = state[slot];
    if (!pt) return;
    const label = prompt('Label for this point (e.g. "Train station"):', pt.label || '');
    if (label == null) return;
    pt.label = label.trim() || 'Point';
    await DB.put('points', {
      id: 'pt-' + Date.now(),
      label: pt.label,
      lat: pt.lat, lng: pt.lng,
      snappedNodeId: pt.node,
      areaId: state.area.id,
    });
    await loadAll();
    renderPoints();
    toast('Point saved.');
  }

  function renderPointMarkers() {
    pointLayer.clearLayers();
    if (state.start) {
      L.marker([state.start.lat, state.start.lng]).addTo(pointLayer)
        .bindTooltip(state.mode === 'circular' ? 'Start / finish' : 'Start');
    }
    if (state.mode === 'linear' && state.end) {
      L.marker([state.end.lat, state.end.lng]).addTo(pointLayer).bindTooltip('End');
    }
  }

  // ---------- params & generation ----------
  function loadParams() {
    $('lengthInput').value = Prefs.get('lastLength', 10);
    $('unitSelect').value = Prefs.get('lastUnit', 'km');
    $('countInput').value = Prefs.get('lastRouteCount', 3);
    $('paceInput').value = Prefs.get('pace', 4);
    $('avoidSidewalksChk').checked = Prefs.get('avoidSidewalks', false);
    updateUnitUI();
  }

  function updateUnitUI() {
    const hours = $('unitSelect').value === 'hours';
    $('paceField').classList.toggle('hidden', !hours);
    $('hoursHint').classList.toggle('hidden', !hours);
  }

  async function generateRoutes() {
    const length = parseFloat($('lengthInput').value);
    const unit = $('unitSelect').value;
    const pace = parseFloat($('paceInput').value) || 4;
    const count = Math.max(1, Math.min(10, parseInt($('countInput').value, 10) || 3));
    if (!(length > 0)) { toast('Enter a target length.'); return; }
    Prefs.set('lastLength', length);
    Prefs.set('lastUnit', unit);
    Prefs.set('lastRouteCount', count);
    Prefs.set('pace', pace);
    Prefs.set('avoidSidewalks', $('avoidSidewalksChk').checked);

    const targetM = (unit === 'hours' ? length * pace : length) * 1000;
    const endNode = state.mode === 'circular' ? state.start.node : state.end.node;
    overlay('Generating routes…');
    try {
      const result = await Router.generate({
        graph: state.graph,
        adj: getAdjacency(),
        snapIndex: state.snapIndex,
        startNode: state.start.node,
        endNode, targetM, count,
        seed: (Math.random() * 2 ** 31) | 0,
        onProgress: (found, attempt) =>
          overlay(`Generating routes… ${found}/${count} found (attempt ${attempt + 1})`),
      });
      if (result.error) {
        const extra = result.minMeters
          ? ` Shortest pleasant path is ${(result.minMeters / 1000).toFixed(1)} km.` : '';
        toast(result.error + extra, 7000);
        return;
      }
      state.candidates = result.routes;
      state.current = 0;
      state.note = result.note;
      show('results');
    } finally {
      overlay(null);
    }
  }

  function formatHours(h) {
    return h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`;
  }

  function renderRoute() {
    routeLayer.clearLayers();
    const c = state.candidates[state.current];
    if (!c) { $('routeInfo').textContent = 'No routes.'; return; }
    const line = L.polyline(c.latlngs, { color: '#c0392b', weight: 4, opacity: 0.85 }).addTo(routeLayer);
    map.fitBounds(line.getBounds(), fitPad());
    const pace = parseFloat($('paceInput').value) || 4;
    const km = c.lengthM / 1000;
    $('routeInfo').innerHTML =
      `<strong>Route ${state.current + 1} / ${state.candidates.length}</strong><br>` +
      `${km.toFixed(1)} km · ~${formatHours(km / pace)} · ${c.offroadPct}% off-road` +
      (c.approximate ? ' · ⚠ off target' : '');
    $('routeNote').textContent = state.note || '';
  }

  function cycle(dir) {
    const n = state.candidates.length;
    if (!n) return;
    state.current = (state.current + dir + n) % n;
    renderRoute();
  }

  async function saveCurrentRoute() {
    const c = state.candidates[state.current];
    if (!c) return;
    const label = prompt('Label for this route:',
      `${state.area.label} ${(c.lengthM / 1000).toFixed(1)} km`);
    if (label == null) return;
    await DB.put('routes', {
      id: 'rt-' + Date.now(),
      areaId: state.area.id,
      mode: state.mode,
      lengthMeters: c.lengthM,
      geometry: c.latlngs,
      seed: c.seed,
      weightProfile: { avoidSidewalks: $('avoidSidewalksChk').checked },
      offroadPct: c.offroadPct,
      createdAt: Date.now(),
      label: label.trim() || 'Route',
    });
    await loadAll();
    toast('Route saved.');
  }

  function exportCurrent() {
    const c = state.candidates[state.current];
    if (!c) return;
    const name = `${state.area.label} ${(c.lengthM / 1000).toFixed(1)} km`;
    GPX.download(slug(name) + '.gpx', GPX.toGPX(name, c.latlngs));
  }

  // ---------- saved routes ----------
  function renderSavedRoutes() {
    const ul = $('savedRouteList');
    ul.innerHTML = '';
    if (!state.savedRoutes.length) {
      ul.innerHTML = '<li class="empty">No saved routes yet.</li>';
      return;
    }
    const sorted = [...state.savedRoutes].sort((a, b) => b.createdAt - a.createdAt);
    for (const r of sorted) {
      const li = document.createElement('li');
      li.className = 'card';
      const km = (r.lengthMeters / 1000).toFixed(1);
      li.innerHTML =
        `<div class="card-main"><div class="card-title">${esc(r.label)}</div>` +
        `<div class="card-meta">${km} km · ${r.mode} · ${r.offroadPct ?? '?'}% off-road · ` +
        `${new Date(r.createdAt).toLocaleDateString()}</div></div>` +
        `<div class="card-actions">` +
        `<button data-act="gpx" title="Export GPX">⬇</button>` +
        `<button data-act="del" title="Delete">🗑</button></div>`;
      li.querySelector('.card-main').onclick = () => previewSaved(r);
      li.querySelector('[data-act=gpx]').onclick = e => {
        e.stopPropagation();
        GPX.download(slug(r.label) + '.gpx', GPX.toGPX(r.label, r.geometry));
      };
      li.querySelector('[data-act=del]').onclick = async e => {
        e.stopPropagation();
        if (!confirm(`Delete route "${r.label}"?`)) return;
        await DB.del('routes', r.id);
        await loadAll();
        renderSavedRoutes();
      };
      ul.appendChild(li);
    }
  }

  function previewSaved(r) {
    routeLayer.clearLayers();
    const line = L.polyline(r.geometry, { color: '#c0392b', weight: 4, opacity: 0.85 }).addTo(routeLayer);
    map.fitBounds(line.getBounds(), fitPad());
    if (isMobile()) setSheet(true);
  }

  // ---------- settings ----------
  function openSettings() {
    const sel = $('overpassSelect');
    sel.innerHTML = '';
    for (const url of Overpass.INSTANCES) {
      const opt = document.createElement('option');
      opt.value = url;
      opt.textContent = new URL(url).hostname;
      sel.appendChild(opt);
    }
    const custom = document.createElement('option');
    custom.value = 'custom';
    custom.textContent = 'Custom…';
    sel.appendChild(custom);
    const current = Prefs.get('overpassInstance', Overpass.INSTANCES[0]);
    if (Overpass.INSTANCES.includes(current)) {
      sel.value = current;
      $('overpassCustom').classList.add('hidden');
    } else {
      sel.value = 'custom';
      $('overpassCustom').value = current;
      $('overpassCustom').classList.remove('hidden');
    }
    $('settingsDialog').showModal();
  }

  function saveSettings() {
    const sel = $('overpassSelect').value;
    const value = sel === 'custom' ? $('overpassCustom').value.trim() : sel;
    if (value) Prefs.set('overpassInstance', value);
    $('settingsDialog').close();
  }

  // ---------- events ----------
  function bindEvents() {
    map.on('click', ev => {
      if (state.view === 'draw') {
        state.drawing.push([ev.latlng.lat, ev.latlng.lng]);
        renderDrawing();
      } else if (state.view === 'points' && state.armedSlot) {
        placePoint(ev.latlng);
      }
    });

    $('newAreaBtn').onclick = startDrawing;
    $('fitAreasBtn').onclick = fitAllAreas;
    $('drawFinishBtn').onclick = () => finishDrawing().catch(showErr);
    $('drawUndoBtn').onclick = () => { state.drawing.pop(); renderDrawing(); };
    $('drawCancelBtn').onclick = cancelDrawing;
    $('modeCircularBtn').onclick = () => { state.mode = 'circular'; state.end = null; show('points'); };
    $('modeLinearBtn').onclick = () => { state.mode = 'linear'; show('points'); };
    $('startPickBtn').onclick = () => armSlot('start');
    $('endPickBtn').onclick = () => armSlot('end');
    $('startSaveBtn').onclick = () => savePoint('start').catch(showErr);
    $('endSaveBtn').onclick = () => savePoint('end').catch(showErr);
    $('pointsNextBtn').onclick = () => show('params');
    $('unitSelect').onchange = updateUnitUI;
    $('generateBtn').onclick = () => generateRoutes().catch(showErr);
    $('prevRouteBtn').onclick = () => cycle(-1);
    $('nextRouteBtn').onclick = () => cycle(1);
    $('saveRouteBtn').onclick = () => saveCurrentRoute().catch(showErr);
    $('exportRouteBtn').onclick = exportCurrent;
    $('regenBtn').onclick = () => generateRoutes().catch(showErr);
    $('savedRoutesBtn').onclick = () => {
      if (state.view !== 'saved') state.returnView = state.view;
      show('saved');
    };
    $('savedBackBtn').onclick = () => show(state.returnView || 'areas');
    $('settingsBtn').onclick = openSettings;
    $('settingsSaveBtn').onclick = saveSettings;
    $('settingsCloseBtn').onclick = () => $('settingsDialog').close();
    $('overpassSelect').onchange = () =>
      $('overpassCustom').classList.toggle('hidden', $('overpassSelect').value !== 'custom');
    $('sheetToggle').onclick = () => setSheet(!$('panel').classList.contains('collapsed'));

    document.querySelectorAll('[data-back]').forEach(b => {
      b.onclick = () => show(b.dataset.back);
    });

    document.addEventListener('keydown', e => {
      if (state.view !== 'results') return;
      if (e.key === 'ArrowLeft') cycle(-1);
      if (e.key === 'ArrowRight') cycle(1);
    });
  }

  // ---------- init ----------
  async function init() {
    bindEvents();
    loadParams();
    await loadAll();
    show('areas');
    if (state.areas.length) fitAllAreas();
    registerServiceWorker();
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
    // updateViaCache:'none' → the sw.js script itself is always revalidated
    // against the network, so a changed worker is noticed promptly.
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          // A new worker finished installing while an old one is in control:
          // a fresh version is ready. Offer a one-tap reload (no auto-reload,
          // so we never interrupt a route generation in progress).
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('A new version is available — tap to update', 0, () => location.reload());
          }
        });
      });
      reg.update();
      setInterval(() => reg.update(), 30 * 60 * 1000);
    }).catch(() => {});
  }

  init().catch(showErr);
})();
