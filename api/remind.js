import { kv, keyFor, getUser, resolveUser, getSettings, decrypt } from "./_lib.js";

async function loadEvents(user) {
  const raws = await kv(["MGET", keyFor(user, "reminders_job"), keyFor(user, "reminders_phd")]) || [];
  return raws.flatMap(raw => (raw ? JSON.parse(raw).events || [] : []));
}

// Subscribe link for the email footer: the user's calendar token, or the legacy secret for an owner who hasn't registered yet.
async function calendarToken(user) {
  if (user.calToken) return user.calToken;
  const ownerName = user.owner && (await kv(["GET", "owner_user"]));
  const owner = ownerName && (await getUser(ownerName));
  return owner?.calToken || process.env.INBOX_SECRET || "";
}

const TZ = process.env.REMIND_TZ || "Asia/Shanghai";
// en-CA formats as YYYY-MM-DD
const todayIn = tz => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const diffDays = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
const isDue = (e, today) => (e.remindOn || []).includes(today) || (e.repeatUntilDone && today >= e.date);
function dueLabel(date, today) {
  const d = diffDays(today, date);
  return d === 0 ? "今天" : d === 1 ? "明天" : d > 1 ? `还有 ${d} 天` : `已逾期 ${-d} 天`;
}
const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const GROUPS = [
  { kind: "milestone", label: "📝 笔试 / 面试", short: "笔试/面试" },
  { kind: "activity", label: "🎤 已报名的活动", short: "活动" },
  { kind: "followup", label: "📮 套磁该跟进了", short: "待跟进导师" },
  { kind: "deadline", label: "⏰ 截止日期", short: "截止" },
  { kind: "todo", label: "📌 待投岗位", short: "待投岗位" },
];

function buildEmail(due, today, siteUrl, calendarUrl) {
  const counts = [];
  const sections = GROUPS.map(g => {
    const items = due.filter(e => e.kind === g.kind).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    if (!items.length) return "";
    counts.push(`${g.short} ${items.length}`);
    const rows = items.map(e => {
      const label = dueLabel(e.date, today);
      const overdue = label.startsWith("已逾期") || label === "今天";
      const title = e.url ? `<a href="${esc(e.url)}" style="color:#2F4538">${esc(e.title)}</a>` : esc(e.title);
      return `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid #E3EEE0;white-space:nowrap;color:${overdue ? "#c0392b" : "#4A6350"};font-weight:700;font-size:13px">${label}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #E3EEE0;font-size:14px;color:#1C2E22">${title}
          <div style="font-size:12px;color:#7A8F7E;margin-top:2px">${esc(e.date)}${e.time ? " " + esc(e.time) : ""}${e.endTime ? "–" + esc(e.endTime) : ""}${e.detail ? " · " + esc(e.detail) : ""}</div></td>
      </tr>`;
    }).join("");
    return `<h3 style="font-size:15px;color:#2F4538;margin:20px 0 6px">${g.label}</h3>
      <table style="border-collapse:collapse;width:100%">${rows}</table>`;
  }).join("");

  const subject = due.length
    ? `【提醒】${today.slice(5)} 共 ${due.length} 件事：${counts.join(" · ")}`
    : `【提醒】${today.slice(5)} 测试邮件：今天没有到期事项`;
  const html = `<div style="font-family:-apple-system,'PingFang SC',sans-serif;max-width:560px;margin:0 auto;padding:8px">
    <h2 style="font-size:18px;color:#2F4538;margin:0 0 4px">今天要处理的事（${esc(today)}）</h2>
    ${sections || `<p style="color:#7A8F7E;font-size:14px">今天没有到期的提醒。这是一封测试邮件。</p>`}
    <p style="font-size:12px;color:#7A8F7E;margin-top:24px;line-height:1.7">
      套磁跟进和待投岗位的提醒会每天重复，直到你在页面上处理（改状态 / 标记已投 / 改提醒日期）。<br/>
      <a href="${esc(siteUrl)}/phd.html" style="color:#5C7A60">打开申博追踪</a> ·
      <a href="${esc(siteUrl)}/index.html" style="color:#5C7A60">打开秋招追踪</a> ·
      <a href="${esc(calendarUrl)}" style="color:#5C7A60">在 iPhone 上订阅提醒日历</a>
    </p>
  </div>`;
  return { subject, html };
}

// Each user mails themselves with their own Resend key; the owner may instead rely on the env-configured account.
async function mailConfig(user) {
  const s = await getSettings(user);
  const key = s.resendKey ? decrypt(s.resendKey) : "";
  if (key && s.email) return { key, to: [s.email], from: "在路上 提醒 <onboarding@resend.dev>" };
  if (user.owner && process.env.RESEND_API_KEY && process.env.REMIND_EMAIL_TO) {
    return {
      key: process.env.RESEND_API_KEY,
      to: process.env.REMIND_EMAIL_TO.split(",").map(s => s.trim()).filter(Boolean),
      from: process.env.REMIND_EMAIL_FROM || "Tracker 提醒 <onboarding@resend.dev>",
    };
  }
  return null;
}

// Resend's errors are in English and terse; say what to fix.
function explainResend(status, data) {
  const msg = String(data?.message || data?.error || "");
  if (/own email address/i.test(msg)) return "收信邮箱必须是你注册 Resend 时用的那个邮箱（没有验证域名时只能发给自己）";
  if (status === 401 || status === 403 && /api key/i.test(msg)) return "Resend key 不对或已被删除，请重新创建一个粘贴进来";
  if (status === 422) return `收信邮箱或发信参数有误（${msg}）`;
  if (status === 429) return "发送太频繁，过一会儿再试";
  return `Resend 发送失败（${status}${msg ? "：" + msg : ""}）`;
}

// Build and (unless nothing is due) send one user's digest. Returns { sent, due } or { error }.
async function runFor(user, { today, test, siteUrl }) {
  const due = (await loadEvents(user)).filter(e => isDue(e, today));
  if (!due.length && !test) return { sent: false, due: 0 };
  const mail = await mailConfig(user);
  if (!mail) return { error: "还没填 Resend key 和收信邮箱", due: due.length };
  const calendarUrl = `${siteUrl}/api/calendar?subscribe=1&key=${encodeURIComponent(await calendarToken(user))}`;
  const { subject, html } = buildEmail(due, today, siteUrl, calendarUrl);
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${mail.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: mail.from, to: mail.to, subject, html }),
  });
  const data = await r.json().catch(() => ({}));
  return r.ok ? { sent: true, due: due.length, id: data.id } : { error: explainResend(r.status, data), due: due.length };
}

// Everyone with an account, plus the owner (who keeps the original keys even before registering).
async function allUsers() {
  const names = (await kv(["SMEMBERS", "users"])) || [];
  const users = (await Promise.all(names.map(getUser))).filter(u => u && !u.owner);
  return [{ name: (await kv(["GET", "owner_user"])) || "站长", owner: true },
    ...users.map(u => ({ name: u.name, owner: false, calToken: u.calToken }))];
}

// Called daily by Vercel Cron (Authorization: Bearer CRON_SECRET) for every user, or manually by a signed-in user for themselves.
// ?dry=1 previews without sending, ?date=YYYY-MM-DD simulates another day, ?test=1 sends even when nothing is due.
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Inbox-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const cronOk = process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const today = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "") ? req.query.date : todayIn(TZ);
  const dry = req.query.dry === "1";
  const test = req.query.test === "1";
  const siteUrl = process.env.SITE_URL || `https://${req.headers["x-forwarded-host"] || req.headers.host}`;

  try {
    if (cronOk && !req.headers["x-inbox-key"] && !req.query.key) {
      const results = [];
      for (const u of await allUsers()) {
        try { results.push({ user: u.name, ...(await runFor(u, { today, test: false, siteUrl })) }); }
        catch (err) { results.push({ user: u.name, error: err.message }); }
      }
      return res.status(200).json({ ok: true, date: today, results });
    }

    const user = await resolveUser(req);
    if (!user) return res.status(401).json({ error: "Unauthorized" });

    if (dry) {
      const due = (await loadEvents(user)).filter(e => isDue(e, today));
      const calendarUrl = `${siteUrl}/api/calendar?subscribe=1&key=${encodeURIComponent(await calendarToken(user))}`;
      const { subject, html } = buildEmail(due, today, siteUrl, calendarUrl);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(`<div style="background:#FFF6D6;padding:10px 14px;font:13px sans-serif;margin-bottom:12px">
        预览（未发送）· 模拟日期 ${esc(today)} · 主题：${esc(subject)}${due.length ? "" : " · 今天没有到期事项，定时任务不会发信"}</div>${html}`);
    }

    const out = await runFor(user, { today, test, siteUrl });
    if (out.error) return res.status(400).json(out);
    res.status(200).json({ ok: true, date: today, ...out });
  } catch (err) {
    res.status(500).json({ error: "Failed", detail: err.message });
  }
}
