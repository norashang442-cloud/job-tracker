// Shared helpers for the API routes. The leading underscore keeps Vercel from deploying this file as an endpoint.
import crypto from "crypto";

export async function kv(cmd) {
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

export function cors(res, methods) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", `${methods}, OPTIONS`);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Inbox-Key");
}

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString("base64url");

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(password, salt, 32).toString("hex") };
}
export function checkPassword(password, user) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.hash, "hex"));
}

// The owner keeps the original un-prefixed KV keys (inbox, reminders_job…), so nothing had to be migrated.
export const keyFor = (user, base) => (user.owner ? base : `u:${user.name}:${base}`);

export async function getUser(name) {
  const raw = await kv(["GET", `user:${name}`]);
  return raw ? JSON.parse(raw) : null;
}

// Who is calling? The X-Inbox-Key header (or ?key=) carries either a login session token or,
// for the owner's older devices, the legacy INBOX_SECRET.
export async function resolveUser(req) {
  const key = req.headers["x-inbox-key"] || req.query.key;
  if (!key) return null;
  if (process.env.INBOX_SECRET && key === process.env.INBOX_SECRET) {
    const ownerName = await kv(["GET", "owner_user"]);
    return { name: ownerName || "站长", owner: true, legacy: true };
  }
  const name = await kv(["GET", `session:${key}`]);
  if (!name) return null;
  const user = await getUser(name);
  return user ? { name: user.name, owner: !!user.owner, calToken: user.calToken, aiAllowed: !!user.aiAllowed } : null;
}

// ---------- AI auto-fill: two channels ----------
// 1. The caller's own DeepSeek key (X-DeepSeek-Key, kept only in their browser) — no login, no cost to the site.
// 2. The site's DEEPSEEK_API_KEY — owner unlimited; other users only once the owner enables them, capped per day.
export const AI_DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT) || 30;
const beijingDay = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
export const usageKey = name => `usage:${name}:${beijingDay()}`;

export async function aiAccess(req) {
  const own = String(req.headers["x-deepseek-key"] || "").trim();
  if (own) return { key: own, own: true };
  const user = await resolveUser(req);
  if (!user) return { status: 401, error: "自动填写需要先登录（使用系统额度），或在「👤 账号」里填自己的 DeepSeek key" };
  if (!user.owner) {
    if (!user.aiAllowed) return { status: 403, error: "自动填写的系统额度还没为你开通：找站长开通，或在「👤 账号」里填自己的 DeepSeek key" };
    const k = usageKey(user.name);
    const n = await kv(["INCR", k]);
    if (n === 1) await kv(["EXPIRE", k, 2 * 86400]);
    if (n > AI_DAILY_LIMIT) return { status: 429, error: `今天的自动填写次数（${AI_DAILY_LIMIT} 次）用完了，明天再来，或在「👤 账号」里填自己的 DeepSeek key` };
  }
  return { key: process.env.DEEPSEEK_API_KEY, own: false };
}

export function aiError(status, own) {
  if (status === 401) return own ? "你的 DeepSeek key 不对或已被删除，请在「👤 账号」里重新填写" : "系统的 DeepSeek key 失效了，请联系站长";
  if (status === 402) return own ? "你的 DeepSeek 账户余额不足，需要先去 DeepSeek 开放平台充值" : "系统额度的余额用完了，请联系站长";
  if (status === 429) return "DeepSeek 请求太频繁，过一会儿再试";
  return `自动填写暂时不可用（DeepSeek ${status}）`;
}

// Per-user settings (Resend key, mail address, site URL). Secrets are AES-GCM encrypted with a key derived
// from INBOX_SECRET, so a leaked database dump alone doesn't expose them — the site owner can still decrypt.
const cipherKey = () => crypto.createHash("sha256").update("settings:" + (process.env.INBOX_SECRET || "")).digest();
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", cipherKey(), iv);
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map(b => b.toString("base64url")).join(".");
}
export function decrypt(blob) {
  try {
    const [iv, tag, data] = blob.split(".").map(s => Buffer.from(s, "base64url"));
    const d = crypto.createDecipheriv("aes-256-gcm", cipherKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  } catch { return ""; }
}
export async function getSettings(user) {
  const raw = await kv(["GET", keyFor(user, "settings")]);
  return raw ? JSON.parse(raw) : {};
}

// Calendar feeds are fetched by calendar apps, so they use a separate per-user token rather than the login session.
export async function resolveCalendarUser(token) {
  if (!token) return null;
  if (process.env.INBOX_SECRET && token === process.env.INBOX_SECRET) return { name: "站长", owner: true };
  const name = await kv(["GET", `cal:${token}`]);
  const user = name && (await getUser(name));
  return user ? { name: user.name, owner: !!user.owner } : null;
}
