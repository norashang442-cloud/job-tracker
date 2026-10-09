async function kv(cmd) {
  const res = await fetch(process.env.KV_REST_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

const diffDays = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
const icsEscape = s => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const compact = d => d.replace(/-/g, "");
const PREFIX = { followup: "📮 跟进", milestone: "📝", deadline: "⏰" };

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

// One alarm per remindOn date. All-day events fire at 09:00 local on that day; timed events fire N days before, or 2h before on the day itself.
function alarms(e) {
  return (e.remindOn || []).map(r => {
    const d = diffDays(r, e.date);
    let trigger;
    if (e.time) trigger = d === 0 ? "-PT2H" : `-P${d}D`;
    else { const h = 9 - 24 * d; trigger = h >= 0 ? `PT${h}H` : `-PT${-h}H`; }
    return ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(e.title)}`, `TRIGGER:${trigger}`, "END:VALARM"];
  }).flat();
}

function buildEvent(e, dtstamp) {
  let dt;
  if (e.time) {
    dt = [`DTSTART:${compact(e.date)}T${e.time.replace(":", "")}00`, "DURATION:PT1H"];
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
  const key = req.query.key;
  if (!key || key !== process.env.INBOX_SECRET) return res.status(401).send("Unauthorized");

  try {
    const events = [];
    for (const k of ["reminders_job", "reminders_phd"]) {
      const raw = await kv(["GET", k]);
      if (raw) events.push(...(JSON.parse(raw).events || []));
    }
    const dtstamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//job-tracker//reminders//CN", "CALSCALE:GREGORIAN",
      "X-WR-CALNAME:求职/申博提醒", "X-PUBLISHED-TTL:PT1H", "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
      ...events.flatMap(e => buildEvent(e, dtstamp)),
      "END:VCALENDAR",
    ];
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(lines.map(fold).join("\r\n"));
  } catch (err) {
    res.status(500).send("Failed: " + err.message);
  }
}
