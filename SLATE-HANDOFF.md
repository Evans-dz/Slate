# Slate — handoff for a self-hosted rebuild

## What this is

Slate is a projects-and-notes tool for a two-person creative agency (Dylan and Zac, EZHD).
A working version already exists as a Claude artifact. **`slate.html` ships alongside this
document — read it first. It is the reference implementation, not a sketch.** Roughly 3,200
lines, single file, vanilla JS, no build step. Every feature described below is implemented
and working in it.

Your job is to port it to a locally hosted app that Dylan can run, modify, and install on his
phone as a real PWA.

**Port, don't rewrite.** The UI layer (rendering, CSS, interaction, whiteboard ink, calendar
recurrence) is tuned and should be carried across close to verbatim. What must be replaced is
the four platform capabilities the artifact runtime provided. That is the whole job.

---

## Why it's being moved

The artifact version works well but is capped by its host:

- No offline access
- No push notifications — an 8am recurring item shows *in* the calendar but can't buzz a phone
- Requires a signed-in Claude account on every device
- Can't be installed as a true standalone app

Self-hosting fixes all four. The cost is that four runtime capabilities disappear and you have
to build them. **Push notifications for recurring items are the main payoff — treat that as a
required feature, not a nice-to-have.**

---

## What has to be replaced

| Artifact capability | What it did | What replaces it |
|---|---|---|
| `claude.use("db")` | Shared realtime document store, live snapshots across both users | SQLite + SSE broadcast |
| `claude.use("user")` | Viewer identity, name/avatar lookup, permission check | Session auth, `users` table |
| `claude.use("assets")` | Image upload, served at `/_blob/<id>` | Disk storage, served at `/blob/<id>` |
| `claude.use("sample")` | Asked Claude to transcribe handwriting from a canvas image | Server proxy to the Anthropic API |

Everything else in `slate.html` is ordinary web code and carries over unchanged.

---

## Recommended stack

Keep it boring. Two users, one box, and the owner is an IT/networking person who wants to
make changes without relearning a framework.

- **Runtime:** Node 20+
- **Server:** Hono (or Express — either is fine, Hono is lighter)
- **Database:** SQLite via `better-sqlite3`. Single file, no daemon, trivially backed up.
- **Realtime:** Server-Sent Events. One `GET /api/stream` per client; the server pushes on
  every write. Do not reach for WebSockets — the traffic here is a handful of events a minute.
- **Frontend:** keep the existing vanilla JS. Split `slate.html` into `index.html`,
  `app.js`, `app.css` for editability, but do not introduce React/Vue/Svelte. The render
  functions are plain DOM calls and work as-is.
- **Build:** none required. If you want one, Vite in library-less mode only. No bundler is a
  feature here.
- **Process:** `systemd` unit or `docker compose`. Provide both if cheap.

### Access from phones

The app is useless if it only works on the LAN. Recommend **Tailscale** in the README: install
on the host and on both phones, then Slate is reachable at `http://slate-host:8080` from
anywhere with no port forwarding, no dynamic DNS, and no certificate wrangling.

**Caveat worth flagging in the README:** service workers and web push require a secure context.
`localhost` counts; a plain-HTTP LAN IP does not. So either terminate TLS (Caddy with a local
CA, or Tailscale's built-in HTTPS via `tailscale cert`) or accept that the PWA install and
notifications won't work. Tailscale HTTPS is the path of least resistance — say so explicitly.

---

## Architecture

```
slate/
  server/
    index.js         # Hono app, routes, static serving
    db.js            # better-sqlite3 schema + query helpers
    stream.js        # SSE client registry + broadcast
    auth.js          # sessions, login, user CRUD
    assets.js        # upload, store, serve
    transcribe.js    # Anthropic API proxy for handwriting
    notify.js        # web-push + schedule scanner
    schema.sql
  public/
    index.html
    app.css
    app.js
    store.js         # <-- the shim; see below
    sw.js            # service worker
    manifest.webmanifest
    icons/
  data/
    slate.db
    blobs/
  .env.example
  README.md
```

### The one idea that makes this port cheap

Write `public/store.js` to expose **the same interface the artifact's `db` capability had**.
Then the ~1,000 lines of rendering code in `slate.html` need almost no edits.

Target shape, taken from the existing call sites:

```js
// what app.js already calls, and must keep calling:
db.collection("tasks").onSnapshot(snap => {
  const rows = snap.docs.map(d => ({ ...d.data(), id: d.id }));
}, onError);

db.doc("tasks/" + id).set({ ... });          // full replace
db.doc("tasks/" + id).update({ ... });       // shallow merge
db.doc("tasks/" + id).delete();
db.doc("notes/" + id).collection("strokes").doc(chunkId).set({ ... });  // subcollection
```

Implement `store.js` as:

- Keep an in-memory cache per collection, hydrated by `GET /api/collection/:name`
- Subscribe to `GET /api/stream`; on each event, patch the cache and fire the relevant
  `onSnapshot` callbacks
- Writes go to the REST endpoints below and **apply optimistically to the local cache** so the
  UI doesn't wait on a round trip; reconcile when the SSE echo arrives
- Serialise writes per document path (the existing code already does this with a promise chain
  keyed by path — keep that)

Path parity rule from the original: odd segment count = collection, even = document.
`notes/abc/strokes/c123` is a document inside a subcollection. Model subcollections as a
`collection` column holding the full path string; don't build a tree.

---

## Data model

Five collections, plus a per-note subcollection for whiteboard ink. All documents are JSON
blobs with an id — keep it schemaless in SQLite so field changes don't need migrations.

```sql
CREATE TABLE docs (
  collection TEXT NOT NULL,        -- 'tasks', 'notes', 'notes/<id>/strokes', ...
  id         TEXT NOT NULL,
  data       TEXT NOT NULL,        -- JSON
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, id)
);
CREATE INDEX idx_docs_collection ON docs(collection);
```

### `projects`
| field | type | notes |
|---|---|---|
| `name` | string | |
| `order` | number | sort key |
| `createdAt` / `createdBy` | ISO string / userId | |

### `spaces`
Sub-groupings inside a project — EZHD → Admin, Content, Client work.

| field | type | notes |
|---|---|---|
| `projectId` | string | |
| `name` | string | |
| `order` | number | |

Deleting a space must **not** delete its contents — it nulls `spaceId` on tasks, notes and
schedules that referenced it.

### `tasks`
| field | type | notes |
|---|---|---|
| `title` | string | |
| `status` | `backlog` \| `doing` \| `review` \| `done` | fixed set, hardcoded |
| `projectId` | string \| null | null = unfiled, shows under "Everything" |
| `spaceId` | string \| null | |
| `assignee` | userId \| null | |
| `due` | `YYYY-MM-DD` \| null | |
| `order` | number | float; midpoint insertion on reorder |
| `createdAt` / `createdBy` / `updatedAt` | | |

### `notes`
| field | type | notes |
|---|---|---|
| `title` | string | |
| `body` | string | plain text; `#tags` and URLs parsed at render time, never stored |
| `kind` | `note` \| `doc` \| `board` | default `note` when absent |
| `images` | string[] | asset ids |
| `projectId` / `spaceId` | string \| null | |
| `createdAt` / `createdBy` / `updatedAt` / `updatedBy` | | |

Tags are **derived**, not stored. `tagsOf(note)` regexes `#([\w-]{1,32})` out of title+body on
every render. Keep it that way — stored tags go stale the moment someone edits the text.

### `notes/<noteId>/strokes` (subcollection, `kind: "board"` only)
| field | type | notes |
|---|---|---|
| `strokes` | Stroke[] | up to ~170 KB of JSON per chunk doc, then roll to a new chunk |
| `at` | ISO string | |

`Stroke = { p: number[], c: string, w: number, m?: 1 }`
`p` is flat `[x, y, pressure*100, x, y, pressure*100, ...]`, coords rounded to 1 decimal.
`c` colour, `w` base width, `m` marks a highlighter stroke (constant width, 32% alpha).

Chunking exists because a page of handwriting blows past any sane single-document size. Keep
it. **Deleting a board note must also delete its stroke chunks** — the artifact version had to
do this manually and so will you.

### `schedules`
Recurring calendar items. This is the "Instagram posts, Mon–Fri, 8am" feature.

| field | type | notes |
|---|---|---|
| `projectId` / `spaceId` | string / string \| null | |
| `title` | string | |
| `freq` | `daily` \| `weekly` \| `monthly` | |
| `days` | number[] | 0=Sun … 6=Sat, for `weekly` |
| `dayOfMonth` | number \| null | 1–31, for `monthly` |
| `time` | `HH:MM` | 24h |
| `startDate` | `YYYY-MM-DD` | |
| `endDate` | `YYYY-MM-DD` \| null | |
| `done` | `{ "YYYY-MM-DD": true }` | per-occurrence completion |

Occurrences are **computed, never materialised**. There is no row per occurrence — the
calendar expands them for the visible range. `occursOn(schedule, date)` in `slate.html` is the
whole algorithm; port it verbatim. Ticking an occurrence writes a key into `done`.

### `users` (new — replaces the `user` capability)
Real table, not a doc blob.

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,     -- argon2id or bcrypt
  avatar_path   TEXT,
  role          TEXT NOT NULL      -- 'editor' | 'viewer'
);
CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
```

Two accounts, created by a CLI script (`npm run adduser`). No self-signup, no email, no
password reset flow — Dylan can re-run the script. Session cookie: `HttpOnly`, `SameSite=Lax`,
long expiry (90 days) so phones don't keep logging out.

Avatars: accept an upload, otherwise generate an initials circle server-side as SVG. The UI
expects `{ id, name, avatarUrl }` from the profile lookup.

---

## API

All under `/api`, all requiring a valid session except `POST /api/login`.

```
POST   /api/login                      { name, password } -> sets cookie
POST   /api/logout
GET    /api/me                         -> { id, name, avatarUrl, role }
GET    /api/users                       -> [{ id, name, avatarUrl }]   (both users; tiny set)

GET    /api/collection/:name            -> { docs: [{ id, data }] }    (:name may contain '/')
PUT    /api/doc/:collection/:id         body = full doc     (set)
PATCH  /api/doc/:collection/:id         body = partial      (update, shallow merge)
DELETE /api/doc/:collection/:id
POST   /api/batch                       [{ op, collection, id, data }]  atomic, for bulk ops

GET    /api/stream                      SSE: { type: 'set'|'delete', collection, id, data }

POST   /api/assets                      multipart image -> { id, url }
GET    /blob/:id                        serves the file, long cache headers
DELETE /api/assets/:id

POST   /api/transcribe                  multipart PNG -> { text }
POST   /api/push/subscribe              web-push subscription
```

Writers must have `role === 'editor'`. A viewer gets `403` on every mutation; the client
already handles a write rejection by flipping into read-only mode and showing a banner —
wire the 403 into that existing path.

### Handwriting transcription

`POST /api/transcribe` receives the flattened canvas PNG, calls the Anthropic Messages API
server-side with `ANTHROPIC_API_KEY` from env, and returns plain text. **The key never reaches
the browser.** Reuse the prompt from `slate.html` verbatim — it's tuned to return bare text
with unclear words in square brackets and the literal string `(nothing legible)` for a blank
page. Rate-limit to something like 10/minute per user.

---

## PWA — the reason for the move

### Install
- `manifest.webmanifest`: `display: "standalone"`, `theme_color` matching the light/dark
  tokens, `background_color: "#F4F2ED"`, 192 / 512 / maskable icons
- The meta tags in `slate.html` (`apple-mobile-web-app-capable`, `apple-mobile-web-app-title`,
  `theme-color` with light/dark media queries, `viewport-fit=cover`) are already correct —
  carry them over

### Offline
Service worker strategy:
- **App shell** (`index.html`, `app.css`, `app.js`, `store.js`, icons, fonts): cache-first,
  versioned cache name, clean up old caches on `activate`
- **`GET /api/collection/*`**: network-first, fall back to cache. Slate is fully usable
  read-only offline.
- **Blobs**: cache-first, they're immutable
- **Writes while offline**: queue them in IndexedDB and replay on reconnect. Last-write-wins is
  fine — two people rarely edit the same field. Show a subtle "offline, N changes queued"
  state in the top bar rather than failing silently.
- Self-host the two Google fonts (Archivo, Newsreader) in `public/fonts/` so the shell works
  with no network at all.

### Push notifications
This is the feature that doesn't exist today. Build it.

- VAPID keypair in `.env`, generated once by a script
- `POST /api/push/subscribe` stores the subscription per user
- A scanner runs every minute (`setInterval` is fine; no cron dependency): for each schedule,
  compute whether an occurrence falls in the last minute, skip if `done[date]` is already set,
  and push `{ title, body: "<schedule name> — <time>", data: { url: "/?date=..." } }`
- Deduplicate with a `sent` table keyed `(scheduleId, date)` so a server restart doesn't
  re-fire the morning's notifications
- Add a per-schedule `notify: boolean` field and a toggle in the schedule dialog. Not every
  recurring item deserves a buzz.
- Notification click opens the calendar on that date

iOS caveat for the README: web push on iOS only works once the app is added to the home screen
and requires iOS 16.4+. Say this plainly — it's the single most likely source of "why isn't it
working".

---

## Feature spec

### Navigation
Left rail: **Feed**, **Everything**, project list (each expanding to its spaces when selected),
**Unfiled notes**. Per-project tabs: **Board · List · Calendar · Notes**.

### Feed
Landing view. Every note from both users, newest first, grouped by day with Today / Yesterday /
date headers. A capture box sits above it: type, press Enter, saved — no naming, no filing.
Shift+Enter for a newline. Paste or drop an image straight in.

Capture splits the text: if the first line is ≤70 chars it becomes the note title and the rest
becomes the body; otherwise the whole thing is the body. Small rule, big usability difference —
keep it.

### Tags
`#anything` inside a note becomes a live filter chip above the feed. Click to filter, click
again to clear. Tag chips are rendered inline inside note text as clickable spans.

### Board
Four fixed columns. Cards drag between them and reorder within them.

**Do not use HTML5 drag-and-drop.** It does nothing on touch, which is why most web PM tools
are broken on phones. The implemented approach:

- Every card has a `.grip` strip on its left edge with `touch-action: none`
- `pointerdown` on the grip starts a drag immediately, on any input type
- `pointerdown` on the card body starts a drag only for `pointerType === "mouse"`, after a 7px
  movement threshold
- A fixed-position clone follows the pointer; the drop column is found with
  `document.elementFromPoint` → `.closest(".col")`
- Auto-pan the board horizontally when the pointer nears either edge
- `justDragged` flag suppresses the click that would otherwise fire after a drop

Drop position: find the insertion index by comparing pointer Y against sibling card midpoints,
then set `order` to the midpoint of the neighbours' orders (`+1` at the end, `-1` at the start).

### List
Table with inline status, due date and owner on desktop. On phones it collapses to a tick and
a title — tapping opens the task sheet.

### Task sheet
Tapping a card opens a dialog with title, status, due, project, space, owner, delete. Full-height
sheet on phones, centred box on desktop. This is the only place a task's space or owner can be
changed, so don't drop it.

### Calendar
Month grid on desktop, **agenda list on phones** — a 7-column grid is unreadable at 390px, so
`.calgrid` is hidden and `.agenda` shown below 860px. Shows expanded schedule occurrences plus
one-off tasks with due dates. Click an occurrence to tick it for that day; the schedule list
below has an Edit button per series.

### Notes, docs, whiteboards
Three kinds, one collection:

- **note** — the quick-capture card editor
- **doc** — wider editor with Write/Read modes. In Read mode the body is split into blocks on
  blank lines and **each block gets its own Copy button**. `##`/`###` headings, `-` bullets,
  triple-backtick code blocks. This exists for a prompt library: paste twenty prompts, get
  twenty copy buttons.
- **board** — the whiteboard

Every note also has **Make this a task**, which drops its title onto the board's backlog in the
same project and space.

### Whiteboard
Pressure-sensitive ink for Apple Pencil, on a ruled 1200×1650 logical page.

Two layers of smoothing, and the tuned constants matter — port them exactly:

1. **Live**, while the pen moves: exponential smoothing on each incoming point,
   `α = 0.45` for position, `0.3` for pressure. Read `getCoalescedEvents()` so fast strokes
   don't go polygonal.
2. **On lift**, the cleanup pass that makes the handwriting look better than it was drawn:
   - resample, dropping points closer than 1.6px
   - two **Chaikin** passes (0.75/0.25 splits)
   - a 1-2-1 moving average over pressure so line weight doesn't jitter mid-letter

Rendering: quadratic curves through segment midpoints, `lineWidth = base * (0.42 + 0.58 * pressure)`.

**Palm rejection:** once any `pointerType === "pen"` event is seen, ignore all `touch`
pointers for drawing. Because the canvas is `touch-action: none`, finger-scrolling over it is
impossible — hence the ↑/↓ buttons in the toolbar that scroll the page. Keep them or replace
with two-finger pan, but don't just delete them.

Tools: pen, marker (wide, translucent), stroke eraser (13px hit radius), four colours, undo,
clear page. Plus **Turn writing into text**, which flattens the canvas to PNG and posts it to
`/api/transcribe`; the result is appended to the note's body.

---

## Mobile and cross-platform requirements

Targets: iPhone, Pixel, iPad, macOS. These were all hit the hard way — don't regress them.

- `100dvh`, not `100vh` (mobile browser chrome)
- `env(safe-area-inset-*)` on the top bar, rail, bottom nav and every sheet footer
- `viewport-fit=cover` in the viewport meta
- **Every input at 16px on phones** or iOS zooms on focus. This includes search, capture, the
  add-task field, inline edits and rail inputs.
- `@media (hover:none)` must force hover-only controls visible — row delete, block copy, space
  delete. An invisible button is a missing feature on touch.
- Tap targets 38–44px minimum
- Bottom tab bar on phones: Projects / Feed / Board / Calendar / Notes
- Rail becomes a drawer with a scrim; tapping the scrim or a project closes it
- Board columns `scroll-snap-align: center` at 86vw
- Overlays become full-height sheets with sticky footers below 860px
- `touch-action: manipulation` on controls to kill the 300ms double-tap delay

**Two CSS ordering traps that bit during the original build** — a base rule placed *after* a
media query overrides it regardless of the query, so:
- `.agenda { display: none }` must appear **before** the `max-width:860px` block
- Inside a media query, never restate `display` on a dialog's base selector (`#confirm`), only
  on its `.on` state — otherwise the dialog is permanently visible on mobile

### Theming
Light/dark via CSS custom properties on `:root`, redefined under
`@media (prefers-color-scheme: dark)`. Self-hosted, you can drop the artifact's
`:root:not([data-theme="light"])` guard and use the plain media query — but consider adding an
explicit light/dark/auto toggle since you now control the whole page.

---

## Build order

1. **Server skeleton + SQLite + auth.** Two users via CLI, login page, session cookie.
2. **`store.js` shim + REST + SSE.** Prove it with the `projects` collection only.
3. **Port the UI.** Split `slate.html` into `index.html` / `app.css` / `app.js`, swap
   `claude.use("db")` for the shim and `claude.use("user")` for `/api/me` + `/api/users`.
   At this point everything except images and transcription should work.
4. **Assets.** Upload, `/blob/:id`, swap `/_blob/` → `/blob/` in the note and feed renderers.
5. **Transcription proxy.**
6. **PWA shell + offline.**
7. **Push notifications + the schedule scanner.**
8. **Packaging.** systemd unit or compose file, backup script (`sqlite3 .backup` plus a
   `blobs/` tarball on a timer), README with the Tailscale and HTTPS notes.

Phases 1–3 give a fully working app. Everything after is the payoff for self-hosting.

---

## Acceptance checklist

- [ ] Both users log in; changes by one appear for the other within a second, no refresh
- [ ] A dropped connection reconnects the SSE stream and re-syncs without a reload
- [ ] Board drag works with: mouse, finger on iPhone, finger on Pixel, Apple Pencil on iPad
- [ ] No input zooms the viewport on iOS focus
- [ ] Calendar shows a month grid on desktop and an agenda on a 390px phone
- [ ] A Mon–Fri 8am schedule renders on exactly the right days and ticks off per-day
- [ ] A push notification arrives on a phone at the scheduled minute, once, and survives a
      server restart without re-firing
- [ ] Whiteboard: Pencil pressure varies line weight; palm resting on screen draws nothing;
      strokes survive a reload; a 200-stroke page saves and reloads correctly
- [ ] Turn-writing-into-text returns a transcription and the API key is absent from all client
      bundles and network responses
- [ ] Installs to the iOS home screen and opens standalone with no browser chrome
- [ ] Airplane mode: app opens, data readable, a queued edit replays on reconnect
- [ ] Deleting a project deletes its tasks and orphans its notes to Unfiled; deleting a space
      nulls `spaceId` without deleting anything; deleting a board note also deletes its stroke
      chunks

---

## Deliberate decisions — don't "fix" these

- **Fixed four statuses.** Custom statuses were considered and skipped; two people don't need
  a workflow builder.
- **Tags derived, not stored.** Prevents drift on edit.
- **No per-occurrence rows for schedules.** A year of daily items would be 365 rows per series
  for no benefit.
- **Vanilla JS, no framework.** The owner wants to open one file and change something.
- **Capture over hierarchy.** The Feed is the landing view on purpose — the tool is
  capture-first, file-later. Don't make people pick a project before they can write something
  down.

## Open questions for Dylan

1. Which host — always-on machine, NAS, or a small VPS? Changes the packaging advice.
2. Should the whiteboard support multiple pages per note, or stay one page?
3. Should push notifications be per-schedule (proposed) or global on/off?
4. Is there anything from ClickUp still missing — time tracking, task comments, file
   attachments on tasks?
