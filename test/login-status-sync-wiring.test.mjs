/**
 * 手动设置登录状态后「所有显示登录状态的页面」都要同步（abb/accounts/event/loginStatusChanged）
 *
 * 页面不能单测，这里按源码钉住：账号页与 AI 任务页（6 个任务页共用）都订阅了这个事件，
 * 并用对应的纯函数就地改行；订阅写在 useEffect 里并把取消函数交回（切页 / 卸载时退订）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(`../app/renderer/src/${rel}`, import.meta.url), "utf8");

const SUBSCRIBERS = {
  "pages/AccountsPage.tsx": "applyLoginStatusChange",
  "pages/AiTaskPage.tsx": "applyAiLoginStatusChange",
};

for (const [rel, fn] of Object.entries(SUBSCRIBERS)) {
  test(`${rel}：订阅 loginStatusChanged 并用 ${fn} 就地改行`, () => {
    const src = read(rel);
    const at = src.indexOf("on(IPC.event.accountsLoginStatusChanged");
    assert.ok(at > 0, "要订阅 IPC.event.accountsLoginStatusChanged");
    const block = src.slice(src.lastIndexOf("useEffect(", at), at + 400);
    assert.match(block, /useEffect\(\s*\(\)\s*=>\s*on\(IPC\.event\.accountsLoginStatusChanged/, "订阅要作为 useEffect 的返回值（卸载时退订）");
    assert.match(block, new RegExp(`\\b${fn}\\(`), `收到事件后要用 ${fn} 改行`);
  });
}
