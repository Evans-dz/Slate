/* The day wrap: what got completed today, grouped Project -> Space. One shared
   brief for everyone — the wrap is team news, not a per-person report. Fires at
   00:00 UTC, which is 6pm Denver in summer; the Denver calendar decides what
   "today" and "weekend" mean, so the UTC date being tomorrow doesn't matter.

   Test by hand:
   curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/evening */

const { handler, service, fromCron, fetchDocs, sendToSubscriptions } = require("../_util");
const brief = require("../../lib/brief");

const EVENING_HOUR = 18; // Denver local

module.exports = handler(async (req, res) => {
  if (!fromCron(req)) return res.status(401).json({ error: "Not from cron" });

  /* Registered at both 00:00 and 01:00 UTC so the 6pm Denver slot holds across
     daylight time; the one that isn't 6pm there right now stops here. ?force=1
     runs it anyway, for testing by hand — reaching this line already required
     the cron secret. */
  const hour = brief.denverHour();
  const force = String((req.query && req.query.force) || "") === "1";
  if (!force && hour !== EVENING_HOUR) {
    return res.status(200).json({ skipped: "not " + EVENING_HOUR + ":00 in Denver", denverHour: hour });
  }

  const today = brief.denverToday();
  if (brief.isWeekend(today.dow)) {
    return res.status(200).json({ date: today.ymd, skipped: "weekend" });
  }

  const sb = service();
  const subs = await sb.from("push_subscriptions").select("user_id,endpoint,p256dh,auth");
  if (subs.error) return res.status(500).json({ error: subs.error.message });
  if (!subs.data.length) return res.status(200).json({ date: today.ymd, skipped: "no subscriptions" });

  const data = await fetchDocs(sb, ["projects", "spaces", "tasks"]);
  const model = brief.eveningModel(data, { ymd: today.ymd });
  if (!model.count) return res.status(200).json({ date: today.ymd, skipped: "nothing completed" });

  const summary = await sendToSubscriptions(sb, subs.data, brief.formatEvening(model), 6 * 3600);
  const out = Object.assign({ date: today.ymd, completed: model.count }, summary);
  console.log("evening brief", JSON.stringify(out));
  return res.status(200).json(out);
});
