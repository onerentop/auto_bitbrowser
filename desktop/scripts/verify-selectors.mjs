/**
 * 选择器一致性校验
 *
 * auto_replace_email / auto_replace_phone 是确定性选择器脚本——
 * 选择器就是它们的全部资产，漏掉一个（比如「跳过引导弹窗」）
 * 就会在真实页面卡住。这里把 Python 源里的选择器全提取出来，
 * 逐个检查 TS 移植版里是否存在。
 *
 * 用法：node scripts/verify-selectors.mjs <python项目根目录>
 */
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.argv[2] ?? path.resolve(import.meta.dirname, "..", "..");

/** 被测的 Python 文件 → 需要在其中找到选择器的 TS 文件（可多个） */
const PAIRS = [
  {
    py: "automation/auto_replace_email.py",
    ts: [
      "desktop/src/automation/auto-replace-email.ts",
      "desktop/src/automation/selector-helpers.ts",
    ],
  },
  {
    py: "automation/auto_replace_phone.py",
    ts: [
      "desktop/src/automation/auto-replace-phone.ts",
      "desktop/src/automation/selector-helpers.ts",
    ],
  },
];

/** 选择器特征：命中任一 CSS/Playwright 语法关键词即视为选择器 */
const SELECTOR_HINT =
  /(button|input|a:text|span:text|div|text=|\[|:visible|:not\(|has-text|text-is|>>|#|\.[a-z-]+\[)/i;

/**
 * 从 Python 源码里抠出所有像是选择器的字符串字面量。
 * 只做文本层面的提取（不解析 AST），因为 Python 里它们是普通字符串。
 */
function extractSelectors(source) {
  const out = new Set();
  // 单引号与双引号两种
  const re = /(['"])((?:\\.|(?!\1).)*)\1/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const v = m[2].replace(/\\"/g, '"').replace(/\\'/g, "'").trim();
    if (v && v.length < 200 && SELECTOR_HINT.test(v)) out.add(v);
  }
  return out;
}

let totalPy = 0;
let totalMissing = 0;

for (const { py, ts } of PAIRS) {
  const pyPath = path.join(repoRoot, py);
  if (!fs.existsSync(pyPath)) {
    console.log(`跳过（Python 源不存在）: ${py}`);
    continue;
  }

  const selectors = extractSelectors(fs.readFileSync(pyPath, "utf8"));
  const tsSource = ts
    .map((t) => path.join(repoRoot, t))
    .filter((p) => fs.existsSync(p))
    .map((p) => fs.readFileSync(p, "utf8"))
    .join("\n");

  const missing = [...selectors].filter((s) => !tsSource.includes(s));

  totalPy += selectors.size;
  totalMissing += missing.length;

  console.log(`\n${py}`);
  console.log(`  选择器 ${selectors.size} 个，缺失 ${missing.length} 个`);
  for (const s of missing.slice(0, 15)) console.log(`    缺失: ${s}`);
  if (missing.length > 15) console.log(`    ... 还有 ${missing.length - 15} 个`);
}

console.log(`\n${"=".repeat(60)}`);
console.log(`合计: Python 侧 ${totalPy} 个选择器，缺失 ${totalMissing} 个`);
process.exit(totalMissing === 0 ? 0 : 1);