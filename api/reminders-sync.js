import { kv, cors, keyFor, resolveUser } from "./_lib.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, max) => String(v ?? "").slice(0, max);

// Pages push their whole reminder list on every change; each target overwrites its own key.
export default async function handler(req, res) {
  cors(res, "POST");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let user;
  try { user = await resolveUser(req); } catch (err) { return res.status(500).json({ error: "Failed", detail: err.message }); }
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const { target, events } = req.body || {};
  if (!Array.isArray(events)) return res.status(400).json({ error: "events must be an array" });
  const kvKey = keyFor(user, target === "phd" ? "reminders_phd" : "reminders_job");

  const clean = events.slice(0, 1000)
    .filter(e => e && DATE_RE.test(e.date))
    .map(e => ({
      id: str(e.id, 120),
      kind: ["followup", "milestone", "deadline", "todo", "activity"].includes(e.kind) ? e.kind : "deadline",
      title: str(e.title, 200),
      detail: str(e.detail, 300),
      date: e.date,
      time: /^\d{2}:\d{2}$/.test(e.time || "") ? e.time : "",
      endTime: /^\d{2}:\d{2}$/.test(e.endTime || "") ? e.endTime : "",
      noAlarm: !!e.noAlarm,
      url: /^https?:\/\//i.test(e.url || "") ? str(e.url, 500) : "",
      remindOn: Array.isArray(e.remindOn) ? e.remindOn.filter(d => DATE_RE.test(d)).slice(0, 10) : [],
      repeatUntilDone: !!e.repeatUntilDone,
    }));

  try {
    await kv(["SET", kvKey, JSON.stringify({ syncedAt: new Date().toISOString(), events: clean })]);
    res.status(200).json({ ok: true, count: clean.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to save", detail: err.message });
  }
}
