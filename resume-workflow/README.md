# Resume Workflow — 本地 DeepSeek API 简历定制流水线

## Web 前端用法（推荐）

已集成到 job-tracker 的网页前端，四步流程都可以在浏览器里操作，无需记命令行参数。

1. 安装依赖（首次使用，或 `requirements.txt` 更新后）：
   ```bash
   cd resume-workflow
   pip install -r requirements.txt
   ```
2. 双击项目根目录的 `start-resume-tool.bat`：会自动在后台启动本地服务（`http://127.0.0.1:5055`，仅本机可访问）并打开 `resume.html`。如果服务已经在运行，会跳过启动、只打开网页。
3. 在网页里：先在"简历库"上传 `cv_zh.docx` / `cv_en.docx`，再新建任务粘贴 JD，按顺序生成/审阅/编辑四步产物，最后下载定制简历。
4. 不用时可以直接关掉那个最小化的服务窗口。

网页产出的文件与下面的 CLI 用法完全共用同一套 `input/`/`output/` 目录，两种方式可以混用（比如网页生成到一半，也可以切回命令行继续）。

### 从部署在 Vercel 的 job-tracker 网站一键启动本地服务

如果你平时是直接打开 Vercel 上部署的 job-tracker 网站（而不是本地打开 `index.html`），网页本身出于浏览器安全限制不能自动帮你双击 `start-resume-tool.bat`。可以注册一个自定义协议（`resumeworkflow://`）来解决：

1. 运行一次（仅需一次，除非重装系统/换电脑）：
   ```powershell
   cd resume-workflow
   .\register-protocol.ps1
   ```
   这只会写入当前 Windows 用户的注册表（`HKEY_CURRENT_USER`），不需要管理员权限，不影响其他用户/程序。
2. 注册后，job-tracker 网站头部的"📝 简历定制"链接、以及 `resume.html` 里"服务未启动"提示条上的"点此启动本地服务"链接，点击后浏览器会弹出一个系统确认框（类似"是否要打开 Resume Workflow？"），确认后即自动启动本地服务并打开 `resume.html`。可以在弹窗里勾选"总是允许"，之后就不会再弹了。
3. 如果想撤销这个协议注册：
   ```powershell
   cd resume-workflow
   .\unregister-protocol.ps1
   ```

## CLI 用法（原始方式）

### 快速开始

### 1. 安装依赖
```bash
pip install python-docx requests python-dotenv
```

### 2. 配置 API Key

方式一（推荐）：创建 `.env` 文件
```
DEEPSEEK_API_KEY=sk-...
```

方式二：环境变量
```bash
export DEEPSEEK_API_KEY="sk-..."
```

方式三：命令行参数
```bash
python scripts/local_workflow.py --company KPMG --api-key sk-...
```

### 3. 准备输入文件

- 把 JD 粘贴到 `input/jd.txt`
- 把中文简历放到 `input/cv_zh.docx`
- 把英文简历放到 `input/cv_en.docx`

### 4. 执行

**全自动（推荐首次使用）**
```bash
python scripts/local_workflow.py --company KPMG --lang zh
```

**分步执行（推荐需要审阅/修改时）**
```bash
# Step 1: JD 拆解
python scripts/local_workflow.py --company KPMG --lang zh --step breakdown

# 检查 output/step1_KPMG_breakdown.md，满意后继续

# Step 2: 定制方案
python scripts/local_workflow.py --company KPMG --lang zh --step plan

# 检查 output/step2_KPMG_plan.md，满意后继续

# Step 3: JSON 指令
python scripts/local_workflow.py --company KPMG --lang zh --step json

# 检查 output/step3_KPMG_instructions.json，满意后继续

# Step 4: 生成 docx
python scripts/local_workflow.py --company KPMG --lang zh --step patch
```

**从中间步骤继续（已手动修改过中间产物）**
```bash
python scripts/local_workflow.py --company KPMG --lang zh --step json --skip-if-exists
python scripts/local_workflow.py --company KPMG --lang zh --step patch
```

## 目录结构

```
resume-workflow/
├── input/
│   ├── jd.txt              # 粘贴目标 JD
│   ├── cv_zh.docx          # 中文简历库
│   └── cv_en.docx          # 英文简历库
├── prompts/
│   ├── jd_breakdown_system.md    # JD 拆解 system prompt
│   ├── tailor_plan_system.md     # 定制方案 system prompt
│   ├── json_generate_system.md   # JSON 生成 system prompt
│   └── json_spec.md              # JSON 指令规范（给模型参考）
├── scripts/
│   ├── local_workflow.py   # 主工作流脚本
│   └── resume_patcher.py   # docx patch 脚本
├── output/                 # 自动生成
│   ├── step1_xxx_breakdown.md
│   ├── step2_xxx_plan.md
│   ├── step3_xxx_instructions.json
│   └── CV_xxx_custom.docx
└── README.md
```

## 成本估算

DeepSeek API (`deepseek-chat`)：
- 单次简历定制约 15K-30K tokens
- 成本约 **0.05-0.15 元**

## 已知限制

1. **格式保真**：`rewrite` 后的 bullet 会统一为单一样式（丢失"部分文本加粗"等复杂格式），建议生成后手动微调
2. **API 稳定性**：DeepSeek API 偶尔有延迟或 429 错误，脚本已内置 3 次重试
3. **模型幻觉**：JSON 生成步骤偶尔会出现格式问题，脚本会自动提取代码块并验证 JSON 合法性

## 故障排查

| 问题 | 解决 |
|------|------|
| `缺少 requests 库` | `pip install requests` |
| `找不到 jd.txt` | 确认文件放在 `input/jd.txt` |
| `API 返回 429` | 等待几秒后重试，或检查 API key 余额 |
| `JSON 解析失败` | 打开 `output/step3_xxx_instructions.json` 手动修复 |
| `Patch 后格式不对` | 这是已知限制，手动在 Word 中微调 |
