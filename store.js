/* Slate's platform layer.
   Exposes the same four capabilities the Claude artifact runtime provided, so the
   app's render code keeps calling the interface it was written against:

     SlateStore.use("db")     -> collection().onSnapshot / doc().set/update/delete
     SlateStore.use("user")   -> me / can / search / profiles
     SlateStore.use("assets") -> upload / delete
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

  /* ?demo runs the app off in-memory sample data, with no Supabase and no sign in.
     Handy for looking at the thing before the project is configured, and for
     showing someone what it does without giving them your data. */
  var DEMO = /(^|[?&])demo(=|&|$)/.test(location.search);

  function loadDemo(){
    return new Promise(function(resolve, reject){
      var el = document.createElement("script");
      el.src = "demo.js";
      el.onload = function(){ resolve(window.SlateDemo.api); };
      el.onerror = function(){ reject(new Error("demo.js failed to load")); };
      document.head.appendChild(el);
    });
  }

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
    if (DEMO) return await loadDemo();
    if (!URL_ || !KEY_) {
      await loginScreen("Supabase isn't configured. Set supabaseUrl and supabaseAnonKey in config.js.");
      return {};
    }
    sb = window.supabase.createClient(URL_, KEY_, {
      auth: { persistSession: true, autoRefreshToken: true }
    });

    var got = await sb.auth.getSession();
    session = got.data.session;
    if (!session) {
      await loginScreen("");
      return {};
    }
    return { db: makeDb(), user: makeUser(), assets: makeAssets(), sample: null };
  })();

  /* ---------- db ---------- */

  /* Path parity with the original: odd segment count is a collection, even is a
     document. A subcollection is just a longer collection string — 'notes/x/strokes'
     is stored as-is, no tree. */
  function makeDb() {
    var cache = {};   // collection -> { id: data }
    var subs = {};    // collection -> [callback]
    var loaded = {};  // collection -> Promise
    var channel = null;

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

    function watch() {
      if (channel) return;
      channel = sb
        .channel("slate-docs")
        .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, function (p) {
          var row = p.new && p.new.collection ? p.new : p.old;
          if (!row) return;
          var col = row.collection;
          if (!(col in cache)) return; // nobody is listening to this collection
          if (p.eventType === "DELETE") delete cache[col][row.id];
          else cache[col][row.id] = row.data;
          emit(col);
        })
        .subscribe();
    }

    function hydrate(col) {
      if (loaded[col]) return loaded[col];
      cache[col] = cache[col] || {};
      loaded[col] = sb
        .from("docs")
        .select("id,data")
        .eq("collection", col)
        .then(function (r) {
          if (r.error) throw r.error;
          r.data.forEach(function (row) { cache[col][row.id] = row.data; });
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
          return sb
            .from("docs")
            .upsert({ collection: p.col, id: p.id, data: data, updated_at: new Date().toISOString() })
            .then(check);
        },
        update: function (patch) {
          var merged = Object.assign({}, (cache[p.col] || {})[p.id], patch);
          local(p.col, p.id, merged);
          return sb
            .from("docs")
            .upsert({ collection: p.col, id: p.id, data: merged, updated_at: new Date().toISOString() })
            .then(check);
        },
        delete: function () {
          local(p.col, p.id, null);
          return sb.from("docs").delete().eq("collection", p.col).eq("id", p.id).then(check);
        },
        collection: function (name) { return collection(path + "/" + name); }
      };
    }

    function check(r) {
      if (r.error) throw r.error;
      return r;
    }

    return { collection: collection, doc: doc };
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
      return all;
    }

    return {
      me: function () {
        return everyone().then(function (list) {
          var mine = list.filter(function (p) { return p.id === session.user.id; })[0];
          return mine || {
            id: session.user.id,
            name: session.user.email.split("@")[0],
            avatarUrl: fallbackAvatar(session.user.email)
          };
        });
      },
      can: function () {
        return Promise.resolve(true);
      },
      search: function (q) {
        return everyone().then(function (list) {
          if (!q) return list;
          var lq = q.toLowerCase();
          return list.filter(function (p) { return p.name.toLowerCase().indexOf(lq) > -1; });
        });
      },
      profiles: function (ids) {
        return everyone().then(function (list) {
          return list.filter(function (p) { return ids.indexOf(p.id) > -1; });
        });
      }
    };
  }

  /* ---------- assets ---------- */

  function makeAssets() {
    return {
      upload: function (file) {
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
      if (DEMO) return window.SlateDemo ? window.SlateDemo.blobUrl(id) : "";
      return URL_ + "/storage/v1/object/public/" + BUCKET + "/" + id;
    },
    signOut: function () {
      return sb.auth.signOut().then(function () { location.reload(); });
    }
  };
})();
