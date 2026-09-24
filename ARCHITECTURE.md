# Slate — how it's built and why

Projects and notes for EZHD, a two-person studio. This document explains the shape of the
app so you can change it without rediscovering the reasoning. For setup and deployment see
`README.md`.

> This file replaces the original `SLATE-HANDOFF.md`, which described a port to a
> self-hosted Node and SQLite server that was never built — the app went to Vercel and
> Supabase instead. The original is still in git at the first commit if you want it.

---

## The shape of it

One HTML file. `index.html` holds the markup, the CSS and roughly 3,000 lines of render
code, in plain JavaScript with no framework and no build step. That's deliberate: the point
is that you can open one file and change something without relearning a toolchain.

`store.js` is the only other moving part. It provides five capabilities — `db`, `user`,
`assets`, `push` and `sample` — and everything else in the app talks to those rather than
to Supabase directly. That separation is what let the app move off the Claude artifact
runtime by rewriting one file, and it's what would let it move again.

```
index.html              markup, CSS, and every render function
store.js                the platform layer: db, user, assets, push, all Supabase-backed
config.js               your Supabase URL, anon key and the push public key
lib/brief.js            brief logic: grouping, wording, Denver dates (page + server)
api/                    Vercel functions: push subscribe/unsubscribe/test, two cron briefs
vendor/supabase.js      the Supabase client, vendored so the shell works offline
sw.js                   service worker: caches the app shell, shows the push briefs
supabase/schema.sql     run once in the Supabase SQL editor
```

### Two contracts in `store.js` worth knowing

Both of these were broken in the port off the artifact runtime, both silently, and both
cost real debugging.

**`user.profiles(ids)` returns a map keyed by id, not an array.** Every caller reads it as
`ps[someUuid]` — `paintPeople()` does it for each `[data-uid]` node, the task sheet does it
for the owner dropdown. Returning an array made every lookup `undefined`, so avatars and
owner names silently fell back to blank everywhere with no error. Keep it a map.

**A write that can't reach the server goes in the outbox, not on the floor.** An
IndexedDB store holds one record per document path; `set`, `update` and `delete` try the
network first and, when the failure is one that could succeed later, persist and *resolve* —
because the bytes really are saved and rejecting would fire "that change didn't save" over a
change that did. A fatal error still rejects, exactly as before. **One record per path is
correct only because every write here upserts the whole document**, so a newer record always
supersedes an older one; a partial PATCH, an RPC or a counter would be silently coalesced
away by it. See *Deliberate decisions*.

**Pending writes are re-applied over everything the server sends.** `overlay()` runs in all
three places server state reaches the cache — `resync()`, `hydrate()` and the realtime
handler — so reconnecting never wipes work that hasn't flushed. The invariant: **cache is
server state with pending applied last**, and a fourth door added later silently breaks it.

**Realtime re-syncs; it doesn't just listen.** Postgres change events are never replayed,
so anything the other person changed while a device was asleep, backgrounded or offline is
simply missed — and on a phone that's most of the day. So the db layer re-reads every
loaded collection whenever the channel subscribes, whenever the page returns to the
foreground, and whenever the browser comes back online. It also watches the channel's
status: an errored or timed-out channel never recovers on its own, so it's torn down and
rebuilt, and the resubscribe closes the gap. The re-read *replaces* each collection rather
than merging into it, which is what makes the other person's deletions disappear here too.

Without these, two people editing at once looks like it works and quietly doesn't.

---

## Data

Everything except accounts lives in one table.

```sql
create table docs (
  collection  text        not null,
  id          text        not null,
  data        jsonb       not null,
  updated_at  timestamptz not null default now(),
  primary key (collection, id)
);
```

`collection` holds the full path string, so a subcollection is just a longer value —
`notes/<id>/strokes` is stored as-is, with no tree. Documents are schemaless JSON, which is
why adding prospects and per-space columns needed no migration at all. Adding a new
collection needs no schema change either; subscribe to it in the boot block and it works.

**Upserts must name their conflict target.** The primary key is composite, so
`onConflict: "collection,id"` is required. Without it every write fails. This cost an
afternoon once.

### Collections

**`projects`** — `name`, `order`, `colorIndex`, `contact`, `email`, `phone`, `website`,
`createdAt`, `createdBy`. Optionally `columns` (see below).

**`spaces`** — `projectId`, `name`, `order`, `createdAt`, `createdBy`. Optionally `columns`.
Deleting a space does **not** delete its contents; it nulls `spaceId` on the tasks, notes and
schedules that referenced it.

**`tasks`** — `title`, `status` (a column id, see below), `projectId`, `spaceId`, `assignee`,
`due` (`YYYY-MM-DD`), `noteId`, `notes`, `order`, timestamps, `completedAt` and
`completedBy`. `order` is a float; reordering inserts at the midpoint of its neighbours.
`noteId` points back at the note a card was made from. `completedAt` is stamped by
`patchTask` the moment a status change lands a task in its done column and cleared when it
leaves — done-ness itself stays positional (see Columns), the timestamp exists so the
evening brief can say what got finished *today* and the dashboard can chart it.
`completedBy` (the uid that ticked it) is stamped and cleared alongside it; the dashboard
credits a completion to the task's `assignee`, falling back to `completedBy`. Three doors
stamp both: `patchTask`, `deleteColumn` (which re-files cards itself), and `createTask`
when a task is typed straight into the done column. `completedAt` exists from
2026-09-17 (`TRACK_START`), `completedBy` from 2026-09-24.

**`notes`** — `title`, `body`, `kind` (`note` | `doc` | `board`), `images` (asset ids),
`projectId`, `spaceId`, timestamps. Tags are **derived, not stored** — `tagsOf()` regexes
`#([\w-]{1,32})` out of title and body on every render. Keep it that way: stored tags go
stale the moment someone edits the text.

**`notes/<id>/strokes`** — whiteboard ink, `kind: "board"` only. `{ strokes: Stroke[], at }`
where `Stroke = { p: number[], c: string, w: number, m?: 1 }` and `p` is flat
`[x, y, pressure*100, …]`. Chunked at roughly 170 KB per document because a page of
handwriting blows past any sane single-document size. **Deleting a board note must also
delete its stroke chunks** — nothing does that for you.

**`schedules`** — `projectId`, `spaceId`, `title`, `freq` (`daily` | `weekly` | `monthly`),
`days` (0=Sun…6=Sat), `dayOfMonth`, `time` (`HH:MM`), `startDate`, `endDate`, and
`done: { "YYYY-MM-DD": true }` per occurrence. Occurrences are **computed, never
materialised** — there is no row per occurrence. `occursOn(schedule, date)` is the whole
algorithm.

**`prospects`** — `company`, `contact`, `email`, `stage`, `note`, `next` (chase date),
`order`, timestamps. Stages are `lead`, `contacted`, `talking`, `lost`. **`won` is not a
stage** — landing one converts it into a project, so a won prospect doesn't exist.

**`meta`** — small shared counters. Currently only `meta/colors` holding `{ high }`, the
colour high water mark.

**`profiles`** — a real table, not a doc blob: `id` (references `auth.users`), `name`,
`avatar_url`. The UI expects `{ id, name, avatarUrl }`.

**`push_subscriptions`** — also a real table: one row per device that enabled the briefs,
keyed unique on `endpoint` so re-enabling upserts instead of duplicating. Written through
the `/api/push` functions with the service role key; rows the push service reports gone
(404/410) are pruned on every send.

---

## Columns

Originally there were four fixed statuses. That was a deliberate decision, and it was
reversed: Admin and Client work want different workflows, and one shared set fits neither.

Columns live on the **space** document as `columns: [{ id, name }]`. A task filed to a
project but to no space uses the **project's** own set. A set that has never been edited
falls back to `DEFAULT_COLUMNS` — To-do, In progress, Done — which costs nothing until
someone edits it.

`task.status` is a column id, scoped to that task's space. Three rules make this safe:

- **The last column always means done.** No flag, no config. The tick, the strikethrough and
  the dashboard all read it that way, so a workflow ending in Delivered or Published just
  works.
- **"In progress" is any middle column.** Not first, not last. That generalises to any
  number of columns.
- **A status matching no column falls back to the first one.** `columnOf(task)` does this,
  so renaming or deleting a column can never strand a card off the board.

Because columns vary, a board is rendered **per column set**. `boardGroups()` buckets tasks
by `(projectId, spaceId)` and each group gets its own board under a heading. Dragging a card
into another group's column re-files it to that project and space, which makes the grouped
board a filing tool as well as a board.

---

## Views

`S.sel` is the current view: `"dash"`, `"all"`, `"capture"`, `"unfiled"`, `"today"`, or a
project id. `isVirtualView()` distinguishes the named ones from a real project. Every change
of view goes through `goView(sel, tab, drill)`, which clears the space, open doc, tag filter
and drill chip, keeps a Prospects tab only where one exists, closes the phone drawer and
starts the new page at the top.

**Dashboard** is the landing page. It reads at a glance and every part of it either acts in
place (tick, assign, open) or drills somewhere specific; it has no tabs. From the top: four
stat tiles (Completed in the range, In progress, Due this week, Overdue); two stacks — *act*
(Today: overdue, events, due today, chases; then Next 7 days by day) and *review* (the
Completed chart, then Finished, the completions log that is the chart's detail view); a
Projects table (progress bar, open, late, done in range, last touched, a Quiet flag after
`STALE_DAYS`); then Workload and Pipeline side by side. All of it comes from one pass over
what's loaded (`dashModel()`), on the Denver date the briefs use.

Two controls scope it, in one row above everything: a **person lens** (Everyone, then each
profile, me first) and a **history range** (7 days, 30 days, 12 weeks — weeks so every
bucket is a whole Monday week). Both are per device (`slate:who`, `slate:dashRange`). The
lens is the morning brief's rule, one rule for everything: *a person's view is theirs plus
nobody's* — open work assigned to them or to no one, completions credited to them or to no
one. So the two lenses overlap and don't add up to Everyone, and the header says so in
words. Events, chases, Pipeline and Workload ignore the lens: they're shared, or per person
already. The range scopes only history: the Completed tile, the chart, Finished and the
Projects Done column.

**All projects** (`"all"`) is the cross-project half the dashboard used to carry: Board /
List / Calendar / Notes / Prospects tabs spanning every project, a board per project and
space. It never applies the lens. A dashboard drill-through arrives as `S.drill`
(`{lens, owner, status, project}`) and shows as one removable chip under the tabs, so a
filter is never left on the shared board without saying so; any `goView` without one clears
it. The phone's Board and Calendar buttons open All projects from any view that isn't a
project, and switch the project's own tab inside one. `/?view=all` deep-links to it.

**Boards and the list only show a fortnight of finished work.** A done card whose
`completedAt` (or, before tracking, `updatedAt`) is more than `DONE_KEEP_DAYS` old folds
behind "Show N older" per board; the list does the same. Counts on tabs, board headings and
the rail are open work only — Dashboard's rail badge is the overdue count, Capture carries
none.

**Capture** is the quick-note stream. Type, press Enter, saved. The project and space
pickers start empty and reset after every save, so each note is filed deliberately rather
than inheriting the last one. Filing to a project also drops a linked card on that board's
first column.

**Unfiled notes** is the triage view: each card carries its own project and space pickers so
the stack clears in one pass.

**A project** shows its name, colour and contact line, then tabs that are its **spaces** —
because once columns became per-space, the space is the unit of work. The four views moved
to an icon switcher at the right of the same row. Docs filed to the project get tabs after
the spaces, and open in place in read mode with per-block Copy buttons.

**Search** crosses everything. A non-empty query replaces the view with grouped results —
notes, tasks, prospects, project details — each saying which project and space it lives in.

---

## The briefs

Two scheduled pushes a day, sent by the app itself over the Web Push standard — no
Firebase, no third-party relay, no cost. Vercel Cron hits `/api/cron/morning` (13:00 UTC)
and `/api/cron/evening` (00:00 UTC); each route checks the `CRON_SECRET` bearer token,
works out the date **in America/Denver**, skips Denver weekends, and fans the digest out
to every row in `push_subscriptions` via the `web-push` package.

The reasoning worth keeping:

- **`lib/brief.js` is the single source of truth.** It builds the models (what's on
  today, what got done) and the notification text. The cron routes require it; the Today
  page loads the same file as a browser global. The push body is a digest — counts plus
  the busiest few `Project → Space` lines — because push bodies truncate; the Today page
  (`/?view=today`, which a notification tap deep-links into) carries the rest.
- **Denver, never UTC.** The evening cron fires at 00:00 UTC, which is 6pm *the previous
  UTC day* in Denver — every date comparison goes through the Denver calendar or the
  brief is quietly wrong. Same for weekends: Friday's wrap fires on Saturday 00:00 UTC
  and must still send. The cron *schedules* are UTC though, so the Denver hour drifts by
  one across DST; the two expressions in `vercel.json` can be nudged twice a year, and a
  guard-and-skip hourly job isn't possible on the Hobby plan's two once-daily crons.
- **The morning brief is per-person** — your tasks plus unassigned ones — and **the
  evening wrap is shared**, because "what we got done" is team news. With nothing
  assigned both people get identical briefs, so the scoping costs nothing until it's
  used.
- **Completion stays positional.** The evening brief needs a time, so `patchTask` stamps
  `completedAt` when a task lands in its done column — but the brief only claims a task
  whose `completedAt` is today **and** which still sits in a done column, so a tick that
  was undone, or a column edit that reshuffled done-ness, can't fabricate a completion.
- **Quiet days send nothing.** No open work and no events, or nothing completed — the
  route logs a skip instead of buzzing a phone about zero.
- **The VAPID key pair is permanent.** Rotate it and every subscription dies silently;
  both users re-enable by hand. The public half lives in `config.js`, the pair in
  Vercel's env.
- **iOS only delivers web push to an installed app** (home screen, iOS 16.4+) and only
  prompts for permission inside a user gesture — which is why the whole subscribe flow
  hangs off the bell button in the top bar, and why the bell shows install instructions
  instead of a dead button in a Safari tab.

---

## Colour

Each project takes the next `colorIndex`, and an index is **never handed out twice**, not
even after the project holding it is deleted. The high water mark lives in `meta/colors` so
it holds for both users rather than one browser. Hues come from the golden angle
(137.508°), so consecutive projects land far apart and the palette can't run out. The colour
shows on the rail dot, the project heading and every calendar chip.

---

## Mobile

Targets: iPhone, Pixel, iPad, macOS. Verified at 320, 375, 402, 412, 430, 744, 834, 1194 and
1440px, light and dark.

- **720px is the phone breakpoint.** Below it: drawer rail, bottom tab bar, and a compact
  month — dates and dots, iPhone Calendar style — over the selected day's list, instead of
  the grid with chips. iPads sit above it and keep the persistent rail and the full grid.
  The calendar is one DOM at every width with CSS choosing what shows, so rotating an iPad
  across the breakpoint needs no re-render.
- `100dvh`, not `100vh`
- `env(safe-area-inset-*)` on the top bar, rail, bottom nav and sheets, including left and
  right for landscape on a notched phone
- **Every input at 16px on phones** or iOS zooms the page on focus. This has bitten twice.
- Tap targets 38px minimum
- `@media (hover:none)` forces hover-only controls visible — row delete, block copy, column
  delete, the Details chip. An invisible button is a missing feature on touch.
- Board drag is pointer events, never HTML5 drag-and-drop, which does nothing on touch. The
  `.grip` starts a drag immediately on any input; the card body only for a mouse, after a
  7px threshold.

### Two CSS traps

Both of these have shipped a bug in this file.

1. **A base rule placed after a media query overrides it regardless of the query.**
   `#railScrim` had no base rule, only `display:none` inside the phone block, so above 860px
   it became a visible grid item and displaced the whole layout. `#railScrim{display:none}`
   and the calendar's desktop-hidden `.dots` now sit above the phone block for this reason.

2. **A shorthand inside the phone block silently drops what an earlier block added.**
   `@media (hover:none)` adds `.card{padding-left:28px}` to clear the drag grip; the phone
   block's `.card{padding:11px 12px}` reset it and the grip landed on the card text. The
   padding there is written out in full now.

Neither is visible reading the CSS. Both were found by rendering at real device widths.

---

## Whiteboard

Pressure-sensitive ink for Apple Pencil on a ruled 1200×1650 logical page. **The constants
are tuned; don't round them off.**

Two layers of smoothing:

1. **Live**, while the pen moves: exponential smoothing on each incoming point, `α = 0.45`
   for position and `0.3` for pressure. Reads `getCoalescedEvents()` so fast strokes don't
   go polygonal.
2. **On lift**, the pass that makes handwriting look better than it was drawn: resample
   dropping points closer than 1.6px, two Chaikin passes at 0.75/0.25, then a 1-2-1 moving
   average over pressure so line weight doesn't jitter mid-letter.

Rendering is quadratic curves through segment midpoints, `lineWidth = base * (0.42 + 0.58 *
pressure)`.

**Palm rejection:** once any `pointerType === "pen"` is seen, all `touch` pointers are
ignored for drawing. Because the canvas is `touch-action: none`, finger-scrolling over it is
impossible — hence the ↑ ↓ buttons in the toolbar. Keep them or replace them with a
two-finger pan, but don't just delete them.

---

## Deliberate decisions

Don't "fix" these.

- **Tags derived, not stored.** Prevents drift when text is edited.
- **No row per schedule occurrence.** A year of a daily item would be 365 rows per series for
  no benefit.
- **In the calendar a tap opens; only the tick completes.** Tapping an item used to complete
  it, so a curious tap on a phone finished a task, and editing a repeating item needed a
  double-click that touch doesn't have. The calendar's today is Denver's, like the briefs,
  because its ticks write `schedule.done` under the same date keys they read.
- **Vanilla JS, no framework, no build.** The owner wants to open one file and change
  something.
- **Capture over hierarchy.** Capture is the quick path on purpose — you should never have to
  pick a project before you can write something down. The pickers are optional and always
  start empty.
- **Won is an action, not a stage.** A won prospect is a project.
- **Last-write-wins at document level.** Two people rarely edit the same field, and field-level
  merging isn't worth the complexity here. The offline outbox now leans on this twice: it is
  why one record per path can replace an older one wholesale, and it is why a write queued in
  a basement can be replayed an hour later without inspecting what changed meanwhile. Both
  hold **only while every write ends in a full-document upsert** — adding a real partial
  update would quietly break them.
- **A fixed dashboard, no widget editor.** Two people don't need a stored layout, and every
  per-person preference is one more thing that differs between your screen and theirs.
- **Completion history is derived from task rows, never backfilled.** A completion counts
  when `completedAt` is set *and* the task still sits in a done column — the evening wrap's
  rule, so the chart's today always equals the wrap. Days before `TRACK_START`
  (2026-09-17) are drawn as "Not tracked", never as zeros, and the Completed tile shows a
  delta only once the previous period is fully tracked. `updatedAt` is not used to invent
  older dates: it moves on any edit. Finished tasks with no `completedAt` still count where
  done-ness is positional (Projects, Workload) and are footnoted everywhere else. Known
  limits, shared with the evening brief: deleting a done card, adding a column after Done,
  or deleting a space (which nulls `spaceId` outside `patchTask`) retroactively removes
  completions. If that bites, the fix is an append-only `completions/<taskId>` doc written
  in `patchTask` — still a full-document upsert, so still outbox-safe.
- **The lens mirrors the morning brief's scoping** (theirs plus unassigned), so each
  person's dashboard agrees with their 7am push. A strict "only mine" filter would look
  empty while most work is unassigned; Workload's Unassigned row, with an owner button on
  each task, is the nudge instead.
- **Chart colours are the `--viz-*` tokens, not the accent.** Accents are per device, so an
  accent-coloured chart would look different on each of your screens. Marks get their
  colour from CSS classes, never from SVG presentation attributes — `var()` there is
  unreliable on iOS.
- **Images are not queued offline.** The text of a note is the thing worth saving in a
  basement; a photo can wait. Queuing blobs would need a second store against the same
  quota, different error semantics, and a two-phase commit so a note never references an
  image that hasn't landed — a failure the *other* person would see. `assets.upload()`
  refuses offline and the note saves without it.

## Reversed decisions

Recorded because the reasoning still gets quoted at me.

- **Four fixed statuses** → per-space named columns. Different spaces genuinely need
  different workflows.
- **Feed as the landing view** → Dashboard. Capture is still one tap away in the bottom bar.
- **Dashboard as summary cards above the cross-project tabs** → a tab-less Dashboard plus
  All projects. The cards were a thin layer over "every board at once", done cards
  included; the boards moved to their own page and the dashboard got history.
- **Self-hosted Node, SQLite and SSE behind Tailscale** → Vercel, Supabase and GitHub.
  Supabase realtime replaces SSE, Supabase auth replaces the sessions table, Supabase storage
  replaces the blobs directory.

---

## Not built

- **Handwriting transcription.** The whiteboard's *Turn writing into text* button hides
  itself until `SlateStore.use("sample")` returns something. It needs a serverless function
  at `/api/transcribe` calling the Anthropic API with the key held server-side. The prompt
  should return bare text, unclear words in square brackets, and the literal string
  `(nothing legible)` for a blank page.
- **Per-item schedule reminders.** The morning brief lists today's recurring items, but
  nothing fires at an item's own time (the 8am reminder at 8am). That needs a `notify` flag
  per schedule, a sent table keyed `(scheduleId, date)` so a restart doesn't re-fire, and a
  cron that runs more than once a day — which the Vercel Hobby plan doesn't allow, so this
  probably means Supabase `pg_cron` plus an Edge Function reusing the same
  `push_subscriptions` rows.
- **Offline *reads*.** The shell is cached but the data is not, so a cold start with no signal
  shows an empty app until it reconnects. Writes are safe (see the outbox above) and anything
  loaded in a live session stays readable — but capturing into an app that looks empty is an
  odd experience. Persisting the document cache alongside the outbox is the fix.
- **A real run against Supabase.** Every feature so far was verified against a local
  stand-in for the platform layer. `store.js` itself has barely been exercised.
