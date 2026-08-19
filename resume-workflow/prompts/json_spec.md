# Resume Patcher JSON 指令规范（v1.0）

> 本规范定义了 `resume_patcher.py` 脚本可识别的 JSON 指令格式。任何模型生成 JSON 指令时，必须严格遵循此规范，否则脚本可能执行失败或产生非预期结果。

---

## 顶层结构

```json
{
  "version": "1.0",
  "target": "原始简历文件名.docx",
  "language": "zh",
  "operations": [
    { ... },
    { ... }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `version` | string | 是 | 固定为 `"1.0"` |
| `target` | string | 是 | 原始简历文件名，仅作记录，脚本不读取此字段 |
| `language` | string | 是 | `"zh"` 或 `"en"`，仅作记录 |
| `operations` | array | 是 | 操作指令列表，按数组顺序依次执行 |

---

## 操作类型

### 1. reorder — 重排章节内的经历块

将指定章节内的经历块按给定顺序重新排列。

```json
{
  "type": "reorder",
  "section": "项目经历",
  "items": [
    {"identifier": "项目A"},
    {"identifier": "项目B"},
    {"identifier": "项目C"}
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `section` | string | 章节标题，必须与 docx 中的章节标题**开头匹配** |
| `items` | array | 每个元素包含 `identifier`，表示期望的顺序 |

**匹配规则**：
- `identifier` 使用**模糊包含匹配**。脚本在指定章节内查找"块标题包含此字符串"的经历块。
- 未在 `items` 中指定的块，**保持原有相对顺序，自动追加到末尾**。
- 如果 `identifier` 匹配不到任何块，脚本输出警告并跳过。

**建议执行顺序**：`reorder` 应在 `delete` 之前执行，确保被删除的块不会干扰排序。

---

### 2. delete — 删除经历块

删除指定章节内（或全文档）匹配的经历块（标题 + 所有 bullet 段落）。

```json
{
  "type": "delete",
  "section": "项目经历",
  "items": [
    {"identifier": "项目D"},
    {"identifier": "项目E"}
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `section` | string \| null | 章节标题（开头匹配）；为 `null` 或省略时，在**全文档**范围内搜索 |
| `items` | array | 每个元素包含 `identifier`，匹配到的整个块将被删除 |

**匹配规则**：同 `reorder`，模糊包含匹配块标题。

---

### 3. rewrite — 重写 bullet 文本

在指定的经历块内，查找并替换 bullet 段落中的文本。

```json
{
  "type": "rewrite",
  "section": "项目经历",
  "identifier": "项目A",
  "changes": [
    {
      "original": "分析某企业的业务背景",
      "replacement": "分析该企业的业务背景与核心痛点"
    },
    {
      "original": "设计分阶段实施策略",
      "replacement": "设计分阶段数字化落地策略"
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `section` | string | 章节标题（开头匹配） |
| `identifier` | string | 经历块标题（模糊包含匹配） |
| `changes` | array | 替换规则列表，按顺序依次执行 |
| `changes[].original` | string | bullet 段落中的**连续子串**，脚本执行 `text.replace(old, new)` |
| `changes[].replacement` | string | 替换后的新文本 |

**关键约束**：
- `original` 必须是 bullet 段落中的**连续子串**。不要写整段原文，只写需要被替换的那句话/短语。
- 如果 `original` 在段落中找不到，该 change 被**跳过**，不报错，继续执行下一个。
- 一个 bullet 段落可能匹配多个 `changes`，按数组顺序依次替换。
- `rewrite` **只修改 bullet 段落**，不修改经历块的标题。

---

### 4. delete_bullet — 删除经历块中多余的 bullet（保留前 N 个）

在指定的经历块内，保留前 N 个 bullet 段落，删除排在它们之后的所有 bullet。用于满足"每项经历不超过 N 条"类要求。

```json
{
  "type": "delete_bullet",
  "section": "项目经历",
  "identifier": "项目B",
  "keep_first": 3
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `section` | string | 章节标题（开头匹配） |
| `identifier` | string | 经历块标题（模糊包含匹配） |
| `keep_first` | integer | 保留前多少个 bullet，未指定时脚本默认取 3 |

**关键约束**：
- 只删除 bullet 段落，**不删除块标题**，也**不修改**保留下来的 bullet 内容
- 若经历块的 bullet 总数不超过 `keep_first`，脚本跳过，不做任何删除
- 若定制方案中列出了多个需要限制的经历块，**必须逐一生成对应的 `delete_bullet` 操作**，不能只生成其中一部分
- 若该经历块整体已出现在某个 `delete` 操作的 `items` 中，不要再为它生成 `delete_bullet`（块都删了，条数限制无意义）

---

## 脚本执行机制（供参考）

### 章节边界检测
- 脚本遍历 docx 的所有段落。
- 通过"段落样式为 Heading 或包含加粗文本"判断是否为标题段落。
- 通过"标题段落文本的开头匹配已知章节关键词"判断章节边界。

### 经历块分组
- 在章节边界内，每个"加粗标题段落"标志一个经历块的开始。
- 块内后续非加粗段落视为该块的 bullet 段落。

### 文本替换
- 使用 python-docx 的 `paragraph.text` 获取全文，执行 `str.replace()`。
- 替换后清除原段落所有 runs，用第一个 run 的格式重建新 run。
- **副作用**：如果原 bullet 中有"部分文本加粗"等复杂格式，替换后会统一为单一样式。

---

## 执行顺序建议

推荐按以下顺序排列 `operations`：

1. `reorder` — 先排好顺序
2. `delete` — 再删除不需要的块
3. `delete_bullet` — 然后精简保留下来的经历块的 bullet 数量
4. `rewrite` — 最后修改文本内容

脚本 `apply_instructions` 会**无视 `operations` 数组的实际书写顺序**，强制按上述顺序执行（同类型内部保持原有相对顺序），因此即使生成顺序有误也不会导致 `rewrite` 作用于已删除的段落；但生成时仍应按此顺序排列，便于人工核查。

---

## 常见错误与避免方法

| 错误 | 原因 | 正确做法 |
|------|------|---------|
| `identifier` 匹配不到 | 字符串与 docx 实际标题差异过大 | 使用标题中的**连续子串**（如项目关键词，而非整句描述） |
| `original` 匹配不到 | 写的不是连续子串，或包含多余空格/标点 | 从 docx 中精确复制需要替换的那句话 |
| `section` 匹配不到 | 章节名与 docx 标题不一致 | 确认 docx 中的章节标题（如 `"项目经历"` 不能写成 `"Projects"`） |
| 替换后格式丢失 | `rewrite` 会重建整个段落的 runs | 接受此限制，或在脚本执行后手动微调格式 |
| 删除后重写报错 | `delete` 和 `rewrite` 操作了同一个块 | 确保被删除的块不在 `rewrite` 的 `identifier` 中 |

---

## 示例：完整 JSON 指令

```json
{
  "version": "1.0",
  "target": "简历_定制.docx",
  "language": "zh",
  "operations": [
    {
      "type": "reorder",
      "section": "项目经历",
      "items": [
        {"identifier": "项目A"},
        {"identifier": "项目B"},
        {"identifier": "项目C"},
        {"identifier": "项目D"}
      ]
    },
    {
      "type": "delete",
      "section": "项目经历",
      "items": [
        {"identifier": "项目E"},
        {"identifier": "项目F"}
      ]
    },
    {
      "type": "delete",
      "section": "工作经历",
      "items": [
        {"identifier": "某公司实习"}
      ]
    },
    {
      "type": "delete",
      "items": [
        {"identifier": "某社团职务"}
      ]
    },
    {
      "type": "rewrite",
      "section": "项目经历",
      "identifier": "项目A",
      "changes": [
        {
          "original": "分析某企业的业务背景，识别其现有系统中的运营痛点",
          "replacement": "分析该企业的核心业务系统，识别关键运营痛点并提出优化路径"
        }
      ]
    }
  ]
}
```
