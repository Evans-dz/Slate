# Slate

Projects and notes for EZHD. Vanilla JS, no build step, no framework — `index.html` is the
whole app. Supabase holds the data; Vercel serves the files.

For how it's built and why, see `ARCHITECTURE.md`.

```
index.html              the app: markup, CSS and the render code
store.js                the platform layer: db, user, assets, push, all Supabase-backed
config.js               your Supabase URL, anon key and the push public key
lib/brief.js            the notification briefs: grouping, wording, Denver dates
api/                    Vercel serverless functions: push subscribe/test, the two cron briefs
vendor/supabase.js      the Supabase client, vendored so the shell works offline
sw.js                   service worker: caches the shell, shows the push briefs
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

## Push notification briefs

Two pushes a day to every enabled device, weekdays only, straight from the app's own
icon — no Firebase, no third-party service:

- **☀️ Morning Brief** (~7am Mountain) — today's events and open to-dos, grouped
  Project → Space. Scoped per person: your tasks and unassigned ones, so with nothing
  assigned you both get the same brief.
- **🌙 Day Wrap** (~6pm Mountain) — what got completed today, the same grouping,
  identical for both of you. Nothing completed, no buzz.

Tapping either lands on the **Today** page, which carries the full detail behind the
digest. The wording and grouping live in `lib/brief.js`, shared by the crons and the page.

**Server setup, once:**

1. `.env.local` holds the six env values the `/api` functions need — Supabase URL and
   service role key, the three VAPID values, and `CRON_SECRET`. Copy each into Vercel
   under Project Settings → Environment Variables, all environments. The VAPID pair is
   **permanent**: rotate it and every device has to re-enable notifications. The public
   half also sits in `config.js` (public by design) and must match `VAPID_PUBLIC_KEY`.
2. Re-run `supabase/schema.sql` in the SQL editor — it's idempotent, and it now creates
   `push_subscriptions`.
3. Deploy. `vercel.json` registers the two cron jobs. **Schedules are UTC**, so the
   Denver hour slips by one when DST flips (7am becomes 6am in winter); nudge the two
   cron expressions if that grates. The Hobby plan allows exactly two once-daily crons,
   and fires them within the hour rather than on the minute.

**On each phone:** install the app first — on iOS web push only works from the
home-screen icon (iOS 16.4+), never from a Safari tab. Then tap the bell in the top
bar → *Enable on this device*, and confirm with *Send a test*. Each person enables
each of their own devices.

**Use the production URL.** Vercel gives the project three addresses and only the short
one is public; the `…-git-main-…` and per-deployment URLs sit behind Vercel
Authentication and answer a redirect to a Vercel login, which is not an obvious failure
when it happens on someone's phone.

**Testing the crons without waiting for the clock:**

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/morning
```

Same for `/api/cron/evening`. Both return a JSON summary (sent / failed / pruned, or
why they skipped) and log the same line, which is what survives in the Vercel logs.

**When a brief doesn't arrive**, in the order worth checking:

- `{"skipped":"no subscriptions"}` — no device is registered. The bell, on the phone.
- `{"skipped":"weekend"}` or `"nothing completed"` — working as intended.
- `401 Not from cron` — `CRON_SECRET` is missing from the Vercel environment, or the
  deployment predates it being set. Env changes need a redeploy.
- `500` naming a variable — that variable isn't set for this environment.
- `sent` is non-zero but nothing appeared on the phone — the push service accepted it and
  iOS dropped it. Usually the app was opened from Safari rather than the home-screen
  icon, or notifications are off for it in iOS Settings.
- `failed` is non-zero — the push service refused. The reason is in the Vercel log.

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
- **Per-item schedule reminders.** The morning brief lists today's recurring items, but
  nothing buzzes at the item's own time (the 8am reminder at 8am). That needs a `notify`
  flag per schedule and a sent-log keyed `(scheduleId, date)` — and more cron granularity
  than the Hobby plan's two once-daily jobs.
- **Offline write queue.** Reads work offline; writes fail until you reconnect.

`ARCHITECTURE.md` has notes on what each of these would take.

## Working across two Macs

If this folder lives in iCloud Drive, **don't rely on iCloud to sync the `.git` directory**.
Two machines writing to the same repo through file sync is a good way to corrupt it, and
"Optimise Mac Storage" can evict files out from under you. Once it's on GitHub, clone it on
the other Mac and use `git pull` / `git push` to move work between them — that's what the
remote is for. Keeping a copy in iCloud as a backup is fine; editing it from both ends is
not.
