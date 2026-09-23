/**
 * 提示词一致性校验器
 *
 * 把 Python 侧的自然语言提示词与 TypeScript 移植版逐条比对，
 * 防止照搬过程中丢字、改标点、漏指令。覆盖范围：
 *   - stagehand : core/stagehand_engine/operations/*.py → src/engine/operations/*.ts
 *     （已删除功能对应的 operation 见 REMOVED_STAGEHAND_OPS，不参与比对）
 *
 * 用法：node scripts/verify-prompts.mjs <ops_spec.json>
 *   ops_spec.json 由 scripts/extract-ops-spec.py 生成：
 *     .\.venv\Scripts\python.exe desktop\scripts\extract-ops-spec.py <输出路径>
 */
import { execFileSync } from "node:child_process";
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

/** 已随账号管理页功能删除的 operation（Python 侧仍保留，TS 侧不再移植），不参与比对 */
const REMOVED_STAGEHAND_OPS = new Set([
  "enable_sharing.py",
  "family.py",
  "join_family.py",
  "oauth.py",
  "pro_status.py",
  "unlock_403.py",
]);

/**
 * 有意删除的单条提示词（Python 文件名 → 提示词原文），不参与比对，输出里单独列出。
 * - login.py「在密码输入框中输入密码」：指令不含密码，AI 会自行往密码框填内容，
 *   Python 随后又 keyboard.type(password)，导致密码写两次或写错。TS 改为按选择器只写入一次
 *   （见 src/engine/operations/login.ts 头注释第 4 条、PROGRESS.md）。
 */
const REMOVED_PROMPTS = {
  "login.py": ["在密码输入框中输入密码"],
  // 真机（2026-09-24）：2SV 首页**没有**「更改手机号 / Add a phone」按钮，只有一个「电话号码 <号>」条目，
  // 点它才进 /two-step-verification/phone-numbers；且 AI act 在该页会「报成功但页面毫无变化」、
  // 原本「先删旧号」的 observe 流程会把后续步骤全部带偏，结果核对也不能再靠 AI 摘要（实测会假成功）。
  // 因此这几条按真机改写（见 src/engine/operations/modify-2sv.ts 的同名注释），不再与 Python 逐字一致。
  "modify_2sv.py": [
    "点击 'Change phone' 或 '更改手机号' 或 'Edit' 或 '编辑' 按钮",
    "查找页面上的手机号输入框或删除现有手机的选项",
    "点击 'Add a phone' 或 '添加手机号' 按钮",
    // 这条是多行 f-string（extract-ops-spec 把变量位置写成 {…}），必须逐行录入：
    // 比对用的是 normalize(p.text) 后的整串相等，只写首行匹配不上。
    `检查页面是否显示修改成功的标志：
1. 显示新的手机号 {…}
2. "Success" 或 "成功" 提示
3. "Phone added" 或 "已添加手机号"
也检查错误信息：
4. "Invalid number" 或 "无效号码"
5. "Error" 或 "错误"`,
    "点击移除或删除现有手机号的按钮",
    "确认删除",
  ],
};
const removedSkipped = [];

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
      const target = normalize(p.text);
      // 有意删除的提示词单独计数（不能靠 TS 注释里恰好出现原文来「匹配」）
      if ((REMOVED_PROMPTS[pyFile] ?? []).includes(target)) {
        removedSkipped.push(`${pyFile}: ${target}`);
        continue;
      }
      totalPy += 1;
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

// ==================== 提示词比对 ====================

// 兼容旧格式：没有 stagehand 键时，整个对象就是 stagehand 段。
// 已删除功能对应的 operation 在 TS 侧不再存在，从比对范围中剔除（旧 spec 里的 browseruse 段同样忽略）。
const stagehandFiles = Object.fromEntries(
  Object.entries(spec.stagehand ?? spec).filter(([pyFile]) => !REMOVED_STAGEHAND_OPS.has(pyFile)),
);
checkGroup(stagehandFiles, stagehandTsPath, "stagehand");

// ==================== 输出 ====================

console.log("=".repeat(64));
console.log("提示词一致性校验");
console.log("=".repeat(64));
console.log(`Python 侧提示词总数 : ${totalPy}`);
console.log(`TS 侧已匹配        : ${totalFound}`);
console.log(`缺失               : ${totalMissing}`);
console.log(`有意删除（不比对） : ${removedSkipped.length}`);
for (const r of removedSkipped) console.log(`    - ${r}`);
console.log("");

for (const [f, items] of Object.entries(missingByFile)) {
  console.log(`--- ${f} (${items.length} 条缺失)`);
  for (const it of items.slice(0, 6)) console.log(`    ${it}`);
  if (items.length > 6) console.log(`    ... 还有 ${items.length - 6} 条`);
}

const coverage = totalPy === 0 ? 0 : Math.round((totalFound / totalPy) * 1000) / 10;
console.log("");
console.log(`覆盖率: ${coverage}%`);

const failed = totalMissing > 0;
// 仓库根目录仅用于错误信息定位，避免路径歧义
if (failed) console.log(`（比对基准仓库: ${repoRoot}）`);
process.exit(failed ? 1 : 0);
