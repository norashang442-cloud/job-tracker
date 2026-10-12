import { kv, cors, keyFor, resolveUser } from "./_lib.js";

export default async function handler(req, res) {
  cors(res, "POST");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { id, target } = req.body || {};

  try {
    const user = await resolveUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    if (!id) return res.status(400).json({ error: "No id" });
    const kvKey = keyFor(user, target === "phd" ? "inbox_phd" : "inbox");

    const raw = await kv(["GET", kvKey]);
    const items = raw ? JSON.parse(raw) : [];
    const filtered = items.filter(i => i.id !== id);
    await kv(["SET", kvKey, JSON.stringify(filtered)]);
    res.status(200).json({ ok: true, count: filtered.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete", detail: err.message });
  }
}
