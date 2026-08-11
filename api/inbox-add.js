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

  const { content } = req.body || {};
  const text = (content || "").trim();
  if (!text) return res.status(400).json({ error: "No content" });

  try {
    const raw = await kv(["GET", "inbox"]);
    const items = raw ? JSON.parse(raw) : [];
    items.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      content: text,
      type: /^https?:\/\//i.test(text) ? "url" : "text",
      createdAt: new Date().toISOString(),
    });
    await kv(["SET", "inbox", JSON.stringify(items)]);
    res.status(200).json({ ok: true, count: items.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to save", detail: err.message });
  }
}
