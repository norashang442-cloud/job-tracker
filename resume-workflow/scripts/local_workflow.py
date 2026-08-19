#!/usr/bin/env python3
"""
Local Resume Workflow — 纯本地 DeepSeek API 简历定制流水线

用法:
    # 设置 API key（推荐写入 .env 或系统环境变量）
    export DEEPSEEK_API_KEY="sk-..."

    # 全自动执行（4步连续）
    python local_workflow.py --company KPMG --lang zh

    # 分步执行（可在中间检查/修改）
    python local_workflow.py --company KPMG --lang zh --step breakdown
    python local_workflow.py --company KPMG --lang zh --step plan
    python local_workflow.py --company KPMG --lang zh --step json
    python local_workflow.py --company KPMG --lang zh --step patch

    # 从某一步继续（假设前面步骤已手动修改）
    python local_workflow.py --company KPMG --lang zh --step json --skip-if-exists

依赖:
    pip install python-docx requests python-dotenv

目录结构:
    resume-workflow/
    ├── input/
    │   ├── jd.txt
    │   └── cv_zh.docx
    ├── prompts/
    │   ├── jd_breakdown_system.md
    │   ├── tailor_plan_system.md
    │   ├── json_generate_system.md
    │   └── json_spec.md
    ├── scripts/
    │   ├── resume_patcher.py
    │   └── local_workflow.py   <- 本文件
    └── output/
        ├── step1_KPMG_breakdown.md
        ├── step2_KPMG_plan.md
        ├── step3_KPMG_instructions.json
        └── CV_KPMG_zh_custom.docx
"""

import os
import sys
import argparse
import json
import time
from pathlib import Path
from docx import Document

try:
    import requests
except ImportError:
    print("[错误] 缺少 requests 库。请运行: pip install requests")
    sys.exit(1)

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ── 配置 ──────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent.parent
INPUT_DIR = BASE_DIR / "input"
OUTPUT_DIR = BASE_DIR / "output"
PROMPTS_DIR = BASE_DIR / "prompts"
SCRIPTS_DIR = BASE_DIR / "scripts"

API_URL = "https://api.deepseek.com/chat/completions"
DEFAULT_MODEL = "deepseek-chat"

# ── 工具函数 ─────────────────────────────────────────────────────

def read_file(path: Path) -> str:
    if not path.exists():
        print(f"[错误] 文件不存在: {path}")
        sys.exit(1)
    return path.read_text(encoding="utf-8")


def write_file(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    print(f"[保存] {path}")


def extract_resume_text(docx_path: Path) -> str:
    doc = Document(docx_path)
    lines = [p.text.strip() for p in doc.paragraphs if p.text.strip()]
    return "\n".join(lines)


def call_deepseek(system_prompt: str, user_prompt: str, api_key: str, model: str = DEFAULT_MODEL) -> str:
    """调用 DeepSeek API，带重试机制"""
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "temperature": 0.2,
        "max_tokens": 8000
    }

    max_retries = 3
    for attempt in range(max_retries):
        try:
            print(f"  [API] 请求中... (attempt {attempt + 1}/{max_retries})")
            resp = requests.post(API_URL, headers=headers, json=payload, timeout=120)
            resp.raise_for_status()
            result = resp.json()["choices"][0]["message"]["content"]
            print(f"  [API] 成功，返回 {len(result)} 字符")
            return result
        except requests.exceptions.Timeout:
            print(f"  [警告] 请求超时，{2 ** attempt}秒后重试...")
            time.sleep(2 ** attempt)
        except requests.exceptions.HTTPError as e:
            print(f"  [错误] HTTP {e.response.status_code}: {e.response.text[:500]}")
            if e.response.status_code == 429:
                print("  [提示] 速率限制，等待 10 秒后重试...")
                time.sleep(10)
            else:
                raise

    raise RuntimeError("API 调用失败，已达最大重试次数")


def extract_json_from_markdown(text: str) -> str:
    """从 markdown 代码块中提取 JSON"""
    text = text.strip()
    if text.startswith("```json"):
        text = text[7:]
    elif text.startswith("```"):
        text = text[3:]
    if text.endswith("```"):
        text = text[:-3]
    return text.strip()


def validate_json(text: str) -> dict:
    """验证 JSON 合法性"""
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        print(f"[错误] JSON 解析失败: {e}")
        print(f"[调试] 前 1000 字符:\n{text[:1000]}")
        raise


def confirm_overwrite(output_path: Path) -> bool:
    """文件已存在时询问是否覆盖，返回 True 表示应重新调用 API 生成"""
    if not output_path.exists():
        return True
    print(f"[提示] {output_path} 已存在，可能包含手动修改。")
    try:
        answer = input("  是否覆盖并重新调用 API 生成？覆盖后手动修改将丢失 [y/N]: ").strip().lower()
    except EOFError:
        answer = ""
    return answer == "y"

# ── 各步骤执行函数 ────────────────────────────────────────────────

def step_breakdown(company: str, lang: str, api_key: str, skip_if_exists: bool):
    output_path = OUTPUT_DIR / f"step1_{company}_breakdown.md"
    if skip_if_exists and output_path.exists():
        print(f"[跳过] 已存在: {output_path}")
        return read_file(output_path)
    if not confirm_overwrite(output_path):
        print(f"[保留] 未覆盖，使用现有文件: {output_path}")
        return read_file(output_path)

    print(f"\n{'='*60}")
    print(f"[Step 1/4] JD 拆解 — {company}")
    print(f"{'='*60}")

    jd = read_file(INPUT_DIR / "jd.txt")
    system = read_file(PROMPTS_DIR / "jd_breakdown_system.md")
    user = f"目标公司：{company}\n\nJD原文：\n{jd}"

    result = call_deepseek(system, user, api_key)
    write_file(output_path, result)
    return result


def step_plan(company: str, lang: str, api_key: str, skip_if_exists: bool):
    output_path = OUTPUT_DIR / f"step2_{company}_plan.md"
    if skip_if_exists and output_path.exists():
        print(f"[跳过] 已存在: {output_path}")
        return read_file(output_path)
    if not confirm_overwrite(output_path):
        print(f"[保留] 未覆盖，使用现有文件: {output_path}")
        return read_file(output_path)

    print(f"\n{'='*60}")
    print(f"[Step 2/4] 定制方案 — {company}")
    print(f"{'='*60}")

    breakdown = read_file(OUTPUT_DIR / f"step1_{company}_breakdown.md")
    system = read_file(PROMPTS_DIR / "tailor_plan_system.md")
    resume_text = extract_resume_text(INPUT_DIR / f"cv_{lang}.docx")
    user = f"目标公司：{company}\n\nJD拆解结果：\n{breakdown}\n\n简历全文：\n{resume_text}"

    result = call_deepseek(system, user, api_key)
    write_file(output_path, result)
    return result


def step_json(company: str, lang: str, api_key: str, skip_if_exists: bool):
    output_path = OUTPUT_DIR / f"step3_{company}_instructions.json"
    if skip_if_exists and output_path.exists():
        print(f"[跳过] 已存在: {output_path}")
        return read_file(output_path)
    if not confirm_overwrite(output_path):
        print(f"[保留] 未覆盖，使用现有文件: {output_path}")
        return read_file(output_path)

    print(f"\n{'='*60}")
    print(f"[Step 3/4] JSON 指令 — {company}")
    print(f"{'='*60}")

    plan = read_file(OUTPUT_DIR / f"step2_{company}_plan.md")
    spec = read_file(PROMPTS_DIR / "json_spec.md")
    system = read_file(PROMPTS_DIR / "json_generate_system.md")
    user = f"已批准的定制方案：\n{plan}\n\nJSON指令规范：\n{spec}"

    result = call_deepseek(system, user, api_key)
    result = extract_json_from_markdown(result)

    # 验证
    validate_json(result)
    write_file(output_path, result)
    return result


def step_patch(company: str, lang: str):
    print(f"\n{'='*60}")
    print(f"[Step 4/4] 执行 Patch — {company}")
    print(f"{'='*60}")

    instructions = OUTPUT_DIR / f"step3_{company}_instructions.json"
    input_cv = INPUT_DIR / f"cv_{lang}.docx"
    output_cv = OUTPUT_DIR / f"CV_{company}_{lang}_custom.docx"
    patch_script = SCRIPTS_DIR / "resume_patcher.py"

    if not instructions.exists():
        print(f"[错误] 找不到指令文件: {instructions}")
        sys.exit(1)
    if not input_cv.exists():
        print(f"[错误] 找不到简历文件: {input_cv}")
        sys.exit(1)
    if not patch_script.exists():
        print(f"[错误] 找不到 patch 脚本: {patch_script}")
        sys.exit(1)

    import subprocess
    cmd = [
        sys.executable,
        str(patch_script),
        "--input", str(input_cv),
        "--instructions", str(instructions),
        "--output", str(output_cv)
    ]

    print(f"  [执行] {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        print(f"[错误] Patch 执行失败:\n{result.stderr}")
        sys.exit(1)

    print(result.stdout)
    print(f"[完成] 定制简历: {output_cv}")

# ── 主函数 ────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="本地 DeepSeek API 简历定制流水线",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 全自动（4步连续执行）
  python local_workflow.py --company KPMG --lang zh

  # 分步执行（可在中间检查/修改）
  python local_workflow.py --company KPMG --step breakdown
  python local_workflow.py --company KPMG --step plan
  python local_workflow.py --company KPMG --step json
  python local_workflow.py --company KPMG --step patch

  # 从某步继续，已存在的文件跳过
  python local_workflow.py --company KPMG --step json --skip-if-exists
        """
    )
    parser.add_argument("--company", required=True, help="目标公司/岗位简称，如 KPMG")
    parser.add_argument("--lang", default="zh", choices=["zh", "en"], help="简历语言")
    parser.add_argument("--step", choices=["breakdown", "plan", "json", "patch", "all"],
                        default="all", help="执行指定步骤，默认 all（全流程）")
    parser.add_argument("--skip-if-exists", action="store_true",
                        help="如果输出文件已存在则跳过（用于从中间步骤继续）")
    parser.add_argument("--api-key", help="DeepSeek API Key（也可通过 DEEPSEEK_API_KEY 环境变量设置）")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"模型名称，默认 {DEFAULT_MODEL}")

    args = parser.parse_args()

    # 获取 API key
    api_key = args.api_key or os.environ.get("DEEPSEEK_API_KEY")
    if not api_key:
        print("[错误] 未提供 DeepSeek API Key。请通过以下方式之一设置：")
        print("  1. 命令行参数: --api-key sk-...")
        print("  2. 环境变量: export DEEPSEEK_API_KEY=sk-...")
        print("  3. .env 文件: DEEPSEEK_API_KEY=sk-...")
        sys.exit(1)

    # 检查必要文件
    if not (INPUT_DIR / "jd.txt").exists():
        print(f"[错误] 找不到 JD 文件: {INPUT_DIR / 'jd.txt'}")
        sys.exit(1)
    if not (INPUT_DIR / f"cv_{args.lang}.docx").exists():
        print(f"[错误] 找不到简历文件: {INPUT_DIR / f'cv_{args.lang}.docx'}")
        sys.exit(1)

    # 执行
    try:
        if args.step == "all":
            step_breakdown(args.company, args.lang, api_key, args.skip_if_exists)
            step_plan(args.company, args.lang, api_key, args.skip_if_exists)
            step_json(args.company, args.lang, api_key, args.skip_if_exists)
            step_patch(args.company, args.lang)
            print(f"\n{'='*60}")
            print("[全部完成] 所有步骤执行完毕")
            print(f"{'='*60}")
            print(f"输出目录: {OUTPUT_DIR}")
            for f in sorted(OUTPUT_DIR.glob(f"*{args.company}*")):
                print(f"  - {f.name}")
        elif args.step == "breakdown":
            step_breakdown(args.company, args.lang, api_key, args.skip_if_exists)
        elif args.step == "plan":
            step_plan(args.company, args.lang, api_key, args.skip_if_exists)
        elif args.step == "json":
            step_json(args.company, args.lang, api_key, args.skip_if_exists)
        elif args.step == "patch":
            step_patch(args.company, args.lang)
    except KeyboardInterrupt:
        print("\n[中断] 用户取消")
        sys.exit(0)
    except Exception as e:
        print(f"\n[错误] {type(e).__name__}: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
