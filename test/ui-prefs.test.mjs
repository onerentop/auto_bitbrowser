/**
 * 界面偏好的解析与分页夹取（app/renderer/src/lib/ui-prefs.ts）
 *
 * localStorage 里的值可能被手改、旧版本写坏或根本没有；读出来的必须是合法值，否则回落默认。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_PAGE_SIZES,
  DEFAULT_ACCOUNT_PAGE_SIZE,
  parsePageSize,
  parseCollapsed,
  clampPage,
} from "../app/renderer/src/lib/ui-prefs.ts";

test("每页条数选项与默认值", () => {
  assert.deepEqual([...ACCOUNT_PAGE_SIZES], [20, 50, 100, 200]);
  assert.equal(DEFAULT_ACCOUNT_PAGE_SIZE, 50);
});

test("parsePageSize：只接受选项里的整数，其余回落 50", () => {
  assert.equal(parsePageSize("20"), 20);
  assert.equal(parsePageSize("100"), 100);
  assert.equal(parsePageSize("200"), 200);
  for (const bad of [null, "", "abc", "30", "0", "-50", "50.5", "1e2", " 100", "NaN", "Infinity"]) {
    assert.equal(parsePageSize(bad), 50, `非法值 ${JSON.stringify(bad)} 应回落 50`);
  }
});

test("parseCollapsed：只有 \"1\" 表示收起", () => {
  assert.equal(parseCollapsed("1"), true);
  for (const v of [null, "", "0", "true", "yes", "2"]) assert.equal(parseCollapsed(v), false, JSON.stringify(v));
});

test("clampPage：夹到 [1, 总页数]，无数据时为 1", () => {
  assert.equal(clampPage(1, 0, 50), 1);
  assert.equal(clampPage(3, 0, 50), 1);
  assert.equal(clampPage(3, 120, 50), 3); // 3 页
  assert.equal(clampPage(4, 120, 50), 3);
  assert.equal(clampPage(6, 100, 50), 2); // 刚好整除
  assert.equal(clampPage(2, 101, 50), 2);
  assert.equal(clampPage(0, 100, 50), 1);
  assert.equal(clampPage(-2, 100, 50), 1);
});
