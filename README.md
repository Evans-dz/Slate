# Slate

Projects and notes for a two-person studio. Vanilla JS, no build step, no framework —
`index.html` is the whole app. Supabase holds the data; Vercel serves the files.

```
index.html              the app: markup, CSS and ~2,700 lines of render code
store.js                the platform layer: db, user, assets, all Supabase-backed
config.js               your Supabase URL and anon key
vendor/supabase.js      the Supabase client, vendored so the app works offline
sw.js                   service worker: caches the shell
manifest.webmanifest    PWA manifest
supabase/schema.sql     run this once in the Supabase SQL editor
SLATE-HANDOFF.md        the original spec, including the self-hosted alternative
```

## Setting it up

**1. Create the Supabase project.** At [supabase.com](https://supabase.com), new project,
any region close to you.

**2. Run the schema.** SQL Editor → paste `supabase/schema.sql` → Run. That creates the
`docs` and `profiles` tables, turns on row level security, enables realtime and makes the
`slate-assets` storage bucket.

**3. Create the two accounts.** Authentication → Users → Add user, twice. Tick
*Auto Confirm User* so there's no email step. Then give each one a display name — the SQL
for that is at the bottom of `schema.sql`.

**4. Fill in `config.js`.** Project Settings → API gives you the Project URL and the
`anon` `public` key:

```js
window.SLATE_CONFIG = {
  supabaseUrl: "https://xxxxxxxx.supabase.co",
  supabaseAnonKey: "eyJhbGciOi..."
};
```

Both values are meant to be public. The anon key only grants what the row level security
policies allow, and those require a signed-in user for everything.

**5. Deploy.** Push to GitHub, then import the repo at
[vercel.com/new](https://vercel.com/new). No framework, no build command, no output
directory — it's a static site. `vercel.json` sets the cache headers.

**6. Install it on your phone.** Open the Vercel URL in Safari (iOS) or Chrome (Android),
then Share → Add to Home Screen. It opens standalone with no browser chrome.

## Running it locally

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`. Service workers need a secure context, and `localhost`
counts, so the PWA behaves the same as it does in production.

## Looking at it without a database

Add `?demo` to the URL — `http://localhost:8080/?demo`, or `your-app.vercel.app/?demo`
once it's deployed. That skips Supabase and the sign in entirely and runs the app off the
sample studio in `demo.js`: four projects, a filled board, a month of recurring items and a
prospect pipeline. Everything works — drag cards, tick things off, open the whiteboard —
but it lives in memory, so a reload starts over and nothing touches your real data.

Useful before the Supabase project exists, and for showing someone what Slate does without
handing them your board. Edit `demo.js` to change what the sample studio looks like.

## What works offline

The shell is cached, so the app opens with no connection and anything already loaded stays
readable. Writes need the network — there's no offline write queue yet. `SLATE-HANDOFF.md`
describes what that would take.

## Not built yet

- **Handwriting transcription.** The whiteboard's *Turn writing into text* button hides
  itself until `SlateStore.use("sample")` returns something. It needs a serverless function
  at `/api/transcribe` that calls the Anthropic API with a key held server-side. The prompt
  to reuse is in `SLATE-HANDOFF.md`.
- **Push notifications** for the 8am recurring items. Schedules render and tick off in the
  calendar, but nothing buzzes a phone. This needs a scheduled job (Supabase `pg_cron` plus
  an Edge Function, or Vercel Cron) and a `web-push` subscription per device. On iOS, web
  push only works once the app is on the home screen, and needs iOS 16.4 or newer.
- **Offline write queue.** Reads work offline; writes fail until you reconnect.

## Devices

Tested at iPhone SE (375), iPhone 16 Pro (402), Pixel 8 (412), iPhone Pro Max (430),
iPad Mini (744), iPad Pro 11" portrait (834) and landscape (1194), and macOS (1440).

The phone layout — drawer rail, bottom tab bar, agenda instead of a month grid — applies
below 720px. iPads keep the persistent rail and the month grid.

Two CSS traps worth knowing before editing, both of which have bitten this file:

- A base rule placed **after** a media query overrides it regardless of the query. That's
  why `#railScrim{display:none}` and `.agenda{display:none}` sit above the `720px` block.
- Inside the phone block, a shorthand like `.card{padding:...}` silently drops the
  `padding-left` that the `@media (hover:none)` rule adds for the drag grip.
