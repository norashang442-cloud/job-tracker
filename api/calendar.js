import { kv, keyFor, resolveCalendarUser } from "./_lib.js";

const diffDays = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
const icsEscape = s => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const compact = d => d.replace(/-/g, "");
const PREFIX = { followup: "📮 跟进", milestone: "📝", deadline: "⏰", todo: "📌", activity: "🎤" };

// RFC 5545 caps lines at 75 octets; fold on character boundaries so CJK text isn't split mid-byte.
function fold(line) {
  const out = [];
  let cur = "", bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

// Only milestones (online tests, interviews…) get alarms — missing those can't be undone. Deadlines, follow-ups,
// to-dos and activities show up in the calendar and daily email without ringing.
// One alarm per remindOn date. All-day events fire at 09:00 local on that day; timed events fire N days before, or 2h before on the day itself.
function alarms(e) {
  if (e.kind !== "milestone" || e.noAlarm) return [];
  return (e.remindOn || []).map(r => {
    const d = diffDays(r, e.date);
    let trigger;
    if (e.time) trigger = d === 0 ? "-PT2H" : `-P${d}D`;
    else { const h = 9 - 24 * d; trigger = h >= 0 ? `PT${h}H` : `-PT${-h}H`; }
    return ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(e.title)}`, `TRIGGER:${trigger}`, "END:VALARM"];
  }).flat();
}

// Event times are Beijing wall-clock (the page converts activities into the user's own timezone, which is UTC+8).
// Tagging them with TZID instead of leaving them floating stops Outlook from reading them as UTC.
const TZID = "Asia/Shanghai";
const VTIMEZONE = [
  "BEGIN:VTIMEZONE", `TZID:${TZID}`, "BEGIN:STANDARD", "DTSTART:19700101T000000",
  "TZOFFSETFROM:+0800", "TZOFFSETTO:+0800", "TZNAME:CST", "END:STANDARD", "END:VTIMEZONE",
];

function buildEvent(e, dtstamp) {
  let dt;
  if (e.time) {
    const start = `DTSTART;TZID=${TZID}:${compact(e.date)}T${e.time.replace(":", "")}00`;
    dt = e.endTime && e.endTime > e.time
      ? [start, `DTEND;TZID=${TZID}:${compact(e.date)}T${e.endTime.replace(":", "")}00`]
      : [start, "DURATION:PT1H"];
  } else {
    const end = new Date(e.date + "T00:00:00Z"); end.setUTCDate(end.getUTCDate() + 1);
    dt = [`DTSTART;VALUE=DATE:${compact(e.date)}`, `DTEND;VALUE=DATE:${compact(end.toISOString().slice(0, 10))}`];
  }
  const desc = [e.detail, e.url].filter(Boolean).join("\n");
  // VEVENT properties must precede VALARM, otherwise Apple Calendar drops SUMMARY.
  return [
    "BEGIN:VEVENT", `UID:${e.id}@job-tracker`, `DTSTAMP:${dtstamp}`, ...dt,
    `SUMMARY:${icsEscape(`${PREFIX[e.kind] || ""} ${e.title}`.trim())}`,
    desc ? `DESCRIPTION:${icsEscape(desc)}` : null,
    e.url ? `URL:${e.url}` : null,
    ...alarms(e),
    "END:VEVENT",
  ].filter(Boolean);
}

export default async function handler(req, res) {
  // vercel.json rewrites /api/calendar/<key>.ics here — new Outlook won't subscribe to the ?key= form.
  // The key is the user's calendar token (or the owner's legacy INBOX_SECRET), never their login session.
  const key = req.query.key;
  let user;
  try { user = await resolveCalendarUser(key); } catch (err) { return res.status(500).send("Failed: " + err.message); }
  if (!user) return res.status(401).send("Unauthorized");

  // Gmail strips webcal:// links from emails, so the email links here (https) and this page hands off to webcal://.
  if (req.query.subscribe === "1") {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const webcal = `webcal://${host}/api/calendar/${encodeURIComponent(key)}.ics`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><title>订阅提醒日历</title></head>
<body style="font-family:-apple-system,'PingFang SC',sans-serif;background:#F2F7F1;color:#1C2E22;margin:0;padding:32px 20px;text-align:center">
<h2 style="color:#2F4538;font-size:20px">📅 订阅求职 / 申博提醒日历</h2>
<p style="font-size:14px;color:#4A6350;line-height:1.7">如果没有自动弹出订阅窗口，点下面的按钮。<br/>订阅时记得<b>关闭「移除提醒」</b>，否则日历不会响。</p>
<a href="${webcal}" style="display:inline-block;margin-top:12px;padding:12px 24px;border-radius:10px;background:#2F4538;color:#fff;text-decoration:none;font-weight:700">订阅日历</a>
<script>location.href=${JSON.stringify(webcal)};</script>
</body></html>`);
  }

  try {
    // One round trip: Outlook's fetcher gives up quickly on slow feeds.
    const events = (await kv(["MGET", keyFor(user, "reminders_job"), keyFor(user, "reminders_phd")]) || [])
      .flatMap(raw => (raw ? JSON.parse(raw).events || [] : []));
    const dtstamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//job-tracker//reminders//CN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "X-WR-CALNAME:求职/申博提醒", `X-WR-TIMEZONE:${TZID}`, "X-PUBLISHED-TTL:PT1H", "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
      ...VTIMEZONE,
      ...events.flatMap(e => buildEvent(e, dtstamp)),
      "END:VCALENDAR",
    ];
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", 'inline; filename="reminders.ics"');
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(lines.map(fold).join("\r\n") + "\r\n");
  } catch (err) {
    res.status(500).send("Failed: " + err.message);
  }
}
