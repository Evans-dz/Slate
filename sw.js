/* Slate service worker.
   The shell is cached so the app opens with no network; data still needs a
   connection, because Supabase requests carry auth and are never cached.
   Also receives the push briefs — see the handlers at the bottom. */

var VERSION = "slate-v6";
/* "/index.html" is deliberately absent: cleanUrls redirects it to "/", so caching
   it stores a redirected response, and returning one of those for a navigation is
   a network error rather than a page. "/" precaches the same bytes. */
var SHELL = [
  "/",
  "/config.js",
  "/store.js",
  "/lib/brief.js",
  "/lib/docmd.js",
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

/* Network first, but a phone on one bar of job-site signal can leave a fetch
   hanging for a minute rather than failing. Past the timeout, the cached copy
   answers and the fetch keeps going in the background to refresh the cache. */
var NET_TIMEOUT = 4000;
var staleClients = {};   // client id -> true when that page's HTML came from the cache
function networkFirst(req, timeout, onCache) {
  var fresh = fetch(req).then(function (res) {
    if (res.ok) {
      var copy = res.clone();
      caches.open(VERSION).then(function (c) { c.put(req, copy); });
    }
    return res;
  });
  fresh.catch(function () {});        // may lose the race and fail later, unobserved
  var timedOut = new Promise(function (resolve, reject) {
    setTimeout(function () { reject(new Error("slow")); }, timeout || NET_TIMEOUT);
  });
  return Promise.race([fresh, timedOut]).catch(function () {
    /* Offline. A push deep link is "/?view=today", which matches no cache key on
       its own — caches.match is query-sensitive — so fall back through the same
       URL ignoring its query, then to the shell. */
    return caches.match(req).then(function (hit) {
      if (hit) { if (onCache) onCache(); return hit; }
      return caches.match(req, { ignoreSearch: true }).then(function (h2) {
        if (h2) { if (onCache) onCache(); return h2; }
        if (req.mode === "navigate") { if (onCache) onCache(); return caches.match("/"); }
        return fresh;                    // nothing cached: wait for the network after all
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

  /* Navigations: network first so a new deploy lands, cache as the offline
     fallback. Which one answered is remembered per page, so that page's code
     comes from the same place: on one bar of signal the big HTML can miss the
     timeout while the small store.js makes it, and the page and its platform
     layer would come from two different builds. */
  if (req.mode === "navigate") {
    var cid = e.resultingClientId;
    if (cid) delete staleClients[cid];
    e.respondWith(networkFirst(req, NET_TIMEOUT, function () { if (cid) staleClients[cid] = true; }));
    return;
  }

  /* Code, config and the manifest: network first, cache as the offline fallback.
     These were cache-first and only refreshed when this file changed, so a deploy
     that touched store.js but not sw.js left every installed phone running the
     OLD store.js under the NEW index.html — the page and its platform layer from
     two different builds. Nothing here is fingerprinted, so nothing here can be
     trusted to be immutable. */
  if (url.origin === location.origin && !/^\/icons\//.test(url.pathname)) {
    if (e.clientId && staleClients[e.clientId]) { e.respondWith(cacheFirst(req)); return; }
    /* a page that loaded fresh had a working network a moment ago: give its code
       longer before falling back to a cached copy from another build */
    e.respondWith(networkFirst(req, e.clientId ? 10000 : NET_TIMEOUT));
    return;
  }

  /* Icons and fonts: cache first. They rarely change, but they are not
     fingerprinted either — when an icon is redrawn under the same URL, bump
     VERSION so activate drops the old cache and the new image is fetched. */
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
