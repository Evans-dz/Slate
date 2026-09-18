/* Slate service worker.
   The shell is cached so the app opens with no network; data still needs a
   connection, because Supabase requests carry auth and are never cached.
   Also receives the push briefs — see the handlers at the bottom. */

var VERSION = "slate-v4";
/* "/index.html" is deliberately absent: cleanUrls redirects it to "/", so caching
   it stores a redirected response, and returning one of those for a navigation is
   a network error rather than a page. "/" precaches the same bytes. */
var SHELL = [
  "/",
  "/config.js",
  "/store.js",
  "/lib/brief.js",
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
    /* Offline. A push deep link is "/?view=today", which matches no cache key on
       its own — caches.match is query-sensitive — so fall back through the same
       URL ignoring its query, then to the shell. */
    return caches.match(req).then(function (hit) {
      if (hit) return hit;
      return caches.match(req, { ignoreSearch: true }).then(function (h2) {
        return h2 || caches.match("/");
      });
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

  // config.js is deploy-time configuration — network first, or a changed key
  // sits stale in the cache forever (vercel.json marks it must-revalidate for
  // the same reason). The cached copy is only the offline fallback.
  if (url.origin === location.origin && url.pathname === "/config.js") {
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

/* ---------- push briefs ---------- */
/* Payloads come from /api/cron/* and /api/push/test as
   { title, body, url, tag }. The tag replaces yesterday's brief of the same
   kind instead of stacking a pile of stale ones. */

self.addEventListener("push", function (e) {
  var data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(
    self.registration.showNotification(data.title || "Slate", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      data: { url: data.url || "/?view=today" },
      tag: data.tag || "slate"
    })
  );
});

/* Tapping a brief lands on the Today page: reuse a window that's already open
   by telling it to switch views, otherwise open one at the deep link. */
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || "/?view=today";
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      var open = list.filter(function (c) { return new URL(c.url).origin === location.origin; })[0];
      if (open) {
        open.postMessage({ kind: "open-view", url: url });
        return open.focus();
      }
      return clients.openWindow(url);
    })
  );
});
