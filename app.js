/* Trajet — appli de trajet temps réel en Suisse.
   Données : transport.opendata.ch (horaires, retards, arrêts proches),
   api3.geo.admin.ch (adresses), TomTom (trafic voiture, optionnel),
   fond de carte swisstopo. Aucune donnée personnelle ne quitte le téléphone
   hormis les requêtes nécessaires à ces services. */
(function () {
  'use strict';

  var API = 'https://transport.opendata.ch/v1';
  var GEO = 'https://api3.geo.admin.ch/rest/services/ech/SearchServer';
  var TILE = 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg';

  // ---------------------------------------------------------------- stockage
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('trajet.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('trajet.' + k, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } }
  };

  var DEFAULT_SETTINGS = { walkMax: 10, walkSpeed: 80, minTransfer: 3, parking: 8, tomtomKey: '' };
  var GPS_PLACE = { kind: 'gps', label: 'Ma position' };
  var DEFAULT_FAVS = [
    { id: 'f1', name: 'Vers Fourmi', from: GPS_PLACE, to: { kind: 'query', label: 'Lausanne, Fourmi' } },
    { id: 'f2', name: 'Retour Gland', from: GPS_PLACE, to: { kind: 'query', label: 'Gland, Communet' } }
  ];

  var state = {
    settings: Object.assign({}, DEFAULT_SETTINGS, store.get('settings', {})),
    favs: store.get('favs', DEFAULT_FAVS),
    recents: store.get('recents', []),
    from: store.get('from', GPS_PLACE),
    to: store.get('to', null),
    gps: null, gpsError: null, gpsLabel: null,
    result: null, loading: false, error: null,
    selectedKey: null, showDetail: false,
    car: null,
    demo: false,
    tab: 'trip',
    departAt: null,
    when: { mode: 'late', result: null, picked: null }
  };

  // ---------------------------------------------------------------- outils
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hm(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function ymd(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function mins(ms) { return Math.round(ms / 60000); }
  function ago(ms) { var s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 5 ? "à l'instant" : s < 60 ? s + ' s' : Math.round(s / 60) + ' min'; }
  function dist(a, b) {
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function walkMin(meters) { return meters < 40 ? 0 : Math.max(1, Math.ceil(meters * 1.3 / state.settings.walkSpeed)); }
  function isoTs(s) { return s ? Date.parse(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN; }
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, 3200);
  }
  function saveState() { store.set('from', state.from); store.set('to', state.to); }

  // ---------------------------------------------------------------- réseau
  function NetErr(msg) { this.message = msg; this.net = true; }
  function getJSON(url, timeout) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeout || 12000);
    return fetch(url, ctrl ? { signal: ctrl.signal } : {}).then(function (r) {
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }, function () { clearTimeout(timer); throw new NetErr('réseau'); });
  }
  function pool(tasks, n) {
    var out = new Array(tasks.length), i = 0;
    function next() { if (i >= tasks.length) return Promise.resolve(); var k = i++; return tasks[k]().then(function (v) { out[k] = { ok: true, v: v }; }, function (e) { out[k] = { ok: false, e: e }; }).then(next); }
    var w = []; for (var j = 0; j < Math.min(n, tasks.length); j++) w.push(next());
    return Promise.all(w).then(function () { return out; });
  }

  // ---------------------------------------------------------------- lieux
  function searchPlaces(q) {
    if (state.demo) return Promise.resolve(Demo.search(q));
    var st = getJSON(API + '/locations?type=station&query=' + encodeURIComponent(q)).then(function (d) {
      return (d.stations || []).filter(function (s) { return s.id && s.coordinate && s.coordinate.x; }).slice(0, 6).map(function (s) {
        return { kind: 'station', id: s.id, label: s.name, lat: s.coordinate.x, lon: s.coordinate.y, sub: 'Arrêt' };
      });
    });
    var ad = getJSON(GEO + '?type=locations&limit=8&origins=address,gazetteer,gg25,zipcode&searchText=' + encodeURIComponent(q)).then(function (d) {
      return (d.results || []).map(function (r) {
        var a = r.attrs || {};
        var label = String(a.label || '').replace(/<[^>]+>/g, '').trim();
        var kinds = { address: 'Adresse', gg25: 'Commune', zipcode: 'NPA', gazetteer: 'Lieu' };
        return { kind: 'address', label: label, lat: a.lat, lon: a.lon, sub: kinds[a.origin] || 'Lieu' };
      }).filter(function (p) { return p.lat && p.lon && p.label; });
    });
    return Promise.allSettled([st, ad]).then(function (rs) {
      if (rs.every(function (r) { return r.status === 'rejected' && r.reason && r.reason.net; })) throw new NetErr('réseau');
      var a = rs[0].status === 'fulfilled' ? rs[0].value : [];
      var b = rs[1].status === 'fulfilled' ? rs[1].value : [];
      var out = [], i = 0;
      while (out.length < 10 && (i < a.length || i < b.length)) { if (a[i]) out.push(a[i]); if (b[i]) out.push(b[i]); i++; }
      return out;
    });
  }

  function resolvePlace(p) {
    if (!p) return Promise.reject(new Error('Lieu manquant'));
    if (p.kind === 'gps') {
      if (state.gps) return Promise.resolve({ kind: 'gps', label: 'Ma position', lat: state.gps.lat, lon: state.gps.lon });
      return Promise.reject(new Error(state.gpsError || 'Position en cours de recherche…'));
    }
    if (p.lat && p.lon) return Promise.resolve(p);
    return searchPlaces(p.label).then(function (r) {
      var hit = r.filter(function (x) { return x.kind === 'station'; })[0] || r[0];
      if (!hit) throw new Error('Lieu introuvable : ' + p.label);
      Object.assign(p, hit, { label: p.label });
      store.set('favs', state.favs);
      return p;
    });
  }

  function nearbyStops(place, max) {
    var base = place.kind === 'station' ? [{ id: place.id, name: place.label, lat: place.lat, lon: place.lon, walk: 0, dist: 0 }] : [];
    var req = state.demo ? Promise.resolve(Demo.nearby(place)) :
      getJSON(API + '/locations?type=station&x=' + place.lat + '&y=' + place.lon).then(function (d) { return d.stations || []; });
    return req.then(function (list) {
      var stops = list.filter(function (s) { return s.id && s.coordinate && s.coordinate.x; }).map(function (s) {
        var m = s.distance != null ? s.distance : dist(place, { lat: s.coordinate.x, lon: s.coordinate.y });
        return { id: s.id, name: s.name, lat: s.coordinate.x, lon: s.coordinate.y, dist: m, walk: walkMin(m) };
      }).sort(function (a, b) { return a.dist - b.dist; });
      var ok = stops.filter(function (s) { return s.walk <= state.settings.walkMax && !base.some(function (b) { return b.id === s.id; }); });
      if (!ok.length && !base.length && stops.length) ok = [stops[0]];
      return base.concat(ok).slice(0, max);
    });
  }

  // ---------------------------------------------------------------- trajets
  var TRAIN = /^(IC|ICN|IR|IRE|RE|R|S|SN|EC|ICE|TGV|EN|NJ|PE|RJX|EXT|D)$/;
  function legType(cat) {
    cat = String(cat || '').toUpperCase();
    if (TRAIN.test(cat)) return 'train';
    if (/^(B|BUS|NFB|KB|EXB|BN|BP)$/.test(cat)) return 'bus';
    if (/^(M|MET)$/.test(cat)) return 'metro';
    if (/^(T|TRAM|NFT)$/.test(cat)) return 'tram';
    return 'other';
  }
  function legLabel(j) {
    var cat = String(j.category || '').toUpperCase(), num = String(j.number || '');
    var t = legType(cat);
    if (t === 'metro') return 'm' + (num || '');
    if (t === 'tram') return 't' + (num || '');
    if (t === 'bus') return num && num.length <= 4 ? num : 'Bus';
    return num && num.length <= 3 ? cat + num : cat;
  }
  var COLORS = { train: '#14181F', bus: '#4B5563', metro: '#C2410C', tram: '#0E7C66', other: '#5B3FB0', walk: '#8A919C', car: '#8A919C' };

  function parseConnection(c, o, d) {
    var legs = [];
    (c.sections || []).forEach(function (s) {
      var dep = s.departure || {}, arr = s.arrival || {};
      var depPlan = (dep.departureTimestamp || 0) * 1000, arrPlan = (arr.arrivalTimestamp || 0) * 1000;
      var dp = dep.prognosis || {}, ap = arr.prognosis || {};
      var depReal = isoTs(dp.departure); if (isNaN(depReal)) depReal = depPlan + (dep.delay ? dep.delay * 60000 : 0);
      var arrReal = isoTs(ap.arrival); if (isNaN(arrReal)) arrReal = arrPlan + (arr.delay ? arr.delay * 60000 : 0);
      var pt = function (x) { var l = x.station || x.location || {}; var cc = l.coordinate || {}; return cc.x ? { lat: cc.x, lon: cc.y, name: l.name } : null; };
      if (s.walk || !s.journey) {
        var wm = depPlan && arrPlan ? mins(arrPlan - depPlan) : Math.round(((s.walk && s.walk.duration) || 0) / 60);
        legs.push({ type: 'walk', min: Math.max(1, wm), from: pt(dep), to: pt(arr), dep: depReal, arr: arrReal });
        return;
      }
      var j = s.journey;
      var path = (j.passList || []).map(function (p) { return pt(p); }).filter(Boolean);
      if (!path.length) path = [pt(dep), pt(arr)].filter(Boolean);
      legs.push({
        type: legType(j.category), label: legLabel(j), to: j.to, name: j.name,
        from: pt(dep), dest: pt(arr), fromName: (dep.station || {}).name, toName: (arr.station || {}).name,
        dep: depReal, arr: arrReal, depPlan: depPlan, arrPlan: arrPlan,
        delay: Math.max(0, mins(depReal - depPlan)), arrDelay: Math.max(0, mins(arrReal - arrPlan)),
        cap: (j.capacity2nd != null ? j.capacity2nd : dp.capacity2nd), platform: dp.platform || dep.platform, realtime: !!(dp.departure || dp.arrival || ap.arrival || dep.delay != null || arr.delay != null),
        path: path
      });
    });
    var veh = legs.filter(function (l) { return l.type !== 'walk'; });
    if (!veh.length) return null;
    var slacks = [];
    for (var i = 1; i < veh.length; i++) slacks.push(mins(veh[i].dep - veh[i - 1].arr));
    var leave = veh[0].dep - (o.walk + (legs[0].type === 'walk' ? 0 : 0)) * 60000 - (legs[0].type === 'walk' ? legs[0].min * 60000 : 0);
    var arrive = legs[legs.length - 1].arr + d.walk * 60000;
    var innerWalk = legs.filter(function (l) { return l.type === 'walk'; }).reduce(function (a, l) { return a + l.min; }, 0);
    return {
      key: o.id + '>' + d.id + '@' + veh.map(function (l) { return l.label + hm(l.dep); }).join('|'),
      sig: o.id + '>' + d.id + ':' + veh.map(function (l) { return l.label + '@' + (l.fromName || ''); }).join('|'),
      origin: o, dest: d, legs: legs, veh: veh,
      leave: leave, arrive: arrive, duration: mins(arrive - leave),
      transfers: veh.length - 1, minSlack: slacks.length ? Math.min.apply(null, slacks) : null,
      transferNames: veh.slice(1).map(function (l) { return l.fromName; }),
      walkTotal: o.walk + d.walk + innerWalk,
      realtime: veh.some(function (l) { return l.realtime; }),
      maxDelay: Math.max.apply(null, veh.map(function (l) { return l.delay; })),
      capacity: capOf(c, veh)
    };
  }

  function capOf(c, veh) {
    var vals = [+c.capacity2nd].concat(veh.map(function (l) { return +l.cap; })).filter(function (v) { return v >= 1 && v <= 3; });
    return vals.length ? Math.max.apply(null, vals) : null;
  }

  function fetchConnections(o, d, whenMs, isArrival, limit) {
    if (state.demo) return Promise.resolve(Demo.connections(o, d, whenMs, isArrival));
    var url = API + '/connections?from=' + encodeURIComponent(o.id) + '&to=' + encodeURIComponent(d.id) +
      '&date=' + ymd(whenMs) + '&time=' + hm(whenMs) + '&limit=' + (limit || 4) + (isArrival ? '&isArrivalTime=1' : '');
    return getJSON(url, 15000).then(function (r) { return r.connections || []; });
  }

  function gather(from, to, whenMs, isArrival, maxO, maxD, limit) {
    return Promise.all([nearbyStops(from, maxO), nearbyStops(to, maxD)]).then(function (ss) {
      var os = ss[0], ds = ss[1];
      if (!os.length) throw new Error('Aucun arrêt à distance de marche du départ.');
      if (!ds.length) throw new Error("Aucun arrêt à distance de marche de l'arrivée.");
      var tasks = [];
      os.forEach(function (o) { ds.forEach(function (d) {
        if (o.id === d.id) return;
        tasks.push(function () {
          var t = isArrival ? whenMs - d.walk * 60000 : whenMs + o.walk * 60000;
          return fetchConnections(o, d, t, isArrival, limit).then(function (cs) { return cs.map(function (c) { return parseConnection(c, o, d); }).filter(Boolean); });
        });
      }); });
      return pool(tasks, 4).then(function (res) {
        if (res.length && res.every(function (r) { return !r.ok && r.e && r.e.net; })) throw new NetErr('réseau');
        var seen = {}, all = [];
        res.forEach(function (r) { if (r.ok) r.v.forEach(function (t) { if (!seen[t.key]) { seen[t.key] = 1; all.push(t); } }); });
        return { trips: all, origins: os, dests: ds, requests: tasks.length };
      });
    });
  }

  function rank(trips) {
    var now = baseTime(), s = state.settings;
    trips.forEach(function (t) {
      t.reasons = []; t.penalty = t.transfers * 1;
      if (t.leave < now - 45000) { t.dead = state.departAt ? 'Part avant l\'heure choisie' : 'Trop tard pour ce départ'; }
      if (t.walkTotal > s.walkMax * 2) { t.dead = t.dead || 'Trop de marche (' + t.walkTotal + ' min)'; }
      if (t.minSlack != null && t.minSlack < s.minTransfer) { t.penalty += 6; t.reasons.push('Correspondance de ' + t.minSlack + ' min, risquée'); }
      if (t.capacity === 3) { t.penalty += 3; t.reasons.push('Très chargé'); }
      if (t.maxDelay >= 3) { t.reasons.push('Retard de ' + t.maxDelay + ' min'); }
      t.score = t.arrive / 60000 + t.penalty;
    });
    var live = trips.filter(function (t) { return !t.dead; }).sort(function (a, b) { return a.score - b.score || b.leave - a.leave; });
    var best = live[0] || null, proposed = [], rejected = [], sigs = {};
    live.forEach(function (t) {
      if (proposed.length < 4 && !sigs[t.sig]) { proposed.push(t); sigs[t.sig] = t; return; }
      if (sigs[t.sig]) t.why = 'Même trajet, départ plus tard';
      else t.why = t.reasons[0] || ('Arrive ' + Math.max(1, mins(t.arrive - best.arrive)) + ' min plus tard');
      rejected.push(t);
    });
    trips.filter(function (t) { return t.dead; }).forEach(function (t) { t.why = t.dead; rejected.push(t); });
    return { best: best, proposed: proposed, rejected: rejected, tested: trips.length };
  }

  function tripTitle(t) {
    var first = t.veh[0], parts = [];
    if (first.type === 'bus' || first.type === 'tram' || first.type === 'metro') parts.push((first.type === 'bus' ? 'Bus ' : '') + first.label + ' depuis ' + shortName(t.origin.name));
    else if (t.origin.walk > 0) parts.push('À pied jusqu\'à ' + shortName(t.origin.name));
    else parts.push('Depuis ' + shortName(t.origin.name));
    for (var i = 1; i < t.veh.length; i++) if (t.veh[i - 1].type === 'train') parts.push('via ' + shortName(t.veh[i].fromName));
    if (t.dest.walk > 0) parts.push('fin à pied depuis ' + shortName(t.dest.name));
    return parts.join(', ');
  }
  function shortName(n) { n = String(n || ''); var i = n.indexOf(', '); return i > 0 && /^(Lausanne|Gland|Genève|Gen[eè]ve|Bern|Zürich)$/.test(n.slice(0, i)) ? n.slice(i + 2) : n; }
  function durTxt(m) { return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + pad(m % 60); }
  function baseTime() { return state.departAt || Date.now(); }
  function dayTxt(ms) { var d = new Date(ms), t = new Date(); if (d.toDateString() === t.toDateString()) return 'aujourd\'hui'; t.setDate(t.getDate() + 1); if (d.toDateString() === t.toDateString()) return 'demain'; return d.toLocaleDateString('fr-CH', { weekday: 'short', day: 'numeric', month: 'short' }); }
  function deltaTxt(d) { return d === 0 ? 'même heure' : (d > 0 ? '+' + d : '−' + (-d)) + ' min'; }

  // ---------------------------------------------------------------- voiture
  function fetchCar(from, to) {
    var k = state.settings.tomtomKey;
    if (state.demo) return Promise.resolve(Demo.car(from, to));
    if (!k) return Promise.resolve(null);
    var url = 'https://api.tomtom.com/routing/1/calculateRoute/' + from.lat + ',' + from.lon + ':' + to.lat + ',' + to.lon +
      '/json?traffic=true&travelMode=car&routeRepresentation=polyline' + (state.departAt && state.departAt > Date.now() ? '&departAt=' + encodeURIComponent(new Date(state.departAt).toISOString()) : '') + '&key=' + encodeURIComponent(k);
    return getJSON(url, 12000).then(function (r) {
      var rt = r.routes && r.routes[0]; if (!rt) return null;
      return {
        travel: rt.summary.travelTimeInSeconds, delay: rt.summary.trafficDelayInSeconds || 0, km: rt.summary.lengthInMeters / 1000,
        points: ((rt.legs && rt.legs[0] && rt.legs[0].points) || []).map(function (p) { return [p.latitude, p.longitude]; }),
        fetchedAt: Date.now(), at: state.departAt
      };
    }).catch(function () { return { error: true }; });
  }

  // ---------------------------------------------------------------- calcul principal
  var running = 0;
  function compute(opts) {
    opts = opts || {};
    if (!state.to) { render(); return; }
    var id = ++running;
    state.loading = !state.result || opts.full; state.error = null;
    if (opts.full) state.selectedKey = null;
    render();
    Promise.all([resolvePlace(state.from), resolvePlace(state.to)]).then(function (pl) {
      var from = pl[0], to = pl[1];
      return gather(from, to, baseTime(), false, 4, 3, 4).then(function (g) {
        if (id !== running) return;
        var r = rank(g.trips);
        state.result = Object.assign(r, { fetchedAt: Date.now(), at: state.departAt, origins: g.origins, dests: g.dests, from: from, to: to, demo: state.demo });
        state.loading = false;
        if (state.selectedKey && !g.trips.some(function (t) { return t.key === state.selectedKey; })) state.selectedKey = null;
        render();
        fetchCar(from, to).then(function (c) { if (id === running) { state.car = c; render(); } });
      });
    }).catch(function (e) {
      if (id !== running) return;
      if (e && e.net && !state.demo) { enableDemo(); return compute(opts); }
      state.loading = false; state.error = (e && e.message) || 'Erreur inconnue'; render();
    });
  }

  // ---------------------------------------------------------------- GPS
  function enableDemo() {
    if (state.demo) return;
    state.demo = true; $('#demo-banner').hidden = false;
    if (!state.gps) { state.gpsError = null; state.gps = Object.assign({}, Demo.home, { ts: Date.now() }); state.gpsLabel = 'près de Gland, Communet (démo)'; }
  }
  function setGps(p) {
    var prev = state.gps;
    state.gps = p; state.gpsError = null;
    if (!prev || dist(prev, p) > 150) labelGps();
    if (state.from && state.from.kind === 'gps' && state.to) {
      var moved = !state.result || !state.result.from || dist(state.result.from, p) > 80;
      if (moved && !state.departAt && Date.now() - (compute._last || 0) > 15000) { compute._last = Date.now(); compute(); }
    }
    renderOd(); renderFresh();
  }
  function labelGps() {
    nearbyStops({ kind: 'gps', lat: state.gps.lat, lon: state.gps.lon }, 1).then(function (s) {
      if (s[0]) { state.gpsLabel = 'près de ' + s[0].name; renderOd(); }
    }).catch(function () {});
  }
  function startGps() {
    if (!('geolocation' in navigator)) { state.gpsError = 'Localisation non disponible sur cet appareil'; return; }
    navigator.geolocation.watchPosition(function (pos) {
      setGps({ lat: pos.coords.latitude, lon: pos.coords.longitude, acc: Math.round(pos.coords.accuracy), ts: pos.timestamp || Date.now() });
    }, function (err) {
      state.gpsError = err.code === 1 ? 'Localisation refusée : autorisez-la ou choisissez un départ' : 'Position introuvable pour le moment';
      if (state.from.kind === 'gps' && state.to && !state.demo) {
        // Tente le réseau pour détecter le mode démo, sinon affiche l'erreur
        getJSON(API + '/locations?query=Gland', 6000).then(function () { state.error = state.gpsError; render(); }, function () { enableDemo(); compute(); });
      }
      renderOd();
    }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  }

  // ---------------------------------------------------------------- rendu
  function badge(l) {
    if (l.type === 'walk') return '<span class="badge walk">à pied ' + l.min + '′</span>';
    return '<span class="badge b-' + l.type + '">' + esc(l.label) + '</span>';
  }
  function legsHtml(t, withTimes) {
    var parts = [];
    if (t.origin.walk) parts.push('<span class="badge walk">à pied ' + t.origin.walk + '′</span>');
    t.legs.forEach(function (l) {
      if (l.type === 'walk') { if (l.min >= 2) parts.push(badge(l)); return; }
      parts.push(withTimes ? '<span class="badge b-' + l.type + '">' + esc(l.label) + ' ' + hm(l.dep) + '</span>' : badge(l));
    });
    if (t.dest.walk) parts.push('<span class="badge walk">à pied ' + t.dest.walk + '′</span>');
    return '<div class="legs">' + parts.join('<span class="sep" aria-hidden="true">›</span>') + '</div>';
  }
  function capLabel(c) { return c === 1 ? 'faible' : c === 2 ? 'moyenne' : c === 3 ? 'élevée' : null; }

  function timelineHtml(t) {
    var items = [], o = t.origin, d = t.dest;
    var from = state.result.from;
    if (o.walk) items.push(['', hm(t.leave), esc(from.kind === 'gps' ? 'Votre position' : from.label), 'À pied ' + o.walk + ' min jusqu\'à ' + esc(o.name)]);
    t.legs.forEach(function (l) {
      if (l.type === 'walk') { items.push(['', hm(l.dep), 'Correspondance à pied', l.min + ' min']); return; }
      var sub = esc(l.label) + ' direction ' + esc(l.to || '') + (l.platform ? ' · voie ' + esc(l.platform) : '') + (l.delay ? ' · <b class="delta-bad">+' + l.delay + ' min</b>' : '') + (l.realtime ? '' : ' · horaire théorique');
      items.push([l.delay ? 'late' : '', hm(l.dep), esc(l.fromName), sub]);
    });
    var last = t.veh[t.veh.length - 1];
    items.push([last.arrDelay ? 'late' : '', hm(last.arr), esc(last.toName), d.walk ? 'Puis ' + d.walk + ' min à pied' : '']);
    if (d.walk) items.push(['', hm(t.arrive), esc(state.result.to.label), 'Arrivée']);
    return '<ul class="timeline">' + items.map(function (it) {
      return '<li><span class="t ' + it[0] + '">' + it[1] + '</span><span class="pt" aria-hidden="true"></span><span class="what"><span>' + it[2] + '</span>' + (it[3] ? '<small>' + it[3] + '</small>' : '') + '</span></li>';
    }).join('') + '</ul>';
  }

  function basedOn(t) {
    var r = state.result, tags = [];
    var age = Date.now() - r.fetchedAt, cls = age < 90000 ? 'good' : age < 300000 ? 'warn' : 'grey';
    if (state.departAt && state.departAt - Date.now() > 90 * 60000) tags.push(['tag-grey', 'Horaire prévu : le temps réel arrive ~1 h avant']);
    else if (t.realtime) tags.push(['tag-' + cls, 'Retards temps réel · ' + ago(r.fetchedAt)]);
    else tags.push(['tag-warn', 'Horaire théorique (pas de temps réel)']);
    if (state.from.kind === 'gps' && state.gps) tags.push([state.gps.acc <= 50 ? 'tag-good' : 'tag-warn', 'GPS ±' + state.gps.acc + ' m · ' + ago(state.gps.ts)]);
    var c = capLabel(t.capacity);
    tags.push(['tag-grey', c ? 'Affluence ' + c + ' (prévision)' : 'Affluence inconnue']);
    if (r.demo) tags.push(['tag-warn', 'Données de démonstration']);
    return '<div class="based"><span class="small muted">Décision basée sur</span><div class="tags">' +
      tags.map(function (x) { return '<span class="tag ' + x[0] + '"><span class="dot"></span>' + esc(x[1]) + '</span>'; }).join('') + '</div></div>';
  }

  function render() {
    renderOd(); renderFavs(); renderFresh();
    var box = $('#trip-results');
    if (!state.to) {
      box.innerHTML = '<div class="empty"><p class="strong">Où allez-vous ?</p><p class="small">Touchez « Arrivée » ou un favori. Une adresse, un arrêt ou un lieu, partout en Suisse.</p></div>';
      return;
    }
    if (state.loading) { box.innerHTML = '<div class="skeleton"></div><div class="skeleton" style="height:64px"></div><div class="skeleton" style="height:64px"></div>'; return; }
    if (state.error && !state.result) { box.innerHTML = '<div class="card empty"><p class="strong">' + esc(state.error) + '</p><button type="button" class="btn btn-soft btn-small" data-act="retry">Réessayer</button></div>'; return; }
    var r = state.result; if (!r) { box.innerHTML = ''; return; }
    if (!r.best) { box.innerHTML = '<div class="card empty"><p class="strong">Aucun trajet trouvé maintenant.</p><p class="small">' + r.tested + ' trajets testés. Essayez une autre heure dans « Quand partir ».</p></div>'; return; }

    var all = r.proposed.concat(r.rejected);
    var main = (state.selectedKey && all.filter(function (t) { return t.key === state.selectedKey; })[0]) || r.best;
    var leaveIn = mins(main.leave - Date.now());
    var leavePill = state.departAt ? ['pill-grey', 'Partez à ' + hm(main.leave)] : leaveIn <= 0 ? ['pill-warn', 'Partez maintenant'] : leaveIn <= 2 ? ['pill-warn', 'Partez dans ' + leaveIn + ' min'] : ['pill-good', 'Partez dans ' + leaveIn + ' min'];
    var h = '';
    if (state.departAt) h += '<div class="sim-banner"><span>Simulation : départ ' + dayTxt(state.departAt) + ' ' + hm(state.departAt) + '</span><button type="button" class="link-btn" data-act="now">Revenir à maintenant</button></div>';
    if (state.error) h += '<div class="banner" style="margin:0">' + esc(state.error) + '</div>';
    h += '<section class="card best" aria-label="Trajet recommandé">' +
      '<div class="row-between"><span class="eyebrow">' + (main === r.best ? 'Meilleur trajet' : 'Votre choix') + '</span><span class="pill ' + leavePill[0] + '">' + leavePill[1] + '</span></div>' +
      '<div class="stats"><div><span class="stat-label">Départ</span><b>' + hm(main.leave) + '</b></div><div><span class="stat-label">Durée totale</span><b>' + durTxt(main.duration) + '</b></div><div><span class="stat-label">Arrivée</span><b>' + hm(main.arrive) + '</b></div></div>' +
      legsHtml(main, true) +
      (main.reasons.length ? '<div class="tags">' + main.reasons.map(function (x) { return '<span class="tag tag-warn"><span class="dot"></span>' + esc(x) + '</span>'; }).join('') + '</div>' : '') +
      (state.showDetail ? timelineHtml(main) : '') +
      '<button type="button" class="btn btn-soft btn-small" data-act="detail" aria-expanded="' + state.showDetail + '">' + (state.showDetail ? 'Masquer le détail' : 'Voir le détail du trajet') + '</button>' +
      basedOn(main) + '</section>';

    var alts = r.proposed.filter(function (t) { return t !== main; });
    h += '<div class="section-head"><h2>Alternatives</h2><button type="button" class="link-btn" data-act="rejected">' + r.tested + ' testés · voir les écartés</button></div>';
    if (!alts.length) h += '<p class="muted small">Pas d\'autre trajet intéressant pour le moment.</p>';
    alts.forEach(function (t) {
      var d = mins(t.arrive - main.arrive);
      h += '<button type="button" class="card alt" data-key="' + esc(t.key) + '"><span class="alt-main"><span class="alt-title">' + esc(tripTitle(t)) + '</span>' + legsHtml(t, false) +
        '<span class="alt-sub">Départ ' + hm(t.leave) + (t.reasons.length ? ' · ' + esc(t.reasons[0]) : '') + '</span></span>' +
        '<span class="alt-time"><b>' + hm(t.arrive) + '</b><span class="dur">' + durTxt(t.duration) + '</span><span>' + deltaTxt(d) + '</span></span></button>';
    });
    h += carHtml(main);
    h += '<p class="muted small" style="text-align:center">Calculé à ' + hm(r.fetchedAt) + (state.departAt ? ' pour un départ simulé' : ' · mise à jour automatique chaque minute') + '</p>';
    box.innerHTML = h;
    if (state.tab === 'map') renderMap();
  }

  function carHtml(main) {
    var c = state.car;
    if (!c) return state.settings.tomtomKey ? '' : '<button type="button" class="card alt car-card" data-act="settings"><span class="alt-main"><span class="alt-title">Et en voiture ?</span><span class="alt-sub">Ajoutez une clé TomTom gratuite dans Réglages pour comparer avec le trafic en direct</span></span></button>';
    if (c.error) return '<div class="card car-card small muted">Trafic voiture indisponible pour le moment.</div>';
    var arrive = (c.at || c.fetchedAt) + (c.travel + state.settings.parking * 60) * 1000;
    var d = mins(arrive - main.arrive), jam = Math.round(c.delay / 60);
    return '<button type="button" class="card alt car-card" data-act="map"><span class="alt-main"><span class="alt-title">En voiture</span>' +
      '<span class="alt-sub ' + (jam >= 5 ? 'delta-bad' : '') + '">' + Math.round(c.travel / 60) + ' min de route' + (jam ? ' dont ' + jam + ' min de bouchons' : ', trafic fluide') + ' + ' + state.settings.parking + ' min parking</span>' +
      '<span class="alt-sub">' + (c.at ? 'Trafic prévu pour ' + hm(c.at) : 'Trafic ' + ago(c.fetchedAt)) + ' · ' + c.km.toFixed(0) + ' km</span></span>' +
      '<span class="alt-time"><b>' + hm(arrive) + '</b><span class="dur">' + durTxt(mins(arrive - (c.at || c.fetchedAt))) + '</span><span>' + deltaTxt(d) + '</span></span></button>';
  }

  function renderOd() {
    var f = state.from, t = state.to;
    $('#from-label').textContent = f ? f.label : 'Choisir un départ';
    var sub = '';
    if (f && f.kind === 'gps') sub = state.gps ? (state.gpsLabel || 'Position trouvée') + ' · ±' + state.gps.acc + ' m' : (state.gpsError || 'Recherche de la position…');
    else if (f && f.sub) sub = f.sub;
    $('#from-sub').textContent = sub;
    $('#to-label').textContent = t ? t.label : 'Choisir une destination';
  }

  function samePlace(a, b) { return a && b && (a.kind === 'gps' ? b.kind === 'gps' : a.label === b.label); }
  function renderFavs() {
    var row = $('#fav-row'), h = '', cur = null;
    state.favs.forEach(function (f) {
      var on = samePlace(f.from, state.from) && samePlace(f.to, state.to); if (on) cur = f;
      h += '<button type="button" role="listitem" class="chip' + (on ? ' active' : '') + '" data-fav="' + esc(f.id) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l3 7 7 .6-5.4 4.7 1.7 7.2L12 17.8 5.7 21.5l1.7-7.2L2 9.6 9 9z"' + (on ? ' fill="currentColor"' : '') + '/></svg>' + esc(f.name) + (f.time ? ' · ' + esc(f.time) : '') + '</button>';
    });
    if (state.to && !cur) h += '<button type="button" role="listitem" class="chip add" data-act="savefav">+ Enregistrer ce trajet</button>';
    row.innerHTML = h;
  }

  function renderFresh() {
    var p = $('#fresh-pill'), t = $('#fresh-text'), r = state.result;
    p.className = 'pill';
    if (state.demo) { p.classList.add('pill-warn'); t.textContent = 'Démo'; return; }
    if (state.loading) { p.classList.add('pill-grey'); t.textContent = 'Calcul…'; return; }
    if (!r) { p.classList.add('pill-grey'); t.textContent = state.gps ? 'GPS ±' + state.gps.acc + ' m' : 'En attente'; return; }
    var age = Date.now() - r.fetchedAt;
    p.classList.add(age < 90000 ? 'pill-good' : age < 300000 ? 'pill-warn' : 'pill-grey');
    t.textContent = (age < 90000 ? 'À jour · ' : 'Données de ') + ago(r.fetchedAt);
    p.setAttribute('aria-label', 'Données mises à jour il y a ' + ago(r.fetchedAt) + '. Toucher pour actualiser.');
  }

  // ---------------------------------------------------------------- écartés
  function openRejected() {
    var r = state.result; if (!r) return;
    var h = '<div class="summary"><div><b>' + r.tested + '</b><span>testés à ' + hm(r.fetchedAt) + '</span></div><div><b>' + r.proposed.length + '</b><span>proposés</span></div><div><b>' + r.rejected.length + '</b><span>écartés</span></div></div>' +
      '<p class="muted small">' + r.origins.length + ' arrêt(s) de départ × ' + r.dests.length + ' arrêt(s) d\'arrivée à distance de marche (' + state.settings.walkMax + ' min max). Vous pouvez choisir un trajet écarté.</p>';
    var list = r.rejected.slice().sort(function (a, b) { return (a.dead ? 1 : 0) - (b.dead ? 1 : 0) || a.arrive - b.arrive; });
    list.forEach(function (t) {
      var d = mins(t.arrive - r.best.arrive);
      h += '<article class="card stack" style="gap:10px"><div class="row-between" style="align-items:flex-start"><div class="alt-main"><span class="alt-title">' + esc(tripTitle(t)) + '</span>' + legsHtml(t, true) + '</div>' +
        '<div class="alt-time"><b>' + hm(t.arrive) + '</b><span class="dur">' + durTxt(t.duration) + '</span><span class="' + (d > 0 ? 'delta-bad' : '') + '">' + deltaTxt(d) + '</span></div></div>' +
        '<div class="row-between"><span class="reason">' + esc(t.why) + '</span>' + (t.dead ? '' : '<button type="button" class="btn btn-soft btn-small" data-pick="' + esc(t.key) + '">Choisir quand même</button>') + '</div></article>';
    });
    if (!list.length) h += '<p class="muted">Aucun trajet écarté.</p>';
    $('#rejected-body').innerHTML = h;
    openSheet('#rejected-sheet');
  }

  // ---------------------------------------------------------------- feuilles
  var lastFocus = null;
  function openSheet(sel) { lastFocus = document.activeElement; $(sel).hidden = false; try { history.pushState({ sheet: sel }, ''); } catch (e) { /* iframe */ } var f = $(sel).querySelector('input, button'); if (f) f.focus(); }
  function closeSheet(sel, fromPop) { if ($(sel).hidden) return; $(sel).hidden = true; if (!fromPop) { try { if (history.state && history.state.sheet) history.back(); } catch (e) { /* iframe */ } } if (lastFocus) lastFocus.focus(); }
  window.addEventListener('popstate', function () { ['#search-sheet', '#rejected-sheet'].forEach(function (s) { closeSheet(s, true); }); });

  var searchField = 'to', searchTimer = null;
  function openSearch(field) {
    searchField = field;
    $('#search-title').textContent = field === 'from' ? 'Départ' : 'Arrivée';
    $('#search-input').value = '';
    renderSearch([]);
    openSheet('#search-sheet');
  }
  function renderSearch(results, q) {
    var h = '';
    if (!q) {
      if (searchField === 'from') h += item({ kind: 'gps', label: 'Ma position', sub: state.gps ? (state.gpsLabel || 'Position GPS') + ' · ±' + state.gps.acc + ' m' : 'Utiliser le GPS' }, 'gps', 'GPS');
      state.recents.forEach(function (p) { h += item(p, 'addr', 'Récent'); });
    }
    results.forEach(function (p) { h += item(p, p.kind === 'station' ? 'stop' : 'addr', p.kind === 'station' ? 'Arrêt' : (p.sub || 'Adresse')); });
    if (q && !results.length) h += '<li class="muted" style="padding:16px 4px">Aucun résultat pour « ' + esc(q) + ' ».</li>';
    $('#search-results').innerHTML = h;
    renderSearch.data = (!q ? [searchField === 'from' ? GPS_PLACE : null].concat(state.recents) : []).filter(Boolean).concat(results);
    function item(p, cls, kind) {
      return '<li><button type="button" data-place="' + esc(p.kind + '|' + p.label) + '"><span class="kind ' + cls + '">' + esc(kind) + '</span><span class="r-text"><span>' + esc(p.label) + '</span>' + (p.sub && kind !== p.sub ? '<span>' + esc(p.sub) + '</span>' : '') + '</span></button></li>';
    }
  }
  function onSearchInput() {
    var q = $('#search-input').value.trim();
    clearTimeout(searchTimer);
    if (q.length < 2) { renderSearch([]); return; }
    $('#search-results').innerHTML = '<li><div class="spinner" role="status" aria-label="Recherche"></div></li>';
    searchTimer = setTimeout(function () {
      searchPlaces(q).then(function (r) { if ($('#search-input').value.trim() === q) renderSearch(r, q); })
        .catch(function (e) {
          if (e && e.net && !state.demo) { enableDemo(); return onSearchInput(); }
          $('#search-results').innerHTML = '<li class="muted" style="padding:16px 4px">Recherche impossible pour le moment.</li>';
        });
    }, 250);
  }
  function pickPlace(key) {
    var p = (renderSearch.data || []).filter(function (x) { return x.kind + '|' + x.label === key; })[0];
    if (!p) return;
    p = Object.assign({}, p);
    if (p.kind !== 'gps') { state.recents = [p].concat(state.recents.filter(function (x) { return x.label !== p.label; })).slice(0, 5); store.set('recents', state.recents); }
    state[searchField] = p; saveState();
    closeSheet('#search-sheet');
    state.result = null; state.car = null; compute({ full: true });
  }

  // ---------------------------------------------------------------- carte
  var map = null, mapLayer = null, mapSel = null;
  function renderMap() {
    if (typeof L === 'undefined') { $('#map').innerHTML = '<p class="empty">Carte indisponible.</p>'; return; }
    if (!map) {
      map = L.map('map', { zoomControl: false, attributionControl: true }).setView([46.47, 6.45], 10);
      L.tileLayer(TILE, { maxZoom: 18, attribution: '© swisstopo' }).addTo(map);
      L.control.zoom({ position: 'topright' }).addTo(map);
      mapLayer = L.layerGroup().addTo(map);
    }
    setTimeout(function () { map.invalidateSize(); }, 50);
    mapLayer.clearLayers();
    var r = state.result, bounds = [];
    if (state.gps) {
      L.marker([state.gps.lat, state.gps.lon], { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), title: 'Vous' }).addTo(mapLayer);
      L.circle([state.gps.lat, state.gps.lon], { radius: state.gps.acc, color: '#2348C9', weight: 1, fillOpacity: 0.08 }).addTo(mapLayer);
      bounds.push([state.gps.lat, state.gps.lon]);
    }
    var sheet = $('#map-sheet');
    if (!r || !r.best) { sheet.innerHTML = '<p class="muted small" style="margin:4px">Choisissez une destination dans l\'onglet Trajet pour voir les itinéraires.</p>'; if (bounds.length) map.setView(bounds[0], 14); return; }
    var sel = mapSel || state.selectedKey || r.best.key;
    var list = r.proposed.slice();
    var chosen = r.rejected.filter(function (t) { return t.key === sel; })[0]; if (chosen) list.push(chosen);
    var drawTrip = function (t, on) {
      var op = on ? 1 : 0.25, w = on ? 6 : 4;
      var line = function (pts, color, dash) { if (pts.length < 2) return; L.polyline(pts, { color: color, weight: w, opacity: op, dashArray: dash || null, lineCap: 'round' }).addTo(mapLayer); if (on) pts.forEach(function (p) { bounds.push(p); }); };
      var from = r.from, to = r.to;
      if (t.origin.walk) line([[from.lat, from.lon], [t.origin.lat, t.origin.lon]], COLORS.walk, '4 8');
      t.legs.forEach(function (l) {
        if (l.type === 'walk') { if (l.from && l.to) line([[l.from.lat, l.from.lon], [l.to.lat, l.to.lon]], COLORS.walk, '4 8'); return; }
        line(l.path.map(function (p) { return [p.lat, p.lon]; }), COLORS[l.type]);
        if (on && l.from) L.circleMarker([l.from.lat, l.from.lon], { radius: 5, color: COLORS[l.type], weight: 3, fillColor: '#fff', fillOpacity: 1 }).bindTooltip(esc(l.fromName) + ' ' + hm(l.dep)).addTo(mapLayer);
      });
      if (t.dest.walk) line([[t.dest.lat, t.dest.lon], [to.lat, to.lon]], COLORS.walk, '4 8');
    };
    list.forEach(function (t) { if (t.key !== sel) drawTrip(t, false); });
    if (state.car && state.car.points && state.car.points.length) L.polyline(state.car.points, { color: COLORS.car, weight: sel === 'car' ? 6 : 4, opacity: sel === 'car' ? 1 : 0.3 }).addTo(mapLayer);
    if (sel === 'car' && state.car && state.car.points) state.car.points.forEach(function (p) { bounds.push(p); });
    var selTrip = list.filter(function (t) { return t.key === sel; })[0]; if (selTrip) drawTrip(selTrip, true);
    L.marker([r.to.lat, r.to.lon], { title: r.to.label, icon: L.divIcon({ className: '', html: '<div class="dest-pin"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(mapLayer); bounds.push([r.to.lat, r.to.lon]);
    if (bounds.length > 1) map.fitBounds(bounds, { paddingTopLeft: [24, 24], paddingBottomRight: [24, Math.round(window.innerHeight * 0.42)] });

    var h = '';
    list.forEach(function (t) {
      var color = COLORS[(t.veh[t.veh.length - 1] || {}).type] || COLORS.train;
      h += '<button type="button" class="alt' + (t.key === sel ? ' selected' : '') + '" data-mapkey="' + esc(t.key) + '" aria-pressed="' + (t.key === sel) + '"><span class="swatch" style="background:' + color + '"></span><span class="alt-main" style="flex:1"><span class="alt-title">' + esc(tripTitle(t)) + '</span>' + legsHtml(t, false) + '</span><span class="alt-time"><b>' + hm(t.arrive) + '</b><span class="dur">' + durTxt(t.duration) + '</span><span>' + (t === r.best ? 'meilleur' : deltaTxt(mins(t.arrive - r.best.arrive))) + '</span></span></button>';
    });
    if (state.car && state.car.points) {
      var ca = (state.car.at || state.car.fetchedAt) + (state.car.travel + state.settings.parking * 60) * 1000;
      h += '<button type="button" class="alt' + (sel === 'car' ? ' selected' : '') + '" data-mapkey="car" aria-pressed="' + (sel === 'car') + '"><span class="swatch" style="background:' + COLORS.car + '"></span><span class="alt-main" style="flex:1"><span class="alt-title">Voiture</span><span class="alt-sub">' + Math.round(state.car.delay / 60) + ' min de bouchons · trafic ' + ago(state.car.fetchedAt) + '</span></span><span class="alt-time"><b>' + hm(ca) + '</b><span>' + deltaTxt(mins(ca - r.best.arrive)) + '</span></span></button>';
    }
    sheet.innerHTML = h;
  }

  // ---------------------------------------------------------------- quand partir
  function initWhen() {
    var inp = $('#when-limit');
    if (!inp.value) { var d = new Date(Date.now() + 60 * 60000); d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0); inp.value = pad(d.getHours()) + ':' + pad(d.getMinutes()); }
    $('#when-od').textContent = state.to ? (state.from.label + ' → ' + state.to.label) : 'Choisissez d\'abord un trajet dans l\'onglet Trajet.';
  }
  function runWhen() {
    if (!state.to) { toast('Choisissez d\'abord une destination.'); return; }
    var v = $('#when-limit').value; if (!v) return;
    var p = v.split(':'), d = new Date(); d.setHours(+p[0], +p[1], 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    var limit = d.getTime();
    $('#when-results').innerHTML = '<div class="spinner" role="status" aria-label="Calcul"></div>';
    Promise.all([resolvePlace(state.from), resolvePlace(state.to)]).then(function (pl) {
      return gather(pl[0], pl[1], limit, true, 2, 2, 6);
    }).then(function (g) {
      var trips = g.trips.filter(function (t) { return t.arrive <= limit + 60000 && t.leave > Date.now() - 60000; });
      var byLeave = {};
      trips.forEach(function (t) { var k = hm(t.leave); if (!byLeave[k] || byLeave[k].arrive > t.arrive) byLeave[k] = t; });
      var slots = Object.keys(byLeave).map(function (k) { return byLeave[k]; }).sort(function (a, b) { return a.leave - b.leave; }).slice(-7);
      state.when.result = { slots: slots, limit: limit, tested: g.trips.length }; state.when.picked = null;
      renderWhen();
    }).catch(function (e) {
      if (e && e.net && !state.demo) { enableDemo(); return runWhen(); }
      $('#when-results').innerHTML = '<div class="card empty">' + esc((e && e.message) || 'Calcul impossible') + '</div>';
    });
  }
  function renderWhen() {
    var w = state.when.result, box = $('#when-results'); if (!w) { box.innerHTML = ''; return; }
    if (!w.slots.length) { box.innerHTML = '<div class="card empty">Aucun départ ne permet d\'arriver avant ' + hm(w.limit) + '.</div>'; return; }
    var mode = state.when.mode, best;
    var crowd = function (t) { return t.capacity || 2; };
    if (mode === 'late') best = w.slots[w.slots.length - 1];
    else if (mode === 'short') best = w.slots.slice().sort(function (a, b) { return a.duration - b.duration || b.leave - a.leave; })[0];
    else best = w.slots.slice().sort(function (a, b) { return crowd(a) - crowd(b) || b.leave - a.leave; })[0];
    if (state.when.picked != null) best = w.slots[state.when.picked] || best;
    var maxD = Math.max.apply(null, w.slots.map(function (t) { return t.duration; })), minD = Math.min.apply(null, w.slots.map(function (t) { return t.duration; }));
    var cols = 'grid-template-columns:repeat(' + w.slots.length + ',minmax(0,1fr))';
    var colorOf = function (t) { return t.capacity === 1 ? '#6E8FE6' : t.capacity === 3 ? '#C2410C' : t.capacity === 2 ? '#2348C9' : '#8A919C'; };
    var h = '<div class="card stack"><div class="row-between"><span class="strong">Durée selon l\'heure de départ</span><span class="muted small">' + w.tested + ' testés</span></div>' +
      '<div class="bars" style="' + cols + '">' + w.slots.map(function (t, i) {
        var hgt = 50 + (maxD === minD ? 60 : (t.duration - minD) / (maxD - minD) * 100);
        return '<button type="button" class="bar-btn' + (t === best ? ' best' : '') + '" data-slot="' + i + '" aria-label="Départ ' + hm(t.leave) + ', ' + t.duration + ' minutes, affluence ' + (capLabel(t.capacity) || 'inconnue') + '"><b>' + t.duration + '</b><i style="height:' + hgt + 'px;background:' + colorOf(t) + '"></i></button>';
      }).join('') + '</div><div class="bar-labels" style="' + cols + '">' + w.slots.map(function (t) { return '<span' + (t === best ? ' style="font-weight:700;color:var(--ink)"' : '') + '>' + hm(t.leave) + '</span>'; }).join('') + '</div>' +
      '<div class="legend"><span><i style="background:#6E8FE6"></i>affluence faible</span><span><i style="background:#2348C9"></i>moyenne</span><span><i style="background:#C2410C"></i>élevée</span><span><i style="background:#8A919C"></i>inconnue</span></div></div>';
    var marge = mins(w.limit - best.arrive);
    h += '<div class="rec"><span class="eyebrow">Recommandé</span><b>Partir à ' + hm(best.leave) + ' · arrivée ' + hm(best.arrive) + '</b><span class="small">Marge ' + marge + ' min · ' + best.duration + ' min de trajet · ' + esc(tripTitle(best)) + '</span>' + legsHtml(best, true) + '</div>';
    var fav = currentFav();
    if (fav) h += '<button type="button" class="btn btn-primary" data-act="favtime" data-time="' + hm(best.leave) + '">Retenir ' + hm(best.leave) + ' pour « ' + esc(fav.name) + ' »</button>';
    else h += '<p class="muted small">Enregistrez ce trajet en favori pour retenir cette heure.</p>';
    box.innerHTML = h;
  }
  function currentFav() { return state.favs.filter(function (f) { return samePlace(f.from, state.from) && samePlace(f.to, state.to); })[0]; }

  // ---------------------------------------------------------------- réglages
  function renderSettings() {
    var s = state.settings;
    $('#walkMax-out').textContent = s.walkMax + ' min';
    $('#minTransfer-out').textContent = s.minTransfer + ' min';
    $('#parking-out').textContent = s.parking + ' min';
    $('#walkSpeed').value = String(s.walkSpeed);
    $('#tomtomKey').value = s.tomtomKey || '';
    var h = '';
    state.favs.forEach(function (f) {
      h += '<div class="card fav-item"><span class="r-text"><input class="text-input" data-favname="' + esc(f.id) + '" value="' + esc(f.name) + '" aria-label="Nom du favori"><span style="margin-top:6px">' + esc(f.from.label) + ' → ' + esc(f.to.label) + (f.time ? ' · ' + esc(f.time) : '') + '</span></span>' +
        '<button type="button" class="icon-btn" data-delfav="' + esc(f.id) + '" aria-label="Supprimer ' + esc(f.name) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button></div>';
    });
    if (!state.favs.length) h = '<p class="muted small">Aucun favori. Dans l\'onglet Trajet, choisissez un départ et une arrivée puis « + Enregistrer ce trajet ».</p>';
    $('#fav-list').innerHTML = h;
  }
  function saveSettings() { store.set('settings', state.settings); }

  // ---------------------------------------------------------------- départ simulé
  function localDT(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function syncDepart(later) {
    $$('[data-dep]').forEach(function (x) { x.setAttribute('aria-pressed', String((x.dataset.dep === 'later') === !!later)); });
    $('#depart-pick').hidden = !later;
  }
  function setDepart(ms) {
    state.departAt = ms && !isNaN(ms) ? ms : null;
    syncDepart(!!state.departAt);
    state.result = null; state.car = null; state.selectedKey = null;
    if (state.to) compute({ full: true }); else render();
  }

  // ---------------------------------------------------------------- navigation
  function showTab(tab) {
    state.tab = tab;
    $$('.screen').forEach(function (s) { s.hidden = s.id !== 'screen-' + tab; });
    $$('.tabbar button').forEach(function (b) { if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var scr = $('#screen-' + tab);
    $('#screen-title').textContent = scr.dataset.title;
    $('#screens').scrollTop = 0;
    $('#screens').style.overflowY = tab === 'map' ? 'hidden' : 'auto';
    if (tab === 'map') renderMap();
    if (tab === 'when') { initWhen(); renderWhen(); }
    if (tab === 'settings') renderSettings();
  }

  // ---------------------------------------------------------------- événements
  function bind() {
    $$('.tabbar button').forEach(function (b) { b.addEventListener('click', function () { showTab(b.dataset.tab); }); });
    $('#from-btn').addEventListener('click', function () { openSearch('from'); });
    $('#to-btn').addEventListener('click', function () { openSearch('to'); });
    $('#swap-btn').addEventListener('click', function () {
      var f = state.from; state.from = state.to || GPS_PLACE; state.to = f && f.kind !== 'gps' ? f : null; saveState();
      state.result = null; state.car = null; compute({ full: true });
    });
    $('#fresh-pill').addEventListener('click', function () { if (state.to) { compute(); toast('Mise à jour des données…'); } });
    $('#search-close').addEventListener('click', function () { closeSheet('#search-sheet'); });
    $('#rejected-close').addEventListener('click', function () { closeSheet('#rejected-sheet'); });
    $('#search-input').addEventListener('input', onSearchInput);
    $('#search-results').addEventListener('click', function (e) { var b = e.target.closest('[data-place]'); if (b) pickPlace(b.dataset.place); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeSheet('#search-sheet'); closeSheet('#rejected-sheet'); } });

    $('#trip-results').addEventListener('click', function (e) {
      var a = e.target.closest('[data-act]'), k = e.target.closest('[data-key]');
      if (a) {
        var act = a.dataset.act;
        if (act === 'detail') { state.showDetail = !state.showDetail; render(); }
        if (act === 'rejected') openRejected();
        if (act === 'retry') compute({ full: true });
        if (act === 'now') setDepart(null);
        if (act === 'settings') showTab('settings');
        if (act === 'map') { mapSel = 'car'; showTab('map'); }
        return;
      }
      if (k) { state.selectedKey = k.dataset.key; state.showDetail = true; render(); $('#screens').scrollTop = 0; }
    });
    $('#fav-row').addEventListener('click', function (e) {
      var f = e.target.closest('[data-fav]'), s = e.target.closest('[data-act="savefav"]');
      if (f) {
        var fav = state.favs.filter(function (x) { return x.id === f.dataset.fav; })[0]; if (!fav) return;
        state.from = Object.assign({}, fav.from); state.to = fav.to; saveState();
        state.result = null; state.car = null; compute({ full: true });
      }
      if (s) {
        var short = function (p) { return p.kind === 'gps' ? 'Ici' : p.label.split(',')[0]; };
        state.favs.push({ id: 'f' + Date.now(), name: short(state.from) + ' → ' + short(state.to), from: state.from, to: state.to });
        store.set('favs', state.favs); renderFavs(); toast('Favori enregistré. Renommez-le dans Réglages.');
      }
    });
    $('#rejected-body').addEventListener('click', function (e) {
      var b = e.target.closest('[data-pick]'); if (!b) return;
      state.selectedKey = b.dataset.pick; state.showDetail = true; closeSheet('#rejected-sheet'); render(); toast('Trajet choisi.');
    });
    $('#map-sheet').addEventListener('click', function (e) { var b = e.target.closest('[data-mapkey]'); if (!b) return; mapSel = b.dataset.mapkey; if (mapSel !== 'car') state.selectedKey = mapSel; renderMap(); });

    $$('[data-dep]').forEach(function (b) { b.addEventListener('click', function () {
      if (b.dataset.dep === 'now') { setDepart(null); return; }
      var inp = $('#depart-time');
      if (!inp.value) { var d = new Date(Date.now() + 15 * 60000); d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0); inp.value = localDT(d); }
      $('#depart-pick').hidden = false; syncDepart(true); inp.focus();
      setDepart(Date.parse(inp.value));
    }); });
    $('#depart-time').addEventListener('change', function (e) { var v = Date.parse(e.target.value); if (!isNaN(v)) setDepart(v); });

    $$('#screen-when .segmented button').forEach(function (b) { b.addEventListener('click', function () {
      state.when.mode = b.dataset.mode; state.when.picked = null;
      $$('#screen-when .segmented button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      renderWhen();
    }); });
    $('#when-go').addEventListener('click', runWhen);
    $('#when-results').addEventListener('click', function (e) {
      var s = e.target.closest('[data-slot]'), f = e.target.closest('[data-act="favtime"]');
      if (s) { state.when.picked = +s.dataset.slot; renderWhen(); }
      if (f) { var fav = currentFav(); if (fav) { fav.time = f.dataset.time; store.set('favs', state.favs); renderFavs(); toast('Heure ' + fav.time + ' retenue pour « ' + fav.name + ' ».'); } }
    });

    $$('[data-step]').forEach(function (b) { b.addEventListener('click', function () {
      var k = b.dataset.step, lim = { walkMax: [0, 30], minTransfer: [1, 10], parking: [0, 40] }[k];
      state.settings[k] = Math.min(lim[1], Math.max(lim[0], state.settings[k] + (+b.dataset.delta)));
      saveSettings(); renderSettings(); if (k !== 'parking') state.result = null;
    }); });
    $('#walkSpeed').addEventListener('change', function (e) { state.settings.walkSpeed = +e.target.value; saveSettings(); state.result = null; });
    $('#tomtomKey').addEventListener('change', function (e) { state.settings.tomtomKey = e.target.value.trim(); saveSettings(); state.car = null; toast(state.settings.tomtomKey ? 'Clé enregistrée.' : 'Clé retirée.'); });
    $('#fav-list').addEventListener('click', function (e) {
      var d = e.target.closest('[data-delfav]'); if (!d) return;
      state.favs = state.favs.filter(function (f) { return f.id !== d.dataset.delfav; }); store.set('favs', state.favs); renderSettings(); renderFavs();
    });
    $('#fav-list').addEventListener('change', function (e) {
      var i = e.target.closest('[data-favname]'); if (!i) return;
      var f = state.favs.filter(function (x) { return x.id === i.dataset.favname; })[0]; if (f) { f.name = i.value.trim() || f.name; store.set('favs', state.favs); renderFavs(); }
    });

    // Recalcule après un changement de réglage, au retour sur l'onglet Trajet
    $$('.tabbar button[data-tab="trip"]').forEach(function (b) { b.addEventListener('click', function () { if (!state.result && state.to) compute({ full: true }); }); });

    // Mises à jour : chaque minute, et au retour dans l'appli
    setInterval(function () { if (document.visibilityState === 'visible' && state.to && state.tab !== 'settings' && !state.departAt) compute(); }, 60000);
    setInterval(function () { renderFresh(); if (state.result && state.tab === 'trip' && !document.querySelector('.sheet:not([hidden])')) { var y = $('#screens').scrollTop; render(); $('#screens').scrollTop = y; } }, 15000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && state.to && state.result && !state.departAt && Date.now() - state.result.fetchedAt > 45000) compute(); });
  }

  // ---------------------------------------------------------------- démo hors ligne
  var Demo = (function () {
    var S = {
      communet: { id: 'd1', name: 'Gland, Communet', lat: 46.4176, lon: 6.2663 },
      gare: { id: 'd2', name: 'Gland', lat: 46.4206, lon: 6.2705 },
      montoly: { id: 'd3', name: 'Gland, Montoly', lat: 46.4160, lon: 6.2720 },
      rolle: { id: 'd4', name: 'Rolle', lat: 46.4585, lon: 6.3365 },
      morges: { id: 'd5', name: 'Morges', lat: 46.5113, lon: 6.4983 },
      renens: { id: 'd6', name: 'Renens VD', lat: 46.5372, lon: 6.5786 },
      lausanne: { id: 'd7', name: 'Lausanne', lat: 46.5167, lon: 6.6291 },
      flon: { id: 'd8', name: 'Lausanne-Flon', lat: 46.5207, lon: 6.6300 },
      riponne: { id: 'd9', name: 'Lausanne, Riponne-M. Béjart', lat: 46.5238, lon: 6.6327 },
      chuv: { id: 'd10', name: 'Lausanne, CHUV', lat: 46.5253, lon: 6.6420 },
      sallaz: { id: 'd11', name: 'Lausanne, Sallaz', lat: 46.5327, lon: 6.6444 },
      fourmi: { id: 'd12', name: 'Lausanne, Fourmi', lat: 46.5363, lon: 6.6460 },
      malley: { id: 'd13', name: 'Prilly-Malley', lat: 46.5265, lon: 6.6105 }
    };
    var home = { lat: 46.4183, lon: 6.2651, acc: 12, ts: Date.now() };
    function st(s) { return { id: s.id, name: s.name, coordinate: { x: s.lat, y: s.lon } }; }
    function sec(cat, num, to, a, b, depMs, arrMs, extra, via) {
      var pass = [a].concat(via || []).concat([b]).map(function (s) { return { station: st(s) }; });
      var e = extra || {};
      return { journey: { category: cat, number: num, to: to, name: cat + ' ' + num, passList: pass },
        departure: { station: st(a), departureTimestamp: depMs / 1000, delay: e.delay != null ? e.delay : 0, platform: e.platform || null, prognosis: { departure: null, platform: e.platform || null } },
        arrival: { station: st(b), arrivalTimestamp: arrMs / 1000, delay: 0, prognosis: {} } };
    }
    function walk(a, b, depMs, arrMs) { return { walk: { duration: (arrMs - depMs) / 1000 }, departure: { station: st(a), departureTimestamp: depMs / 1000 }, arrival: { station: st(b), arrivalTimestamp: arrMs / 1000 } }; }
    function base(t) { var d = new Date(t); d.setSeconds(0, 0); return d.getTime(); }
    var M = 60000;
    function trainsFrom(t0) {
      // trains R toutes les 15 min environ depuis Gland, 31 min jusqu'à Lausanne
      var out = [], d = new Date(t0); d.setMinutes(d.getMinutes() < 24 ? 9 : d.getMinutes() < 39 ? 24 : d.getMinutes() < 54 ? 39 : 54, 0, 0);
      if (d.getTime() < t0 - 2 * M) d = new Date(d.getTime() + 15 * M);
      for (var i = 0; i < 6; i++) out.push(d.getTime() + i * 15 * M);
      return out;
    }
    function connections(o, d, when, isArrival) {
      var t0 = base(isArrival ? when - 75 * M : when), res = [];
      var busStop = o.id === S.communet.id || o.id === S.montoly.id;
      trainsFrom(t0 + (busStop ? 6 : 0) * M).forEach(function (tr, i) {
        var delay = i === 1 ? 4 : 0, secs = [], cap = [2, 3, 3, 2, 1, 1][i];
        if (busStop) secs.push(sec('B', o.id === S.communet.id ? (i % 2 ? '831' : '833') : '831', 'Gland, gare', o, S.gare, tr - 9 * M, tr - 3 * M, { platform: null }));
        var toFourmi = d.id === S.fourmi.id || d.id === S.sallaz.id || d.id === S.chuv.id;
        var viaRenens = i % 3 === 2;
        if (viaRenens) {
          secs.push(sec('R', '3', 'Lausanne', o.id === S.gare.id || busStop ? S.gare : o, S.renens, tr + delay * M, tr + 25 * M + delay * M, { platform: '1', delay: delay }, [S.rolle, S.morges]));
          secs.push(sec('T', '1', 'Lausanne-Flon', S.renens, S.flon, tr + 29 * M + delay * M, tr + 44 * M + delay * M, {}, [S.malley]));
          if (toFourmi) secs.push(sec('M', '2', 'Croisettes', S.flon, d, tr + 47 * M + delay * M, tr + 56 * M + delay * M, {}, [S.riponne, S.chuv, S.sallaz]));
        } else {
          secs.push(sec('R', '3', 'Lausanne', o.id === S.gare.id || busStop ? S.gare : o, S.lausanne, tr + delay * M, tr + 31 * M + delay * M, { platform: '1', delay: delay }, [S.rolle, S.morges, S.renens]));
          if (toFourmi) secs.push(sec('M', '2', 'Croisettes', S.lausanne, d, tr + 34 * M + delay * M, tr + 46 * M + delay * M, {}, [S.flon, S.riponne, S.chuv, S.sallaz]));
        }
        res.push({ sections: secs, capacity2nd: cap });
      });
      return res;
    }
    function nearby(p) {
      var all = [S.communet, S.gare, S.montoly, S.fourmi, S.sallaz, S.chuv, S.flon, S.lausanne, S.renens];
      return all.map(function (s) { return { id: s.id, name: s.name, coordinate: { x: s.lat, y: s.lon }, distance: Math.round(dist(p, s)) }; })
        .filter(function (s) { return s.distance < 2500; }).sort(function (a, b) { return a.distance - b.distance; });
    }
    function search(q) {
      q = q.toLowerCase();
      var places = Object.keys(S).map(function (k) { return { kind: 'station', id: S[k].id, label: S[k].name, lat: S[k].lat, lon: S[k].lon, sub: 'Arrêt' }; });
      places.push({ kind: 'address', label: 'Rue du Bugnon 46, 1011 Lausanne', lat: 46.5257, lon: 6.6430, sub: 'Adresse' });
      return places.filter(function (p) { return p.label.toLowerCase().indexOf(q) >= 0 || (q.indexOf('fourmi') >= 0 && p.id === S.fourmi.id); });
    }
    function car(f, t) {
      var km = dist(f, t) / 1000 * 1.25;
      return { travel: Math.round(km / 75 * 3600) + 14 * 60, delay: 14 * 60, km: km, fetchedAt: Date.now(), at: state.departAt,
        points: [[f.lat, f.lon], [46.44, 6.30], [46.49, 6.42], [46.52, 6.53], [46.545, 6.59], [t.lat, t.lon]] };
    }
    return { connections: connections, nearby: nearby, search: search, car: car, home: home,
      fourmi: { kind: 'station', id: S.fourmi.id, label: S.fourmi.name, lat: S.fourmi.lat, lon: S.fourmi.lon } };
  })();

  // ---------------------------------------------------------------- démarrage
  bind();
  showTab('trip');
  render();
  startGps();
  if (state.to && state.from.kind !== 'gps') compute({ full: true });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () {});
  // Test hors ligne : ?demo=1
  var framed = false; try { framed = window.self !== window.top; } catch (e) { framed = true; }
  if (/[?&]demo=1/.test(location.search) || framed) { enableDemo(); if (!state.to) { state.to = Demo.fourmi; } compute({ full: true }); }
})();
