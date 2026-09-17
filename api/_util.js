/* Shared plumbing for the /api functions. The leading underscore keeps Vercel
   from serving this file as an endpoint.

   Env (set in Vercel and .env.local, see README "Push notification briefs"):
     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   server-side Supabase, bypasses RLS
     VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT   web push identity
     CRON_SECRET   Vercel Cron sends it as a bearer token */

const { createClient } = require("@supabase/supabase-js");
const webpush = require("web-push");

let vapidReady = false;

function service() {
  const url = process.env.SUPABASE_URL;
  // either name: the classic service_role JWT or Supabase's new sb_secret_... key
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) not set");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function configureWebPush() {
  if (vapidReady) return;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) throw new Error("VAPID keys not set");
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:evans@armour-crete.com", pub, priv);
  vapidReady = true;
}

/* The signed-in Supabase user behind a request, from its Authorization header.
   Returns null when the token is missing or bad — the caller 401s. */
async function requireUser(sb, req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return null;
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data || !data.user) return null;
  return data.user;
}

/* True when the request carries the cron secret Vercel attaches to scheduled
   invocations. Without this check the brief routes are publicly callable. */
function fromCron(req) {
  const secret = process.env.CRON_SECRET;
  return !!secret && (req.headers.authorization || "") === "Bearer " + secret;
}

/* Every doc in the given collections, as { collection: [{ id, ...data }] }.
   Paged because PostgREST caps a single response at 1000 rows. */
async function fetchDocs(sb, collections) {
  const out = {};
  collections.forEach((c) => { out[c] = []; });
  const page = 1000;
  for (let from = 0; ; from += page) {
    const r = await sb.from("docs")
      .select("collection,id,data")
      .in("collection", collections)
      .order("collection").order("id")
      .range(from, from + page - 1);
    if (r.error) throw r.error;
    r.data.forEach((row) => {
      const o = Object.assign({}, row.data);
      o.id = row.id;
      out[row.collection].push(o);
    });
    if (r.data.length < page) break;
  }
  return out;
}

/* Send one payload to a batch of subscription rows. Endpoints the push service
   reports gone (404/410) are deleted — subscriptions expire on their own and the
   table accumulates garbage otherwise. Returns { sent, failed, pruned }. */
async function sendToSubscriptions(sb, subs, payload, ttl) {
  configureWebPush();
  const body = JSON.stringify(payload);
  const results = await Promise.all(subs.map(async (row) => {
    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        body,
        { TTL: ttl || 6 * 3600 }
      );
      return { row, ok: true };
    } catch (e) {
      return { row, ok: false, status: e && e.statusCode };
    }
  }));

  const summary = { sent: 0, failed: 0, pruned: 0 };
  await Promise.all(results.map(async (r) => {
    if (r.ok) {
      summary.sent++;
      await sb.from("push_subscriptions")
        .update({ last_success_at: new Date().toISOString() })
        .eq("endpoint", r.row.endpoint);
    } else if (r.status === 404 || r.status === 410) {
      summary.pruned++;
      await sb.from("push_subscriptions").delete().eq("endpoint", r.row.endpoint);
    } else {
      summary.failed++;
    }
  }));
  return summary;
}

module.exports = { service, requireUser, fromCron, fetchDocs, sendToSubscriptions };
