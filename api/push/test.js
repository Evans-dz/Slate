/* POST here (signed in) to fire a test notification at every device the
   calling user has enabled. Debugging push without a manual trigger is
   miserable — keep this. */

const { service, requireUser, sendToSubscriptions } = require("../_util");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const sb = service();
  const user = await requireUser(sb, req);
  if (!user) return res.status(401).json({ error: "Sign in first" });

  const { data, error } = await sb.from("push_subscriptions")
    .select("endpoint,p256dh,auth")
    .eq("user_id", user.id);
  if (error) return res.status(500).json({ error: error.message });
  if (!data.length) return res.status(200).json({ ok: true, sent: 0, note: "No devices enabled" });

  const summary = await sendToSubscriptions(sb, data, {
    title: "Slate",
    body: "Test notification — this device is set up.",
    url: "/?view=today",
    tag: "test"
  }, 300);

  return res.status(200).json(Object.assign({ ok: true }, summary));
};
