import { kv, cors, randomToken, hashPassword, checkPassword, getUser, resolveUser, keyFor, getSettings, encrypt } from "./_lib.js";

// Accounts: invite-only registration, username + password login.
// Registering with INBOX_SECRET as the invite code creates the owner account (once); the owner hands out invite codes.
const SESSION_TTL = 60 * 60 * 24 * 365;
const NAME_RE = /^[a-z0-9_\-一-龥]{2,20}$/;

async function newSession(name) {
  const token = randomToken();
  await kv(["SET", `session:${token}`, name, "EX", SESSION_TTL]);
  return token;
}

export default async function handler(req, res) {
  cors(res, "POST");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body = req.body || {};
  const name = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");

  try {
    switch (body.action) {
      case "register": {
        if (!NAME_RE.test(name)) return res.status(400).json({ error: "用户名 2–20 位，可用中文、小写字母、数字、- 和 _" });
        if (password.length < 6) return res.status(400).json({ error: "密码至少 6 位" });
        const code = String(body.code || "").trim();
        if (!code) return res.status(400).json({ error: "需要邀请码" });
        const asOwner = !!process.env.INBOX_SECRET && code === process.env.INBOX_SECRET;
        if (asOwner && (await kv(["GET", "owner_user"]))) return res.status(400).json({ error: "站长账号已经注册过了" });
        if (!asOwner && !(await kv(["SISMEMBER", "invites", code]))) return res.status(400).json({ error: "邀请码无效或已被使用" });

        const user = { name, ...hashPassword(password), owner: asOwner, calToken: randomToken(18), createdAt: new Date().toISOString() };
        // NX: the username is claimed atomically, so two people can't register the same name at once.
        if (!(await kv(["SET", `user:${name}`, JSON.stringify(user), "NX"]))) return res.status(400).json({ error: "这个用户名已经有人用了" });
        if (asOwner) await kv(["SET", "owner_user", name]);
        else await kv(["SREM", "invites", code]);
        await kv(["SET", `cal:${user.calToken}`, name]);
        await kv(["SADD", "users", name]);
        return res.status(200).json({ token: await newSession(name), user: { name, owner: asOwner } });
      }

      case "login": {
        const user = await getUser(name);
        if (!user || !checkPassword(password, user)) return res.status(401).json({ error: "用户名或密码不对" });
        return res.status(200).json({ token: await newSession(name), user: { name, owner: !!user.owner } });
      }

      case "logout": {
        const key = req.headers["x-inbox-key"];
        if (key && key !== process.env.INBOX_SECRET) await kv(["DEL", `session:${key}`]);
        return res.status(200).json({ ok: true });
      }
    }

    // Everything below needs a signed-in caller.
    const me = await resolveUser(req);
    if (!me) return res.status(401).json({ error: "Unauthorized" });

    switch (body.action) {
      case "me":
        return res.status(200).json({ user: me });

      // Mail settings: the user's own Resend key (only ever returned as a masked hint) and the address it may send to.
      case "settings-get": {
        const s = await getSettings(me);
        return res.status(200).json({ email: s.email || "", resendHint: s.resendHint || "", envFallback: me.owner && !!process.env.RESEND_API_KEY });
      }

      case "settings-set": {
        const s = await getSettings(me);
        const email = String(body.email ?? s.email ?? "").trim();
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "邮箱格式不对" });
        const next = { ...s, email };
        const resendKey = String(body.resendKey || "").trim();
        if (resendKey) {
          if (!/^re_\w{8,}$/.test(resendKey)) return res.status(400).json({ error: "Resend key 应该以 re_ 开头，检查是否复制完整" });
          next.resendKey = encrypt(resendKey);
          next.resendHint = `${resendKey.slice(0, 5)}…${resendKey.slice(-4)}`;
        }
        if (body.clearResend) { delete next.resendKey; delete next.resendHint; }
        await kv(["SET", keyFor(me, "settings"), JSON.stringify(next)]);
        return res.status(200).json({ email: next.email, resendHint: next.resendHint || "" });
      }

      case "invite-create": {
        if (!me.owner) return res.status(403).json({ error: "只有站长能生成邀请码" });
        const code = randomToken(6);
        await kv(["SADD", "invites", code]);
        return res.status(200).json({ code });
      }

      case "admin-list": {
        if (!me.owner) return res.status(403).json({ error: "Forbidden" });
        const [users, invites] = await Promise.all([kv(["SMEMBERS", "users"]), kv(["SMEMBERS", "invites"])]);
        return res.status(200).json({ users: (users || []).sort(), invites: invites || [] });
      }

      case "invite-delete": {
        if (!me.owner) return res.status(403).json({ error: "Forbidden" });
        await kv(["SREM", "invites", String(body.code || "")]);
        return res.status(200).json({ ok: true });
      }
    }
    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    res.status(500).json({ error: "Failed", detail: err.message });
  }
}
