export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { text, url } = req.body;
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
          .slice(0, 3000);
        content = stripped + (text ? "\n\n补充文字：" + text : "");
      } else {
        const slug = decodeURIComponent(url).replace(/https?:\/\/[^/]+/, "").replace(/[?#].*/, "");
        content = "URL路径：" + slug + (text ? "\n\n补充文字：" + text : "");
      }
    } catch {
      const slug = decodeURIComponent(url).replace(/https?:\/\/[^/]+/, "").replace(/[?#].*/, "");
      content = "URL路径：" + slug + (text ? "\n\n补充文字：" + text : "");
    }
  }

  const prompt = `从以下内容中提取博士项目网申信息，只返回JSON，不要任何多余文字或markdown符号。

内容：
${content}

提取字段：
- school: 学校名称
- program: 项目/院系名称（如 Computer Science PhD）
- cycle: 申请批次（如 Fall 2027，从页面中的入学年份/学期推断，找不到就返回空字符串）
- deadline: 申请截止日期，必须转换为 YYYY-MM-DD 格式；页面写的是"rolling basis"/滚动招生/无固定截止日期时返回空字符串；找不到明确日期也返回空字符串

无法判断的字段返回空字符串。
返回格式：{"school":"...","program":"...","cycle":"...","deadline":"..."}`;

  try {
    const aiRes = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await aiRes.json();
    const result = data.choices?.[0]?.message?.content || "";
    const json = JSON.parse(result.replace(/```json|```/g, "").trim());
    res.status(200).json(json);
  } catch (err) {
    res.status(500).json({ error: "Extraction failed", detail: err.message });
  }
}
