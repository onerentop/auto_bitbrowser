/**
 * 界面偏好的解析与分页夹取（app/renderer/src/lib/ui-prefs.ts）
 *
 * localStorage 里的值可能被手改、旧版本写坏或根本没有；读出来的必须是合法值，否则回落默认。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_VIEW_KEY,
  PAGE_SIZES,
  DEFAULT_PAGE_SIZE,
  pageSizeKey,
  parseAccountView,
  parsePageSize,
  parseCollapsed,
  clampPage,
  parseNotifyEnabled,
  NOTIFY_FINISH_KEY,
} from "../app/renderer/src/lib/ui-prefs.ts";

test("每页条数选项与默认值", () => {
  assert.deepEqual([...PAGE_SIZES], [20, 50, 100, 200]);
  assert.equal(DEFAULT_PAGE_SIZE, 50);
});

test("pageSizeKey：按列表分别记，账号表沿用旧键", () => {
  assert.equal(pageSizeKey("accounts"), "abb/accounts/pageSize");
  assert.equal(pageSizeKey("home"), "abb/home/pageSize");
  assert.equal(pageSizeKey("taskHistoryItems"), "abb/taskHistoryItems/pageSize");
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

test("账号页视角：只认 \"windows\"，其余回落账号视角", () => {
  assert.equal(ACCOUNT_VIEW_KEY, "abb/accounts/view");
  assert.equal(parseAccountView("windows"), "windows");
  assert.equal(parseAccountView("accounts"), "accounts");
  for (const bad of [null, "", "Windows", "window", "1", "{}"]) {
    assert.equal(parseAccountView(bad), "accounts", `非法值 ${JSON.stringify(bad)} 应回落账号视角`);
  }
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

test("任务结束通知开关：只有写过 \"0\" 才算关闭，没写过按开", () => {
  assert.equal(NOTIFY_FINISH_KEY, "abb/notify/finish");
  assert.equal(parseNotifyEnabled(null), true, "没写过 = 默认开");
  assert.equal(parseNotifyEnabled("1"), true);
  assert.equal(parseNotifyEnabled("0"), false, "只有 \"0\" 关闭");
  for (const bad of ["", "false", "off", "no", "2", " 0"]) {
    assert.equal(parseNotifyEnabled(bad), true, `非法值 ${JSON.stringify(bad)} 按默认（开）`);
  }
});
