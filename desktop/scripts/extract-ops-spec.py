# -*- coding: utf-8 -*-
r"""
从 Python 侧提取提示词与结构清单，供 verify-prompts.mjs 做一致性校验。

覆盖两个引擎：
  1. stagehand —— core/stagehand_engine/operations/*.py
  2. browseruse —— core/browseruse_engine/ 下的 operations / tools / agent

产出 ops_spec.json（结构见下），scratch 目录被清理后用它重新生成即可。

    {
      "stagehand":  { "<file.py>": {methods, prompts, schemas} },
      "browseruse": { "<rel/path.py>": {methods, prompts, schemas} },
      "browseruse_constants": { "<常量名>": <值> },
      "browseruse_prompt_files": { "<名字.md>": {"sha256":…, "bytes":…} }
    }

用法（在项目根目录执行）：
    .\.venv\Scripts\python.exe desktop\scripts\extract-ops-spec.py [输出路径]
"""
import ast
import hashlib
import json
import os
import sys

BASE = os.path.join("core", "stagehand_engine", "operations")
BU_BASE = os.path.join("core", "browseruse_engine")

# stagehand 侧的引擎调用
ENGINE_CALLS = {"act", "extract", "observe", "navigate", "wait"}
# browseruse 侧：Agent 任务提示词走 engine.run(task=...)
BU_ENGINE_CALLS = {"run", "act", "extract", "observe", "navigate"}

# browseruse 里要扫的文件（相对 BU_BASE）
BU_FILES = [
    os.path.join("operations", "join_family.py"),
    os.path.join("tools", "actions.py"),
    os.path.join("agent", "service.py"),
    os.path.join("agent", "prompts", "__init__.py"),
]

# 需要逐条对齐的常量（join_family.py 里的 URL 与关键词表）
BU_CONST_FILE = os.path.join(BU_BASE, "operations", "join_family.py")
BU_CONST_NAMES = {"FAMILY_INVITE_URL", "FAMILY_DETAILS_URL", "GMAIL_URL"}
# 函数内的局部关键词表：函数名 -> 局部变量名
BU_LOCAL_LISTS = {
    "_check_needs_create_family": "create_keywords",
    "_check_family_full": "full_keywords",
    "_check_invite_sent": "sent_keywords",
    "_verify_join": "success_keywords",
}

PROMPT_DIR = os.path.join(BU_BASE, "agent", "prompts")


def joined_text(node):
    """把 f-string 的固定部分拼起来，变量位置标记为 {…}"""
    parts = []
    for v in node.values:
        if isinstance(v, ast.Constant):
            parts.append(str(v.value))
        else:
            parts.append("{…}")
    return "".join(parts)


def scan_file(path, engine_calls=ENGINE_CALLS):
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
            if isinstance(f, ast.Attribute) and f.attr in engine_calls:
                for a in list(node.args) + [k.value for k in node.keywords]:
                    if isinstance(a, ast.Constant) and isinstance(a.value, str) and len(a.value) > 3:
                        info["prompts"].append({"call": f.attr, "text": a.value})
                    elif isinstance(a, ast.JoinedStr):
                        info["prompts"].append(
                            {"call": f.attr, "text": joined_text(a), "fstring": True}
                        )
    return info


def scan_decorator_texts(path):
    """
    tools/actions.py：动作的 name / description / parameters 描述文本。

    这些文本会随动作清单进提示词，必须与 TS 侧逐字一致，
    因此也当成 prompts 处理（call 标成 action）。
    """
    src = open(path, encoding="utf-8").read()
    tree = ast.parse(src)
    texts = []

    def walk_const(node):
        """收集装饰器参数里的所有字符串常量"""
        for sub in ast.walk(node):
            if isinstance(sub, ast.Constant) and isinstance(sub.value, str):
                if len(sub.value) > 3:
                    texts.append(sub.value)

    for node in ast.walk(tree):
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
            for dec in node.decorator_list:
                walk_const(dec)

    return [{"call": "action", "text": t} for t in texts]


def const_value(node):
    """把简单字面量（str / list[str]）转成 Python 值，其它返回 None"""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.List):
        vals = []
        for e in node.elts:
            if isinstance(e, ast.Constant) and isinstance(e.value, str):
                vals.append(e.value)
            else:
                return None
        return vals
    return None


def scan_constants(path):
    """抽 join_family.py 的模块级 URL 常量与 4 张函数内关键词表"""
    src = open(path, encoding="utf-8").read()
    tree = ast.parse(src)
    out = {}

    # 模块级常量
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id in BU_CONST_NAMES:
                    v = const_value(node.value)
                    if v is not None:
                        out[t.id] = v

    # 函数内的局部关键词表
    for node in ast.walk(tree):
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)):
            want = BU_LOCAL_LISTS.get(node.name)
            if not want:
                continue
            for sub in ast.walk(node):
                if isinstance(sub, ast.Assign):
                    for t in sub.targets:
                        if isinstance(t, ast.Name) and t.id == want:
                            v = const_value(sub.value)
                            if v is not None:
                                out[f"{node.name}:{want}"] = v
    return out


def scan_prompt_files():
    """两个系统提示词 md 的字节指纹"""
    out = {}
    if not os.path.isdir(PROMPT_DIR):
        return out
    for fn in sorted(os.listdir(PROMPT_DIR)):
        if not fn.endswith(".md"):
            continue
        p = os.path.join(PROMPT_DIR, fn)
        data = open(p, "rb").read()
        out[fn] = {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    return out


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.environ.get("PI_SCRATCH_DIR", "."), "ops_spec.json"
    )

    # 1. stagehand
    stagehand = {}
    for fn in sorted(os.listdir(BASE)):
        if not fn.endswith(".py") or fn == "__init__.py":
            continue
        stagehand[fn] = scan_file(os.path.join(BASE, fn))

    # 2. browseruse
    browseruse = {}
    for rel in BU_FILES:
        p = os.path.join(BU_BASE, rel)
        if not os.path.exists(p):
            continue
        key = rel.replace("\\", "/")
        info = scan_file(p, BU_ENGINE_CALLS)
        if rel.endswith(os.path.join("tools", "actions.py")):
            info["prompts"].extend(scan_decorator_texts(p))
        browseruse[key] = info

    result = {
        "stagehand": stagehand,
        "browseruse": browseruse,
        "browseruse_constants": scan_constants(BU_CONST_FILE),
        "browseruse_prompt_files": scan_prompt_files(),
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)

    sh_total = sum(len(v["prompts"]) for v in stagehand.values())
    bu_total = sum(len(v["prompts"]) for v in browseruse.values())
    print(f"已写入 {out_path}")
    print(f"stagehand : 文件 {len(stagehand)} 个，提示词 {sh_total} 条")
    print(f"browseruse: 文件 {len(browseruse)} 个，提示词 {bu_total} 条")
    print(f"常量 {len(result['browseruse_constants'])} 组，提示词文件 {len(result['browseruse_prompt_files'])} 个")


if __name__ == "__main__":
    main()
