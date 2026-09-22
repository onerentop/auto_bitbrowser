/**
 * 提示词一致性校验器
 *
 * 把 Python operation 里的自然语言提示词与 TypeScript 移植版逐条比对，
 * 防止照搬过程中丢字、改标点、漏指令。
 *
 * 用法：node scripts/verify-prompts.mjs <ops_spec.json>
 *   ops_spec.json 由 scratch/extract_ops.py 生成
 */
import fs from "node:fs";
import path from "node:path";

const specPath = process.argv[2];
if (!specPath) {
  console.error("用法: verify-prompts.mjs <ops_spec.json>");
  process.exit(1);
}

const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const tsDir = path.resolve(import.meta.dirname, "..", "src", "engine", "operations");

/** 文件名映射：Python 名 -> TS 名 */
function tsName(pyFile) {
  return pyFile.replace(/\.py$/, "").replace(/_/g, "-") + ".ts";
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

for (const [pyFile, info] of Object.entries(spec)) {
  const tsFile = tsName(pyFile);
  const tsPath = path.join(tsDir, tsFile);
  if (!fs.existsSync(tsPath)) {
    missingByFile[pyFile] = [`(整个文件缺失: ${tsFile})`];
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
      missing.push(`[${p.call}] ${flatProbe.slice(0, 90)}`);
    }
  }

  if (missing.length > 0) missingByFile[pyFile] = missing;
}

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

const coverage = totalPy === 0 ? 0 : Math.round((totalFound / totalPy) * 1000) / 10;
console.log("");
console.log(`覆盖率: ${coverage}%`);
process.exit(totalMissing === 0 ? 0 : 1);