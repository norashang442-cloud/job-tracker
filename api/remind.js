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

async function loadEvents() {
  const out = [];
  for (const k of ["reminders_job", "reminders_phd"]) {
    const raw = await kv(["GET", k]);
    if (raw) out.push(...(JSON.parse(raw).events || []));
  }
  return out;
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
  { kind: "followup", label: "📮 套磁该跟进了", short: "待跟进导师" },
  { kind: "deadline", label: "⏰ 截止日期", short: "截止" },
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
          <div style="font-size:12px;color:#7A8F7E;margin-top:2px">${esc(e.date)}${e.time ? " " + esc(e.time) : ""}${e.detail ? " · " + esc(e.detail) : ""}</div></td>
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
      套磁跟进的提醒会每天重复，直到你在页面上把状态改掉（已跟进 / 已回复等）。<br/>
      <a href="${esc(siteUrl)}/phd.html" style="color:#5C7A60">打开申博追踪</a> ·
      <a href="${esc(siteUrl)}/index.html" style="color:#5C7A60">打开秋招追踪</a> ·
      <a href="${esc(calendarUrl)}" style="color:#5C7A60">在 iPhone 上订阅提醒日历</a>
    </p>
  </div>`;
  return { subject, html };
}

// Called daily by Vercel Cron (Authorization: Bearer CRON_SECRET), or manually with ?key=INBOX_SECRET.
// ?dry=1 previews without sending, ?date=YYYY-MM-DD simulates another day, ?test=1 sends even when nothing is due.
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Inbox-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const cronOk = process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const key = req.headers["x-inbox-key"] || req.query.key;
  if (!cronOk && (!key || key !== process.env.INBOX_SECRET)) return res.status(401).json({ error: "Unauthorized" });

  const today = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "") ? req.query.date : todayIn(TZ);
  const dry = req.query.dry === "1";
  const test = req.query.test === "1";
  const siteUrl = process.env.SITE_URL || `https://${req.headers["x-forwarded-host"] || req.headers.host}`;
  const calendarUrl = `${siteUrl.replace(/^https?:/, "webcal:")}/api/calendar?key=${encodeURIComponent(process.env.INBOX_SECRET || "")}`;

  try {
    const due = (await loadEvents()).filter(e => isDue(e, today));
    const { subject, html } = buildEmail(due, today, siteUrl, calendarUrl);

    if (dry) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(`<div style="background:#FFF6D6;padding:10px 14px;font:13px sans-serif;margin-bottom:12px">
        预览（未发送）· 模拟日期 ${esc(today)} · 主题：${esc(subject)}${due.length ? "" : " · 今天没有到期事项，定时任务不会发信"}</div>${html}`);
    }
    if (!due.length && !test) return res.status(200).json({ ok: true, sent: false, date: today, due: 0 });

    if (!process.env.RESEND_API_KEY || !process.env.REMIND_EMAIL_TO) {
      return res.status(500).json({ error: "缺少 RESEND_API_KEY 或 REMIND_EMAIL_TO 环境变量" });
    }
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.REMIND_EMAIL_FROM || "Tracker 提醒 <onboarding@resend.dev>",
        to: process.env.REMIND_EMAIL_TO.split(",").map(s => s.trim()).filter(Boolean),
        subject,
        html,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: "Resend 发送失败", detail: data });
    res.status(200).json({ ok: true, sent: true, date: today, due: due.length, id: data.id });
  } catch (err) {
    res.status(500).json({ error: "Failed", detail: err.message });
  }
}
