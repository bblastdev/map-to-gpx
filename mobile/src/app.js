/*
 * Map to GPX, the app's interface.
 *
 * The routing, parsing, geometry and GPX writing are not here: they are the
 * site's own core and engine, copied out of index.html at build time, so the
 * app and the site cannot disagree about a route. This file is only what a
 * phone needs that a web page does not -- two views instead of one rail, a
 * sheet over the map, Send and Save through the system, the last route kept on
 * the phone, and links shared in from Google Maps.
 *
 * The conversion flow, the map drawing and the elevation chart follow the
 * site's interface closely, down to the reasoning in its comments; where they
 * differ it is because the layout does.
 */
(function () {
  'use strict';
  const C = globalThis.MapToGPX;
  const E = globalThis.MTGEngine;
  const $ = (id) => document.getElementById(id);

  /* ── platform ─────────────────────────────────────────────────────────── */

  const CAP = globalThis.Capacitor;
  const NATIVE = !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform());
  const PLATFORM = (CAP && CAP.getPlatform) ? CAP.getPlatform() : 'web';

  /* Each plugin's own browser bundle defines a global; see scripts/build-www.mjs.
     In a plain browser tab they fall back to web behaviour, which is what lets
     this interface be worked on outside a simulator. */
  const G = (g, k) => (globalThis[g] && globalThis[g][k]) || null;
  const Filesystem = G('capacitorFilesystemPluginCapacitor', 'Filesystem');
  const Directory = G('capacitorFilesystemPluginCapacitor', 'Directory') || {};
  const Encoding = G('capacitorFilesystemPluginCapacitor', 'Encoding') || {};
  const Share = G('capacitorShare', 'Share');
  const Clipboard = G('capacitorClipboard', 'Clipboard');
  const Network = G('capacitorNetwork', 'Network');
  const Preferences = G('capacitorPreferences', 'Preferences');
  const App = G('capacitorApp', 'App');
  const StatusBar = G('capacitorStatusBar', 'StatusBar');
  const StatusStyle = G('capacitorStatusBar', 'Style') || {};
  const SecureStorage = G('capacitorSecureStorage', 'SecureStorage');
  const ShareTarget = G('capacitorCapacitorShareTarget', 'CapacitorShareTarget');

  /* The site's API. The app's pages load from an origin of its own
     (capacitor://app.map-to-gpx.com), which the routing proxy accepts by name;
     in a browser tab during development the API is same-origin, and a
     development build can name another (MTG_API, see scripts/build-www.mjs). */
  const SITE = 'https://map-to-gpx.com';
  const API = (typeof globalThis.MTG_API === 'string' && globalThis.MTG_API) || (NATIVE ? SITE : location.origin);

  /* ── constants ────────────────────────────────────────────────────────── */

  /* Three separate questions, so three fields -- see the site for why Run
     routes on cycling-regular rather than a foot profile. */
  const PROFILES = [
    { id: 'cycling-road', name: 'Bike', sub: 'road bike', icon: 'b-bicycle', pace: 'cycling-road' },
    { id: 'foot-walking', name: 'Run', sub: 'roads', icon: 'b-person-simple-run', ors: 'cycling-regular', pace: 'running' }
  ];
  const paceFor = (id) => (PROFILES.find((p) => p.id === id) || {}).pace || id;
  const orsFor = (id) => (PROFILES.find((p) => p.id === id) || {}).ors || id;
  /* Which network a route is drawn on: the one closest to what Google planned
     the link for, for a ride or a run alike. Car and motorcycle links -- nearly
     every Indonesian one -- on the roads a motor vehicle takes (Engine.route on
     the site); bicycle links on the city-bike profile, as Google's bike
     directions ride; anything else on the activity's own profile. */
  const routingFor = (profile) => C.plannedForVehicle(state.travelMode) ? 'driving-car'
    : state.travelMode === 'bicycling' ? 'cycling-regular' : orsFor(profile || state.profile);
  const ICON = {
    stepDone: 'f-check-circle', start: 'f-play-circle', mid: 'f-map-pin', finish: 'f-flag-checkered',
    valid: 'f-seal-check', invalid: 'f-warning', copy: 'b-copy', copied: 'b-check',
    radioOn: 'f-radio-button', radioOff: 'b-circle',
    tagOn: 'f-check-circle', tagGo: 'b-arrow-right', tagNotBuilt: 'b-circle-dashed'
  };
  const HOSTS = [
    { id: 'auto', label: 'Automatic — heigit, then openrouteservice.org' },
    { id: 'https://api.heigit.org/openrouteservice/v2/directions', label: 'api.heigit.org (new)' },
    { id: 'https://api.openrouteservice.org/v2/directions', label: 'api.openrouteservice.org (legacy)' }
  ];
  const STEPS = [
    { key: 'read', label: 'Read the link', icon: 'b-link-simple' },
    { key: 'locate', label: 'Locate the stops', icon: 'b-map-pin-line' },
    { key: 'route', label: 'Route it on OpenStreetMap', icon: 'b-path' },
    { key: 'gpx', label: 'Measure and write the GPX', icon: 'b-file-code' }
  ];
  /* Names with a map position, so the lookup has somewhere to look -- the same
     route as the share card. */
  const EXAMPLE = 'https://www.google.com/maps/dir/Purwokerto/Baturraden/@-7.37,109.22,13z/data=!4m2!4m1!3e1';

  /* Publishable and domain-free, like the site's; see index.html. */
  const CARTO_KEY = 'cb1_2aq4_1_babdbcd2cfb72b8cd0933e61';
  const TILES = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=' + encodeURIComponent(CARTO_KEY);

  /*
   * The tip links stay off inside the store builds. Apple treats a tip to the
   * developer of an app as a digital purchase that has to go through in-app
   * purchase, and a link out to Ko-fi is a common reason for rejection; Google
   * Play's payments policy reads much the same. The site keeps them. Turn this
   * on only once that has been checked for the stores you ship to.
   */
  const SUPPORT_IN_APP = !NATIVE;
  const SUPPORT_URL = 'https://ko-fi.com/hakimhn';
  const SUPPORT_URL_ID = 'https://saweria.co/hakimhn';

  /* How far the sheet is up, in px: peek shows its title, half the profile. */
  const SHEET = { peek: 48, half: 202 };

  /* ── state ────────────────────────────────────────────────────────────── */

  const state = {
    view: 'home', link: '', fromShare: false, profile: 'cycling-road', travelMode: null, units: 'metric',
    key: '', host: 'auto', settingsOpen: false,
    busy: false, step: null, progressMsg: '', elapsed: '0s',
    error: null, result: null, selected: 0, addMode: false,
    detent: 'half', offline: false, last: null,
    copyLabel: 'Copy GPX'
  };
  let waypoints = [], plan = null, notes = [], splitPoints = [], splitNotes = [];
  let altSearchDone = false, altSearching = false, routeGen = 0;
  let map = null, tiles = null, layer = null, renderer = null, hoverDot = null, pins = [];
  let bounds = null, needsFit = false, fitKey = null, mapStamp = null, chartStamp = null;
  let series = null, clock = null;

  const token = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#fc4c02';

  /* ── storage ──────────────────────────────────────────────────────────── */

  async function prefGet(key) {
    try { if (Preferences) return (await Preferences.get({ key })).value; } catch (_) { }
    try { return localStorage.getItem('mtg:' + key); } catch (_) { return null; }
  }
  async function prefSet(key, value) {
    try { if (Preferences) return await Preferences.set({ key, value: String(value) }); } catch (_) { }
    try { localStorage.setItem('mtg:' + key, String(value)); } catch (_) { }
  }

  /* The key lives in the Keychain on iOS and in Keystore-backed storage on
     Android. In a browser tab it is kept in memory only: a page has nowhere
     secure to put it, so it is not put anywhere. */
  const KEY_NAME = 'ors-key';
  async function loadKey() {
    if (!NATIVE || !SecureStorage) return '';
    try { return (await SecureStorage.get(KEY_NAME)) || ''; } catch (_) { return ''; }
  }
  async function saveKey(value) {
    if (!NATIVE || !SecureStorage) return;
    try {
      if (value) await SecureStorage.set(KEY_NAME, value);
      else await SecureStorage.remove(KEY_NAME);
    } catch (_) { /* the next launch simply asks again */ }
  }

  /*
   * The last route, kept whole on the phone so it opens with no connection:
   * stops, the chosen line with its elevation, and the figures read off it.
   * Stored as a file rather than a preference because a long route is a few
   * hundred kilobytes of coordinates -- and in Library, not Data: on iOS Data
   * is the Documents folder, which the Files app shows beside the saved GPX.
   */
  const LAST_FILE = 'last-route.json';
  async function saveLast() {
    const r = state.result;
    if (!r || !plan) return;
    const opt = plan.options[state.selected] || plan.options[0];
    const record = {
      v: 1, savedAt: Date.now(), link: state.link, profile: state.profile, travelMode: state.travelMode || null, name: r.name,
      waypoints: waypoints.map((w) => ({ kind: w.kind, label: w.label, lat: w.lat, lon: w.lon, source: w.source })),
      option: {
        label: opt && opt.label || null,
        distance: r.distance, duration: opt && opt.duration || null,
        ascent: r.ascent, descent: r.descent,
        points: r.points.map((p) => [+p.lat.toFixed(6), +p.lon.toFixed(6), Number.isFinite(p.ele) ? +p.ele.toFixed(1) : null])
      }
    };
    const json = JSON.stringify(record);
    state.last = summarise(record);
    try {
      if (Filesystem && NATIVE) {
        await Filesystem.writeFile({ path: LAST_FILE, data: json, directory: Directory.Library, encoding: Encoding.UTF8 });
      } else {
        localStorage.setItem('mtg:' + LAST_FILE, json);
      }
    } catch (_) { /* a route that cannot be kept is still a route */ }
  }
  async function readLast() {
    try {
      let json = null;
      if (Filesystem && NATIVE) {
        json = (await Filesystem.readFile({ path: LAST_FILE, directory: Directory.Library, encoding: Encoding.UTF8 })).data;
      } else {
        json = localStorage.getItem('mtg:' + LAST_FILE);
      }
      const rec = json ? JSON.parse(json) : null;
      return rec && rec.v === 1 && Array.isArray(rec.waypoints) && rec.option && Array.isArray(rec.option.points) ? rec : null;
    } catch (_) { return null; }
  }
  function summarise(rec) {
    return { name: rec.name, distance: rec.option.distance, ascent: rec.option.ascent, profile: rec.profile };
  }

  /* ── small helpers ────────────────────────────────────────────────────── */

  const U = () => C.unitsFor(state.units);
  const fmtDist = (m) => { const v = C.toDistance(m, state.units); return v.toFixed(v < 10 ? 2 : 1); };
  const fmtEle = (m) => Math.round(C.toElevation(m, state.units)).toLocaleString('en-US');
  const fmtTarget = (m) => {
    const v = C.toDistance(m, state.units);
    return Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1);
  };
  const targetLabel = (m) => fmtTarget(m) + ' ' + U().distance;
  function fmtDuration(seconds) {
    const mins = Math.round((seconds || 0) / 60);
    const h = Math.floor(mins / 60), m = mins % 60;
    return h ? h + 'h ' + m + 'm' : m + 'm';
  }
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(id, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
  }
  const setIcon = (useId, id) => { const u = $(useId); if (u) u.setAttribute('href', '#' + id); };
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3600);
  }
  /* The first link in some shared text. Google Maps shares a sentence with the
     link at the end ("Directions from A to B … https://maps.app.goo.gl/…"),
     and other apps share the bare link. */
  function firstUrl(text) {
    const m = /https?:\/\/[^\s<>"']+/i.exec(String(text || ''));
    return m ? m[0].replace(/[).,;]+$/, '') : '';
  }

  /* ── share links ──────────────────────────────────────────────────────── */

  /* Always the site's address, never the app's: a capacitor:// link is
     meaningless to whoever receives it. It opens on the site and rebuilds the
     same stops there. */
  function shareUrl() {
    const data = {
      p: state.profile, m: state.travelMode || undefined, u: state.link || '',
      w: waypoints.map((w) => [Number(w.lat.toFixed(5)), Number(w.lon.toFixed(5)), String(w.label || '').slice(0, 40)])
    };
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(data)))).replace(/\+/g, '-').replace(/\//g, '_');
    return SITE + '/#r=' + b64;
  }

  /* ── views and the sheet ──────────────────────────────────────────────── */

  function showView(view) {
    state.view = view;
    render();
    if (view === 'route') {
      initMap();
      /* The map was measured while hidden; measure again now it has a size. */
      requestAnimationFrame(() => { if (map) map.invalidateSize(false); needsFit = true; fitLater(); drawChart(); });
    }
  }

  function sheetPx(detent) {
    if (detent === 'full') return $('stage').clientHeight;
    return SHEET[detent] || SHEET.half;
  }
  function setDetent(detent) {
    if (state.detent === detent) return;
    state.detent = detent;
    $('sheet-scroll').scrollTop = 0;
    render();
    /* Refit after the sheet has moved, so the route sits in the map that is
       still showing -- except at full, where there is no map left to fit. */
    if (detent !== 'full') setTimeout(() => { needsFit = true; fitLater(); }, 300);
    setTimeout(drawChart, 300);
  }
  function cycleDetent() {
    setDetent(state.detent === 'half' ? 'full' : state.detent === 'full' ? 'peek' : 'half');
  }

  /* Drag the sheet by its title; a tap cycles it. */
  function wireSheetDrag() {
    const grab = $('grab'), sheet = $('sheet');
    grab.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      const startY = ev.clientY, startH = sheet.getBoundingClientRect().height;
      const maxH = $('stage').clientHeight;
      let moved = false;
      try { grab.setPointerCapture(ev.pointerId); } catch (_) { }
      const move = (e) => {
        if (e.pointerId !== ev.pointerId) return;
        const dy = e.clientY - startY;
        if (!moved && Math.abs(dy) < 6) return;
        moved = true;
        sheet.classList.add('dragging');
        sheet.style.height = Math.max(SHEET.peek, Math.min(maxH, startH - dy)) + 'px';
      };
      const end = (e) => {
        if (e.pointerId !== ev.pointerId) return;
        grab.removeEventListener('pointermove', move);
        grab.removeEventListener('pointerup', end);
        grab.removeEventListener('pointercancel', end);
        sheet.classList.remove('dragging');
        sheet.style.height = '';
        if (!moved) return cycleDetent();
        /* Settle on whichever detent the sheet was let go nearest to. */
        const h = startH - (e.clientY - startY);
        const stops = [['peek', SHEET.peek], ['half', SHEET.half], ['full', maxH]];
        let best = stops[0];
        for (const s of stops) if (Math.abs(s[1] - h) < Math.abs(best[1] - h)) best = s;
        setDetent(best[0]);
        render();
      };
      grab.addEventListener('pointermove', move);
      grab.addEventListener('pointerup', end);
      grab.addEventListener('pointercancel', end);
    });
  }

  /* ── map ──────────────────────────────────────────────────────────────── */

  function initMap() {
    const box = $('map');
    if (!box || map || typeof L === 'undefined') return;
    /* Quarter zoom steps, as in the design: between the numbers and the sheet
       the map is only a couple of hundred pixels tall, and a whole-step fit
       can leave half of that empty. */
    map = L.map(box, { zoomControl: false, attributionControl: false, preferCanvas: true, zoomSnap: 0.25 }).setView([-6.2, 106.83], 10);
    tiles = L.tileLayer(TILES, { maxZoom: 19 });
    renderer = L.canvas({ padding: 0.4 }).addTo(map);
    map.on('click', (e) => { if (state.addMode) insertStopAt(e.latlng); });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fitLater).observe(box);
    wirePinDragging();
    syncMap();
  }

  /* Fit with the sheet and the controls taken out of the view, so the route
     is framed in the part of the map that can actually be seen. */
  function fitPadding() {
    const bottom = (state.detent === 'full' ? SHEET.half : sheetPx(state.detent)) + 28;
    return { paddingTopLeft: [20, 64], paddingBottomRight: [20, bottom] };
  }
  function fitLater() {
    if (!map) return;
    map.invalidateSize(false);
    if (bounds && needsFit && $('map').clientWidth > 0 && state.view === 'route') {
      map.fitBounds(bounds, fitPadding());
      needsFit = false;
    }
  }

  function syncMap() {
    if (!map) return;
    /* Offline, as in the design, the map is the route alone: whatever tiles
       happen to be cached would be a patchwork, and the badge says there are
       none. */
    if (state.offline && map.hasLayer(tiles)) tiles.remove();
    else if (!state.offline && !map.hasLayer(tiles)) tiles.addTo(map);
    const r = state.result;
    const opts = (plan && plan.options) || [];
    const stamp = (r ? r.stamp : 'none') + '|' + state.selected + '|' + waypoints.length +
      '|' + opts.length + '|' + opts.reduce((n, o) => n + (o.ready ? 1 : 0), 0) + '|' + state.units + '|' + state.offline;
    if (mapStamp === stamp) return;
    mapStamp = stamp;
    if (layer) { layer.remove(); layer = null; }
    if (!r) return;

    const acc = token('--acc'), cool = token('--cool'), ok = token('--ok'), surf = token('--surf');
    layer = L.layerGroup().addTo(map);

    /* The ways not chosen, faint underneath and tappable -- pointing at the
       line you want is how anyone expects to choose a route. Not offline:
       none of them can be built without a connection. */
    if (plan && plan.options.length > 1 && !state.offline) {
      plan.options.forEach((opt, i) => {
        if (i === state.selected) return;
        const track = opt.points || opt.corridorPoints;
        if (!track || track.length < 2) return;
        const latlngs = track.map((p) => [p.lat, p.lon]);
        /* A fingertip needs a fat target; the drawn line stays thin. */
        const hit = L.polyline(latlngs, { renderer, color: cool, weight: 26, opacity: 0, interactive: true, bubblingMouseEvents: false }).addTo(layer);
        L.polyline(latlngs, { renderer, color: cool, weight: 3, opacity: .55, dashArray: '7 6', interactive: false }).addTo(layer);
        /* The fat target doesn't pass taps on to the map, so in add mode it
           adds the stop itself; a finger that lands near a dashed line
           still means "here". */
        hit.on('click', (e) => {
          L.DomEvent.stop(e);
          if (state.addMode) return insertStopAt(e.latlng);
          if (state.busy || state.offline) return;
          pickOption(i);
        });
      });
    }

    const line = L.polyline(r.points.map((p) => [p.lat, p.lon]), {
      renderer, color: acc, weight: 5.5, opacity: .95, lineJoin: 'round'
    }).addTo(layer);
    drawDirectionArrows(r.points, token('--ink'));

    pins = [];
    waypoints.forEach((w, i) => {
      const last = i === waypoints.length - 1;
      pins[i] = L.circleMarker([w.lat, w.lon], {
        renderer, radius: (i === 0 || last) ? 10 : 7.5, color: surf, weight: 3.5,
        fillColor: i === 0 ? ok : last ? acc : midPinColour(i, waypoints.length - 2),
        fillOpacity: 1, bubblingMouseEvents: false
      }).addTo(layer);
    });
    splitPoints.forEach((p) => {
      L.circleMarker([p.lat, p.lon], { renderer, radius: 7, color: acc, weight: 2.5, dashArray: '3 2', fillColor: surf, fillOpacity: 1, interactive: false }).addTo(layer);
    });
    hoverDot = L.circleMarker([r.points[0].lat, r.points[0].lon], {
      renderer, radius: 7.5, color: surf, weight: 2.5, fillColor: acc, fillOpacity: 1, interactive: false
    });

    bounds = line.getBounds();
    if (fitKey !== r.stamp) { needsFit = true; fitKey = r.stamp; }
    fitLater();
    requestAnimationFrame(fitLater);
  }

  /* Arrowheads, so the line says which way round it goes; see the site. */
  function drawDirectionArrows(points, colour) {
    if (!layer || points.length < 2) return;
    const dists = C.cumulativeDistances(points);
    const total = dists[dists.length - 1];
    if (!(total > 0)) return;
    const gap = Math.max(400, total / 6), s = 13;
    let next = gap / 2;
    for (let i = 1; i < points.length; i++) {
      if (dists[i] < next) continue;
      next += gap;
      const a = points[i - 1], b = points[i];
      const midLat = ((a.lat + b.lat) / 2) * Math.PI / 180;
      const dx = (b.lon - a.lon) * Math.cos(midLat), dy = b.lat - a.lat;
      if (!dx && !dy) continue;
      const angle = Math.atan2(dx, dy) * 180 / Math.PI;
      L.marker([b.lat, b.lon], {
        interactive: false, keyboard: false,
        icon: L.divIcon({
          className: '', iconSize: [s, s], iconAnchor: [s / 2, s / 2],
          html: '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" style="display:block;transform:rotate(' +
                angle.toFixed(1) + 'deg)"><path d="M12 4 L18.5 19 L12 15.4 L5.5 19 Z" fill="' + colour + '"/></svg>'
        })
      }).addTo(layer);
    }
  }

  /* Intermediate stops take a hue by their place in the route; see the site. */
  function midPinColour(index, midCount) {
    if (midCount <= 1) return token('--cool');
    return `hsl(${Math.round(190 + ((index - 1) / (midCount - 1)) * 110)}, 58%, 66%)`;
  }

  /* Dragging a pin, on any input: Leaflet's canvas renderer forwards only
     mouse events to its layers, so the hit test lives here. */
  function wirePinDragging() {
    const box = $('map');
    box.addEventListener('pointerdown', (ev) => {
      if (!map || state.addMode || state.busy || state.offline || !pins.length) return;
      const index = pinUnder(ev);
      if (index < 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      beginDrag(index, ev);
    });
  }
  function pinUnder(ev) {
    const box = $('map').getBoundingClientRect();
    const at = L.point(ev.clientX - box.left, ev.clientY - box.top);
    let best = -1, bestDist = Infinity;
    waypoints.forEach((w, i) => {
      if (typeof w.lat !== 'number') return;
      const d = map.latLngToContainerPoint([w.lat, w.lon]).distanceTo(at);
      const drawn = (i === 0 || i === waypoints.length - 1) ? 10 : 7.5;
      const slop = ev.pointerType === 'mouse' ? 4 : 18;
      if (d <= drawn + slop && d < bestDist) { bestDist = d; best = i; }
    });
    return best;
  }
  function beginDrag(index, ev) {
    const box = $('map'), marker = pins[index];
    map.dragging.disable();
    document.body.classList.add('grabbing');
    try { box.setPointerCapture(ev.pointerId); } catch (_) { }
    const toLatLng = (e) => {
      const b = box.getBoundingClientRect();
      return map.containerPointToLatLng([e.clientX - b.left, e.clientY - b.top]);
    };
    let moved = false;
    const move = (e) => {
      if (e.pointerId !== ev.pointerId) return;
      if (!moved && Math.hypot(e.clientX - ev.clientX, e.clientY - ev.clientY) <= 3) return;
      moved = true;
      if (marker) marker.setLatLng(toLatLng(e));
    };
    const end = (e) => {
      if (e.pointerId !== ev.pointerId) return;
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', end);
      box.removeEventListener('pointercancel', end);
      try { box.releasePointerCapture(ev.pointerId); } catch (_) { }
      document.body.classList.remove('grabbing');
      map.dragging.enable();
      /* A tap is not a drag: it must not spend a routing request going nowhere. */
      if (!moved || e.type === 'pointercancel') { if (marker) marker.setLatLng([waypoints[index].lat, waypoints[index].lon]); return; }
      const ll = toLatLng(e), w = waypoints[index];
      if (!w) return;
      w.lat = ll.lat; w.lon = ll.lng; w.kind = 'coords'; w.source = 'dragged'; w.display = null;
      w.label = `${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)}`;
      routeCurrent();
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
  }

  /** Insert a stop where the tap falls along the current line. */
  function insertStopAt(latlng) {
    const r = state.result;
    if (!r || state.busy) return;
    const pt = { lat: latlng.lat, lon: latlng.lng };
    let bestI = 0, bestD = Infinity;
    r.points.forEach((p, i) => { const d = C.haversine(p, pt); if (d < bestD) { bestD = d; bestI = i; } });
    const wpIndex = waypoints.map((w) => {
      let bi = 0, bd = Infinity;
      r.points.forEach((p, i) => { const d = C.haversine(p, w); if (d < bd) { bd = d; bi = i; } });
      return bi;
    });
    let insertAt = waypoints.length - 1;
    for (let i = 0; i < wpIndex.length; i++) { if (wpIndex[i] > bestI) { insertAt = i; break; } }
    waypoints.splice(insertAt, 0, { kind: 'coords', lat: pt.lat, lon: pt.lon, source: 'added', label: `${pt.lat.toFixed(4)}, ${pt.lon.toFixed(4)}` });
    state.addMode = false;
    routeCurrent();
  }

  /* ── elevation chart ──────────────────────────────────────────────────── */

  function drawChart() {
    const svg = $('chart');
    const r = state.result;
    if (!svg || state.view !== 'route') return;
    /* Real pixels, not a stretched viewBox -- see the site for why. */
    const W = Math.round(svg.clientWidth), H = Math.round(svg.clientHeight);
    if (W < 80 || H < 60) return;
    const stamp = (r ? r.stamp : 'empty') + '|' + W + 'x' + H + '|' + state.units;
    if (chartStamp === stamp) return;
    chartStamp = stamp;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    if (!r || !r.hasElevation) { svg.innerHTML = ''; series = null; return; }

    const PAD_L = 40, PAD_R = 12, PAD_T = 16, PAD_B = 24;
    const dists = C.cumulativeDistances(r.points);
    /* The profile the figures were read from, so the line agrees with them. */
    const eles = r.profile.map((p) => p.ele);
    const step = Math.max(1, Math.floor(r.points.length / 600));
    const xs = [], ys = [];
    for (let i = 0; i < r.points.length; i += step) if (Number.isFinite(eles[i])) { xs.push(dists[i]); ys.push(eles[i]); }
    const lastI = r.points.length - 1;
    if (Number.isFinite(eles[lastI]) && xs[xs.length - 1] !== dists[lastI]) { xs.push(dists[lastI]); ys.push(eles[lastI]); }
    if (xs.length < 2) { svg.innerHTML = ''; series = null; return; }

    const total = dists[lastI] || 1;
    const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    const span = Math.max(10, maxY - minY);
    const lo = minY - span * 0.14, hi = maxY + span * 0.14;
    const px = (d) => PAD_L + (d / total) * (W - PAD_L - PAD_R);
    const py = (e) => PAD_T + (1 - (e - lo) / (hi - lo)) * (H - PAD_T - PAD_B);

    let d = '';
    for (let i = 0; i < xs.length; i++) d += (i ? 'L' : 'M') + px(xs[i]).toFixed(1) + ' ' + py(ys[i]).toFixed(1);
    const baseY = H - PAD_B, right = W - PAD_R;
    const area = d + 'L' + px(xs[xs.length - 1]).toFixed(1) + ' ' + baseY + 'L' + px(xs[0]).toFixed(1) + ' ' + baseY + 'Z';

    const acc = token('--acc'), line = token('--line'), ink3 = token('--ink3'), surf = token('--surf');
    const gridS = `stroke:${line};stroke-width:1`;
    const axisS = `fill:${ink3};font:600 12px Inter, system-ui, sans-serif;letter-spacing:.06em`;
    const out = [];
    const un = C.unitsFor(state.units);
    for (const t of C.axisTicks(C.toElevation(lo, state.units), C.toElevation(hi, state.units), 3)) {
      const y = py(t * un.perElevation).toFixed(1);
      out.push(`<line style="${gridS};opacity:.75" x1="${PAD_L}" y1="${y}" x2="${right}" y2="${y}"/>`);
      out.push(`<text style="${axisS}" x="${PAD_L - 8}" y="${y}" dy="4" text-anchor="end">${Math.round(t)}</text>`);
    }
    const plotW = right - PAD_L;
    for (const t of C.axisTicks(0, C.toDistance(total, state.units), Math.max(3, Math.min(6, Math.round(plotW / 70))))) {
      if (t <= 0 || t * un.perDistance > total) continue;
      const xv = px(t * un.perDistance), x = xv.toFixed(1);
      out.push(`<line style="${gridS};opacity:.5" x1="${x}" y1="${PAD_T}" x2="${x}" y2="${baseY}"/>`);
      if (xv < right - 30) out.push(`<text style="${axisS}" x="${x}" y="${H - 6}" text-anchor="middle">${t}</text>`);
    }
    out.push(`<line style="${gridS}" x1="${PAD_L}" y1="${baseY}" x2="${right}" y2="${baseY}"/>`);
    out.push(`<path fill="${acc}" fill-opacity=".14" d="${area}"/>`);
    out.push(`<path style="fill:none;stroke:${acc};stroke-width:3;stroke-linejoin:round" d="${d}"/>`);
    out.push(`<text style="${axisS};opacity:.8" x="${PAD_L - 8}" y="${PAD_T - 4}" text-anchor="end">${un.elevation.toUpperCase()}</text>`);
    out.push(`<text style="${axisS};opacity:.8" x="${right}" y="${H - 6}" text-anchor="end">${un.distance.toUpperCase()}</text>`);
    out.push(`<line id="mtg-cursor" style="stroke:${ink3};stroke-width:1;stroke-dasharray:3 3;display:none" x1="0" y1="${PAD_T}" x2="0" y2="${baseY}"/>`);
    out.push(`<circle id="mtg-dot" style="fill:${acc};stroke:${surf};stroke-width:2;display:none" r="5.5" cx="0" cy="0"/>`);
    svg.innerHTML = out.join('');
    series = { xs, ys, total, px, py, W, PAD_L, PAD_R, points: r.points, dists };
  }

  /* Drag across the profile to read distance · elevation · slope, mirrored
     as a dot on the map. */
  function chartHover(evt) {
    const svg = $('chart');
    if (!series || !svg) return;
    const rect = svg.getBoundingClientRect();
    const rel = (evt.clientX - rect.left) / rect.width;
    const inner = (rel * series.W - series.PAD_L) / (series.W - series.PAD_L - series.PAD_R);
    const dist = Math.max(0, Math.min(1, inner)) * series.total;
    let i = 0;
    while (i < series.xs.length - 1 && series.xs[i + 1] < dist) i++;
    const x = series.px(series.xs[i]), y = series.py(series.ys[i]);
    const cur = svg.querySelector('#mtg-cursor'), dot = svg.querySelector('#mtg-dot');
    if (cur) { cur.setAttribute('x1', x.toFixed(1)); cur.setAttribute('x2', x.toFixed(1)); cur.style.display = ''; }
    if (dot) { dot.setAttribute('cx', x.toFixed(1)); dot.setAttribute('cy', y.toFixed(1)); dot.style.display = ''; }
    const a = Math.max(0, i - 1), b = Math.min(series.xs.length - 1, i + 1);
    const run = series.xs[b] - series.xs[a];
    const slope = run > 1 ? ((series.ys[b] - series.ys[a]) / run) * 100 : 0;
    const u = U();
    $('readout').textContent = C.toDistance(series.xs[i], state.units).toFixed(1) + ' ' + u.distance + ' · ' +
      Math.round(C.toElevation(series.ys[i], state.units)).toLocaleString('en-US') + ' ' + u.elevation + ' · ' +
      (slope >= 0 ? '+' : '') + slope.toFixed(1) + '%';
    if (map && hoverDot && layer) {
      let j = 0, bd = Infinity;
      for (let k = 0; k < series.dists.length; k += 3) {
        const dd = Math.abs(series.dists[k] - series.xs[i]);
        if (dd < bd) { bd = dd; j = k; }
      }
      const pt = series.points[j];
      if (pt) { hoverDot.setLatLng([pt.lat, pt.lon]); if (!map.hasLayer(hoverDot)) hoverDot.addTo(layer); }
    }
  }
  function chartLeave() {
    const svg = $('chart');
    const cur = svg.querySelector('#mtg-cursor'), dot = svg.querySelector('#mtg-dot');
    if (cur) cur.style.display = 'none';
    if (dot) dot.style.display = 'none';
    $('readout').textContent = '';
    if (map && hoverDot && map.hasLayer(hoverDot)) hoverDot.remove();
  }

  /* ── conversion flow ──────────────────────────────────────────────────── */

  function progress(msg, step) {
    state.progressMsg = msg;
    if (step) state.step = step;
    render();
  }
  function startClock() {
    const t0 = Date.now();
    clearInterval(clock);
    state.elapsed = '0s';
    clock = setInterval(() => {
      const s = Math.round((Date.now() - t0) / 1000);
      state.elapsed = s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
      $('elapsed').textContent = state.elapsed;
      $('rbusy-elapsed').textContent = state.elapsed;
    }, 1000);
  }
  function stopClock() { clearInterval(clock); }

  function engine() {
    E.key = state.key.trim();
    E.proxy = API + '/api/route';
    E.resolver = API + '/api/resolve';
    E.hostChoice = state.host;
    return E;
  }

  async function convert() {
    if (state.busy || state.offline) return;
    const input = firstUrl(state.link) || (state.link || '').trim();
    if (!input) return;
    $('link').blur();
    /* The route in memory belongs to the old link; the last one saved on the
       phone is still there for the card on this screen. */
    plan = null;
    Object.assign(state, { busy: true, error: null, step: 'read', progressMsg: 'Reading the link…', result: null, selected: 0 });
    render();
    startClock();
    try {
      const parsed = await engine().resolveInput(input, progress);
      waypoints = parsed.waypoints;
      notes = parsed.notes || [];
      state.travelMode = parsed.travelMode || null;
      if (parsed.expandedUrl) state.link = parsed.expandedUrl;
      await runRoute(true);
      state.detent = 'half';
      showView('route');
    } catch (err) { fail(err); }
  }

  /** Re-route the stops we already have (drag, insert, remove, reorder, profile). */
  async function routeCurrent() {
    if (!waypoints || waypoints.length < 2 || state.busy) return;
    if (state.offline) { toast('Rerouting needs a connection.'); return render(); }
    Object.assign(state, { busy: true, error: null, step: 'route', progressMsg: 'Rerouting…' });
    render();
    startClock();
    try { await runRoute(false); } catch (err) { fail(err); }
  }

  async function runRoute(withLabels) {
    altSearchDone = false; altSearching = false;
    const gen = ++routeGen;
    const eng = engine();
    const out = await eng.route(routingFor(), waypoints, progress, { explore: withLabels, fallback: orsFor(state.profile) });
    plan = out.plan;
    splitPoints = eng.legSplitPoints.concat(out.chosen.splitPoints || []);
    splitNotes = eng.legSplitNotes.concat(out.chosen.note ? [out.chosen.note] : []);
    progress('Measuring climbs and writing the GPX…', 'gpx');
    commit(out.chosen, 0);
    stopClock();
    Object.assign(state, { busy: false, step: null, selected: 0 });
    render();
    saveLast();
    if (withLabels && plan.options.length > 1) eng.labelOptions(plan, (p) => { if (plan === p) render(); });
    /* Google shows the other ways round unasked, so this does too -- after the
       route is on screen, never in front of it. */
    /* A car route brings its own ways round; asking the car again finds nothing new. */
    if (plan.kind === 'direct' && plan.options.length === 1 && routingFor() !== 'driving-car') findWaysRound(gen);
  }

  async function findWaysRound(gen) {
    if (altSearching || !plan || !state.result || state.offline) return;
    altSearching = true;
    render();
    let found = null;
    try { found = await engine().otherWaysRound(routingFor(), plan.waypoints, state.result.points, () => { }); }
    catch (_) { found = null; }
    if (gen !== routeGen) return;
    altSearching = false;
    if (found) {
      altSearchDone = true;
      found.forEach((c, i) => plan.options.push({
        id: plan.options.length + i, label: null, ready: false,
        via: c.via, corridorPoints: c.corridorPoints, corridorDistance: c.corridorDistance,
        distance: c.corridorDistance, ascent: null, descent: null, points: null
      }));
    }
    render();
  }

  async function pickOption(index) {
    if (!plan || state.busy || index === state.selected) return;
    const opt = plan.options[index];
    if (!opt.ready) {
      if (state.offline) { toast('Building another way round needs a connection.'); return; }
      Object.assign(state, { busy: true, error: null, step: 'route', progressMsg: 'Building this way round…' });
      render();
      startClock();
      try {
        const eng = engine();
        await (opt.via
          ? eng.realiseVia(routingFor(), plan, opt, (m) => progress(m, 'route'))
          : eng.realiseCorridor(routingFor(), plan, opt, (m) => progress(m, 'route')));
        splitPoints = eng.legSplitPoints.concat(opt.splitPoints || []);
        splitNotes = eng.legSplitNotes.concat(opt.note ? [opt.note] : []);
      } catch (err) { return fail(err); }
      stopClock();
      Object.assign(state, { busy: false, step: null });
    } else {
      splitPoints = (opt.splitPoints || []).slice();
      splitNotes = opt.note ? [opt.note] : [];
    }
    commit(opt, index);
    state.selected = index;
    render();
    saveLast();
  }

  async function stretchTo(targetM) {
    if (!plan || !state.result || state.busy || state.offline) return;
    const direct = plan.options[0] && plan.options[0].distance;
    Object.assign(state, { busy: true, error: null, step: 'route', progressMsg: `Looking for a ${targetLabel(targetM)} way round…` });
    render();
    startClock();
    let found = null;
    try { found = await engine().stretchToDistance(routingFor(), plan, targetM, direct, (m) => progress(m, 'route')); }
    catch (err) { stopClock(); return fail(err); }
    stopClock();
    Object.assign(state, { busy: false, step: null });
    if (!found) {
      state.error = {
        kind: 'Routing', message: `No ${targetLabel(targetM)} way round turned up between these two stops.`,
        fix: 'The roads either side may not go far enough out. Try a different distance, or add a stop where you would like it to go.'
      };
      return render();
    }
    const b = found.built, off = Math.abs(b.distance - targetM) / targetM;
    const opt = {
      id: plan.options.length, ready: true, label: targetLabel(targetM),
      points: b.points, distance: b.distance, duration: b.duration, ascent: b.ascent, descent: b.descent,
      splitPoints: [found.via],
      note: `The same two stops with a detour through one point, chosen to bring the ride out near ${targetLabel(targetM)} — ` +
        `it came back ${fmtDist(b.distance)} ${U().distance}, ${off < 0.01 ? 'as close as the roads allow' : Math.round(off * 100) + '% off'}. ` +
        'Nobody chose that point but the search, so drag the hollow marker if it goes somewhere you would rather it did not.'
    };
    plan.options.push(opt);
    splitPoints = [found.via];
    splitNotes = [opt.note];
    commit(opt, opt.id);
    state.selected = opt.id;
    render();
    saveLast();
  }

  /** Turn a routed option into everything the interface shows, GPX included. */
  function commit(option, index) {
    const points = C.dedupePoints(option.points);
    /* Figures from the smoothed profile; the GPX from the raw one. */
    const profile = C.smoothElevation(points);
    const name = C.routeName(waypoints);
    const stats = C.elevationStats(profile);
    const ascent = option.ascent != null ? Math.round(option.ascent) : stats.ascent;
    const descent = option.descent != null ? Math.round(option.descent) : stats.descent;
    const distance = option.distance || C.cumulativeDistances(points).pop();
    const grades = C.gradeStats(profile);
    const activity = paceFor(state.profile);
    const gpx = C.buildGpx({
      points, name, profile: activity,
      desc: `Converted from a Google Maps directions link · profile ${activity} · ` + waypoints.map((w) => w.label).join(' → ')
    });
    const check = C.validateGpx(gpx);
    let filename = C.buildFilename(waypoints, activity);
    if (plan && plan.options.length > 1 && index > 0) filename = filename.replace(/\.gpx$/, `-${index + 1}.gpx`);
    state.result = {
      stamp: String(Date.now()) + ':' + index,
      points, profile, name, distance,
      duration: C.estimateDuration(profile, activity),
      ascent, descent, stats, grades,
      gpx, filename, valid: check.ok, errors: check.errors,
      hasElevation: points.some((p) => Number.isFinite(p.ele))
    };
  }

  function fail(err) {
    stopClock();
    const known = err && (err.name === 'ParseError' || err.name === 'RoutingError');
    Object.assign(state, {
      busy: false, step: null,
      error: {
        kind: err && err.name === 'ParseError' ? 'That link' : 'Routing',
        message: (err && err.message) || 'Something went wrong.',
        fix: known ? (err.fix || '') : 'Check your connection and try again.',
        detail: (err && err.detail) || (known ? null : String(err && err.stack || err))
      }
    });
    render();
  }

  /* ── the file ─────────────────────────────────────────────────────────── */

  /*
   * Send hands the .gpx to the system share sheet, the way the file is meant
   * to leave: Garmin Connect on Android, Komoot, Wahoo, Files, AirDrop. Only
   * the file and a title -- adding a link or text makes some apps take that and
   * drop the attachment. (Garmin Connect on iOS does not accept shared GPX at
   * all; Garmin's own support says so. That is theirs to change.)
   */
  async function sendGpx() {
    const r = state.result;
    if (!r) return;
    if (!NATIVE || !Filesystem || !Share) return downloadInBrowser(r);
    try {
      const file = await Filesystem.writeFile({ path: r.filename, data: r.gpx, directory: Directory.Cache, encoding: Encoding.UTF8 });
      await Share.share({ title: r.name, files: [file.uri] });
    } catch (err) {
      /* Dismissing the sheet is a decision, not a failure. */
      if (/cancel/i.test(String(err && (err.message || err)))) return;
      toast('Could not open the share sheet.');
    }
  }

  /* ↓ keeps a copy: Files › On My iPhone › Map to GPX on iOS, Documents on
     Android. */
  async function saveGpx() {
    const r = state.result;
    if (!r) return;
    if (!NATIVE || !Filesystem) return downloadInBrowser(r);
    try {
      await Filesystem.writeFile({ path: r.filename, data: r.gpx, directory: Directory.Documents, encoding: Encoding.UTF8, recursive: true });
      toast(PLATFORM === 'ios' ? 'Saved to Files › On My iPhone › Map to GPX' : 'Saved to Documents › ' + r.filename);
    } catch (err) {
      toast('Could not save the file: ' + String(err && err.message || err));
    }
  }

  function downloadInBrowser(r) {
    const url = URL.createObjectURL(new Blob([r.gpx], { type: 'application/gpx+xml' }));
    const a = document.createElement('a');
    a.href = url; a.download = r.filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function copyGpx() {
    const r = state.result;
    if (!r) return;
    try {
      if (Clipboard) await Clipboard.write({ string: r.gpx });
      else await navigator.clipboard.writeText(r.gpx);
      state.copyLabel = 'Copied';
    } catch (_) { state.copyLabel = 'Copy blocked'; }
    render();
    setTimeout(() => { state.copyLabel = 'Copy GPX'; render(); }, 1800);
  }

  async function shareLink() {
    if (!waypoints.length) return;
    const url = shareUrl();
    if (NATIVE && Share) {
      try { await Share.share({ title: state.result ? state.result.name : 'Map to GPX', url }); } catch (_) { }
      return;
    }
    try { if (Clipboard) await Clipboard.write({ string: url }); else await navigator.clipboard.writeText(url); toast('Link copied'); }
    catch (_) { toast('Copy blocked'); }
  }

  async function pasteLink() {
    let text = '';
    try {
      if (Clipboard) text = (await Clipboard.read()).value || '';
      else text = await navigator.clipboard.readText();
    } catch (_) { text = ''; }
    const url = firstUrl(text) || text.trim();
    if (!url) { toast('Nothing to paste — copy the link from Google Maps first.'); return; }
    state.link = url;
    state.fromShare = false;
    $('link').value = url;
    render();
  }

  /* ── the last route ───────────────────────────────────────────────────── */

  async function openLast() {
    /* Already in memory: just go back to it. */
    if (state.result && plan) { state.detent = 'half'; return showView('route'); }
    const rec = await readLast();
    if (!rec) { state.last = null; return render(); }
    state.link = rec.link || '';
    state.profile = PROFILES.some((p) => p.id === rec.profile) ? rec.profile : 'cycling-road';
    state.travelMode = typeof rec.travelMode === 'string' ? rec.travelMode : null;
    /* Each stop keeps its kind, so a stop found by name is still named by it:
       the title and the file name are read from that. */
    waypoints = rec.waypoints.map((w) => ({ kind: w.kind || 'coords', label: w.label, lat: w.lat, lon: w.lon, source: w.source || 'saved' }));
    notes = []; splitPoints = []; splitNotes = [];
    const opt = {
      id: 0, ready: true, label: rec.option.label,
      points: rec.option.points.map((t) => ({ lat: t[0], lon: t[1], ele: t[2] == null ? undefined : t[2] })),
      distance: rec.option.distance, duration: rec.option.duration,
      ascent: rec.option.ascent, descent: rec.option.descent
    };
    /* Restored, not routed: no alternatives were asked for, and none are
       until someone asks -- opening a saved route spends no routing. */
    plan = { kind: waypoints.length === 2 ? 'direct' : 'single', waypoints, options: [opt], restored: true };
    altSearchDone = false; altSearching = false; routeGen++;
    commit(opt, 0);
    state.selected = 0;
    state.detent = 'half';
    showView('route');
  }

  /* ── settings ─────────────────────────────────────────────────────────── */

  /* No focus on the key field: on a phone that raises the keyboard over the
     note that explains the key, before anyone has read it. */
  function openSettings() { state.settingsOpen = true; render(); }
  function closeSettings() {
    state.settingsOpen = false;
    render();
  }

  /* ── render ───────────────────────────────────────────────────────────── */

  function buildStatic() {
    for (const id of ['profiles-home', 'profiles-route']) {
      const box = $(id);
      PROFILES.forEach((p) => {
        const b = el('button');
        b.setAttribute('role', 'radio');
        b.dataset.id = p.id;
        const txt = el('span');
        txt.append(el('b', null, p.name), el('i', null, p.sub));
        b.append(icon(p.icon), txt);
        b.addEventListener('click', () => {
          if (state.profile === p.id) return;
          const onRoute = !!(state.result && id === 'profiles-route');
          /* A route copied from a car or motorcycle link runs on the same roads
             for a ride or a run: only the pace and the file change, so nothing
             is rerouted -- and it works offline. */
          const sameRoads = onRoute && !!plan && routingFor(p.id) === routingFor();
          if (onRoute && !sameRoads && state.offline) return toast('Changing activity reroutes, which needs a connection.');
          state.profile = p.id;
          prefSet('profile', p.id);
          if (sameRoads) { commit(plan.options[state.selected] || plan.options[0], state.selected); saveLast(); }
          render();
          if (onRoute && !sameRoads) routeCurrent();
        });
        box.appendChild(b);
      });
    }
    const sw = $('steps');
    STEPS.forEach((s) => {
      const row = el('div', 'step');
      row.dataset.key = s.key;
      const mid = el('div');
      mid.append(el('div', 'label', s.label), el('div', 'msg'));
      row.append(icon(s.icon), mid);
      sw.appendChild(row);
    });
    const hw = $('hosts');
    HOSTS.forEach((h) => {
      const b = el('button');
      b.setAttribute('role', 'radio');
      b.dataset.id = h.id;
      b.append(icon(ICON.radioOff), document.createTextNode(h.label));
      b.addEventListener('click', () => { state.host = h.id; prefSet('host', h.id); render(); });
      hw.appendChild(b);
    });
    if (SUPPORT_IN_APP) {
      const url = paysFromIndonesia() ? SUPPORT_URL_ID : SUPPORT_URL;
      for (const id of ['support-home', 'support-route']) { $(id).href = url; $(id).hidden = false; }
      $('tip-a').href = SUPPORT_URL; $('tip-b').href = SUPPORT_URL_ID; $('tipjar').hidden = false;
    }
  }

  function paysFromIndonesia() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      if (tz) return /^Asia\/(Jakarta|Pontianak|Makassar|Jayapura)$/.test(tz);
    } catch (_) { }
    return /^id\b/i.test(navigator.language || '');
  }

  function render() {
    const s = state, r = s.result;
    $('v-home').hidden = s.view !== 'home';
    $('v-route').hidden = s.view !== 'route';
    for (const id of ['profiles-home', 'profiles-route']) {
      for (const b of $(id).children) b.setAttribute('aria-checked', String(b.dataset.id === s.profile));
    }
    if (s.view === 'home') renderHome(); else renderRoute();
    renderSettings();
  }

  function renderHome() {
    const s = state;
    $('off-home').hidden = !s.offline;
    const field = $('link');
    if (document.activeElement !== field && field.value !== s.link) field.value = s.link;
    $('btn-clear').hidden = !s.link;
    $('btn-paste').hidden = !!s.link;
    const hint = $('link-hint');
    hint.textContent = s.fromShare && s.link ? 'Shared from Google Maps' : 'Long or maps.app.goo.gl short links';
    hint.classList.toggle('shared', !!(s.fromShare && s.link));

    const cta = $('btn-convert');
    cta.classList.toggle('off', s.offline);
    cta.disabled = s.busy || s.offline || !s.link.trim();
    $('convert-label').textContent = s.offline ? 'No connection' : s.busy ? 'Working…' : 'Convert to GPX';
    setIcon('convert-icon', s.offline ? 'b-link-break' : 'b-arrow-right');

    $('card-busy').hidden = !s.busy;
    if (s.busy) {
      $('elapsed').textContent = s.elapsed;
      const order = STEPS.findIndex((x) => x.key === s.step);
      for (const row of $('steps').children) {
        const mine = STEPS.findIndex((x) => x.key === row.dataset.key);
        const st = order > mine ? 'done' : order === mine ? 'active' : 'todo';
        row.dataset.state = st;
        const u = row.querySelector('use');
        if (u) u.setAttribute('href', '#' + (st === 'done' ? ICON.stepDone : STEPS[mine].icon));
        const msg = row.querySelector('.msg');
        msg.textContent = st === 'active' ? s.progressMsg : '';
        msg.hidden = st !== 'active';
      }
    }

    renderError($('card-error'), 'err');
    $('card-last').hidden = !s.last || s.busy || !!s.error;
    if (s.last) {
      $('last-name').textContent = s.last.name;
      $('last-facts').textContent = fmtDist(s.last.distance) + ' ' + U().distance + ' · ↑ ' +
        (s.last.ascent == null ? '—' : fmtEle(s.last.ascent) + ' ' + U().elevation) + ' · ' +
        ((PROFILES.find((p) => p.id === s.last.profile) || PROFILES[0]).name.toLowerCase());
    }
    $('howto').hidden = s.busy || !!s.error;
  }

  /* One error card on home, one over the map in the route view. Every message
     a key would fix names one, so the word is the signal for the key button. */
  function renderError(box, prefix) {
    const s = state;
    const where = s.view === 'home' ? 'err' : 'rerr';
    box.hidden = !s.error || prefix !== where;
    if (box.hidden) return;
    const keyFixes = /\bkey\b/i.test((s.error.fix || '') + ' ' + (s.error.message || ''));
    if (prefix === 'err') {
      $('err-kind').textContent = s.error.kind + ' problem';
      $('err-msg').textContent = s.error.message;
      const fixes = $('err-fixes');
      fixes.textContent = '';
      String(s.error.fix || '').split(/(?<=[.;])\s+/).map((t) => t.trim()).filter(Boolean).slice(0, 4).forEach((t) => {
        const row = el('div', 'fix');
        row.append(icon('b-arrow-elbow-down-right'), el('span', null, t));
        fixes.appendChild(row);
      });
      $('btn-err-key').hidden = !keyFixes;
      $('err-tech').hidden = !s.error.detail;
      $('err-detail').textContent = s.error.detail || '';
    } else {
      $('rerr-msg').textContent = s.error.message;
      $('rerr-fix').textContent = s.error.fix || '';
      $('btn-rerr-key').hidden = !keyFixes;
    }
  }

  function renderRoute() {
    const s = state, r = s.result;
    if (!r) return;
    const sheet = $('sheet');
    sheet.dataset.detent = s.detent;
    const h = s.detent === 'full' ? '100%' : sheetPx(s.detent) + 'px';
    $('stage').style.setProperty('--sheet', h);

    $('off-route').hidden = !s.offline;
    $('attr').hidden = s.offline;
    $('btn-add').hidden = s.offline;
    const rerouting = s.busy && s.progressMsg === 'Rerouting…';
    $('btn-add').disabled = s.busy;
    $('btn-add').setAttribute('aria-pressed', String(s.addMode));
    $('add-label').textContent = rerouting ? 'Rerouting…' : s.addMode ? 'Tap the map…' : 'Add a stop';
    $('maphint').hidden = !(s.addMode && !s.offline && s.detent !== 'full');
    $('rbusy').hidden = !s.busy;
    if (s.busy) { $('rbusy-msg').textContent = s.progressMsg || 'Working…'; $('rbusy-elapsed').textContent = s.elapsed; }
    renderError($('rerr'), 'rerr');

    $('r-name').textContent = r.name;
    const activity = (PROFILES.find((p) => p.id === s.profile) || {}).name || s.profile;
    $('r-sub').textContent = r.points.length.toLocaleString('en-US') + ' pts · ' + waypoints.length + ' stops · ' + activity.toLowerCase();
    $('units').querySelectorAll('.unit').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.units === s.units)));
    $('r-dist').textContent = fmtDist(r.distance);
    const withUnit = (id, text, unit) => { const n = $(id); n.textContent = text; if (unit) n.appendChild(el('u', null, unit)); };
    withUnit('r-asc', r.ascent == null ? '—' : fmtEle(r.ascent), U().elevation);
    withUnit('r-desc', r.descent == null ? '—' : fmtEle(r.descent), U().elevation);
    $('r-time').textContent = r.duration ? fmtDuration(r.duration) : '—';
    withUnit('r-peak', r.stats.max == null ? '—' : fmtEle(r.stats.max) + ' / ' + fmtEle(r.stats.min), U().elevation);
    $('r-grade').textContent = r.stats.max == null ? '—'
      : '+' + r.grades.maxClimb.toFixed(1) + ' / ' + r.grades.maxDescent.toFixed(1).replace('-', '−');
    $('nochart').hidden = r.hasElevation;
    $('chart').style.display = r.hasElevation ? '' : 'none';

    const locked = s.offline || s.busy;
    /* Offline, switching activity is locked only where it would reroute. */
    $('profiles-route').classList.toggle('locked', s.offline && !C.plannedForVehicle(s.travelMode));

    /* ways round */
    const opts = (plan && plan.options) || [];
    const many = opts.length > 1;
    $('opt-count').textContent = many ? opts.length + ' ways round' : 'One way round';
    $('opt-note').textContent = s.offline ? 'Other ways round need a connection. The ticked one is the route saved on this phone.'
      : many ? (plan.kind === 'corridor' ? 'Ways round from OpenRouteService — the ride is built along the one you pick' : 'Alternatives from OpenRouteService, not from Google')
      : altSearching ? 'Looking for other ways round on the road network…'
      : plan.restored && plan.kind === 'direct' && !altSearchDone ? 'This is the route saved on this phone. Other ways round are looked up again when you ask.'
      : plan.kind === 'single' ? 'Alternatives only come back for a plain two-stop route. Remove the stops in between to see other ways round.'
      : altSearchDone ? 'Nothing else to offer: OpenRouteService suggested no alternative, and the road network has no other way round that is meaningfully different from this one.'
      : 'OpenRouteService offered no meaningfully different alternative here — it only suggests one when the detour shares less than about 60% of this route.';
    $('btn-find-alt').hidden = many || plan.kind !== 'direct' || altSearchDone || altSearching || s.offline ||
      routingFor() === 'driving-car';
    $('btn-find-alt').disabled = s.busy;
    const box = $('opts');
    box.textContent = '';
    box.classList.toggle('locked', s.offline);
    opts.forEach((o, i) => {
      const on = i === s.selected;
      const b = el('button', 'opt');
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(on));
      b.disabled = locked || !many;
      const bits = [fmtDist(o.distance) + ' ' + U().distance];
      if (o.ascent != null) bits.push('↑ ' + fmtEle(Math.round(o.ascent)) + ' ' + U().elevation);
      if (!o.ready) bits.push('road distance — tap to build it');
      const mid = el('span', 'mid');
      mid.append(el('span', 'lab', o.label || (many ? (i === 0 ? 'Fastest' : 'Option ' + (i + 1)) : 'This route')), el('span', 'facts', bits.join(' · ')));
      b.append(mid, icon(on ? ICON.tagOn : o.ready ? ICON.tagGo : ICON.tagNotBuilt));
      if (many) b.addEventListener('click', () => pickOption(i));
      box.appendChild(b);
    });

    /* make it longer */
    const direct = opts.length ? opts[0].distance : 0;
    const targets = (!s.offline && plan.kind === 'direct' && plan.waypoints && plan.waypoints.length === 2)
      ? C.distanceTargets(direct, s.units) : [];
    $('card-longer').hidden = !targets.length;
    const tb = $('targets');
    tb.textContent = '';
    targets.forEach((m) => {
      const b = el('button', null, targetLabel(m));
      b.disabled = locked || opts.some((o) => o.label === targetLabel(m));
      b.addEventListener('click', () => stretchTo(m));
      tb.appendChild(b);
    });

    /* stops */
    const sw = $('stops');
    sw.textContent = '';
    waypoints.forEach((w, i) => {
      const last = i === waypoints.length - 1;
      const row = el('div', 'stop' + (i === 0 ? ' start' : last ? ' end' : ''));
      const origin = w.source === 'nominatim' ? '  ·  geocoded name' : w.source === 'dragged' ? '  ·  moved by you'
        : w.source === 'added' ? '  ·  added by you' : w.source === 'shared' ? '  ·  from a shared link'
        : w.source === 'google-via' ? '  ·  dragged in Google Maps' : '';
      const mid = el('span', 'mid');
      mid.append(el('span', 'lab', w.label || 'Stop'),
        el('span', 'sub', (typeof w.lat === 'number' ? w.lat.toFixed(4) + ', ' + w.lon.toFixed(4) : '—') + origin));
      const glyph = icon(i === 0 ? ICON.start : last ? ICON.finish : ICON.mid);
      if (!(i === 0 || last)) glyph.style.color = midPinColour(i, waypoints.length - 2);
      row.append(glyph, mid);
      if (!(i === 0 || last)) {
        const x = el('button', 'x');
        x.appendChild(icon('b-x'));
        x.setAttribute('aria-label', 'Remove this stop');
        x.disabled = locked;
        x.addEventListener('click', () => { waypoints.splice(i, 1); routeCurrent(); });
        row.appendChild(x);
      }
      if (waypoints.length > 1 && !s.offline) {
        const grip = el('button', 'grip');
        grip.appendChild(icon('b-dots-six-vertical'));
        grip.setAttribute('aria-label', `Reorder ${w.label || 'stop'}, position ${i + 1} of ${waypoints.length}`);
        grip.addEventListener('pointerdown', (ev) => beginReorder(i, row, ev));
        row.appendChild(grip);
      }
      sw.appendChild(row);
    });

    /* notes */
    const all = notes.concat(splitNotes);
    const geocoded = waypoints.filter((w) => w.source === 'nominatim');
    if (geocoded.length) {
      all.push('Found by name on OpenStreetMap: ' + geocoded.map((w) => '“' + w.label + '”').join(', ') +
        ' — a looked-up name is a guess, so check those pins before you ride.');
    }
    if (!r.valid) all.push('GPX validation warning: ' + r.errors.join('; '));
    $('card-notes').hidden = !all.length;
    if (all.length) {
      $('notes-label').textContent = all.length === 1 ? 'One thing worth checking' : all.length + ' things worth checking';
      const nb = $('notes');
      nb.textContent = '';
      all.forEach((t) => nb.appendChild(el('div', null, t)));
    }

    /* the file */
    $('gpx-icon').closest('.gpxhead').classList.toggle('bad', !r.valid);
    setIcon('gpx-icon', r.valid ? ICON.valid : ICON.invalid);
    $('gpx-badge').textContent = r.valid ? 'GPX 1.1 · validated' : 'GPX written with warnings';
    $('gpx-file').textContent = r.filename;
    $('copy-label').textContent = s.copyLabel;
    setIcon('copy-icon', /copied/i.test(s.copyLabel) ? ICON.copied : ICON.copy);
    $('saved-note').hidden = !s.last;

    syncMap();
    drawChart();
  }

  function renderSettings() {
    const s = state;
    $('settings').hidden = !s.settingsOpen;
    if (!s.settingsOpen) return;
    if (document.activeElement !== $('key') && $('key').value !== s.key) $('key').value = s.key;
    for (const b of $('hosts').children) {
      const on = b.dataset.id === s.host;
      b.setAttribute('aria-checked', String(on));
      const u = b.querySelector('use');
      if (u) u.setAttribute('href', '#' + (on ? ICON.radioOn : ICON.radioOff));
    }
  }

  /* Reordering the stops by a row's grip; the order is the route, so a
     reorder is a reroute. */
  function beginReorder(index, row, ev) {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    if (state.busy || state.offline) return;
    const box = $('stops'), rows = Array.from(box.children), step = row.offsetHeight;
    if (!step || rows.length < 2) return;
    ev.preventDefault();
    ev.stopPropagation();
    try { ev.target.setPointerCapture(ev.pointerId); } catch (_) { }
    const startY = ev.clientY;
    let target = index;
    document.body.classList.add('grabbing');
    box.classList.add('reordering');
    row.classList.add('lifted');
    const move = (e) => {
      if (e.pointerId !== ev.pointerId) return;
      const dy = e.clientY - startY;
      row.style.transform = `translateY(${dy}px)`;
      const next = Math.max(0, Math.min(rows.length - 1, index + Math.round(dy / step)));
      if (next === target) return;
      target = next;
      rows.forEach((r, j) => {
        if (j === index) return;
        let shift = 0;
        if (target > index && j > index && j <= target) shift = -step;
        else if (target < index && j < index && j >= target) shift = step;
        r.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const end = (e) => {
      if (e.pointerId !== ev.pointerId) return;
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerup', end);
      box.removeEventListener('pointercancel', end);
      document.body.classList.remove('grabbing');
      box.classList.remove('reordering');
      row.classList.remove('lifted');
      rows.forEach((r) => { r.style.transform = ''; });
      if (e.type === 'pointercancel' || target === index) return;
      waypoints.splice(target, 0, waypoints.splice(index, 1)[0]);
      routeCurrent();
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
  }

  /* ── wiring ───────────────────────────────────────────────────────────── */

  buildStatic();
  wireSheetDrag();

  $('link').addEventListener('input', (e) => { state.link = e.target.value; state.fromShare = false; render(); });
  $('link').addEventListener('keydown', (e) => { if (e.key === 'Enter') convert(); });
  $('btn-example').addEventListener('click', () => { state.link = EXAMPLE; state.fromShare = false; $('link').value = EXAMPLE; render(); });
  $('btn-clear').addEventListener('click', () => { state.link = ''; state.fromShare = false; $('link').value = ''; render(); });
  $('btn-paste').addEventListener('click', pasteLink);
  $('btn-convert').addEventListener('click', convert);
  $('btn-last').addEventListener('click', openLast);
  $('btn-err-key').addEventListener('click', openSettings);
  $('btn-rerr-key').addEventListener('click', openSettings);
  $('btn-rerr-close').addEventListener('click', () => { state.error = null; render(); });

  $('btn-back').addEventListener('click', goHome);
  $('units').addEventListener('click', (e) => {
    const b = e.target.closest('.unit');
    if (!b || state.units === b.dataset.units) return;
    state.units = b.dataset.units;
    prefSet('units', state.units);
    render();
  });
  $('btn-add').addEventListener('click', () => {
    state.addMode = !state.addMode;
    if (state.addMode && state.detent !== 'peek') setDetent('peek');
    render();
  });
  $('btn-fit').addEventListener('click', () => { needsFit = true; fitLater(); });
  $('btn-find-alt').addEventListener('click', () => { if (!state.busy) findWaysRound(routeGen); });
  $('btn-copy').addEventListener('click', copyGpx);
  $('btn-share-link').addEventListener('click', shareLink);
  $('btn-send').addEventListener('click', sendGpx);
  $('btn-save').addEventListener('click', saveGpx);

  const chart = $('chart');
  chart.addEventListener('pointermove', chartHover);
  chart.addEventListener('pointerdown', chartHover);
  chart.addEventListener('pointerleave', chartLeave);
  chart.addEventListener('pointercancel', chartLeave);

  $('btn-close-settings').addEventListener('click', closeSettings);
  $('scrim').addEventListener('click', closeSettings);
  $('key').addEventListener('change', (e) => { state.key = e.target.value.trim(); saveKey(state.key); });
  $('key').addEventListener('input', (e) => { state.key = e.target.value.trim(); });

  function goHome() {
    state.addMode = false;
    if (state.error && state.view === 'route') state.error = null;
    showView('home');
  }

  /* Android's back does what ← does: settings first, then add-mode, then the
     full sheet, then the route, and only then out of the app. */
  if (App) {
    App.addListener('backButton', () => {
      if (state.settingsOpen) return closeSettings();
      if (state.view === 'route') {
        if (state.addMode) { state.addMode = false; return render(); }
        if (state.detent === 'full') return setDetent('half');
        return goHome();
      }
      App.exitApp();
    });
  }

  /* Shared in from Google Maps: the link is filled in and conversion starts
     by itself. */
  function receiveShared(text) {
    const url = firstUrl(text);
    /* Android offers a .gpx to every app that takes shares, this one included
       -- the file has no type it knows -- so a file can arrive here. */
    if (!url) return toast('Map to GPX reads Google Maps links: share the directions from Google Maps.');
    state.link = url;
    state.fromShare = true;
    state.error = null;
    $('link').value = url;
    if (state.view !== 'home') state.view = 'home';
    render();
    convert();
  }
  if (ShareTarget) {
    ShareTarget.addListener('shareReceived', (e) => {
      const texts = [].concat(e && e.texts || [], e && e.title || []);
      receiveShared(texts.find((t) => firstUrl(t)) || '');
    });
  }

  if (Network) {
    Network.addListener('networkStatusChange', (st) => { state.offline = !st.connected; render(); });
  }

  /* Back from another app -- the share sheet, say -- with the route nowhere on
     the map: a pan still in flight when the page was paused can be left
     frozen far away. Stop it and bring the route back. */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !map || !bounds || state.view !== 'route') return;
    map.stop();
    if (!map.getBounds().intersects(bounds)) { needsFit = true; fitLater(); }
  });

  /* ── boot ─────────────────────────────────────────────────────────────── */

  (async function boot() {
    if (NATIVE && StatusBar) { try { await StatusBar.setStyle({ style: StatusStyle.Dark || 'DARK' }); } catch (_) { } }
    const [units, profile, host, key, net, last] = await Promise.all([
      prefGet('units'), prefGet('profile'), prefGet('host'), loadKey(),
      Network ? Network.getStatus().catch(() => null) : null, readLast()
    ]);
    /* Kilometres until someone chooses otherwise, as on the site. */
    if (units === 'imperial' || units === 'metric') state.units = units;
    if (PROFILES.some((p) => p.id === profile)) state.profile = profile;
    if (HOSTS.some((h) => h.id === host)) state.host = host;
    state.key = key || '';
    if (net) state.offline = !net.connected;
    if (last) state.last = summarise(last);
    render();
  })();
})();
