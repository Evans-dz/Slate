# Slate

Projects and notes for EZHD. Vanilla JS, no build step, no framework — `index.html` is the
whole app. Supabase holds the data; Vercel serves the files.

For how it's built and why, see `ARCHITECTURE.md`.

```
index.html              the app: markup, CSS and the render code
store.js                the platform layer: db, user, assets, all Supabase-backed
config.js               your Supabase URL and anon key
vendor/supabase.js      the Supabase client, vendored so the shell works offline
sw.js                   service worker: caches the shell
manifest.webmanifest    PWA manifest
supabase/schema.sql     run this once in the Supabase SQL editor
ARCHITECTURE.md         data model, views, deliberate decisions, the CSS traps
```

## Setting it up

**1. Create the Supabase project.** At [supabase.com](https://supabase.com), new project,
any region close to you.

**2. Run the schema.** SQL Editor → paste `supabase/schema.sql` → Run. That creates the
`docs` and `profiles` tables, turns on row level security, enables realtime and makes the
`slate-assets` storage bucket.

**3. Create the two accounts.** Authentication → Users → Add user, twice. Tick
*Auto Confirm User* so there's no email step. Then give each one a display name — the SQL
for that is at the bottom of `schema.sql`. Skip this and you'll both show up as the first
half of your email address.

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

## First run

Nothing in the app has been exercised against a real Supabase project yet, so work through
this once and the rest should follow:

- [ ] Sign in as both accounts, in two browsers. A change by one appears for the other
      within a second, with no refresh — that's realtime working
- [ ] Make a project, a space, a task. Rename a column, add one, delete one
- [ ] Drag a card between columns, then between two spaces
- [ ] Capture a note with a project and space chosen: the note saves **and** a linked card
      lands on that board's first column
- [ ] Paste an image into a note — that's storage and the bucket policy
- [ ] Sign out and back in; the session should persist across a reload
- [ ] Airplane mode: the app still opens and loaded data is readable

If writes fail immediately, check the browser console. The most likely causes are a row
level security policy that didn't apply, or the schema not having been run.

## Running it locally

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`. Service workers need a secure context, and `localhost`
counts, so the PWA behaves the same as it does in production.

## How it's laid out

**Dashboard** is the landing page: a summary of today, overdue, in progress and the next
seven days, with Board / List / Calendar / Notes / Prospects tabs spanning every project.

**Capture** is the quick-note stream — type, press Enter, saved. Pick a project and space
and the note is filed *and* dropped onto that board as a linked card.

**A project** shows its contact details under the name, then tabs for its **spaces**, with
the four views as icons at the right. Each space has its own named columns. Docs filed to
the project get their own tabs and open in place with per-block copy buttons.

**Prospects** is the outreach pipeline on the Dashboard. Landing one turns it into a
project and carries your notes across.

On a phone the layout switches below 720px: drawer rail, bottom tab bar, agenda instead of a
month grid. iPads keep the rail and the grid.

## What works offline

The shell is cached, so the app opens with no connection and anything already loaded stays
readable. Writes need the network — there's no offline write queue yet.

## Not built yet

- **Handwriting transcription.** The whiteboard's *Turn writing into text* button hides
  itself until a serverless `/api/transcribe` exists to call the Anthropic API with the key
  held server-side.
- **Push notifications** for the 8am recurring items. Schedules render and tick off in the
  calendar, but nothing buzzes a phone. On iOS, web push only works once the app is on the
  home screen, and needs iOS 16.4 or newer.
- **Offline write queue.** Reads work offline; writes fail until you reconnect.

`ARCHITECTURE.md` has notes on what each of these would take.

## Working across two Macs

If this folder lives in iCloud Drive, **don't rely on iCloud to sync the `.git` directory**.
Two machines writing to the same repo through file sync is a good way to corrupt it, and
"Optimise Mac Storage" can evict files out from under you. Once it's on GitHub, clone it on
the other Mac and use `git pull` / `git push` to move work between them — that's what the
remote is for. Keeping a copy in iCloud as a backup is fine; editing it from both ends is
not.
