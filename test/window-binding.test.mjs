/**
 * 账号 ↔ 窗口自动绑定（src/application/window-binding.ts）
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BUSY_SKIP_MESSAGE,
  autoBindAccounts,
  planAutoBind,
  rankBindCandidates,
  sameNameWindowCounts,
  windowNameKey,
} from "../src/application/window-binding.ts";

const W = (id, name) => ({ profile_id: id, name });

test("windowNameKey：去空白、不区分大小写；非字符串为空", () => {
  assert.equal(windowNameKey("  A@X.com "), "a@x.com");
  assert.equal(windowNameKey(null), "");
  assert.equal(windowNameKey(12), "");
});

test("planAutoBind：唯一同名绑定；多个同名不猜；没找到列出；已绑定不动；被占用窗口不用；同批不重复占用", () => {
  const accounts = [
    { email: "a@x.com", browser_profile_id: null },
    { email: "b@x.com", browser_profile_id: "" },
    { email: "c@x.com", browser_profile_id: null },
    { email: "d@x.com", browser_profile_id: "9" },
    { email: "e@x.com", browser_profile_id: null },
    { email: "other@x.com", browser_profile_id: "5" },
    { email: "F@x.com", browser_profile_id: null },
    { email: "f@X.com", browser_profile_id: null },
  ];
  const windows = [
    W(1, " A@X.COM "),
    W(2, "b@x.com"),
    W(3, "b@x.com"),
    W(9, "d@x.com"),
    W(10, "d@x.com"),
    W(5, "e@x.com"), // 已被 other@x.com 占用
    W(6, "e@x.com"), // 唯一可用
    W(7, "f@x.com"),
  ];
  const r = planAutoBind(accounts, ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "F@x.com", "f@X.com", "a@x.com", "ghost@x.com"], windows);
  assert.deepEqual(r.toBind, [
    ["a@x.com", "1"],
    ["e@x.com", "6"],
    ["F@x.com", "7"],
  ]);
  assert.deepEqual(r.ambiguous, [{ email: "b@x.com", windowIds: ["2", "3"] }]);
  assert.deepEqual(r.notFound, ["c@x.com", "f@X.com"], "7 号已被本批前一个账号占用");
  assert.equal(r.alreadyBound, 1, "d@x.com 已绑定，不动（即使有同名窗口）");
});

test("autoBindAccounts：写库；写库失败列入 failed；取窗口失败不抛错，只记 error", async () => {
  /** @type {Record<string, string>} */
  const bindings = {};
  const repo = {
    getAllAccounts: () => [
      { email: "a@x.com", browser_profile_id: null },
      { email: "b@x.com", browser_profile_id: null },
    ],
    bindAccountToBrowser: (email, id) => {
      if (email === "b@x.com") return false;
      bindings[email] = id;
      return true;
    },
  };
  const r = await autoBindAccounts({ repo, listWindows: async () => [W(1, "a@x.com"), W(2, "b@x.com")] }, ["a@x.com", "b@x.com"]);
  assert.deepEqual(bindings, { "a@x.com": "1" });
  assert.deepEqual(r, { bound: 1, ambiguous: [], notFound: [], failed: ["b@x.com"], alreadyBound: 0, error: null });

  const e = await autoBindAccounts(
    {
      repo,
      listWindows: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    },
    ["a@x.com"],
  );
  assert.deepEqual(e, { bound: 0, ambiguous: [], notFound: [], failed: [], alreadyBound: 0, error: "获取窗口列表失败：connect ECONNREFUSED" });

  const none = await autoBindAccounts({ repo, listWindows: async () => [] }, []);
  assert.equal(none.error, null, "没有要绑定的账号时不取窗口");
});

test("autoBindAccounts：有任务在跑时不写绑定（开始前就忙 / 取窗口期间变忙），只记 error", async () => {
  const writes = [];
  const repo = {
    getAllAccounts: () => [{ email: "a@x.com", browser_profile_id: null }],
    bindAccountToBrowser: (email, id) => {
      writes.push([email, id]);
      return true;
    },
  };
  let listed = 0;
  const listWindows = async () => {
    listed += 1;
    return [W(1, "a@x.com")];
  };
  const before = await autoBindAccounts({ repo, listWindows, isBusy: () => true }, ["a@x.com"]);
  assert.equal(before.error, BUSY_SKIP_MESSAGE);
  assert.equal(listed, 0, "开始前就忙时不去取窗口");

  let busy = false;
  const during = await autoBindAccounts(
    {
      repo,
      listWindows: async () => {
        busy = true; // 取窗口期间有任务启动
        return [W(1, "a@x.com")];
      },
      isBusy: () => busy,
    },
    ["a@x.com"],
  );
  assert.equal(during.error, BUSY_SKIP_MESSAGE);
  assert.deepEqual(writes, [], "任务运行中不写绑定");

  const idle = await autoBindAccounts({ repo, listWindows, isBusy: () => false }, ["a@x.com"]);
  assert.equal(idle.bound, 1);
});

test("sameNameWindowCounts：按规范化窗口名计数", () => {
  const m = sameNameWindowCounts([W(1, "a@x.com"), W(2, " A@x.com"), W(3, "b@x.com"), W(4, "")]);
  assert.equal(m.get("a@x.com"), 2);
  assert.equal(m.get("b@x.com"), 1);
  assert.equal(m.has(""), false);
});

test("rankBindCandidates：与邮箱同名的窗口排最前并标注，其余保持原顺序", () => {
  const r = rankBindCandidates(" A@x.com", [
    { profileId: "1", name: "z" },
    { profileId: "2", name: "a@x.com" },
    { profileId: "3", name: "y" },
    { profileId: "4", name: "A@X.COM" },
  ]);
  assert.deepEqual(
    r.map((o) => [o.profileId, o.sameName]),
    [
      ["2", true],
      ["4", true],
      ["1", false],
      ["3", false],
    ],
  );
});
