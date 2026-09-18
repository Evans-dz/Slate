/* Slate's platform layer.
   Exposes the same four capabilities the Claude artifact runtime provided, so the
   app's render code keeps calling the interface it was written against:

     SlateStore.use("db")     -> collection().onSnapshot / doc().set/update/delete
     SlateStore.use("user")   -> me / can / search / profiles
     SlateStore.use("assets") -> upload / delete
     SlateStore.use("push")   -> subscribe / unsubscribe / test (the notification briefs)
     SlateStore.use("sample") -> handwriting transcription (null until /api/transcribe is wired)

   Everything is backed by Supabase: one `docs` table for every collection, realtime
   for live updates, auth for identity, storage for images. */
window.SlateStore = (function () {
  "use strict";

  var URL_ = window.SLATE_CONFIG && window.SLATE_CONFIG.supabaseUrl;
  var KEY_ = window.SLATE_CONFIG && window.SLATE_CONFIG.supabaseAnonKey;
  var BUCKET = "slate-assets";

  var sb = null;
  var session = null;

  /* ---------- login ---------- */

  function loginScreen(message) {
    return new Promise(function () {
      var wrap = document.createElement("div");
      wrap.id = "slateLogin";
      wrap.innerHTML =
        '<form>' +
        '<div class="lbrand"><span class="mark"></span><span>Slate</span></div>' +
        '<p class="lsub">Sign in to your projects and notes.</p>' +
        '<label for="lem">Email</label>' +
        '<input id="lem" type="email" autocomplete="username" required>' +
        '<label for="lpw">Password</label>' +
        '<input id="lpw" type="password" autocomplete="current-password" required>' +
        '<button type="submit">Sign in</button>' +
        '<p class="lerr"></p>' +
        '</form>';
      document.body.appendChild(wrap);

      var form = wrap.querySelector("form");
      var err = wrap.querySelector(".lerr");
      if (message) err.textContent = message;

      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var btn = form.querySelector("button");
        btn.disabled = true;
        btn.textContent = "Signing in…";
        err.textContent = "";
        sb.auth
          .signInWithPassword({
            email: wrap.querySelector("#lem").value.trim(),
            password: wrap.querySelector("#lpw").value
          })
          .then(function (r) {
            if (r.error) throw r.error;
            location.reload();
          })
          .catch(function (e2) {
            err.textContent = e2.message || "That didn't work.";
            btn.disabled = false;
            btn.textContent = "Sign in";
          });
      });
      // never resolves: the page reloads on success
    });
  }

  /* ---------- boot ---------- */

  var ready = (async function () {
    if (!URL_ || !KEY_) {
      await loginScreen("Supabase isn't configured. Set supabaseUrl and supabaseAnonKey in config.js.");
      return {};
    }
    sb = window.supabase.createClient(URL_, KEY_, {
      auth: { persistSession: true, autoRefreshToken: true }
    });

    var got = await sb.auth.getSession();
    session = got.data.session;

    /* getSession() tries to refresh a token within 90 seconds of expiring, and
       offline that refresh fails and it hands back no session at all. Taking that
       at face value sends someone in a basement to a sign-in screen they cannot
       possibly complete — with their unsynced work sitting behind it. A session
       we stored earlier is still proof of who they are, so boot on it and let the
       refresh happen when there's signal. */
    if (!session) {
      var stored = storedSession();
      if (stored) session = stored;
    }

    if (!session) {
      await loginScreen("");
      return {};
    }
    return { db: makeDb(), user: makeUser(), assets: makeAssets(), push: makePush(), sample: null };
  })();

  /* supabase-js persists the session here itself; we only ever read it. */
  function storedSession() {
    try {
      var host = URL_.replace(/^https?:\/\//, "").split(".")[0];
      var raw = localStorage.getItem("sb-" + host + "-auth-token");
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (s && s.currentSession) s = s.currentSession;   // older shape
      return s && s.access_token && s.user ? s : null;
    } catch (e) { return null; }
  }

  /* ---------- outbox ----------
     Writes that couldn't reach the server, kept on disk until they can.

     IndexedDB rather than localStorage for two concrete reasons: a page of
     handwriting is chunked at ~170KB per document and would blow the 5MB cap on
     its own, and localStorage writes are synchronous on the main thread — between
     pen strokes, on a phone.

     ONE RECORD PER PATH, replaced wholesale. That is only sound because every
     write in this file ends in an upsert of the WHOLE document, and update()
     merges its patch over the cache (which already holds the pending value)
     first. So the newest record is always the complete current document and
     older ones for that path carry nothing extra. A real partial PATCH, an RPC,
     or a counter would be silently coalesced away by this — see ARCHITECTURE.md. */

  var OUTBOX_MAX = 500;            // records
  var OUTBOX_BYTES = 20 * 1024 * 1024;

  var onOutbox = null;             // the app registers one listener for the count
  var outboxState = { pending: 0, stuck: false };

  var idb = null;
  function openOutbox() {
    if (idb) return idb;
    idb = new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open("slate", 1); } catch (e) { return reject(e); }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains("outbox")) db.createObjectStore("outbox", { keyPath: "key" });
        if (!db.objectStoreNames.contains("failed")) db.createObjectStore("failed", { keyPath: "key" });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error("IndexedDB blocked")); };
    });
    return idb;
  }

  function idbDo(store, mode, fn) {
    return openOutbox().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, mode);
        var out = fn(tx.objectStore(store));
        // resolve on COMMIT, not on the request: only then is it really on disk
        tx.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error("aborted")); };
      });
    });
  }

  /* ---------- db ---------- */

  /* Path parity with the original: odd segment count is a collection, even is a
     document. A subcollection is just a longer collection string — 'notes/x/strokes'
     is stored as-is, no tree. */
  function makeDb() {
    var cache = {};   // collection -> { id: data }
    var subs = {};    // collection -> [callback]
    var loaded = {};  // collection -> Promise
    var channel = null;

    /* in-memory mirror of the outbox: collection -> { id: {op, data} }.
       THE INVARIANT: cache is always server state with pending applied last. An
       entry stays here until the server confirms it, including while it is in
       flight — never remove on send. cache[col] is only ever assigned by
       resync(), hydrate() and local(); the first two MUST end in overlay(), and
       any fourth door added later silently reintroduces the wipe. */
    var pending = {};
    var seq = 0;
    var outboxReady = loadOutbox();

    function pendingCount() {
      var n = 0;
      Object.keys(pending).forEach(function (c) { n += Object.keys(pending[c]).length; });
      return n;
    }

    function overlay(col, rows) {
      var p = pending[col];
      if (!p) return rows;
      Object.keys(p).forEach(function (id) {
        if (p[id].op === "del") delete rows[id];
        else rows[id] = p[id].data;
      });
      return rows;
    }

    function loadOutbox() {
      return idbDo("outbox", "readonly", function (s) { return s.getAll(); })
        .then(function (recs) {
          (recs || []).forEach(function (r) {
            if (session && r.uid && r.uid !== session.user.id) return;  // the other account's work
            (pending[r.col] = pending[r.col] || {})[r.id] = { op: r.op, data: r.data };
            if (r.seq >= seq) seq = r.seq + 1;
          });
          if (recs && recs.length) report();
        })
        .catch(function () { /* no IDB (private browsing): behave as it did before */ });
    }

    /* Verified against the vendored client rather than assumed: postgrest-js
       never rejects on a transport failure — it resolves with status 0 and an
       empty error.code. So the status, which only lives on the response, is the
       evidence, and classification has to happen here where we still hold it. */
    function retryable(r) {
      if (!r || !r.error) return false;
      if (r.status === 0) return true;                 // the request never left the device
      if (r.status === 408 || r.status === 429) return true;
      if (r.status >= 500) return true;                // pooler or Postgres bounced
      /* 401/403/42501 look like a permission denial but cannot be one here: the
         docs policy is "to authenticated using (true)", so a signed-in user is
         never refused a row. What they actually mean is that a token refresh
         failed and the client fell back to the anon key. Hold, never drop. */
      if (r.status === 401 || r.status === 403) return true;
      var c = r.error.code;
      return c === "42501" || c === "PGRST301" || c === "PGRST303";
    }

    function enqueue(col, id, op, data) {
      var key = col + " " + id;
      var rec = {
        key: key, col: col, id: id, op: op,
        // a shallow copy: saveInk hands down the live stroke array and keeps
        // pushing into it, so the mirror would otherwise drift from the record
        data: op === "del" ? null : shallow(data),
        seq: seq++, uid: session ? session.user.id : null, at: new Date().toISOString()
      };
      var count = pendingCount();
      var already = pending[col] && pending[col][id];
      if (!already && count >= OUTBOX_MAX) {
        var full = new Error("There are too many unsaved changes on this device already.");
        full.code = "queue_full";
        return Promise.reject(full);
      }
      return idbDo("outbox", "readwrite", function (s) { return s.put(rec); })
        .then(function () {
          (pending[col] = pending[col] || {})[id] = { op: op, data: rec.data };
          report();
          scheduleFlush(0);
        });
    }

    function shallow(o) {
      if (!o || typeof o !== "object") return o;
      var c = Array.isArray(o) ? o.slice() : Object.assign({}, o);
      Object.keys(c).forEach(function (k) { if (Array.isArray(c[k])) c[k] = c[k].slice(); });
      return c;
    }

    /* Every write goes through here. Try the network; if the failure is one that
       could succeed later, put it on disk and RESOLVE — the bytes are saved, and
       telling the caller otherwise would fire "that change didn't save" over a
       change that did. Only a genuinely fatal error, or no usable IndexedDB,
       still rejects, which is exactly what happened before this existed. */
    function send(col, id, op, data, attempt) {
      if (navigator.onLine === false) return enqueue(col, id, op, data);   // trustworthy only as a negative
      if (pending[col] && pending[col][id]) return enqueue(col, id, op, data); // don't race the flusher
      return attempt().then(function (r) {
        if (!r || !r.error) { offlineStreak = 0; return r; }
        if (retryable(r)) { noteStreak(r); return enqueue(col, id, op, data); }
        throw r.error;
      }, function (e) {
        throw e;                                    // synchronous/serialisation failure: fatal
      });
    }

    var offlineStreak = 0;
    function noteStreak(r) {
      /* status 0 while the device insists it is online is what a wrong URL or a
         CORS problem looks like; without this it queues in silence until the cap */
      if (r.status === 0 && navigator.onLine !== false) offlineStreak++;
      else offlineStreak = 0;
    }

    function report() {
      outboxState = { pending: pendingCount(), stuck: offlineStreak >= 5 };
      if (onOutbox) onOutbox(outboxState);
    }

    var flushT = null, flushing = false, backoff = 2000;
    function scheduleFlush(delay) {
      if (flushT) return;
      flushT = setTimeout(function () { flushT = null; flush(); }, delay || 0);
    }

    function flush() {
      if (flushing || !pendingCount()) return Promise.resolve();
      flushing = true;
      var run = function () { return drain(); };
      /* a Safari tab and the installed PWA share one IndexedDB; without this the
         two can both take the same record and one of them loses it unattempted */
      var p = (navigator.locks && navigator.locks.request)
        ? navigator.locks.request("slate-flush", { ifAvailable: true }, function (lock) {
            return lock ? run() : null;
          })
        : run();
      return Promise.resolve(p).catch(function () {}).then(function () { flushing = false; });
    }

    function drain() {
      return idbDo("outbox", "readonly", function (s) { return s.getAll(); })
        .then(function (recs) {
          recs = (recs || []).sort(function (a, b) { return a.seq - b.seq; });
          var ok = true;
          return recs.reduce(function (chain, rec) {
            return chain.then(function () {
              if (!ok) return;                               // stop the pass, keep the rest
              if (session && rec.uid && rec.uid !== session.user.id) return;
              return sendRecord(rec).then(function (res) {
                if (res === "retry") { ok = false; return; }
                return idbDo("outbox", "readwrite", function (s) { return s.delete(rec.key); })
                  .then(function () {
                    var p = pending[rec.col];
                    // only forget it if nothing newer replaced it while in flight
                    if (p && p[rec.id] && p[rec.id].seq === undefined) delete p[rec.id];
                    if (p && !Object.keys(p).length) delete pending[rec.col];
                    report();
                  });
              });
            });
          }, Promise.resolve()).then(function () {
            if (!pendingCount()) { backoff = 2000; resyncSoon(); return; }
            if (ok) return;
            backoff = Math.min(60000, Math.round(backoff * 1.8));
            setTimeout(function () { scheduleFlush(0); }, backoff);
          });
        })
        .catch(function () {});
    }

    function sendRecord(rec) {
      var q = rec.op === "del"
        ? sb.from("docs").delete().eq("collection", rec.col).eq("id", rec.id)
        : sb.from("docs").upsert(
            { collection: rec.col, id: rec.id, data: rec.data, updated_at: rec.at },
            { onConflict: "collection,id" });
      return Promise.resolve(q).then(function (r) {
        if (!r || !r.error) { offlineStreak = 0; return "done"; }
        if (retryable(r)) { noteStreak(r); report(); return "retry"; }
        return park(rec, r.error).then(function () { return "done"; });
      }, function () { return "retry"; });
    }

    /* A write the server will never accept is parked rather than deleted: the
       words stay on the device instead of evaporating, and one bad record can't
       block everything behind it. */
    function park(rec, err) {
      rec.error = (err && err.message) || "rejected";
      return idbDo("failed", "readwrite", function (s) { return s.put(rec); })
        .catch(function () {});
    }

    function emit(col) {
      var rows = cache[col] || {};
      var snap = {
        docs: Object.keys(rows).map(function (id) {
          var d = rows[id];
          return { id: id, data: function () { return d; } };
        })
      };
      (subs[col] || []).forEach(function (cb) { cb(snap); });
    }

    /* Re-read every collection currently on screen and replace the cache with
       what the server has. Postgres change events are not replayed, so anything
       the other person did while this device was asleep or offline would stay
       invisible until a reload — on a phone that backgrounds constantly, that's
       most of the time. Replacing rather than merging is what makes their
       deletions show up too. */
    function resync() {
      Object.keys(loaded).forEach(function (col) {
        fetchAll(col).then(function (fresh) {
          if (!fresh) return;                        // offline; the next wake tries again
          cache[col] = overlay(col, fresh);          // pending goes back on top
          emit(col);
        });
      });
    }

    /* Every response is capped at the project's Max Rows (1000 by default), so a
       plain select quietly stops there. Page until a short one comes back, and
       resolve null on error rather than throwing into a background resync. */
    function fetchAll(col) {
      var acc = {}, cap = null;
      function page(from) {
        return sb.from("docs").select("id,data").eq("collection", col)
          .order("id").range(from, from + 999)
          .then(function (r) {
            if (r.error) return null;
            r.data.forEach(function (row) { acc[row.id] = row.data; });
            if (cap === null) cap = r.data.length;
            if (!r.data.length || r.data.length < cap) return acc;
            return page(from + r.data.length);
          });
      }
      return page(0);
    }

    var resyncT = null;
    function resyncSoon() {                          // coalesce bursts of wake events
      clearTimeout(resyncT);
      resyncT = setTimeout(resync, 250);
    }

    function watch() {
      if (channel) return;
      channel = sb
        .channel("slate-docs")
        .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, function (p) {
          var row = p.new && p.new.collection ? p.new : p.old;
          if (!row) return;
          var col = row.collection;
          if (!(col in cache)) return; // nobody is listening to this collection
          /* the third door, and the one that fires most: an event carrying the
             other device's older copy would otherwise clobber a write of ours
             that hasn't flushed yet — mid-typing, while online */
          if (pending[col] && pending[col][row.id]) return;
          if (p.eventType === "DELETE") delete cache[col][row.id];
          else cache[col][row.id] = row.data;
          emit(col);
        })
        .subscribe(function (status) {
          /* A channel that errors or times out never comes back on its own, and
             a silent dead channel looks exactly like "nobody changed anything".
             Tear it down and rebuild; every fresh subscription re-syncs, which
             also closes the gap where events were missed. */
          if (status === "SUBSCRIBED") {
            resyncSoon();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            if (!channel) return;
            var dead = channel;
            channel = null;
            try { sb.removeChannel(dead); } catch (e) {}
            setTimeout(watch, 2000);
          }
        });
    }

    /* Coming back to the foreground, or back onto a network, are the two moments
       a phone has most likely missed changes. */
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) { watch(); resyncSoon(); scheduleFlush(0); }
      });
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", function () { watch(); resyncSoon(); scheduleFlush(0); });
    }
    /* onLine and its event are not dependable in a truck — a tunnel often
       produces no event at all — so a slow timer backs them up whenever there is
       anything waiting. */
    setInterval(function () { if (pendingCount()) scheduleFlush(0); }, 30000);
    outboxReady.then(function () { scheduleFlush(500); });

    function hydrate(col) {
      if (loaded[col]) return loaded[col];
      cache[col] = cache[col] || {};
      loaded[col] = outboxReady.then(function () {
        return fetchAll(col);
      }).then(function (rows) {
        if (!rows) throw new Error("Couldn't load " + col);
        Object.keys(rows).forEach(function (id) { cache[col][id] = rows[id]; });
        overlay(col, cache[col]);
        emit(col);
      });
      return loaded[col];
    }

    function split(path) {
      var i = path.lastIndexOf("/");
      return { col: path.slice(0, i), id: path.slice(i + 1) };
    }

    function local(col, id, data) {           // optimistic
      cache[col] = cache[col] || {};
      if (data === null) delete cache[col][id];
      else cache[col][id] = data;
      if (subs[col] && subs[col].length) emit(col);
    }

    function collection(col) {
      return {
        onSnapshot: function (cb, onErr) {
          subs[col] = subs[col] || [];
          subs[col].push(cb);
          watch();
          hydrate(col).catch(function (e) { if (onErr) onErr(e); });
          return function () {
            subs[col] = (subs[col] || []).filter(function (f) { return f !== cb; });
            /* Forget the collection entirely once nobody is watching it, or every
               whiteboard opened this session stays in `loaded` and resync() re-pages
               all of them — 170KB documents each — on the first bar of signal,
               alongside the flush. Anything still pending keeps its cache. */
            if (!subs[col].length && !(pending[col] && Object.keys(pending[col]).length)) {
              delete subs[col];
              delete loaded[col];
              delete cache[col];
            }
          };
        },
        doc: function (id) { return doc(col + "/" + id); }
      };
    }

    function doc(path) {
      var p = split(path);
      return {
        set: function (data) {
          local(p.col, p.id, data);
          return send(p.col, p.id, "put", data, function () {
            return sb.from("docs").upsert(
              { collection: p.col, id: p.id, data: data, updated_at: new Date().toISOString() },
              { onConflict: "collection,id" });
          });
        },
        update: function (patch) {
          var base = (cache[p.col] || {})[p.id];
          /* Every write here upserts the WHOLE document, so merging a patch onto
             a document the cache doesn't have would send the patch alone AS the
             document — erasing title, project, order, everything absent from it.
             Online that was masked because the UI only patches what it is
             showing; queued, it would be transmitted faithfully. */
          if (!base) {
            var e = new Error("Can't update " + p.col + "/" + p.id + " before it has loaded");
            e.code = "not_loaded";
            return Promise.reject(e);
          }
          var merged = Object.assign({}, base, patch);
          local(p.col, p.id, merged);
          return send(p.col, p.id, "put", merged, function () {
            return sb.from("docs").upsert(
              { collection: p.col, id: p.id, data: merged, updated_at: new Date().toISOString() },
              { onConflict: "collection,id" });
          });
        },
        delete: function () {
          local(p.col, p.id, null);
          return send(p.col, p.id, "del", null, function () {
            return sb.from("docs").delete().eq("collection", p.col).eq("id", p.id);
          });
        },
        collection: function (name) { return collection(path + "/" + name); }
      };
    }

    function check(r) {
      if (r.error) throw r.error;
      return r;
    }

    return {
      collection: collection,
      doc: doc,
      outbox: function (cb) { onOutbox = cb; if (cb) cb(outboxState); },
      flushNow: function () { return flush(); },
      pendingCount: pendingCount
    };
  }

  /* ---------- user ---------- */

  function initials(name) {
    var parts = (name || "?").trim().split(/\s+/);
    return ((parts[0] || "")[0] || "?").toUpperCase() + (parts[1] ? parts[1][0].toUpperCase() : "");
  }

  function fallbackAvatar(name) {
    var hue = 0;
    for (var i = 0; i < (name || "").length; i++) hue = (hue * 31 + name.charCodeAt(i)) % 360;
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
      '<circle cx="24" cy="24" r="24" fill="hsl(' + hue + ',32%,34%)"/>' +
      '<text x="24" y="31" font-family="sans-serif" font-size="18" fill="#fff" text-anchor="middle">' +
      initials(name) +
      "</text></svg>";
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  }

  function makeUser() {
    var all = null;

    function everyone() {
      if (all) return all;
      all = sb
        .from("profiles")
        .select("id,name,avatar_url")
        .then(function (r) {
          if (r.error) throw r.error;
          return r.data.map(function (p) {
            return { id: p.id, name: p.name, avatarUrl: p.avatar_url || fallbackAvatar(p.name) };
          });
        });
      /* Memoising the REJECTION was fatal offline: the boot sequence awaits
         user.me() unguarded, so one failed profiles read left S.db unset and the
         app read-only for the rest of the session — with no way back but a
         reload it could not do. Forget a failure so the next call retries. */
      all.catch(function () { all = null; });
      return all;
    }

    return {
      /* identity must never depend on the network: the session already carries it */
      me: function () {
        return everyone().catch(function () { return []; }).then(function (list) {
          var mine = list.filter(function (p) { return p.id === session.user.id; })[0];
          var email = session.user.email || "";
          return mine || {
            id: session.user.id,
            name: email.split("@")[0] || "You",
            avatarUrl: fallbackAvatar(email || "You")
          };
        });
      },
      can: function () {
        return Promise.resolve(true);
      },
      /* these feed render code that doesn't catch; offline they return nothing
         rather than rejecting into an unhandled promise */
      search: function (q) {
        return everyone().catch(function () { return []; }).then(function (list) {
          if (!q) return list;
          var lq = q.toLowerCase();
          return list.filter(function (p) { return p.name.toLowerCase().indexOf(lq) > -1; });
        });
      },
      /* keyed by id, because that's how the render code reads it:
         paintPeople does ps[node.dataset.uid] and the task sheet does ps[uid].
         Returning an array here made every avatar and owner name resolve to
         undefined and silently fall back to a blank. */
      profiles: function (ids) {
        return everyone().catch(function () { return []; }).then(function (list) {
          var byId = {};
          list.forEach(function (p) { if (ids.indexOf(p.id) > -1) byId[p.id] = p; });
          return byId;
        });
      }
    };
  }

  /* ---------- push ---------- */

  /* Talks to the /api/push functions with the caller's Supabase token, fetched
     fresh per call because access tokens rotate. The render code hands over the
     PushSubscription and never sees the API or the token. */
  function makePush() {
    function call(path, body) {
      return sb.auth.getSession().then(function (got) {
        var token = got.data.session && got.data.session.access_token;
        if (!token) throw new Error("Not signed in");
        return fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
          body: JSON.stringify(body || {})
        });
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (j) {
          if (!res.ok) throw new Error(j.error || "Request failed (" + res.status + ")");
          return j;
        });
      });
    }
    return {
      subscribe: function (subscription) {
        return call("/api/push/subscribe", { subscription: subscription, userAgent: navigator.userAgent });
      },
      unsubscribe: function (endpoint) {
        return call("/api/push/unsubscribe", { endpoint: endpoint });
      },
      test: function () {
        return call("/api/push/test");
      }
    };
  }

  /* ---------- assets ---------- */

  function makeAssets() {
    return {
      upload: function (file) {
        /* Blobs aren't queued — see ARCHITECTURE.md — so say so immediately
           rather than hanging for thirty seconds on a dead connection. The note's
           text still saves; only the picture waits. */
        if (navigator.onLine === false) {
          var off = new Error("Images need a connection.");
          off.code = "offline";
          return Promise.reject(off);
        }
        var ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
        var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + "." + ext;
        return sb.storage
          .from(BUCKET)
          .upload(id, file, { contentType: file.type, cacheControl: "31536000" })
          .then(function (r) {
            if (r.error) throw r.error;
            return { id: id };
          });
      },
      delete: function (id) {
        return sb.storage.from(BUCKET).remove([id]).then(function (r) {
          if (r.error) throw r.error;
        });
      }
    };
  }

  return {
    use: function (name) {
      return ready.then(function (api) { return api[name] || null; });
    },
    blobUrl: function (id) {
      return URL_ + "/storage/v1/object/public/" + BUCKET + "/" + id;
    },
    /* Signing out drops the session the outbox needs to replay under, so anything
       still waiting would become unreplayable. The caller decides. */
    pendingWrites: function () { return outboxState.pending; },
    signOut: function () {
      return sb.auth.signOut().then(function () { location.reload(); });
    }
  };
})();
