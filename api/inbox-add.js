import { kv, cors, keyFor, resolveUser } from "./_lib.js";

export default async function handler(req, res) {
  cors(res, "POST");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { content, target, kind } = req.body || {};
  const text = (content || "").trim();

  try {
    const user = await resolveUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!text) return res.status(400).json({ error: "No content" });
    const kvKey = keyFor(user, target === "phd" ? "inbox_phd" : "inbox");

    const raw = await kv(["GET", kvKey]);
    const items = raw ? JSON.parse(raw) : [];
    items.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      content: text,
      type: /^https?:\/\//i.test(text) ? "url" : "text",
      ...(kind === "event" ? { kind: "event" } : {}),
      createdAt: new Date().toISOString(),
    });
    await kv(["SET", kvKey, JSON.stringify(items)]);
    res.status(200).json({ ok: true, count: items.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to save", detail: err.message });
  }
}
