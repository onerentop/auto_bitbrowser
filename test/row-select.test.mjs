/**
 * 列表点行选中（app/renderer/src/components/row-select.ts）
 *
 * 六张带勾选列 / 单选的表格共用这一份规则；这里用假事件把规则钉住：
 * 点普通单元格 = 切换、点交互元素 = 不切换、禁用行 = 不切换、单选 = 只选不取消。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { NO_SELECT_SELECTOR, rowSelect } from "../app/renderer/src/components/row-select.ts";

/** 假元素：closest 按选择器里的**单个条目**精确命中（模拟按钮 / 输入框 / 勾选框 / 标记过的单元格） */
/** @param {string | null} [hit] */
function el(hit = null) {
  return {
    nodeType: 1,
    closest: (selector) => (hit && selector.split(",").some((part) => part.trim() === hit) ? { hit } : null),
  };
}
/** 假文本节点：点单元格里的文字时，事件的 target 是文本节点 */
function textNode(host) {
  return { nodeType: 3, parentElement: host };
}

function setup(options = {}) {
  const { keys = [], disabled, mode } = options;
  const calls = [];
  const onRow = rowSelect({
    keyOf: (r) => r.id,
    keys,
    onChange: (next) => calls.push(next),
    disabled,
    mode,
  });
  return { calls, onRow, click: (record, target) => onRow(record).onClick({ target }) };
}

test("点普通单元格：选中该行；再点一次取消", () => {
  const add = setup({ keys: [] });
  add.click({ id: "a" }, el());
  assert.deepEqual(add.calls, [["a"]]);

  const remove = setup({ keys: ["a"] });
  remove.click({ id: "a" }, el());
  assert.deepEqual(remove.calls, [[]], "再点一次要取消");
});

test("多选：点新行是追加，不动已有的勾选", () => {
  const s = setup({ keys: ["a", "b"] });
  s.click({ id: "c" }, el());
  assert.deepEqual(s.calls, [["a", "b", "c"]]);
});

test("点单元格里的文字（target 是文本节点）也算点行", () => {
  const s = setup({ keys: [] });
  s.click({ id: "a" }, textNode(el()));
  assert.deepEqual(s.calls, [["a"]]);
});

test("禁用行点了不选中（与复选框 disabled 一致）", () => {
  const s = setup({ keys: [], disabled: (r) => r.id === "b" });
  s.click({ id: "b" }, el());
  assert.deepEqual(s.calls, []);
});

test("点交互元素不切换选中：清单里的每一项都要挡住，清单本身也钉住", () => {
  // 假 closest 是**逐条精确**匹配，所以下面既钉住清单内容（少一项 / 改一项就红），
  // 也钉住每一条真的被挡住——早先用「子串命中」时删掉 "button" 也照样绿（[role='button'] 里有这个子串）
  assert.deepEqual(
    NO_SELECT_SELECTOR.split(",").map((part) => part.trim()),
    ["button", "a", "input", "textarea", "select", "label", "[role='button']", "[contenteditable='true']", "[data-no-row-select]"],
    "互动元素清单变了，这段和 row-select.ts 的注释要一起改",
  );
  for (const hit of NO_SELECT_SELECTOR.split(",").map((part) => part.trim())) {
    const s = setup({ keys: [] });
    s.click({ id: "a" }, el(hit));
    assert.deepEqual(s.calls, [], `点 ${hit} 不该切换选中`);
  }
  const nested = setup({ keys: [] });
  nested.click({ id: "a" }, textNode(el("button")));
  assert.deepEqual(nested.calls, [], "按钮里的文字同样不切换");
});

test("单选模式（任务历史）：已选行再点不会取消", () => {
  const s = setup({ keys: [3], mode: "always" });
  s.click({ id: 3 }, el());
  assert.deepEqual(s.calls, [[3]]);
  s.click({ id: 4 }, el());
  assert.deepEqual(s.calls, [[3], [4]]);
});

test("target 不是元素（null / 非节点）时不切换", () => {
  const s = setup({ keys: [] });
  s.click({ id: "a" }, null);
  s.click({ id: "a" }, {});
  assert.deepEqual(s.calls, []);
});

test("文本节点没有宿主元素时不切换（不知道该按谁判断）", () => {
  const s = setup({ keys: [] });
  s.click({ id: "a" }, { nodeType: 3 });
  s.click({ id: "a" }, { nodeType: 3, parentElement: null });
  assert.deepEqual(s.calls, []);
});

test("行光标：可选行是手型，不可选行不是", () => {
  const on = setup({ keys: [] });
  assert.deepEqual(on.onRow({ id: "a" }).style, { cursor: "pointer" });

  const off = setup({ keys: [], disabled: () => true });
  assert.deepEqual(off.onRow({ id: "a" }).style, { cursor: "default" }, "不可选的行别装成可点");
});
