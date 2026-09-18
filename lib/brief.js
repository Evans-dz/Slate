/* Slate's brief logic: what goes in the morning and evening push notifications,
   and in the Today page behind them. One module, two consumers — index.html loads
   it as window.SlateBrief, the /api functions require() it — so the grouping and
   the wording can never drift apart.

   Everything works on plain data: pass { projects, spaces, tasks, schedules } as
   arrays of { id, ...fields }, the shape both docsToArray (client) and the cron
   routes (server) produce. Dates are computed in America/Denver regardless of
   where the code runs; "today" on a Vercel box in UTC is still today in Denver. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SlateBrief = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var TZ = "America/Denver";

  /* Column semantics, mirrored from the app: columns live on the space, else the
     project, else the defaults, and the last column always means done. */
  var DEFAULT_COLUMNS = [
    { id: "todo",  name: "To-do" },
    { id: "doing", name: "In progress" },
    { id: "done",  name: "Done" }
  ];

  var DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /* ---------- dates ---------- */

  /* The calendar date in Denver for a given instant: { ymd, dow, label }.
     dow is 0=Sun..6=Sat; label reads "Thu, Sep 18". */
  function denverToday(now) {
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short"
    }).formatToParts(now || new Date());
    var m = {};
    parts.forEach(function (p) { m[p.type] = p.value; });
    var ymd = m.year + "-" + m.month + "-" + m.day;
    return { ymd: ymd, dow: DOW_NAMES.indexOf(m.weekday), label: labelFor(ymd) };
  }

  /* The Denver calendar date an ISO timestamp falls on, or null. */
  function ymdInDenver(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d)) return null;
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(d);
    var m = {};
    parts.forEach(function (p) { m[p.type] = p.value; });
    return m.year + "-" + m.month + "-" + m.day;
  }

  function labelFor(ymd) {
    var p = ymd.split("-");
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    return DOW_NAMES[d.getUTCDay()] + ", " + MONTH_NAMES[d.getUTCMonth()] + " " + (+p[2]);
  }

  function isWeekend(dow) { return dow === 0 || dow === 6; }

  /* The hour in Denver right now, 0-23. Cron schedules are UTC, so a fixed one
     lands an hour earlier once Denver leaves daylight time — a brief meant for
     7am arriving at 6am. Two schedules are registered per brief, one for each
     offset, and this is what lets the wrong one bow out. Hobby's ±59-minute
     jitter moves the minute, never the hour, so comparing hours is safe. */
  function denverHour(now) {
    return +new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hour: "2-digit", hour12: false
    }).format(now || new Date());
  }

  /* Does a schedule fall on this Denver date? Same semantics as the calendar:
     start and end dates inclusive; weekly matches s.days (0=Sun..6=Sat). */
  function occursOn(s, ymd) {
    if (s.startDate && ymd < s.startDate) return false;
    if (s.endDate && ymd > s.endDate) return false;
    if (s.freq === "daily") return true;
    var p = ymd.split("-");
    if (s.freq === "monthly") return +p[2] === (+s.dayOfMonth || 1);
    var dow = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay();
    return (s.days || []).indexOf(dow) !== -1;
  }

  /* ---------- columns / done ---------- */

  function ctxOf(data) {
    var projects = {}, spaces = {};
    (data.projects || []).forEach(function (p) { projects[p.id] = p; });
    (data.spaces || []).forEach(function (s) { spaces[s.id] = s; });
    return { projects: projects, spaces: spaces, data: data };
  }

  function columnsFor(ctx, projectId, spaceId) {
    var sp = spaceId && ctx.spaces[spaceId];
    if (sp && sp.columns && sp.columns.length) return sp.columns;
    var pr = projectId && ctx.projects[projectId];
    if (pr && pr.columns && pr.columns.length) return pr.columns;
    return DEFAULT_COLUMNS;
  }

  function taskDone(ctx, t) {
    var c = columnsFor(ctx, t.projectId, t.spaceId);
    return !!c.length && t.status === c[c.length - 1].id;
  }

  /* ---------- grouping ---------- */

  /* Bucket tasks Project -> Space. Returns groups sorted busiest first, tasks
     without a project last under "Unfiled". Within a project, spaces follow
     their board order and the spaceless bucket (name null) comes last. */
  function groupTasks(ctx, tasks) {
    var byProject = {};
    tasks.forEach(function (t) {
      var pid = t.projectId || "";
      (byProject[pid] = byProject[pid] || []).push(t);
    });

    return Object.keys(byProject).map(function (pid) {
      var list = byProject[pid];
      var bySpace = {};
      list.forEach(function (t) {
        var sid = t.spaceId && ctx.spaces[t.spaceId] ? t.spaceId : "";
        (bySpace[sid] = bySpace[sid] || []).push(t);
      });
      var buckets = Object.keys(bySpace).map(function (sid) {
        var sp = sid ? ctx.spaces[sid] : null;
        return {
          spaceId: sid || null,
          name: sp ? (sp.name || "Untitled space") : null,
          order: sp ? (sp.order || 0) : Infinity,
          tasks: bySpace[sid].sort(byDueThenOrder)
        };
      }).sort(function (a, b) { return a.order - b.order; });

      var pr = pid ? ctx.projects[pid] : null;
      return {
        projectId: pid || null,
        name: pr ? (pr.name || "Untitled project") : "Unfiled",
        count: list.length,
        spaces: buckets
      };
    }).sort(function (a, b) {
      if (!a.projectId !== !b.projectId) return a.projectId ? -1 : 1; // Unfiled last
      return b.count - a.count || a.name.localeCompare(b.name);
    });
  }

  function byDueThenOrder(a, b) {
    var ad = a.due || "9999-99-99", bd = b.due || "9999-99-99";
    return ad < bd ? -1 : ad > bd ? 1 : (a.order || 0) - (b.order || 0);
  }

  /* ---------- models ---------- */

  /* Morning: today's schedule occurrences plus open tasks, grouped
     Project -> Space. When uid is given the tasks are scoped to that person —
     theirs and unassigned — so with nothing assigned both users get the same
     brief. Events are never scoped; the calendar is shared. */
  function morningModel(data, opts) {
    var ctx = ctxOf(data);
    var ymd = opts.ymd, uid = opts.uid || null;

    var events = (data.schedules || []).filter(function (s) { return occursOn(s, ymd); })
      .sort(function (a, b) { return String(a.time || "").localeCompare(String(b.time || "")); });

    /* Occurrences are ticked off per date on the schedule itself. The page still
       lists the finished ones (struck through, like the dashboard), but counting
       them as "today's events" would keep claiming work that's already done. */
    var pending = events.filter(function (s) { return !(s.done && s.done[ymd]); });

    var open = (data.tasks || []).filter(function (t) {
      if (taskDone(ctx, t)) return false;
      if (uid && t.assignee && t.assignee !== uid) return false;
      return true;
    });

    return {
      kind: "morning",
      ymd: ymd,
      label: labelFor(ymd),
      events: events,             // everything scheduled today, done or not
      pendingEvents: pending,     // what's actually still outstanding
      groups: groupTasks(ctx, open),
      openCount: open.length
    };
  }

  /* Evening: what got completed today — completedAt falls on this Denver date
     and the task still sits in its done column, so something ticked and then
     unticked doesn't get claimed. Shared, not per-user: the wrap is team news. */
  function eveningModel(data, opts) {
    var ctx = ctxOf(data);
    var ymd = opts.ymd;

    var doneToday = (data.tasks || []).filter(function (t) {
      return t.completedAt && ymdInDenver(t.completedAt) === ymd && taskDone(ctx, t);
    });

    return {
      kind: "evening",
      ymd: ymd,
      label: labelFor(ymd),
      groups: groupTasks(ctx, doneToday),
      count: doneToday.length
    };
  }

  /* ---------- notification text ---------- */

  var MAX_LINES = 4; // project lines in a push body; the Today page has the rest

  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

  function clip(s, n) {
    s = String(s || "");
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  /* "Alloy Homes → Website 3 · Social 1", spaceless bucket labelled like the
     board ("No space") — unless it's the only bucket, then just "Alloy Homes 3". */
  function morningLine(g) {
    if (g.spaces.length === 1 && !g.spaces[0].name) return clip(g.name, 40) + " " + g.count;
    var segs = g.spaces.map(function (b) {
      return (b.name ? clip(b.name, 24) : "No space") + " " + b.tasks.length;
    });
    return clip(g.name, 40) + " → " + segs.join(" · ");
  }

  function formatMorning(model) {
    var head;
    var ev = model.pendingEvents.length;
    var evPart = ev ? plural(ev, "event") + " today" : "No events today";
    if (model.openCount) {
      head = evPart + " · " + model.openCount + " open across " + plural(model.groups.length, "project");
    } else {
      head = evPart + " · nothing open";
    }
    var lines = model.groups.slice(0, MAX_LINES).map(morningLine);
    if (model.groups.length > MAX_LINES) {
      lines.push("+" + plural(model.groups.length - MAX_LINES, "more project"));
    }
    return {
      title: "☀️ Morning Brief — " + model.label,
      body: [head].concat(lines).join("\n"),
      url: "/?view=today",
      tag: "morning"
    };
  }

  /* "Alloy Homes → Website: hero copy, contact form" — one line per
     project/space bucket, titles clipped, overflow counted. */
  function eveningLines(model) {
    var lines = [];
    model.groups.forEach(function (g) {
      g.spaces.forEach(function (b) {
        var where = b.name ? clip(g.name, 30) + " → " + clip(b.name, 20) : clip(g.name, 30);
        var titles = b.tasks.slice(0, 3).map(function (t) { return clip(t.title || "Untitled", 28); });
        if (b.tasks.length > 3) titles.push("+" + (b.tasks.length - 3));
        lines.push(where + ": " + titles.join(", "));
      });
    });
    if (lines.length > MAX_LINES) {
      var extra = lines.length - MAX_LINES;
      lines = lines.slice(0, MAX_LINES);
      lines.push("+" + extra + " more");
    }
    return lines;
  }

  function formatEvening(model) {
    return {
      title: "🌙 Day Wrap — " + model.label,
      body: [model.count + " completed today"].concat(eveningLines(model)).join("\n"),
      url: "/?view=today&sec=done",
      tag: "evening"
    };
  }

  return {
    TZ: TZ,
    DEFAULT_COLUMNS: DEFAULT_COLUMNS,
    denverToday: denverToday,
    denverHour: denverHour,
    ymdInDenver: ymdInDenver,
    isWeekend: isWeekend,
    occursOn: occursOn,
    morningModel: morningModel,
    eveningModel: eveningModel,
    formatMorning: formatMorning,
    formatEvening: formatEvening
  };
});
