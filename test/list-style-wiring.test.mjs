/**
 * 列表规范接线（.trellis/tasks/09-25-list-display-design/design.md）
 *
 * 页面不能单测，这里按源码钉住：
 *   1. 有状态的列表都画行首状态条（rowClassName 用 railClass）并用 StatusDot 显示状态；
 *   2. 身份列固定在左、操作列固定在右（宽表横向滚动时一直可见）；
 *   3. 状态不再用带底色的 Tag（颜色只在状态条与圆点上）；任务面板结果表不整行上底色。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(`../app/renderer/src/${rel}`, import.meta.url), "utf8");

/** 有状态的列表：文件 → 状态条色调函数 */
const RAIL_LISTS = {
  "pages/AccountsPage.tsx": "accountLoginTone",
  "pages/accounts/TaskPanel.tsx": "aiItemTone",
  "pages/totp/ResultTable.tsx": "totpTone",
  "pages/settings/TaskHistoryTab.tsx": "runOutcomeTone",
  "pages/settings/ProxiesTab.tsx": "proxyCheckTone",
};

for (const [rel, toneFn] of Object.entries(RAIL_LISTS)) {
  test(`${rel}：状态条 + 状态圆点`, () => {
    const src = read(rel);
    assert.match(src, /rowClassName=\{[^}]*railClass\(/, "表格要用 railClass 画行首状态条");
    assert.match(src, new RegExp(`\\b${toneFn}\\(`), `状态色调要用 ${toneFn}`);
    assert.match(src, /<StatusDot\b/, "状态列要用 StatusDot");
  });
}

test("任务历史逐条目表也有状态条（historyItemTone）", () => {
  const src = read("pages/settings/TaskHistoryTab.tsx");
  assert.equal((src.match(/rowClassName=\{[^}]*railClass\(/g) ?? []).length, 2);
  assert.match(src, /historyItemTone\(/);
});

test("批量导入预览：无效行画红色状态条", () => {
  const src = read("components/BatchImportModal.tsx");
  assert.match(src, /rowClassName=\{[^}]*railClass\(/);
});

/** 身份列 / 操作列固定：文件 → 必须 fixed 的列 key */
const FIXED = {
  "pages/AccountsPage.tsx": { left: ["email"], right: ["action"] },
  "pages/accounts/WindowsView.tsx": { left: ["id"], right: [] },
  "pages/accounts/TaskPanel.tsx": { left: ["email"], right: [] },
  "pages/settings/ProxiesTab.tsx": { left: [], right: ["actions"] },
};

/** 取 key 为 k 的列定义所在的那个对象字面量（从 key: "k" 往前找最近的 `{`，往后找到配平的 `}`） */
function columnBlock(src, key) {
  const at = src.search(new RegExp(`key:\\s*"${key}"`));
  assert.ok(at >= 0, `找不到列 ${key}`);
  let start = src.lastIndexOf("{", at);
  // 同一行里 `{ title: ..., key: ...` 的写法：lastIndexOf 已经就是列对象的开头
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`列 ${key} 的对象没有闭合`);
}

for (const [rel, { left, right }] of Object.entries(FIXED)) {
  test(`${rel}：身份列固定在左、操作列固定在右`, () => {
    const src = read(rel);
    for (const k of left) assert.match(columnBlock(src, k), /fixed:\s*"left"/, `列 ${k} 应 fixed: "left"`);
    for (const k of right) assert.match(columnBlock(src, k), /fixed:\s*"right"/, `列 ${k} 应 fixed: "right"`);
    // 左侧固定了数据列时，它前面的勾选列也必须固定：否则横向滚动时勾选列与身份列错位，
    // 行首状态条（画在勾选列上）也会跟着滚出视口
    if (left.length > 0 && /rowSelection=\{\{/.test(src)) {
      const sel = src.slice(src.indexOf("rowSelection={{"), src.indexOf("}}", src.indexOf("rowSelection={{")));
      assert.match(sel, /fixed:\s*"left"/, "rowSelection 应 fixed: \"left\"");
    }
  });
}

test("状态不再用带底色的 Tag；AI 任务列表不再整行上底色", () => {
  assert.doesNotMatch(read("pages/AccountsPage.tsx"), /<Tag[^>]*color=\{v\.color\}/, "账号登录状态不用 Tag");
  assert.doesNotMatch(read("pages/accounts/TaskPanel.tsx"), /color-mix\(/, "任务面板结果表不整行上底色");
  assert.doesNotMatch(read("pages/accounts/TaskPanel.tsx"), /LOGIN_COLOR/, "任务面板状态不用 Tag 色");
  assert.doesNotMatch(read("pages/totp/ResultTable.tsx"), /STATUS_TAG_COLOR/, "TOTP 状态不用 Tag 色");
  assert.doesNotMatch(read("pages/settings/TaskHistoryTab.tsx"), /function (outcomeTag|itemStatusTag)/, "任务历史不用 Tag");
});
