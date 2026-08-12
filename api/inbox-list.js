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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Inbox-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const key = req.headers["x-inbox-key"] || req.query.key;
  if (!key || key !== process.env.INBOX_SECRET) return res.status(401).json({ error: "Unauthorized" });

  const kvKey = req.query.target === "phd" ? "inbox_phd" : "inbox";

  try {
    const raw = await kv(["GET", kvKey]);
    const items = raw ? JSON.parse(raw) : [];
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.status(200).json({ items });
  } catch (err) {
    res.status(500).json({ error: "Failed to load", detail: err.message });
  }
}
