/**
 * 「等后端就绪再自动加载」的接线（app/renderer/src 下所有首屏会自动拉数据的页面）
 *
 * 真机踩过：渲染层窗口可能早于后端（utilityProcess）ready 就打开，此时发起 IPC 会拿到
 * HOST_UNAVAILABLE。页面如果在挂载时无条件拉一次，就会「拉失败 → 列表空白」，用户必须手点
 * 「刷新」才看得到数据（任务历史页与窗口视角都中过这一枪）。
 *
 * 页面不能单测，这里按源码把这条规矩钉住：读 hostReady，并让首次加载落在它的守卫里。
 * 新增这类页面时把它登记到下面这张表。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(`../app/renderer/src/${rel}`, import.meta.url), "utf8");

/** 首屏自动加载的页面 → 「就绪守卫」的写法（各页写法不同，逐个登记，改写法要同步改这里） */
const GATED = {
  "pages/AccountsPage.tsx": /if \(!hostReady \|\| autoLoaded\.current\) return;/,
  "pages/accounts/WindowsView.tsx": /if \(!hostReady \|\| autoLoaded\.current\) return;/,
  "pages/settings/TaskHistoryTab.tsx": /if \(!hostReady\) return;/,
  "pages/settings/ProxiesTab.tsx": /if \(hostReady && !loaded\) void load\(\);/,
  "pages/settings/ConfigTab.tsx": /if \(hostReady && !loaded\) void load\(\);/,
  "pages/settings/CreateParams.tsx": /if \(!hostReady \|\| loaded\.current\) return;/,
};

test("登记表非空（接口改了这里要跟着改）", () => {
  assert.ok(Object.keys(GATED).length >= 6, `只登记了 ${Object.keys(GATED).length} 个页面`);
});

for (const [rel, guard] of Object.entries(GATED)) {
  test(`${rel}：首次自动加载等后端就绪`, () => {
    const src = read(rel);
    assert.match(src, /useHostStatus\(\)\?\.state === "ready"/, "要读后端就绪状态（useHostStatus）");
    const m = src.match(guard);
    assert.ok(m, `首次加载要落在就绪守卫里，当前找不到：${guard}`);
    const after = src.slice(m.index ?? 0, (m.index ?? 0) + 420);
    assert.match(after, /(\bvoid (load|refresh|refreshList|refreshGroups)\(|\binvoke\()/, "守卫里要真的发起加载");
  });
}
