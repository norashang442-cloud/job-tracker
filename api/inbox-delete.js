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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Inbox-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const key = req.headers["x-inbox-key"] || req.query.key;
  if (!key || key !== process.env.INBOX_SECRET) return res.status(401).json({ error: "Unauthorized" });

  const { id, target } = req.body || {};
  if (!id) return res.status(400).json({ error: "No id" });
  const kvKey = target === "phd" ? "inbox_phd" : "inbox";

  try {
    const raw = await kv(["GET", kvKey]);
    const items = raw ? JSON.parse(raw) : [];
    const filtered = items.filter(i => i.id !== id);
    await kv(["SET", kvKey, JSON.stringify(filtered)]);
    res.status(200).json({ ok: true, count: filtered.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete", detail: err.message });
  }
}
