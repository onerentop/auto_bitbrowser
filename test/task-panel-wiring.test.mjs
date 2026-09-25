/**
 * 批 3：账号内嵌任务区（AI 任务页并入账号页的「任务」抽屉）
 *
 * 页面不能单测，这里按源码钉住这次收敛的几条硬约束：
 *   1. 侧栏不再有 6 个 AI 任务页（原「Google 操作」分组整组撤掉），页面只剩账号 / 设置；
 *   2. 账号页挂载任务抽屉，工具栏只剩一个任务入口（原来那排「批量登录 / 并发 / 关窗 / 巡检 / 删除」按钮不再回来）；
 *   3. 任务抽屉是任务表的渲染器：名称 / 说明 / 顺序都来自 shared/logic/task-panel.ts，不在界面里硬编码；
 *      两种任务的通道分工也要钉住（AI 任务走 abb/aitasks/start，账号动作交回账号页的 onRunAccountAction）；
 *   4. 被删的文件（AiTaskPage / AccountListCard / ai-task-list）不再存在，也没有残留引用。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RENDERER = new URL("../app/renderer/src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (rel) => readFileSync(join(RENDERER, rel), "utf8");
/** 某个片段在源码里出现的次数 */
const count = (src, re) => (src.match(re) ?? []).length;

test("侧栏只剩账号与设置：6 个 AI 任务页已撤掉", () => {
  const app = read("App.tsx");
  assert.doesNotMatch(app, /AiTaskPage/, "不该再引用已删除的 AiTaskPage");
  assert.doesNotMatch(app, /Google 操作/, "「Google 操作」分组应已撤掉");
  assert.doesNotMatch(app, /AI_TASK_KINDS|ai-tasks\.ts/, "外壳不该再依赖 AI 任务定义");
  const keys = [...app.matchAll(/key: "(accounts|settings)"/g)].map((m) => m[1]);
  assert.deepEqual(keys, ["accounts", "settings"], "导航项应为账号 + 设置");
  assert.doesNotMatch(app, /ai_(replace_phone|replace_email|modify_2sv|modify_auth|kick_devices|change_password)/, "不该再有 AI 任务页的 key");
});

test("账号页挂载任务抽屉，且只剩一个任务入口", () => {
  const page = read("pages/AccountsPage.tsx");
  assert.match(page, /import \{ TaskPanel \} from "\.\/accounts\/TaskPanel\.tsx"/, "要引入任务抽屉");
  assert.match(page, /<TaskPanel\b/, "要渲染任务抽屉");
  assert.equal(count(page, /setTaskOpen\(true\)/g), 1, "任务入口只应有一个");
  // 原来那排批量按钮（actionBtn 工厂 + 内联的并发 / 关窗）都收进抽屉了
  assert.doesNotMatch(page, /actionBtn/, "批量按钮工厂应已删除");
  assert.equal(count(page, /IPC\.invoke\.accountsStart/g), 1, "启动账号任务只应经 runAction 一处");
  assert.match(page, /onRunAccountAction=\{/, "抽屉要把账号动作交回账号页");
  assert.equal(count(page, /runAction\(action, undefined, options\)/g), 1, "交回的是同一个 runAction");
});

test("任务抽屉是任务表的渲染器，不在界面里硬编码任务名", () => {
  const panel = read("pages/accounts/TaskPanel.tsx");
  for (const literal of ["替换手机号", "替换辅助邮箱", "踢出设备", "修改密码", "修改验证器", "批量登录"]) {
    assert.ok(!panel.includes(`"${literal}"`), `任务名「${literal}」应来自任务表，不该写死在界面里`);
  }
  assert.match(panel, /TASK_PANEL_GROUPS/, "任务按钮要按任务表的分组渲染");
  assert.match(panel, /taskPanelDef\(/, "每个任务的定义都从任务表取");
});

test("两种任务的通道分工：AI 任务走 aiTasksStart，账号动作走 onRunAccountAction", () => {
  const panel = read("pages/accounts/TaskPanel.tsx");
  assert.match(panel, /IPC\.invoke\.aiTasksStart/, "AI 任务要经 abb/aitasks/start 启动");
  assert.match(panel, /onRunAccountAction\(d\.id as AccountsAction/, "账号动作要交回账号页");
  // AI 任务条目要带窗口 ID（后端按它校验窗口名），没有窗口的账号由任务表逻辑跳过
  assert.match(panel, /aiItemsFromAccounts\(rows\)/, "AI 任务条目要按窗口 ID 组装");
  assert.match(panel, /markTaskStarted\(info\)/, "启动后要通知全局任务坞（底部进度 / 日志）");
});

test("被删的文件不再存在（避免死代码残留）", () => {
  for (const rel of ["pages/AiTaskPage.tsx", "pages/ai-tasks/AccountListCard.tsx"]) {
    assert.ok(!existsSync(join(RENDERER, rel)), `${rel} 应已删除`);
  }
  const shared = new URL("../app/shared/logic/ai-task-list.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  assert.ok(!existsSync(shared), "app/shared/logic/ai-task-list.ts 应已删除（只服务已删的 AI 任务列表页）");
});

test("全仓不再引用被删的 AI 任务列表页", () => {
  const files = ["App.tsx", "pages/AccountsPage.tsx", "pages/accounts/TaskPanel.tsx", "pages/settings/StatusTab.tsx"];
  for (const rel of files) {
    const src = read(rel);
    assert.doesNotMatch(src, /AiTaskPage|ai-tasks\/AccountListCard|ai-task-list/, `${rel} 不应引用已删除的文件`);
  }
});
