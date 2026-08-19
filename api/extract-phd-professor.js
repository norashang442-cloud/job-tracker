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

  const prompt = `从以下内容中提取导师个人主页信息，只返回JSON，不要任何多余文字或markdown符号。

内容：
${content}

提取字段：
- name: 导师姓名（保留 Prof./Dr. 等头衔前缀原样，不要翻译）
- institution: 所在院校/系所（如 "MIT · EECS"，找不到系所就只填学校）
- researchAreas: 研究方向关键词数组，把导师的研究兴趣拆成多个简短的独立关键词/短语（每个2-8个词，如"机器学习"、"强化学习"、"计算机视觉"，不要把整段研究兴趣描述当成一个词），最多提取8个，按页面中出现的顺序排列

无法判断的字段：name/institution 返回空字符串，researchAreas 返回空数组。
返回格式：{"name":"...","institution":"...","researchAreas":["...","..."]}`;

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
