/* Service worker : l'interface fonctionne hors connexion ; les données (horaires, trafic) viennent toujours du réseau. */
var CACHE = 'trajet-v1';
var SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'vendor/leaflet.js', 'vendor/leaflet.css', 'icons/icon.svg', 'icons/icon-192.png'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) { e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); })); });
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // API et tuiles : toujours en direct
  e.respondWith(fetch(e.request).then(function (r) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(e.request, copy); }); return r; }).catch(function () { return caches.match(e.request); }));
});
