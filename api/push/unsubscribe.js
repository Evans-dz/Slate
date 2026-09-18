/* POST { endpoint } to stop notifications for one device. The row goes by
   endpoint alone: endpoints are unguessable, and a device that presents one
   no longer wants pushes regardless of which account is signed in. */

const { handler, service, requireUser } = require("../_util");

module.exports = handler(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const sb = service();
  const user = await requireUser(sb, req);
  if (!user) return res.status(401).json({ error: "Sign in first" });

  const endpoint = req.body && req.body.endpoint;
  if (!endpoint) return res.status(400).json({ error: "endpoint required" });

  const { error } = await sb.from("push_subscriptions").delete().eq("endpoint", endpoint);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
});
