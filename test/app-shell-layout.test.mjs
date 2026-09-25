/**
 * 应用外壳布局（app/renderer/src/App.tsx）
 *
 * 侧栏右边的内层 <Layout> 是横向 flex 的子项，默认 min-width:auto，会被宽表格
 * （账号页 scroll.x ≈ 可见列宽之和）撑到比窗口还宽——整个内容区溢出窗口，
 * 右侧的「添加账号」「操作」列看不到，表格自己的横向滚动条也失效（真机踩过）。
 * 必须给它 minWidth: 0，让宽表格在表格内部横向滚动。页面不能单测，这里按源码钉住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../app/renderer/src/App.tsx", import.meta.url), "utf8");

test("侧栏右侧的内层 Layout 带 minWidth: 0（防止宽表格撑破窗口）", () => {
  const siderEnd = src.indexOf("</Sider>");
  assert.ok(siderEnd > 0, "找不到 </Sider>");
  const inner = src.slice(siderEnd).match(/<Layout\b[^>]*>/);
  assert.ok(inner, "</Sider> 之后找不到内层 <Layout>");
  assert.match(inner[0], /minWidth:\s*0\b/);
});
