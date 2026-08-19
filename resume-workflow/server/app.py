#!/usr/bin/env python3
"""
Resume Workflow 本地 HTTP 服务 — 给 resume.html 前端提供接口。

用法:
    python server/app.py

仅监听 127.0.0.1:5055（本机可用），配合项目根目录的 start-resume-tool.bat 使用。
"""

import sys
import os
import re
import json
import subprocess
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from local_workflow import (  # noqa: E402
    call_deepseek,
    extract_resume_text,
    extract_json_from_markdown,
    validate_json,
    INPUT_DIR,
    OUTPUT_DIR,
    PROMPTS_DIR,
    SCRIPTS_DIR,
)

from flask import Flask, request, jsonify, send_file

app = Flask(__name__)

PORT = 5055
COMPANY_RE = re.compile(r'^[^\\/:*?"<>|]{1,80}$')


def safe_company(company):
    company = (company or "").strip()
    if not company or ".." in company or not COMPANY_RE.match(company):
        raise ValueError('公司名不合法（不能为空，不能包含 / \\ : * ? " < > | 或 ..）')
    return company


def safe_lang(lang):
    if lang not in ("zh", "en"):
        raise ValueError("lang 必须是 zh 或 en")
    return lang


def local_read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def local_write(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def get_api_key() -> str:
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        raise RuntimeError("未配置 DEEPSEEK_API_KEY，请检查 resume-workflow/.env")
    return key


def step_paths(company):
    return {
        "step0": OUTPUT_DIR / f"step0_{company}_jd.txt",
        "step1": OUTPUT_DIR / f"step1_{company}_breakdown.md",
        "step2": OUTPUT_DIR / f"step2_{company}_plan.md",
        "step3": OUTPUT_DIR / f"step3_{company}_instructions.json",
    }


def docx_path(company, lang):
    return OUTPUT_DIR / f"CV_{company}_{lang}_custom.docx"


@app.after_request
def add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


def error_response(exc, status=500):
    return jsonify({"error": str(exc)}), status


# ---------- 简历库 ----------

@app.route("/api/resumes", methods=["GET"])
def list_resumes():
    result = {}
    for lang in ("zh", "en"):
        p = INPUT_DIR / f"cv_{lang}.docx"
        result[lang] = {"exists": p.exists(), "mtime": p.stat().st_mtime if p.exists() else None}
    return jsonify(result)


@app.route("/api/resumes/<lang>", methods=["POST"])
def upload_resume(lang):
    try:
        lang = safe_lang(lang)
        f = request.files.get("file")
        if not f:
            raise ValueError("未提供文件")
        INPUT_DIR.mkdir(parents=True, exist_ok=True)
        f.save(INPUT_DIR / f"cv_{lang}.docx")
        return jsonify({"ok": True})
    except ValueError as e:
        return error_response(e, 400)
    except Exception as e:
        return error_response(e)


# ---------- 公司列表 / 状态 ----------

@app.route("/api/companies", methods=["GET"])
def list_companies():
    items = []
    if OUTPUT_DIR.exists():
        for p in OUTPUT_DIR.glob("step1_*_breakdown.md"):
            name = p.name[len("step1_"):-len("_breakdown.md")]
            paths = step_paths(name)
            items.append({
                "company": name,
                "mtime": p.stat().st_mtime,
                "steps": {k: v.exists() for k, v in paths.items()},
            })
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return jsonify(items)


@app.route("/api/state/<company>", methods=["GET"])
def get_state(company):
    try:
        company = safe_company(company)
    except ValueError as e:
        return error_response(e, 400)
    paths = step_paths(company)
    state = {key: (local_read(p) if p.exists() else None) for key, p in paths.items()}
    state["docx"] = {lang: docx_path(company, lang).exists() for lang in ("zh", "en")}
    return jsonify(state)


# ---------- 生成步骤 ----------

@app.route("/api/generate/breakdown", methods=["POST"])
def generate_breakdown():
    data = request.get_json(force=True) or {}
    try:
        company = safe_company(data.get("company"))
        jd_text = (data.get("jd_text") or "").strip()
        if not jd_text:
            raise ValueError("jd_text 不能为空")
        api_key = get_api_key()
        local_write(OUTPUT_DIR / f"step0_{company}_jd.txt", jd_text)
        system = local_read(PROMPTS_DIR / "jd_breakdown_system.md")
        user = f"目标公司：{company}\n\nJD原文：\n{jd_text}"
        result = call_deepseek(system, user, api_key)
        local_write(OUTPUT_DIR / f"step1_{company}_breakdown.md", result)
        return jsonify({"content": result})
    except ValueError as e:
        return error_response(e, 400)
    except Exception as e:
        return error_response(e)


@app.route("/api/content/step1/<company>", methods=["PUT"])
def save_step1(company):
    try:
        company = safe_company(company)
        content = (request.get_json(force=True) or {}).get("content", "")
        local_write(OUTPUT_DIR / f"step1_{company}_breakdown.md", content)
        return jsonify({"ok": True})
    except ValueError as e:
        return error_response(e, 400)
    except Exception as e:
        return error_response(e)


@app.route("/api/generate/plan", methods=["POST"])
def generate_plan():
    data = request.get_json(force=True) or {}
    try:
        company = safe_company(data.get("company"))
        lang = safe_lang(data.get("lang", "zh"))
        breakdown_path = OUTPUT_DIR / f"step1_{company}_breakdown.md"
        cv_path = INPUT_DIR / f"cv_{lang}.docx"
        if not breakdown_path.exists():
            raise ValueError("请先完成 Step 1（JD 拆解）")
        if not cv_path.exists():
            raise ValueError(f"未找到简历文件 input/cv_{lang}.docx，请先在简历库上传")
        api_key = get_api_key()
        breakdown = local_read(breakdown_path)
        system = local_read(PROMPTS_DIR / "tailor_plan_system.md")
        resume_text = extract_resume_text(cv_path)
        user = f"目标公司：{company}\n\nJD拆解结果：\n{breakdown}\n\n简历全文：\n{resume_text}"
        result = call_deepseek(system, user, api_key)
        local_write(OUTPUT_DIR / f"step2_{company}_plan.md", result)
        return jsonify({"content": result})
    except ValueError as e:
        return error_response(e, 400)
    except Exception as e:
        return error_response(e)


@app.route("/api/content/step2/<company>", methods=["PUT"])
def save_step2(company):
    try:
        company = safe_company(company)
        content = (request.get_json(force=True) or {}).get("content", "")
        local_write(OUTPUT_DIR / f"step2_{company}_plan.md", content)
        return jsonify({"ok": True})
    except ValueError as e:
        return error_response(e, 400)
    except Exception as e:
        return error_response(e)


@app.route("/api/generate/json", methods=["POST"])
def generate_json_step():
    data = request.get_json(force=True) or {}
    try:
        company = safe_company(data.get("company"))
        plan_path = OUTPUT_DIR / f"step2_{company}_plan.md"
        if not plan_path.exists():
            raise ValueError("请先完成 Step 2（定制方案）")
        api_key = get_api_key()
        plan = local_read(plan_path)
        spec = local_read(PROMPTS_DIR / "json_spec.md")
        system = local_read(PROMPTS_DIR / "json_generate_system.md")
        user = f"已批准的定制方案：\n{plan}\n\nJSON指令规范：\n{spec}"
        result = call_deepseek(system, user, api_key)
        result = extract_json_from_markdown(result)
        try:
            validate_json(result)
        except json.JSONDecodeError as e:
            raise ValueError(f"模型返回的 JSON 不合法：{e}")
        local_write(OUTPUT_DIR / f"step3_{company}_instructions.json", result)
        return jsonify({"content": result})
    except ValueError as e:
        return error_response(e, 400)
    except Exception as e:
        return error_response(e)


@app.route("/api/content/step3/<company>", methods=["PUT"])
def save_step3(company):
    try:
        company = safe_company(company)
        content = (request.get_json(force=True) or {}).get("content", "")
        try:
            validate_json(content)
        except json.JSONDecodeError as e:
            raise ValueError(f"JSON 不合法：{e}")
        local_write(OUTPUT_DIR / f"step3_{company}_instructions.json", content)
        return jsonify({"ok": True})
    except ValueError as e:
        return error_response(e, 400)
    except Exception as e:
        return error_response(e)


@app.route("/api/generate/patch", methods=["POST"])
def generate_patch():
    data = request.get_json(force=True) or {}
    try:
        company = safe_company(data.get("company"))
        lang = safe_lang(data.get("lang", "zh"))
        instructions = OUTPUT_DIR / f"step3_{company}_instructions.json"
        input_cv = INPUT_DIR / f"cv_{lang}.docx"
        output_cv = docx_path(company, lang)
        patch_script = SCRIPTS_DIR / "resume_patcher.py"

        if not instructions.exists():
            raise ValueError("请先完成 Step 3（JSON 指令）")
        if not input_cv.exists():
            raise ValueError(f"未找到简历文件 input/cv_{lang}.docx")

        cmd = [
            sys.executable, str(patch_script),
            "--input", str(input_cv),
            "--instructions", str(instructions),
            "--output", str(output_cv),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            return error_response(f"生成失败：{result.stderr[-2000:]}", 500)
        return jsonify({"ok": True, "log": result.stdout})
    except ValueError as e:
        return error_response(e, 400)
    except Exception as e:
        return error_response(e)


@app.route("/api/download/<company>/<lang>", methods=["GET"])
def download(company, lang):
    try:
        company = safe_company(company)
        lang = safe_lang(lang)
    except ValueError as e:
        return error_response(e, 400)
    p = docx_path(company, lang)
    if not p.exists():
        return error_response("文件不存在，请先生成", 404)
    return send_file(p, as_attachment=True, download_name=p.name)


if __name__ == "__main__":
    print(f"[简历工作流] 本地服务启动: http://127.0.0.1:{PORT}")
    app.run(host="127.0.0.1", port=PORT, threaded=True, debug=False)
