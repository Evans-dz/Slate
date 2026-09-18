/* The morning brief: today's events and open to-dos, grouped Project -> Space.
   Runs on Vercel Cron (see vercel.json); the schedule is UTC so the Denver hour
   drifts by one when DST flips. Weekends are skipped by Denver's calendar, not
   UTC's. Scoped per user — your tasks and unassigned ones — which degrades to
   identical briefs while nothing is assigned.

   Test by hand:
   curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/morning */

const { handler, service, fromCron, fetchDocs, sendToSubscriptions } = require("../_util");
const brief = require("../../lib/brief");

module.exports = handler(async (req, res) => {
  if (!fromCron(req)) return res.status(401).json({ error: "Not from cron" });

  const today = brief.denverToday();
  if (brief.isWeekend(today.dow)) {
    return res.status(200).json({ date: today.ymd, skipped: "weekend" });
  }

  const sb = service();
  const subs = await sb.from("push_subscriptions").select("user_id,endpoint,p256dh,auth");
  if (subs.error) return res.status(500).json({ error: subs.error.message });
  if (!subs.data.length) return res.status(200).json({ date: today.ymd, skipped: "no subscriptions" });

  const data = await fetchDocs(sb, ["projects", "spaces", "tasks", "schedules"]);

  const byUser = {};
  subs.data.forEach((row) => { (byUser[row.user_id] = byUser[row.user_id] || []).push(row); });

  const summary = { date: today.ymd, sent: 0, failed: 0, pruned: 0, quiet: 0 };
  for (const uid of Object.keys(byUser)) {
    const model = brief.morningModel(data, { ymd: today.ymd, uid: uid });
    if (!model.events.length && !model.openCount) { summary.quiet++; continue; } // nothing to say
    const r = await sendToSubscriptions(sb, byUser[uid], brief.formatMorning(model), 6 * 3600);
    summary.sent += r.sent; summary.failed += r.failed; summary.pruned += r.pruned;
  }

  return res.status(200).json(summary);
});
