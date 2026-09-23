# -*- coding: utf-8 -*-
r"""
从 Python 侧的 stagehand operations 提取提示词与结构清单。

产出 ops_spec.json，供 verify-prompts.mjs 做一致性校验。
scratch 目录被清理后用它重新生成即可。

用法（在项目根目录执行）：
    .\.venv\Scripts\python.exe desktop\scripts\extract-ops-spec.py [输出路径]
"""
import ast
import json
import os
import sys

BASE = os.path.join("core", "stagehand_engine", "operations")
ENGINE_CALLS = {"act", "extract", "observe", "navigate", "wait"}


def joined_text(node):
    """把 f-string 的固定部分拼起来，变量位置标记为 {…}"""
    parts = []
    for v in node.values:
        if isinstance(v, ast.Constant):
            parts.append(str(v.value))
        else:
            parts.append("{…}")
    return "".join(parts)


def scan_file(path):
    src = open(path, encoding="utf-8").read()
    tree = ast.parse(src)
    info = {"methods": [], "prompts": [], "schemas": []}

    for node in ast.walk(tree):
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
            args = [a.arg for a in node.args.args if a.arg != "self"]
            info["methods"].append(
                {"name": node.name, "args": args, "async": isinstance(node, ast.AsyncFunctionDef)}
            )
        if isinstance(node, ast.ClassDef):
            for b in node.bases:
                if getattr(b, "attr", "") == "BaseModel" or getattr(b, "id", "") == "BaseModel":
                    fields = [t.target.id for t in node.body if isinstance(t, ast.AnnAssign)]
                    info["schemas"].append({"name": node.name, "fields": fields})
        if isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Attribute) and f.attr in ENGINE_CALLS:
                for a in list(node.args) + [k.value for k in node.keywords]:
                    if isinstance(a, ast.Constant) and isinstance(a.value, str) and len(a.value) > 3:
                        info["prompts"].append({"call": f.attr, "text": a.value})
                    elif isinstance(a, ast.JoinedStr):
                        info["prompts"].append(
                            {"call": f.attr, "text": joined_text(a), "fstring": True}
                        )
    return info


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.environ.get("PI_SCRATCH_DIR", "."), "ops_spec.json"
    )
    result = {}
    for fn in sorted(os.listdir(BASE)):
        if not fn.endswith(".py") or fn == "__init__.py":
            continue
        result[fn] = scan_file(os.path.join(BASE, fn))

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)

    total = sum(len(v["prompts"]) for v in result.values())
    print(f"已写入 {out_path}")
    print(f"文件 {len(result)} 个，提示词 {total} 条")


if __name__ == "__main__":
    main()