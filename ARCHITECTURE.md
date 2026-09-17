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

`store.js` is the only other moving part. It provides four capabilities — `db`, `user`,
`assets` and `sample` — and everything else in the app talks to those rather than to
Supabase directly. That separation is what let the app move off the Claude artifact runtime
by rewriting one file, and it's what would let it move again.

```
index.html              markup, CSS, and every render function
store.js                the platform layer: db, user, assets, all Supabase-backed
config.js               your Supabase URL and anon key
vendor/supabase.js      the Supabase client, vendored so the shell works offline
sw.js                   service worker: caches the app shell
supabase/schema.sql     run once in the Supabase SQL editor
```

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
`due` (`YYYY-MM-DD`), `noteId`, `order`, timestamps. `order` is a float; reordering inserts
at the midpoint of its neighbours. `noteId` points back at the note a card was made from.

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

`S.sel` is the current view: `"dash"`, `"capture"`, `"unfiled"`, or a project id.
`isVirtualView()` distinguishes the first three from a real project.

**Dashboard** is the landing page and the only cross-project home. A four-card summary —
today, overdue, in progress, next seven days — sits above the Board / List / Calendar /
Notes / Prospects tabs, which span every project. Prospect chase dates surface in the Today
and Next seven days cards so a follow-up can't quietly pass.

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

- **720px is the phone breakpoint.** Below it: drawer rail, bottom tab bar, agenda instead
  of a month grid. iPads sit above it and keep the persistent rail and the grid.
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
   and `.agenda{display:none}` now sit above the phone block for this reason.

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
- **Vanilla JS, no framework, no build.** The owner wants to open one file and change
  something.
- **Capture over hierarchy.** Capture is the quick path on purpose — you should never have to
  pick a project before you can write something down. The pickers are optional and always
  start empty.
- **Won is an action, not a stage.** A won prospect is a project.
- **Last-write-wins at document level.** Two people rarely edit the same field, and field-level
  merging isn't worth the complexity here.

## Reversed decisions

Recorded because the reasoning still gets quoted at me.

- **Four fixed statuses** → per-space named columns. Different spaces genuinely need
  different workflows.
- **Feed as the landing view** → Dashboard. Capture is still one tap away in the bottom bar.
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
- **Push notifications** for recurring items. Schedules render and tick off, but nothing
  buzzes a phone. Needs a scheduled job (Supabase `pg_cron` plus an Edge Function, or Vercel
  Cron), a `web-push` subscription per device, a `notify` flag per schedule, and a sent table
  keyed `(scheduleId, date)` so a restart doesn't re-fire the morning's notifications. On iOS
  this only works once the app is on the home screen, and needs iOS 16.4 or newer.
- **Offline write queue.** Reads work offline because the shell is cached; writes fail until
  you reconnect. Queue them in IndexedDB and replay on reconnect.
- **A real run against Supabase.** Every feature so far was verified against a local
  stand-in for the platform layer. `store.js` itself has barely been exercised.
