/**
 * 列表点行选中的接线（app/renderer/src 下所有用 rowSelect 的表）
 *
 * 页面不能单测（没有 DOM），但「表格 rowKey」与「行选中的 keyOf / 勾选判断字段」必须是同一个字段——
 * 这两个值写岔了不会报错，只会表现为「点行没反应、也不变色」（真机踩过一次：
 * AI 任务表 rowKey="key"，keyOf 却取 email）。
 * 这里按源码扫一遍，把这条接线规则钉住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("../app/renderer/src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** 渲染层全部源码文件（相对 app/renderer/src 的正斜杠路径） */
function rendererSources() {
  return readdirSync(ROOT, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
    .map((e) => join(e.parentPath ?? e.path, e.name))
    .map((p) => relative(ROOT, p).split(sep).join("/"))
    .sort();
}

/** 所有调用 rowSelect 的页面 + 其源码（泛型调用是 `rowSelect<...>(`；跳过定义它的模块本身） */
function rowSelectFiles() {
  return rendererSources()
    .filter((rel) => rel !== "components/row-select.ts")
    .map((rel) => ({ rel, src: readFileSync(join(ROOT, rel), "utf8") }))
    .filter((f) => /rowSelect[<(]/.test(f.src));
}

test("用 rowSelect 的每个页面都能被扫到（接口变了这里要跟着改）", () => {
  const files = rowSelectFiles().map((f) => f.rel);
  assert.ok(files.length >= 5, `至少要扫到五张表，实际 ${files.length}：${files.join(", ")}`);
});

/**
 * 一张表的接线：`rowKey="x"` 的 x，与 `keyOf: (r) => r.y` 的 y 必须一致；
 * 勾选集合的判断（`checkedKeys.includes(r.z)` / `checkedSet.has(r.z)`）也必须用同一个字段。
 */
test("表格 rowKey 与行选中 / 勾选判断用的是同一个字段", () => {
  /** @type {string[]} */
  const mismatches = [];
  for (const { rel, src } of rowSelectFiles()) {
    const rowKeys = [...src.matchAll(/rowKey="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(
      rowKeys.length > 0,
      `${rel}：找不到 rowKey="..." 字面量（改成函数式 rowKey 时，请让 rowSelect 的 keyOf 与它同源）`,
    );

    const keyOf = src.match(/keyOf:\s*\((\w+)\)\s*=>\s*\1\.(\w+)/);
    assert.ok(keyOf, `${rel}：keyOf 不是「取一个字段」的写法，扫不到`);

    const field = keyOf[2];
    if (!rowKeys.includes(field)) {
      mismatches.push(`${rel}：rowKey=${JSON.stringify(rowKeys)}，keyOf 取的是 .${field}`);
    }

    // 勾选判断：checked / checkedKeys / checkedSet … .includes|has(行变量.字段)
    const param = keyOf[1];
    for (const m of src.matchAll(/checked\w*\.(?:includes|has)\(\s*(\w+)\.(\w+)\s*\)/g)) {
      const [, variable, used] = m;
      if (variable !== param) continue; // 判断的不是行数据（比如别的集合），跳过
      if (!rowKeys.includes(used)) {
        mismatches.push(`${rel}：rowKey=${JSON.stringify(rowKeys)}，勾选判断用的是 .${used}`);
      }
    }
  }
  assert.deepEqual(mismatches, [], `行键写岔了（点了不会选中）：\n${mismatches.join("\n")}`);
});
