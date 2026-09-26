/**
 * 提示体系收敛的源码钉法（真机 2026-09-26）
 *
 * 页面/组件不能单测，这里按既有做法（test/task-panel-wiring.test.mjs）扫源码钉住这次收敛：
 *   1. 任务坞不再有完成弹窗，结果只用 store 里的 lastFinished 渲染一行；
 *   2. 结果文案的唯一实现是 lib/task-result.ts，组件里不再自带字段名表与平铺逻辑；
 *   3. 旧的完成提示实现（finished-notice）文件与引用都已删除；
 *   4. 账号页不再为任务结束发卡片；
 *   5. 「停止失败」在任务坞与任务抽屉两处都走右上卡片，没有弹窗 / 短条的第二形态；
 *   6. 结论文案只有一份（任务抽屉从 lib 引入）。
 *
 * 为什么值得钉：这几点都会被后续改动悄悄改回去（例如图省事再加回完成弹窗），而真机回归成本高。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RENDERER = new URL("../app/renderer/src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (rel) => readFileSync(join(RENDERER, rel), "utf8");

test("任务坞不再有完成弹窗，结果只用 lastFinished 渲染一行", () => {
  const dock = read("components/TaskDock.tsx");
  assert.doesNotMatch(dock, /\bModal\b/, "任务坞不该再用 Modal（任务结束不弹窗）");
  assert.doesNotMatch(dock, /onTaskFinished/, "结果不该再由事件回调存进局部 state");
  assert.match(dock, /lastFinished/, "结果行要来自 store 的 lastFinished");
  assert.match(dock, /taskResultView/, "结果文案要来自 lib/task-result.ts");
  assert.doesNotMatch(dock, /RESULT_LABELS|function summarize/, "字段中文名与平铺逻辑只能有一份（在 lib 里）");
});

test("旧的完成提示实现已删除，且没有真实引用残留", () => {
  assert.equal(
    existsSync(join(RENDERER, "pages/accounts/finished-notice.ts")),
    false,
    "finished-notice.ts 应已删除（结论文案并入 lib/task-result.ts）",
  );
  // 只查真实引用（import 或调用）：注释里提到文件名是正常的历史说明
  const reference = /finishedNotice\s*\(|from "[^"]*finished-notice/;
  for (const rel of ["pages/AccountsPage.tsx", "components/TaskDock.tsx", "lib/task-result.ts"]) {
    assert.doesNotMatch(read(rel), reference, `${rel} 不该再引用 finishedNotice`);
  }
});

test("账号页不再为任务结束发卡片（结果只留任务坞）", () => {
  const page = read("pages/AccountsPage.tsx");
  assert.doesNotMatch(page, /notification\.(info|success)\(/, "任务结束的卡片应已删除，只保留错误卡片");
});

test("停止失败在任务坞与任务抽屉两处都走卡片，没有弹窗 / 短条的第二形态", () => {
  const dock = read("components/TaskDock.tsx");
  const panel = read("pages/accounts/TaskPanel.tsx");

  assert.match(dock, /notification\.error\(\{ message: "停止失败"/, "任务坞的停止失败要走卡片");
  assert.match(panel, /notification\.error\(\{ message: "停止失败"/, "任务抽屉的停止失败要走卡片");
  assert.doesNotMatch(dock, /Modal\.error/, "不该再用阻塞弹窗报停止失败");
  assert.doesNotMatch(
    panel,
    /stopTask\(\)\.catch\(\(e: unknown\) => void message\./,
    "不该再用短条报停止失败（同一事件只能有一个面）",
  );
});

test("结论文案只有一份：任务抽屉从 lib 引入，不再自带映射表", () => {
  const panel = read("pages/accounts/TaskPanel.tsx");
  assert.match(panel, /import \{ OUTCOME_TEXT \} from "\.\.\/\.\.\/lib\/task-result\.ts"/, "结论映射要共用 lib 那份");
  assert.doesNotMatch(panel, /const OUTCOME_TEXT\s*[:=]/, "不要在抽屉里再写一份结论映射");
});
