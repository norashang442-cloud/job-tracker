import { kv, cors, keyFor, resolveUser } from "./_lib.js";

export default async function handler(req, res) {
  cors(res, "GET");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const user = await resolveUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    const kvKey = keyFor(user, req.query.target === "phd" ? "inbox_phd" : "inbox");

    const raw = await kv(["GET", kvKey]);
    const items = raw ? JSON.parse(raw) : [];
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.status(200).json({ items });
  } catch (err) {
    res.status(500).json({ error: "Failed to load", detail: err.message });
  }
}
