/* POST a PushSubscription here to start receiving the briefs on a device.
   Body: { subscription: { endpoint, keys: { p256dh, auth } }, userAgent? }
   Auth: the signed-in user's Supabase access token as a bearer token.

   Upserts on endpoint — re-enabling from the same device updates the existing
   row instead of stacking duplicates. One row per device per user. */

const { handler, service, requireUser } = require("../_util");

module.exports = handler(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const sb = service();
  const user = await requireUser(sb, req);
  if (!user) return res.status(401).json({ error: "Sign in first" });

  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: "Not a push subscription" });
  }

  const { error } = await sb.from("push_subscriptions").upsert({
    user_id: user.id,
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
    user_agent: (req.body.userAgent || "").slice(0, 300) || null
  }, { onConflict: "endpoint" });

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
});
