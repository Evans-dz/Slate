/* Demo data. Loaded only when the URL carries ?demo — see store.js.
   Everything lives in memory for the session, so you can click around, drag cards,
   tick things off and nothing touches Supabase. Reload to start over.
   Dates are relative to today, so it always looks current. */
window.SlateDemo = (function () {
  "use strict";

  var now = new Date();
  function day(n) { var d = new Date(now); d.setDate(d.getDate() + n); return d; }
  function iso(d) { return d.toISOString(); }
  function ymd(d) {
    var m = d.getMonth() + 1, dd = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (dd < 10 ? "0" : "") + dd;
  }
  var DYLAN = "u_dylan", ZAC = "u_zac";

  function avatar(letter, colour) {
    return "data:image/svg+xml;utf8," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
      '<circle cx="24" cy="24" r="24" fill="' + colour + '"/>' +
      '<text x="24" y="31" font-family="sans-serif" font-size="19" fill="#fff" ' +
      'text-anchor="middle">' + letter + '</text></svg>');
  }

  var PEOPLE = [
    { id: DYLAN, name: "Dylan", avatarUrl: avatar("D", "#2C5849") },
    { id: ZAC,   name: "Zac",   avatarUrl: avatar("Z", "#8C3A2B") }
  ];

  var store = {
    projects: {
      p_ezhd:   { name: "EZHD",                   order: 1, createdAt: iso(day(-120)), createdBy: DYLAN },
      p_north:  { name: "Northside Dental",       order: 2, createdAt: iso(day(-48)),  createdBy: DYLAN },
      p_harper: { name: "Harper & Co Architects", order: 3, createdAt: iso(day(-11)),  createdBy: ZAC },
      p_me:     { name: "Personal",               order: 4, createdAt: iso(day(-90)),  createdBy: DYLAN }
    },

    spaces: {
      s_admin:   { projectId: "p_ezhd",   name: "Admin",       order: 1 },
      s_content: { projectId: "p_ezhd",   name: "Content",     order: 2 },
      s_client:  { projectId: "p_ezhd",   name: "Client work", order: 3 },
      s_launch:  { projectId: "p_north",  name: "Launch",      order: 1 },
      s_social:  { projectId: "p_north",  name: "Socials",     order: 2 },
      s_film:    { projectId: "p_harper", name: "Film",        order: 1 }
    },

    tasks: {
      t1:  { title: "Invoice run — everything outstanding since the 1st", status: "backlog",
             projectId: "p_ezhd", spaceId: "s_admin", assignee: ZAC, due: ymd(day(-2)), order: 1,
             createdAt: iso(day(-9)), createdBy: ZAC },
      t2:  { title: "Quarterly BAS", status: "backlog",
             projectId: "p_ezhd", spaceId: "s_admin", assignee: DYLAN, due: ymd(day(12)), order: 2,
             createdAt: iso(day(-4)), createdBy: DYLAN },
      t3:  { title: "Rewrite the pricing page copy and get Zac to sign off", status: "doing",
             projectId: "p_ezhd", spaceId: "s_content", assignee: DYLAN, due: ymd(day(2)), order: 1,
             createdAt: iso(day(-6)), createdBy: DYLAN },
      t4:  { title: "Shoot the studio reel", status: "backlog",
             projectId: "p_ezhd", spaceId: "s_content", assignee: null, due: null, order: 3,
             createdAt: iso(day(-3)), createdBy: DYLAN },
      t5:  { title: "Colour grade the Northside cut", status: "review",
             projectId: "p_ezhd", spaceId: "s_client", assignee: DYLAN, due: ymd(day(5)), order: 1,
             createdAt: iso(day(-2)), createdBy: DYLAN },
      t6:  { title: "Send the Northside deck", status: "done",
             projectId: "p_ezhd", spaceId: "s_admin", assignee: ZAC, due: null, order: 1,
             createdAt: iso(day(-14)), createdBy: ZAC },

      t7:  { title: "Deliver the final 60 second edit", status: "doing",
             projectId: "p_north", spaceId: "s_launch", assignee: ZAC, due: ymd(day(1)), order: 1,
             createdAt: iso(day(-7)), createdBy: ZAC },
      t8:  { title: "Captions and subtitles", status: "backlog",
             projectId: "p_north", spaceId: "s_launch", assignee: DYLAN, due: ymd(day(3)), order: 2,
             createdAt: iso(day(-5)), createdBy: DYLAN },
      t9:  { title: "Schedule the launch posts", status: "backlog",
             projectId: "p_north", spaceId: "s_social", assignee: ZAC, due: ymd(day(4)), order: 3,
             createdAt: iso(day(-5)), createdBy: ZAC },
      t10: { title: "Cut three vertical teasers", status: "review",
             projectId: "p_north", spaceId: "s_social", assignee: DYLAN, due: ymd(day(6)), order: 1,
             createdAt: iso(day(-3)), createdBy: DYLAN },

      t11: { title: "Location recce at the Fortitude Valley site", status: "doing",
             projectId: "p_harper", spaceId: "s_film", assignee: DYLAN, due: ymd(day(6)), order: 1,
             createdAt: iso(day(-2)), createdBy: DYLAN },
      t12: { title: "Quote the studio tour film", status: "backlog",
             projectId: "p_harper", spaceId: "s_film", assignee: DYLAN, due: ymd(day(0)), order: 2,
             createdAt: iso(day(-1)), createdBy: ZAC },

      t13: { title: "Fix the bike", status: "backlog",
             projectId: "p_me", spaceId: null, assignee: DYLAN, due: null, order: 1,
             createdAt: iso(day(-20)), createdBy: DYLAN },
      t14: { title: "Renew the domain", status: "backlog",
             projectId: "p_me", spaceId: null, assignee: DYLAN, due: ymd(day(9)), order: 2,
             createdAt: iso(day(-8)), createdBy: DYLAN }
    },

    notes: {
      n1: { title: "Client call — Northside",
            body: "They want the launch moved up. #northside #urgent\n\nBudget is flexible if we can hit the 14th. Ask Zac about studio availability, and check whether the old footage is still on the drive.",
            kind: "note", images: [], projectId: "p_north", spaceId: "s_launch",
            createdAt: iso(day(0)), createdBy: DYLAN, updatedAt: iso(day(0)), updatedBy: DYLAN },

      n2: { title: "",
            body: "remember to check whether the old analytics tag is still firing on the marketing site #todo",
            kind: "note", images: [], projectId: null, spaceId: null,
            createdAt: iso(day(0)), createdBy: ZAC, updatedAt: iso(day(0)), updatedBy: ZAC },

      n3: { title: "Harper brief — first pass",
            body: "Studio tour film, roughly three minutes. #harper\n\nTom wants it to feel like a walkthrough rather than a corporate piece. No voiceover if we can avoid it — let the building do the talking.\n\nShoot over two half days, natural light only.",
            kind: "note", images: [], projectId: "p_harper", spaceId: "s_film",
            createdAt: iso(day(-1)), createdBy: DYLAN, updatedAt: iso(day(-1)), updatedBy: DYLAN },

      n4: { title: "Prompt library",
            body: "## Tone of voice\n\nWrite in plain Australian English. No exclamation marks. Short sentences. Never say \"leverage\" or \"solutions\".\n\n## Client brief template\n\n- What are we making\n- Who is it for\n- What does done look like\n- What is the one thing it has to achieve\n\n## Transcript summary\n\n```\nSummarise the following call transcript in five bullets.\nLead with anything that changes scope, budget or deadline.\nFlag anything the client asked for that we did not agree to.\n```\n\n## Socials caption\n\n```\nWrite three caption options for this clip.\nUnder 120 characters. No hashtags. No emoji.\n```",
            kind: "doc", images: [], projectId: "p_ezhd", spaceId: "s_content",
            createdAt: iso(day(-16)), createdBy: DYLAN, updatedAt: iso(day(-2)), updatedBy: DYLAN },

      n5: { title: "Shoot plan sketch",
            body: "", kind: "board", images: [], projectId: "p_ezhd", spaceId: "s_client",
            createdAt: iso(day(-2)), createdBy: DYLAN, updatedAt: iso(day(-2)), updatedBy: DYLAN },

      n6: { title: "Ideas",
            body: "Long-form piece on why small studios beat agencies. #writing\n\nCould run as a three-parter. The Northside job is the obvious case study — we turned it around in nine days and an agency would still be in discovery.",
            kind: "note", images: [], projectId: "p_ezhd", spaceId: "s_content",
            createdAt: iso(day(-1)), createdBy: ZAC, updatedAt: iso(day(-1)), updatedBy: ZAC },

      n7: { title: "Gear list for the Harper shoot",
            body: "#harper\n\n- FX3 plus the 24-70\n- Two Aputure lights, probably won't need them\n- Slider\n- Spare batteries, the cold drains them\n- Lav for Tom if he agrees to talk on camera",
            kind: "note", images: [], projectId: "p_harper", spaceId: "s_film",
            createdAt: iso(day(-1)), createdBy: DYLAN, updatedAt: iso(day(-1)), updatedBy: DYLAN },

      n8: { title: "What worked on Northside",
            body: "Keeping the edit rounds to two was the whole thing. #process\n\nNext time put that in the quote so it's not a conversation later.",
            kind: "note", images: [], projectId: "p_ezhd", spaceId: "s_client",
            createdAt: iso(day(-4)), createdBy: ZAC, updatedAt: iso(day(-4)), updatedBy: ZAC },

      n9: { title: "",
            body: "call the framer back about the print for the studio wall",
            kind: "note", images: [], projectId: null, spaceId: null,
            createdAt: iso(day(-3)), createdBy: DYLAN, updatedAt: iso(day(-3)), updatedBy: DYLAN }
    },

    schedules: {
      sc1: { projectId: "p_ezhd", spaceId: "s_content", title: "Instagram post",
             freq: "weekly", days: [1, 2, 3, 4, 5], dayOfMonth: null, time: "08:00",
             startDate: ymd(day(-60)), endDate: null, done: {} },
      sc2: { projectId: "p_ezhd", spaceId: "s_admin", title: "Weekly invoice check",
             freq: "weekly", days: [5], dayOfMonth: null, time: "16:30",
             startDate: ymd(day(-60)), endDate: null, done: {} },
      sc3: { projectId: "p_ezhd", spaceId: null, title: "Monthly bookkeeping",
             freq: "monthly", days: [], dayOfMonth: 1, time: "09:00",
             startDate: ymd(day(-120)), endDate: null, done: {} },
      sc4: { projectId: "p_north", spaceId: "s_social", title: "Northside socials check",
             freq: "weekly", days: [2, 4], dayOfMonth: null, time: "10:00",
             startDate: ymd(day(-30)), endDate: null, done: {} }
    },

    prospects: {
      pr1: { company: "Riverside Dental", contact: "Dr Amy Chen", email: "amy@riversidedental.com.au",
             stage: "contacted",
             note: "Same setup as Northside — two chairs, family practice. Their site has no video at all and the photos look like stock. Lead with the Northside numbers.",
             next: ymd(day(-1)), order: 1,
             createdAt: iso(day(-14)), createdBy: DYLAN, updatedAt: iso(day(-4)), updatedBy: DYLAN },
      pr2: { company: "Bayside Orthodontics", contact: "", email: "",
             stage: "lead",
             note: "Found via the dental association list. Check their socials before reaching out — they may already have someone.",
             next: null, order: 2,
             createdAt: iso(day(-6)), createdBy: ZAC, updatedAt: iso(day(-6)), updatedBy: ZAC },
      pr3: { company: "Lumen Physio", contact: "", email: "hello@lumenphysio.com.au",
             stage: "lead",
             note: "Not dental, but the same shape of business. Worth one email to see if the case study travels.",
             next: ymd(day(2)), order: 3,
             createdAt: iso(day(-3)), createdBy: DYLAN, updatedAt: iso(day(-3)), updatedBy: DYLAN },
      pr4: { company: "Craft & Co Brewing", contact: "Sam Oduya", email: "sam@craftandco.com.au",
             stage: "talking",
             note: "Replied within the hour. Wants a quote for a launch film plus six months of socials. Send numbers by Friday — Zac to sanity check the retainer figure first.",
             next: ymd(day(3)), order: 4,
             createdAt: iso(day(-10)), createdBy: ZAC, updatedAt: iso(day(-1)), updatedBy: ZAC },
      pr5: { company: "Metro Fitness", contact: "Jess", email: "jess@metrofit.com.au",
             stage: "lost",
             note: "Went with an in-house hire. She was happy with the pitch though — try again mid next year.",
             next: null, order: 5,
             createdAt: iso(day(-40)), createdBy: ZAC, updatedAt: iso(day(-25)), updatedBy: ZAC }
    }
  };

  /* ---------- an in-memory stand-in for the db capability ---------- */

  var subs = [];
  function snapshotOf(col) {
    var rows = store[col] || {};
    return {
      docs: Object.keys(rows).map(function (id) {
        return { id: id, data: function () { return rows[id]; } };
      })
    };
  }
  function emit(col) {
    subs.forEach(function (s) { if (s.col === col) s.cb(snapshotOf(col)); });
  }
  function split(path) {
    var i = path.lastIndexOf("/");
    return { col: path.slice(0, i), id: path.slice(i + 1) };
  }
  function collection(col) {
    return {
      onSnapshot: function (cb) {
        subs.push({ col: col, cb: cb });
        setTimeout(function () { cb(snapshotOf(col)); }, 0);
        return function () { subs = subs.filter(function (s) { return s.cb !== cb; }); };
      },
      doc: function (id) { return doc(col + "/" + id); }
    };
  }
  function doc(path) {
    var p = split(path);
    return {
      set: function (d) {
        (store[p.col] = store[p.col] || {})[p.id] = JSON.parse(JSON.stringify(d));
        emit(p.col); return Promise.resolve();
      },
      update: function (patch) {
        var c = store[p.col] = store[p.col] || {};
        c[p.id] = Object.assign({}, c[p.id], JSON.parse(JSON.stringify(patch)));
        emit(p.col); return Promise.resolve();
      },
      delete: function () {
        if (store[p.col]) delete store[p.col][p.id];
        emit(p.col); return Promise.resolve();
      },
      collection: function (name) { return collection(path + "/" + name); }
    };
  }

  var blobs = {};

  return {
    api: {
      db: { collection: collection, doc: doc },
      user: {
        me: function () { return Promise.resolve(PEOPLE[0]); },
        can: function () { return Promise.resolve(true); },
        search: function (q) {
          return Promise.resolve(!q ? PEOPLE : PEOPLE.filter(function (p) {
            return p.name.toLowerCase().indexOf(q.toLowerCase()) > -1;
          }));
        },
        profiles: function (ids) {
          return Promise.resolve(PEOPLE.filter(function (p) { return ids.indexOf(p.id) > -1; }));
        }
      },
      assets: {
        upload: function (file) {
          return new Promise(function (res) {
            var r = new FileReader();
            r.onload = function () {
              var id = "a" + Math.random().toString(36).slice(2, 9);
              blobs[id] = r.result;
              res({ id: id });
            };
            r.readAsDataURL(file);
          });
        },
        delete: function (id) { delete blobs[id]; return Promise.resolve(); }
      },
      sample: null
    },
    blobUrl: function (id) { return blobs[id] || ""; }
  };
})();
