/* Slate service worker.
   The shell is cached so the app opens with no network; data still needs a
   connection, because Supabase requests carry auth and are never cached. */

var VERSION = "slate-v1";
var SHELL = [
  "/",
  "/index.html",
  "/config.js",
  "/store.js",
  "/vendor/supabase.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) {
      return c.addAll(SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function cacheFirst(req) {
  return caches.match(req).then(function (hit) {
    if (hit) return hit;
    return fetch(req).then(function (res) {
      if (res.ok) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put(req, copy); });
      }
      return res;
    });
  });
}

function networkFirst(req) {
  return fetch(req).then(function (res) {
    if (res.ok) {
      var copy = res.clone();
      caches.open(VERSION).then(function (c) { c.put(req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(req).then(function (hit) {
      return hit || caches.match("/index.html");
    });
  });
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);

  // Supabase: auth-bearing and live. Never cache, never serve stale.
  if (url.hostname.indexOf("supabase.co") > -1) return;

  // Navigations: network first so a new deploy lands, cache as the offline fallback.
  if (req.mode === "navigate") {
    e.respondWith(networkFirst(req));
    return;
  }

  // Fonts and same-origin assets: cache first, they're versioned or immutable.
  if (url.origin === location.origin ||
      url.hostname === "fonts.googleapis.com" ||
      url.hostname === "fonts.gstatic.com") {
    e.respondWith(cacheFirst(req));
  }
});
