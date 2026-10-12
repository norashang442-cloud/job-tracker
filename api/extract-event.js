const TIMEZONES = ["Asia/Shanghai", "Europe/London", "Europe/Paris", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Australia/Sydney", "UTC"];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { text, url, context } = req.body;
  if (!text && !url) return res.status(400).json({ error: "No input provided" });

  let content = text || "";

  // If URL provided, try to fetch page content
  if (url) {
    try {
      const pageRes = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "en-GB,en;q=0.9,zh-CN;q=0.8",
        },
        signal: AbortSignal.timeout(8000),
      });
      if (pageRes.ok) {
        const html = await pageRes.text();
        const stripped = html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 4000);
        content = stripped + (text ? "\n\n补充文字：" + text : "");
      } else {
        content = "URL：" + url + (text ? "\n\n补充文字：" + text : "");
      }
    } catch {
      content = "URL：" + url + (text ? "\n\n补充文字：" + text : "");
    }
  }

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const orgField = context === "phd"
    ? `- school: 相关的学校/大学名称（如果是某个学校或项目办的活动）`
    : `- company: 相关的公司名称（如果是某家公司办的宣讲会/Insight Day 等）`;

  const prompt = `从以下内容中提取一个线上/线下活动（宣讲会、网络研讨会、Open Day、讲座、答疑会等）的信息，只返回JSON，不要任何多余文字或markdown符号。
今天是 ${today}，内容里的日期如果没写年份，按今天之后最近的那个日期推断。

内容：
${content}

提取字段：
- title: 活动名称
- organizer: 主办方
${orgField}
- date: 活动日期，YYYY-MM-DD
- time: 开始时间，24小时制 HH:MM
- endTime: 结束时间，24小时制 HH:MM
- timezone: 活动时间所用的时区，只能从这些里选一个：${TIMEZONES.join(", ")}。内容写 BST/GMT/UK time 选 Europe/London，CET/CEST 选 Europe/Paris，ET/EST/EDT 选 America/New_York，PT/PST/PDT 选 America/Los_Angeles，北京时间/中国时间/没写时区的中文内容选 Asia/Shanghai
- joinUrl: 参会链接（Zoom/Teams/腾讯会议/直播间等），没有就空
- regUrl: 报名/注册链接，没有就空
- regDeadline: 报名截止日期，YYYY-MM-DD

无法判断的字段返回空字符串。
返回格式：{"title":"...","organizer":"...",${context === "phd" ? `"school":"..."` : `"company":"..."`},"date":"...","time":"...","endTime":"...","timezone":"...","joinUrl":"...","regUrl":"...","regDeadline":"..."}`;

  try {
    const aiRes = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await aiRes.json();
    const result = data.choices?.[0]?.message?.content || "";
    const json = JSON.parse(result.replace(/```json|```/g, "").trim());
    if (!TIMEZONES.includes(json.timezone)) json.timezone = "Asia/Shanghai";
    for (const k of ["date", "regDeadline"]) if (!/^\d{4}-\d{2}-\d{2}$/.test(json[k] || "")) json[k] = "";
    for (const k of ["time", "endTime"]) if (!/^\d{2}:\d{2}$/.test(json[k] || "")) json[k] = "";
    res.status(200).json(json);
  } catch (err) {
    res.status(500).json({ error: "Extraction failed", detail: err.message });
  }
}
