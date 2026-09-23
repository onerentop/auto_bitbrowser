/**
 * 提示词一致性校验器
 *
 * 把 Python 侧的自然语言提示词与 TypeScript 移植版逐条比对，
 * 防止照搬过程中丢字、改标点、漏指令。覆盖两个引擎：
 *   - stagehand  : core/stagehand_engine/operations/*.py   → src/engine/operations/*.ts
 *   - browseruse : core/browseruse_engine/ 的 4 个文件      → src/browseruse/**\/*.ts
 *
 * 额外两项校验（BrowserUse 专属）：
 *   - 常量：join_family.py 的 URL 与 5 组关键词，必须在 src/browseruse/constants.ts 里逐条出现
 *   - 系统提示词 md：两份文件与 Python 侧**字节级**一致（sha256 比对）
 *
 * 用法：node scripts/verify-prompts.mjs <ops_spec.json>
 *   ops_spec.json 由 scripts/extract-ops-spec.py 生成：
 *     .\.venv\Scripts\python.exe desktop\scripts\extract-ops-spec.py <输出路径>
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const repoRoot = path.resolve(import.meta.dirname, "..", "..");

/**
 * 定位 ops_spec.json：
 *   1. 命令行参数
 *   2. 环境变量 OPS_SPEC
 *   3. $PI_SCRATCH_DIR/ops_spec.json（本机约定）
 *   4. 系统临时目录（无 scratch 时的落点）
 * 找不到就调 Python 提取脚本现场生成一份，这样 `pnpm verify:prompts` 不带参数也能跑。
 */
function resolveSpecPath() {
  const explicit = process.argv[2] ?? process.env["OPS_SPEC"];
  if (explicit) return explicit;
  const scratch = process.env["PI_SCRATCH_DIR"];
  if (scratch && fs.existsSync(path.join(scratch, "ops_spec.json"))) {
    return path.join(scratch, "ops_spec.json");
  }
  return path.join(scratch || os.tmpdir(), "ops_spec.json");
}

function ensureSpec(specPath) {
  if (fs.existsSync(specPath)) return specPath;

  // 现场重建：优先用仓库自带的 .venv，其次 PATH 上的 python
  const script = path.join(repoRoot, "desktop", "scripts", "extract-ops-spec.py");
  const candidates = [
    path.join(repoRoot, ".venv", "Scripts", "python.exe"),
    path.join(repoRoot, ".venv", "bin", "python"),
    "python",
  ];
  for (const py of candidates) {
    try {
      execFileSync(py, [script, specPath], { cwd: repoRoot, stdio: "ignore" });
      if (fs.existsSync(specPath)) {
        console.log(`（ops_spec.json 缺失，已用 ${py} 重新生成）`);
        return specPath;
      }
    } catch {
      /* 换下一个候选解释器 */
    }
  }

  console.error(`找不到也无法生成 ops_spec.json（尝试路径: ${specPath}）`);
  console.error("请手动执行：");
  console.error(`  .\\.venv\\Scripts\\python.exe desktop\\scripts\\extract-ops-spec.py "${specPath}"`);
  process.exit(1);
}

const specPath = ensureSpec(resolveSpecPath());
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

/** stagehand：Python 文件名 → TS 文件路径 */
function stagehandTsPath(pyFile) {
  const name = pyFile.replace(/\.py$/, "").replace(/_/g, "-") + ".ts";
  return path.join(srcDir, "engine", "operations", name);
}

/** browseruse：Python 相对路径 → TS 文件路径 */
const BROWSERUSE_MAP = {
  "operations/join_family.py": ["browseruse", "operations", "join-family.ts"],
  "tools/actions.py": ["browseruse", "tools", "actions.ts"],
  "agent/service.py": ["browseruse", "agent", "service.ts"],
  "agent/prompts/__init__.py": ["browseruse", "agent", "prompts.ts"],
};
function browseruseTsPath(pyFile) {
  const parts = BROWSERUSE_MAP[pyFile];
  return parts ? path.join(srcDir, ...parts) : null;
}

/** 归一化：去掉首尾空白、统一换行、压缩内部连续空白行 */
function normalize(s) {
  return s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

/**
 * 把源码里的字符串字面量抽出来按顺序拼成一条文本流。
 * 用于处理 TS 用 "a" + "b" 拼接长提示词的写法——
 * 这种情况在原始源码里搜不到连续文本，但拼接后与 Python 侧一致。
 */
function literalStream(src) {
  const lits = [];
  // 三种字符串字面量都要提取：提示词可能写成 "..."、'...' 或 `...`
  const patterns = [
    /"((?:[^"\\\n]|\\.)*)"/g,   // 双引号
    / '((?:[^'\\\n]|\\.)*)'/g,  // 单引号（前导空格避免匹配到缩写撇号）
    /`((?:[^`\\]|\\.)*)`/g,     // 模板字符串
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(src)) !== null) lits.push(m[1]);
  }
  return lits
    .join(" ")
    .replace(/\\(['"`])/g, "$1") // 还原转义的引号，使 \' 与 Python 的 ' 等价
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 把多行文本压成单空格分隔，用于跨行比对 */
function flatten(s) {
  return s.replace(/\s+/g, " ").trim();
}

let totalPy = 0;
let totalFound = 0;
let totalMissing = 0;
const missingByFile = {};

/** 比对一组文件的提示词 */
function checkGroup(files, resolveTs, label) {
  for (const [pyFile, info] of Object.entries(files)) {
    const tsPath = resolveTs(pyFile);
    const key = `${label}:${pyFile}`;
    if (!tsPath || !fs.existsSync(tsPath)) {
      missingByFile[key] = [`(整个文件缺失: ${tsPath ?? "未映射"})`];
      totalPy += info.prompts.length;
      totalMissing += info.prompts.length;
      continue;
    }

    const tsSrc = fs.readFileSync(tsPath, "utf8");
    const normTs = normalize(tsSrc);
    const flatTs = flatten(normTs);
    const litTs = literalStream(tsSrc);
    const missing = [];

    for (const p of info.prompts) {
      totalPy += 1;
      const target = normalize(p.text);
      if (!target) continue;

      // 含 f-string 变量的提示词，按前半段固定文本匹配
      const probe = p.fstring ? target.split("\n")[0].replace(/\{…\}.*$/, "").trim() : target;

      const flatProbe = flatten(probe);
      const matched =
        (probe && normTs.includes(probe)) ||
        (flatProbe && flatTs.includes(flatProbe)) ||
        (flatProbe && litTs.includes(flatProbe));
      if (matched) {
        totalFound += 1;
      } else {
        totalMissing += 1;
        missing.push(`[${p.call}] ${flatProbe.slice(0, 90)}`);
      }
    }

    if (missing.length > 0) missingByFile[key] = missing;
  }
}

// ==================== 1. 提示词比对 ====================

// 兼容旧格式：没有 stagehand 键时，整个对象就是 stagehand 段
const stagehandFiles = spec.stagehand ?? spec;
checkGroup(stagehandFiles, stagehandTsPath, "stagehand");
if (spec.browseruse) {
  checkGroup(spec.browseruse, browseruseTsPath, "browseruse");
}

// ==================== 2. BrowserUse 常量比对 ====================

let constTotal = 0;
let constMissing = 0;
const constProblems = [];

if (spec.browseruse_constants) {
  const constPath = path.join(srcDir, "browseruse", "constants.ts");
  const constSrc = fs.existsSync(constPath) ? fs.readFileSync(constPath, "utf8") : "";
  for (const [name, value] of Object.entries(spec.browseruse_constants)) {
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      constTotal += 1;
      // 关键词/URL 必须以字符串字面量的形式出现在 constants.ts
      if (!constSrc.includes(JSON.stringify(v)) && !constSrc.includes(`"${v}"`)) {
        constMissing += 1;
        constProblems.push(`${name}: ${v}`);
      }
    }
  }
}

// ==================== 3. 系统提示词 md 字节比对 ====================

let mdTotal = 0;
let mdMissing = 0;
const mdProblems = [];

if (spec.browseruse_prompt_files) {
  for (const [name, meta] of Object.entries(spec.browseruse_prompt_files)) {
    mdTotal += 1;
    const tsMd = path.join(srcDir, "browseruse", "agent", "prompts", name);
    if (!fs.existsSync(tsMd)) {
      mdMissing += 1;
      mdProblems.push(`${name}: TS 侧缺失`);
      continue;
    }
    const buf = fs.readFileSync(tsMd);
    const sha = crypto.createHash("sha256").update(buf).digest("hex");
    if (sha !== meta.sha256 || buf.length !== meta.bytes) {
      mdMissing += 1;
      mdProblems.push(
        `${name}: sha256 ${sha.slice(0, 12)}… vs Python ${String(meta.sha256).slice(0, 12)}…，` +
          `字节 ${buf.length} vs ${meta.bytes}`,
      );
    }
  }
}

// ==================== 输出 ====================

console.log("=".repeat(64));
console.log("提示词一致性校验");
console.log("=".repeat(64));
console.log(`Python 侧提示词总数 : ${totalPy}`);
console.log(`TS 侧已匹配        : ${totalFound}`);
console.log(`缺失               : ${totalMissing}`);
console.log("");

for (const [f, items] of Object.entries(missingByFile)) {
  console.log(`--- ${f} (${items.length} 条缺失)`);
  for (const it of items.slice(0, 6)) console.log(`    ${it}`);
  if (items.length > 6) console.log(`    ... 还有 ${items.length - 6} 条`);
}

if (spec.browseruse_constants) {
  console.log(`BrowserUse 常量     : ${constTotal - constMissing}/${constTotal} 命中`);
  for (const p of constProblems.slice(0, 10)) console.log(`    缺失常量: ${p}`);
}
if (spec.browseruse_prompt_files) {
  console.log(`系统提示词 md 字节  : ${mdTotal - mdMissing}/${mdTotal} 一致`);
  for (const p of mdProblems) console.log(`    ${p}`);
}

const coverage = totalPy === 0 ? 0 : Math.round((totalFound / totalPy) * 1000) / 10;
console.log("");
console.log(`覆盖率: ${coverage}%`);

const failed = totalMissing > 0 || constMissing > 0 || mdMissing > 0;
// 仓库根目录仅用于错误信息定位，避免路径歧义
if (failed) console.log(`（比对基准仓库: ${repoRoot}）`);
process.exit(failed ? 1 : 0);
