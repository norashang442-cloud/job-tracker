export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "No text provided" });

  try {
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        max_tokens: 400,
        messages: [{
          role: "user",
          content: `从以下职位描述文本中提取信息，只返回JSON，不要任何多余文字或markdown符号。

文本内容：
${text}

提取字段：
- company: 公司/雇主名称
- position: 职位名称
- industry: 公司所属行业，只能是以下之一：汽车/交通、科技/互联网、金融/银行、咨询、能源/环保、制造/工业、医疗/健康、教育、消费/零售、媒体/广告、政府/公共事业、其他
- type: 职位类型，只能是以下之一：全职、实习、应届生项目、科研、兼职、其他（graduate/scheme→应届生项目，intern→实习，research→科研）
- source: 来源平台，只能是以下之一：Boss直聘、猎聘、智联招聘、LinkedIn、Bright Network、Glassdoor、Indeed、拉勾网、前程无忧、牛客网、脉脉、Reed、TotalJobs、Graduateland、内推、官网、其他

无法判断的字段返回空字符串。
返回格式：{"company":"...","position":"...","industry":"...","type":"...","source":"..."}`
        }]
      })
    });
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    const json = JSON.parse(content.replace(/```json|```/g, "").trim());
    res.status(200).json(json);
  } catch (err) {
    res.status(500).json({ error: "Extraction failed", detail: err.message });
  }
}
