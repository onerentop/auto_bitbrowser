/**
 * 所有列表都分页（app/renderer/src 下每个 antd Table / List）
 *
 * 页面不能单测，这里按源码扫一遍，钉住三条：
 *   1. 不再有 `pagination={false}`；
 *   2. 每个 Table / List 都接共用 hook 的分页：`pagination={<变量>.pagination}`，个数与 Table / List 一一对应；
 *   3. 每个列表的 `usePagination("<名称>"...)` 名称全仓唯一（每页条数按列表分别记住，名称撞了会互相覆盖）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = new URL("../app/renderer/src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function sources() {
  return readdirSync(ROOT, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx$/.test(e.name))
    .map((e) => join(e.parentPath ?? e.path, e.name))
    .map((p) => ({ rel: relative(ROOT, p).split(sep).join("/"), src: readFileSync(p, "utf8") }))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

/** 列表组件的开标签：<Table ...> / <Table<T> ...> / <List ...>（不含 List.Item） */
const LIST_TAG = /<(?:Table|List)(?=[\s<])/g;

const files = sources();
const listFiles = files.filter((f) => (f.src.match(LIST_TAG) ?? []).length > 0);

test("扫到了已知的列表文件（防止扫描本身失效变成假绿）", () => {
  const rels = listFiles.map((f) => f.rel);
  for (const must of [
    "pages/AccountsPage.tsx",
    "pages/accounts/WindowsView.tsx",
    "pages/ai-tasks/AccountListCard.tsx",
    "pages/totp/ResultTable.tsx",
    "pages/settings/TaskHistoryTab.tsx",
    "pages/settings/ProxiesTab.tsx",
    "components/BatchImportModal.tsx",
    "pages/accounts/TagManagerModal.tsx",
  ]) {
    assert.ok(rels.includes(must), `没扫到 ${must}`);
  }
});

for (const f of listFiles) {
  test(`${f.rel}：每个列表都接共用分页`, () => {
    assert.doesNotMatch(f.src, /pagination=\{false\}/, "不应再关闭分页");
    const lists = (f.src.match(LIST_TAG) ?? []).length;
    const wired = (f.src.match(/pagination=\{\w+\.pagination\}/g) ?? []).length;
    const all = (f.src.match(/pagination=/g) ?? []).length;
    assert.equal(wired, lists, `Table/List ${lists} 个，接共用分页的 ${wired} 个`);
    assert.equal(all, wired, "不应有手写的分页配置");
    assert.match(f.src, /import \{[^}]*\busePagination\b[^}]*\} from "[./]+(?:\/components)?\/use-pagination\.ts"/);
  });
}

test("usePagination 的列表名称全仓唯一", () => {
  const names = files.flatMap((f) => [...f.src.matchAll(/usePagination\(\s*"([^"]+)"/g)].map((m) => `${m[1]}@${f.rel}`));
  const byName = new Map();
  for (const n of names) {
    const [name, rel] = n.split("@");
    byName.set(name, [...(byName.get(name) ?? []), rel]);
  }
  const dup = [...byName].filter(([, rels]) => rels.length > 1);
  assert.deepEqual(dup, [], `名称重复：${JSON.stringify(dup)}`);
  assert.ok(names.length >= 10, `只找到 ${names.length} 处 usePagination`);
});
