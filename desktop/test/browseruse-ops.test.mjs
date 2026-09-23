/**
 * BrowserUse 引擎 - join_family 操作与引擎生命周期单测（全离线）
 *
 * 不连 ixBrowser（53200）、不开浏览器、不调 LLM：
 *   - JoinFamilyOperation 吃的是假引擎（navigate/wait/run/getPageContent/getCurrentUrl）
 *   - BrowserUseEngine 吃的是假 CdpConnector + 假 Page + 假 LLM
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACCEPT_INVITE_TASK,
  CREATE_FAMILY_TASK,
  GMAIL_POPUP_TASK,
  JoinFamilyOperation,
  buildSendInviteTask,
  checkInviteSent,
  checkNeedsCreateFamily,
} from "../src/browseruse/operations/join-family.ts";
import {
  ALREADY_IN_FAMILY_KEYWORDS,
  FAMILY_DETAILS_URL,
  FAMILY_FULL_KEYWORDS,
  FAMILY_INVITE_URL,
  FAMILY_MEMBERS_KEYWORDS,
  GMAIL_URL,
  JOIN_SUCCESS_KEYWORDS,
  matchesAnyKeyword,
} from "../src/browseruse/constants.ts";
import { BrowserUseEngine, withEngine } from "../src/browseruse/engine.ts";

// ==================== 替身 ====================

/** 一次性序列取值器：用完之后一直返回 fallback */
function seq(list, fallback) {
  let i = 0;
  return () => {
    const v = list[i];
    i += 1;
    return v === undefined ? fallback : v;
  };
}

/** 假引擎：只实现 JoinFamilyEngine 的 5 个能力，全部同步返回预置数据 */
function fakeJoinEngine(script = {}) {
  const calls = { navigate: [], wait: [], run: [], contents: 0, urls: 0 };
  const nextContent = seq(script.pageContents ?? [], script.defaultContent ?? "");
  const nextUrl = seq(script.urls ?? [], script.defaultUrl ?? "https://mail.google.com/inbox");
  const nextNav = seq(script.navResults ?? [], null);
  const nextRun = seq(script.runResults ?? [], null);

  const okNav = (url) => ({ success: true, url, final_url: url, error: null, duration_ms: 0 });
  const okRun = () => ({
    success: true,
    message: "",
    error: null,
    extracted_content: null,
    steps: [],
    total_steps: 0,
    duration_ms: 0,
  });

  return {
    calls,
    async navigate(url, options) {
      calls.navigate.push({ url, options });
      return nextNav() ?? okNav(url);
    },
    async wait(milliseconds) {
      calls.wait.push(milliseconds);
    },
    async run(task, options) {
      calls.run.push({ task, options });
      const scripted = nextRun();
      if (scripted instanceof Error) throw scripted;
      return scripted ?? okRun();
    },
    async getPageContent() {
      calls.contents += 1;
      return nextContent();
    },
    async getCurrentUrl() {
      calls.urls += 1;
      return nextUrl();
    },
  };
}

// ==================== 1. 关键词判定分支 ====================

test("checkNeedsCreateFamily: 命中（英文 / 西语 / 中文）与不命中", () => {
  assert.equal(checkNeedsCreateFamily("Create A Family Group"), true, "大小写不敏感");
  assert.equal(checkNeedsCreateFamily("Bring your family together"), true);
  assert.equal(checkNeedsCreateFamily("Crear un grupo familiar"), true);
  assert.equal(checkNeedsCreateFamily("请点击创建家庭组"), true);
  assert.equal(checkNeedsCreateFamily("Family members: Alice, Bob"), false);
});

test("checkInviteSent: 命中与不命中", () => {
  assert.equal(checkInviteSent("Invitation sent to a@b.com"), true);
  assert.equal(checkInviteSent("邀请已发送"), true);
  assert.equal(checkInviteSent("Status: Pending"), true);
  assert.equal(checkInviteSent("Enter email address"), false);
});

test("family-full / join-success / already-in-family 三组关键词判定", () => {
  assert.equal(matchesAnyKeyword("this family is full".toLowerCase(), FAMILY_FULL_KEYWORDS), true);
  assert.equal(matchesAnyKeyword("成员已达上限", FAMILY_FULL_KEYWORDS), true);
  assert.equal(matchesAnyKeyword("you can add 3 members", FAMILY_FULL_KEYWORDS), false);

  assert.equal(matchesAnyKeyword("welcome to the family", JOIN_SUCCESS_KEYWORDS), true);
  assert.equal(matchesAnyKeyword("你已加入", JOIN_SUCCESS_KEYWORDS), true);
  assert.equal(matchesAnyKeyword("please wait", JOIN_SUCCESS_KEYWORDS), false);

  assert.equal(matchesAnyKeyword("already in another family", ALREADY_IN_FAMILY_KEYWORDS), true);
  assert.equal(matchesAnyKeyword("尚未加入任何家庭组", ALREADY_IN_FAMILY_KEYWORDS), false);
  assert.equal(matchesAnyKeyword("家庭成员列表", FAMILY_MEMBERS_KEYWORDS), true);
});

// ==================== 2. sendInvite 的四条路径 ====================

test("sendInvite: 导航失败 → 返回「导航到家庭邀请页面失败」", async () => {
  const engine = fakeJoinEngine({
    navResults: [{ success: false, url: FAMILY_INVITE_URL, final_url: null, error: "timeout", duration_ms: 1 }],
  });
  const op = new JoinFamilyOperation(engine);

  const result = await op.sendInvite("invitee@example.com");

  assert.equal(result.success, false);
  assert.equal(result.message, "导航到家庭邀请页面失败");
  assert.equal(result.error, "timeout");
  assert.equal(result.invite_sent, false);
  assert.equal(engine.calls.navigate[0].url, FAMILY_INVITE_URL);
  assert.equal(engine.calls.navigate[0].options.timeoutMs, 30000);
  assert.equal(engine.calls.run.length, 0, "导航失败后不该启动 Agent");
});

test("sendInvite: 家庭组已满 → error_type=family_full", async () => {
  const engine = fakeJoinEngine({ pageContents: ["Invite members", "This family is full"] });
  const op = new JoinFamilyOperation(engine);

  const result = await op.sendInvite("invitee@example.com");

  assert.equal(result.success, false);
  assert.equal(result.message, "家庭组已满");
  assert.equal(result.error, "家庭组成员已达上限 (6人)");
  assert.equal(result.error_type, "family_full");
  assert.equal(engine.calls.run.length, 0);
});

test("sendInvite: Agent 失败 → 返回「发送邀请失败」", async () => {
  const engine = fakeJoinEngine({
    pageContents: ["Invite members", "Invite members"],
    runResults: [
      {
        success: false,
        message: "",
        error: "Agent 步数耗尽",
        extracted_content: null,
        steps: [],
        total_steps: 10,
        duration_ms: 0,
      },
    ],
  });
  const op = new JoinFamilyOperation(engine);

  const result = await op.sendInvite("invitee@example.com");

  assert.equal(result.success, false);
  assert.equal(result.message, "发送邀请失败");
  assert.equal(result.error, "Agent 步数耗尽");
  assert.equal(engine.calls.run[0].task, buildSendInviteTask("invitee@example.com"));
  assert.equal(engine.calls.run[0].options.maxSteps, 10);
});

test("sendInvite: 成功但页面没有「已发送」关键词 → 仍算成功，文案不同", async () => {
  const engine = fakeJoinEngine({
    pageContents: ["Invite members", "Invite members", "Nothing special here"],
  });
  const op = new JoinFamilyOperation(engine);

  const result = await op.sendInvite("invitee@example.com");

  assert.equal(result.success, true);
  assert.equal(result.invite_sent, true);
  assert.equal(result.message, "邀请操作完成，等待 invitee@example.com 接受");
});

test("sendInvite: 成功且看到「Invitation sent」 → 明确的成功文案", async () => {
  const engine = fakeJoinEngine({
    pageContents: ["Invite members", "Invite members", "Invitation sent"],
  });
  const op = new JoinFamilyOperation(engine);

  const result = await op.sendInvite("invitee@example.com");

  assert.equal(result.success, true);
  assert.equal(result.invite_sent, true);
  assert.equal(result.message, "已发送家庭邀请给 invitee@example.com");
  assert.equal(result.error, null);
});

test("sendInvite: 检测到需要创建家庭组 → 先跑创建任务再重新导航", async () => {
  const engine = fakeJoinEngine({
    pageContents: ["Create a Family Group", "Invite members", "Invitation sent"],
  });
  const op = new JoinFamilyOperation(engine);

  const result = await op.sendInvite("invitee@example.com");

  assert.equal(engine.calls.run[0].task, CREATE_FAMILY_TASK);
  assert.equal(engine.calls.run[0].options.maxSteps, 8);
  assert.equal(engine.calls.run[1].task, buildSendInviteTask("invitee@example.com"));
  assert.equal(engine.calls.navigate.length, 2, "创建完成后重新导航到邀请页");
  assert.equal(result.success, true);
});

test("sendInvite: 引擎抛异常 → 收敛成「操作失败: xxx」", async () => {
  const engine = fakeJoinEngine();
  engine.navigate = async () => {
    throw new Error("连接断了");
  };
  const op = new JoinFamilyOperation(engine);

  const result = await op.sendInvite("invitee@example.com");

  assert.equal(result.success, false);
  assert.equal(result.message, "操作失败: 连接断了");
  assert.equal(result.error, "连接断了");
});

// ==================== 3. acceptInvite ====================

test("acceptInvite: 验证成功 → invite_accepted=true", async () => {
  const engine = fakeJoinEngine({
    urls: ["https://families.google.com/families"],
    pageContents: ["Welcome to the family"],
  });
  const op = new JoinFamilyOperation(engine);

  const result = await op.acceptInvite("inviter@example.com");

  assert.equal(result.success, true);
  assert.equal(result.message, "成功加入家庭组");
  assert.equal(result.inviter_email, "inviter@example.com");
  assert.equal(result.invite_accepted, true);
  assert.equal(result.already_in_family, false);
  assert.equal(engine.calls.navigate[0].url, GMAIL_URL);
  assert.equal(engine.calls.run[0].task, GMAIL_POPUP_TASK, "先处理 Gmail 弹窗");
  assert.equal(engine.calls.run[1].task, ACCEPT_INVITE_TASK);
  assert.equal(engine.calls.run[1].options.maxSteps, 15);
});

test("acceptInvite: 页面提示 already in → error_type=already_in_family", async () => {
  const engine = fakeJoinEngine({
    urls: ["https://families.google.com/families"],
    pageContents: ["You are already in another family group"],
  });
  const op = new JoinFamilyOperation(engine);

  const result = await op.acceptInvite("inviter@example.com");

  assert.equal(result.success, false);
  assert.equal(result.message, "已在其他家庭组中");
  assert.equal(result.error, "被邀请人已加入其他家庭组");
  assert.equal(result.error_type, "already_in_family");
  assert.equal(result.already_in_family, true);
  assert.equal(result.invite_accepted, false);
});

test("acceptInvite: 当前不在家庭页时，回落到导航家庭页确认成员", async () => {
  const engine = fakeJoinEngine({
    urls: ["https://mail.google.com/inbox"],
    pageContents: ["Family members: Alice"],
  });
  const op = new JoinFamilyOperation(engine);

  const result = await op.acceptInvite("inviter@example.com");

  assert.equal(result.success, true);
  assert.equal(result.invite_accepted, true);
  const navUrls = engine.calls.navigate.map((c) => c.url);
  assert.deepEqual(navUrls, [GMAIL_URL, FAMILY_DETAILS_URL]);
});

test("acceptInvite: 验证不出结果但 Agent 成功 → 走备选判断", async () => {
  const engine = fakeJoinEngine({
    urls: ["https://mail.google.com/inbox"],
    pageContents: ["无关内容"],
  });
  const op = new JoinFamilyOperation(engine);

  const result = await op.acceptInvite("inviter@example.com");

  assert.equal(result.success, true);
  assert.equal(result.message, "家庭邀请已处理");
  assert.equal(result.invite_accepted, true);
});

test("acceptInvite: 验证失败且 Agent 也失败 → 接受邀请失败", async () => {
  const engine = fakeJoinEngine({
    urls: ["https://mail.google.com/inbox"],
    pageContents: ["无关内容"],
    runResults: [
      // 第 1 次是 Gmail 弹窗处理，第 2 次才是接受邀请
      null,
      {
        success: false,
        message: "",
        error: "找不到邀请邮件",
        extracted_content: null,
        steps: [],
        total_steps: 15,
        duration_ms: 0,
      },
    ],
  });
  const op = new JoinFamilyOperation(engine);

  const result = await op.acceptInvite("inviter@example.com");

  assert.equal(result.success, false);
  assert.equal(result.message, "接受邀请失败");
  assert.equal(result.error, "找不到邀请邮件");
  assert.equal(result.inviter_email, "inviter@example.com");
});

// ==================== 4. 引擎生命周期 ====================

/** 假 Page */
function fakeEnginePage(opts = {}) {
  const calls = { goto: [], innerText: [] };
  let currentUrl = opts.url ?? "https://start.example/";
  const page = {
    url: () => currentUrl,
    title: async () => "标题",
    goto: async (url, options) => {
      calls.goto.push({ url, options });
      if (opts.gotoThrows) throw new Error("goto 失败");
      currentUrl = url;
    },
    evaluate: async () => ({ elements: [], page_url: currentUrl, page_title: "标题" }),
    click: async () => {},
    fill: async () => {},
    screenshot: async () => new Uint8Array([7]),
    innerText: async (selector) => {
      calls.innerText.push(selector);
      return opts.bodyText ?? "页面正文";
    },
    goBack: async () => {},
    viewportSize: () => ({ width: 800, height: 600 }),
    mouse: { click: async () => {} },
    keyboard: { press: async () => {}, type: async () => {} },
    context: () => ({ pages: () => [page] }),
  };
  return { page, calls };
}

/** 假 CdpConnector：不加载 playwright，也不连任何端点 */
function fakeConnector(page, opts = {}) {
  /** order 记录关闭动作的先后，用于断言本地模式的关闭顺序 */
  const calls = { connect: [], launchLocal: 0, close: 0, dispose: 0, closeContext: 0, order: [] };
  const connection = {
    page,
    async close() {
      calls.close += 1;
      calls.order.push("close");
    },
    async dispose() {
      calls.dispose += 1;
      calls.order.push("dispose");
    },
    async closeContext() {
      calls.closeContext += 1;
      calls.order.push("closeContext");
    },
  };
  return {
    calls,
    async connect(wsEndpoint) {
      calls.connect.push(wsEndpoint);
      if (opts.connectThrows) throw new Error("连不上");
      return connection;
    },
    async launchLocal() {
      calls.launchLocal += 1;
      return connection;
    },
  };
}

/** 假 LLM：构造引擎时必须给，否则会走 createLlmFromConfig 读环境变量 */
const fakeLlm = { model: "fake", async ainvoke() {
  throw new Error("本测试不应调用 LLM");
} };

/** 按脚本回放 ChatCompletion 的假 LLM（Agent 路径用） */
function scriptedLlm(script) {
  const seen = [];
  return {
    model: "scripted",
    seen,
    async ainvoke(messages, responseFormat) {
      seen.push({ messages, responseFormat });
      return script[Math.min(seen.length - 1, script.length - 1)];
    },
  };
}

/** 一个立刻 done 的 AgentOutput */
function doneOutput(message) {
  return { thinking: "t", next_goal: "收尾", action: [{ done: { message, success: true } }] };
}

/** 一个永远不 done 的 AgentOutput（用来撞 maxSteps） */
const NEVER_DONE_OUTPUT = { thinking: "t", next_goal: "继续", action: [{ wait: { milliseconds: 1 } }] };

function makeEngine(pageOpts = {}, connectorOpts = {}, engineOpts = {}) {
  const { page, calls: pageCalls } = fakeEnginePage(pageOpts);
  const connector = fakeConnector(page, connectorOpts);
  const engine = new BrowserUseEngine({
    llm: fakeLlm,
    cdpConnector: connector,
    useVision: false,
    ...engineOpts,
  });
  return { engine, connector, page, pageCalls };
}

test("引擎: 未初始化时调用受保护方法抛「引擎未初始化…」", async () => {
  const { engine } = makeEngine();
  assert.equal(engine.isInitialized, false);
  await assert.rejects(() => engine.navigate("https://x.io"), /引擎未初始化/);
  await assert.rejects(() => engine.getCurrentUrl(), /引擎未初始化/);
  await assert.rejects(() => engine.getPageContent(), /引擎未初始化/);
  await assert.rejects(() => engine.run("任务"), /引擎未初始化/);
  assert.throws(() => engine.page, /引擎未初始化/);
});

test("引擎: connectCdp → isInitialized → navigate/getPageContent/getCurrentUrl", async () => {
  const { engine, connector, pageCalls } = makeEngine();

  await engine.connectCdp("ws://127.0.0.1:0/devtools/browser/fake");

  assert.equal(engine.isInitialized, true);
  assert.equal(engine.isCdpMode, true);
  assert.deepEqual(connector.calls.connect, ["ws://127.0.0.1:0/devtools/browser/fake"]);

  const nav = await engine.navigate("https://target.example/page");
  assert.equal(nav.success, true);
  assert.equal(nav.url, "https://target.example/page");
  assert.equal(nav.final_url, "https://target.example/page");
  assert.equal(pageCalls.goto[0].options.waitUntil, "domcontentloaded");
  assert.equal(pageCalls.goto[0].options.timeout, 30000);

  assert.equal(await engine.getCurrentUrl(), "https://target.example/page");
  assert.equal(await engine.getPageContent(), "页面正文");
  assert.deepEqual(pageCalls.innerText, ["body"]);
  assert.equal(await engine.getPageTitle(), "标题");
});

test("引擎: navigate 失败返回 error 结果而非抛出", async () => {
  const { engine } = makeEngine({ gotoThrows: true });
  await engine.connectCdp("ws://fake");

  const nav = await engine.navigate("https://target.example/");
  assert.equal(nav.success, false);
  assert.equal(nav.error, "goto 失败");
  assert.equal(nav.final_url, null);
});

test("引擎: stop() 关闭连接并复位状态", async () => {
  const { engine, connector } = makeEngine();
  await engine.connectCdp("ws://fake");

  await engine.stop();

  assert.equal(engine.isInitialized, false);
  assert.equal(engine.isCdpMode, false);
  assert.equal(connector.calls.close, 1);
  assert.equal(connector.calls.dispose, 1);
  await assert.rejects(() => engine.getCurrentUrl(), /引擎未初始化/);

  // 重复 stop 不应抛错
  await engine.stop();
});

test("引擎: 重复 connectCdp 抛「引擎已初始化，无法重复连接」", async () => {
  const { engine } = makeEngine();
  await engine.connectCdp("ws://fake");
  await assert.rejects(() => engine.connectCdp("ws://fake2"), /引擎已初始化，无法重复连接/);
});

test("引擎: CDP 连接失败时清理状态并抛「CDP 连接失败: xxx」", async () => {
  const { engine } = makeEngine({}, { connectThrows: true });

  await assert.rejects(() => engine.connectCdp("ws://fake"), /CDP 连接失败: 连不上/);
  assert.equal(engine.isInitialized, false);
  assert.equal(engine.isCdpMode, false);
});

test("引擎: withEngine 在 body 抛错时也会 stop()", async () => {
  const { engine, connector } = makeEngine();
  await engine.connectCdp("ws://fake");

  await assert.rejects(
    () =>
      withEngine(engine, async () => {
        throw new Error("业务炸了");
      }),
    /业务炸了/,
  );
  assert.equal(connector.calls.close, 1);
  assert.equal(engine.isInitialized, false);
});

test("引擎: observe 直接读 DOM 树，不调用 LLM", async () => {
  const { engine } = makeEngine();
  await engine.connectCdp("ws://fake");

  const result = await engine.observe("列出可交互元素");
  assert.equal(result.success, true);
  assert.deepEqual(result.elements, []);
  assert.equal(result.error, null);
});

// ==================== 5. act / extract / run 的结果映射 ====================

test("引擎 act(): 成功路径带出 extracted_content 与 `执行成功: <指令>`", async () => {
  const llm = scriptedLlm([{ content: "", parsed: doneOutput("已点击登录按钮") }]);
  const { engine } = makeEngine({}, {}, { llm });
  await engine.connectCdp("ws://fake");

  const result = await engine.act("点击登录按钮");

  assert.equal(result.success, true);
  assert.equal(result.message, "执行成功: 点击登录按钮");
  assert.equal(result.extracted_content, "已点击登录按钮");
  assert.equal(result.error, null);
  assert.equal(llm.seen.length, 1, "act 内部是 maxSteps=1 的 Agent");
});

test("引擎 act(): Agent 失败时 error 取 result.error", async () => {
  const llm = scriptedLlm([{ content: "", parsed: NEVER_DONE_OUTPUT }]);
  const { engine } = makeEngine({}, {}, { llm });
  await engine.connectCdp("ws://fake");

  const result = await engine.act("做不完的事");

  assert.equal(result.success, false);
  assert.equal(result.error, "达到最大步数限制", "maxSteps=1 未 done → 沿用 Agent 的 error");
  assert.equal(result.message, "");
  assert.equal(result.extracted_content, null);
});

test("引擎 extract(): extracted_content 是合法 JSON → data 为解析后的对象", async () => {
  const llm = scriptedLlm([{ content: "", parsed: doneOutput('{"plan":"2 TB","members":3}') }]);
  const { engine } = makeEngine({}, {}, { llm });
  await engine.connectCdp("ws://fake");

  const result = await engine.extract("套餐信息", { type: "object" }, { maxSteps: 1 });

  assert.equal(result.success, true);
  assert.deepEqual(result.data, { plan: "2 TB", members: 3 });
  assert.equal(result.error, null);
});

test("引擎 extract(): 非 JSON 内容 → data 退化成 { content: ... }", async () => {
  const llm = scriptedLlm([{ content: "", parsed: doneOutput("这是一段纯文本") }]);
  const { engine } = makeEngine({}, {}, { llm });
  await engine.connectCdp("ws://fake");

  const result = await engine.extract("套餐信息", null, { maxSteps: 1 });

  assert.equal(result.success, true);
  assert.deepEqual(result.data, { content: "这是一段纯文本" });
});

test("引擎 extract(): 失败时 error 取 result.error || 提取失败", async () => {
  const llm = scriptedLlm([{ content: "", parsed: NEVER_DONE_OUTPUT }]);
  const { engine } = makeEngine({}, {}, { llm });
  await engine.connectCdp("ws://fake");

  const result = await engine.extract("套餐信息", null, { maxSteps: 1 });

  assert.equal(result.success, false);
  assert.equal(result.data, null);
  assert.equal(result.error, "达到最大步数限制");
});

test("引擎 run(): 把 AgentService 的步骤映射成 AgentStep", async () => {
  const llm = scriptedLlm([{ content: "", parsed: doneOutput("搞定") }]);
  const { engine } = makeEngine({}, {}, { llm });
  await engine.connectCdp("ws://fake");

  const result = await engine.run("干点活", { maxSteps: 1 });

  assert.equal(result.success, true);
  assert.equal(result.total_steps, 1);
  assert.equal(result.extracted_content, "搞定");
  assert.equal(result.steps.length, 1);

  const step = result.steps[0];
  assert.equal(step.step_number, 0);
  assert.equal(step.thinking, "t");
  assert.equal(step.action_name, "done");
  assert.deepEqual(step.action_params, { message: "搞定", success: true });
  assert.equal(step.browser_url, "https://start.example/");
  assert.equal(typeof step.timestamp, "number");
  assert.ok(step.timestamp > 0);
  assert.equal(step.result, null, "engine.run 的转换不透传 result 字段，只留 createAgentStep 的默认 null");
});

test("引擎 run(): 步骤缺字段/类型不对时取 AgentStep 的默认值，非对象条目被丢弃", async () => {
  const { engine } = makeEngine();
  await engine.connectCdp("ws://fake");

  // 这段防御性映射只在 AgentService 返回畸形步骤时才会走到，
  // 正常路径构造不出这种输入，因此直接替换引擎持有的 AgentService（运行时是普通属性）。
  engine._agentService = {
    async run() {
      return {
        success: true,
        message: "m",
        error: null,
        extracted_content: "c",
        steps: [{}, { step_number: "不是数字", action_params: 123 }, "不是对象", null],
        total_steps: 4,
        duration_ms: 0,
      };
    },
  };

  const result = await engine.run("任务");

  assert.equal(result.steps.length, 2, "字符串与 null 条目被丢弃");
  assert.deepEqual(result.steps[0], {
    step_number: 0,
    thinking: "",
    action_name: "",
    action_params: {},
    result: null,
    browser_url: "",
    timestamp: 0,
  });
  assert.equal(result.steps[1].step_number, 0, "step_number 不是 number → 取默认 0");
  assert.deepEqual(result.steps[1].action_params, {}, "action_params 不是对象 → 取默认 {}");
  assert.equal(result.total_steps, 4, "total_steps 直接透传");
});

// ==================== 6. connectToIxBrowser 与本地模式关闭顺序 ====================

/** 假 ixBrowser 客户端：不碰 53200 端口，只记录调用 */
function fakeIxClient(opts = {}) {
  const calls = { openProfile: [], closeProfile: [] };
  return {
    calls,
    async openProfile(profileId) {
      calls.openProfile.push(profileId);
      if (opts.openThrows) throw new Error("窗口不存在");
      return { ws: opts.ws ?? "ws://127.0.0.1:1/devtools/browser/x", debugging_port: 0, profile_id: profileId };
    },
    async closeProfile(profileId) {
      calls.closeProfile.push(profileId);
    },
  };
}

test("引擎 connectToIxBrowser(): 取到 ws 后建立 CDP 连接", async () => {
  const { page } = fakeEnginePage();
  const connector = fakeConnector(page);
  const ix = fakeIxClient();

  const engine = await BrowserUseEngine.connectToIxBrowser(370, {
    llm: fakeLlm,
    cdpConnector: connector,
    ixClient: ix,
    useVision: false,
  });

  assert.deepEqual(ix.calls.openProfile, [370]);
  assert.deepEqual(connector.calls.connect, ["ws://127.0.0.1:1/devtools/browser/x"]);
  assert.equal(engine.isInitialized, true);
  assert.equal(engine.isCdpMode, true);
  assert.equal(engine.browserId, 370);

  // 默认 closeBrowserOnExit=false：stop() 不关 ixBrowser 窗口
  await engine.stop();
  assert.deepEqual(ix.calls.closeProfile, []);
});

test("引擎 connectToIxBrowser(): 字符串 browserId 会被转成数字", async () => {
  const { page } = fakeEnginePage();
  const ix = fakeIxClient();
  const engine = await BrowserUseEngine.connectToIxBrowser("370", {
    llm: fakeLlm,
    cdpConnector: fakeConnector(page),
    ixClient: ix,
  });
  assert.deepEqual(ix.calls.openProfile, [370]);
  assert.equal(engine.browserId, 370);
  await engine.stop();
});

test("引擎 connectToIxBrowser(): openProfile 抛错 → 「打开 ixBrowser 窗口失败: …」", async () => {
  const { page } = fakeEnginePage();
  const connector = fakeConnector(page);
  const ix = fakeIxClient({ openThrows: true });

  await assert.rejects(
    () =>
      BrowserUseEngine.connectToIxBrowser(370, {
        llm: fakeLlm,
        cdpConnector: connector,
        ixClient: ix,
      }),
    /打开 ixBrowser 窗口失败: 窗口不存在/,
  );
  assert.equal(connector.calls.connect.length, 0, "拿不到 ws 就不该去连 CDP");
});

test("引擎 connectToIxBrowser(): ws 为空串 → 同样报「打开 ixBrowser 窗口失败」", async () => {
  const { page } = fakeEnginePage();
  const ix = fakeIxClient({ ws: "" });

  await assert.rejects(
    () =>
      BrowserUseEngine.connectToIxBrowser(370, {
        llm: fakeLlm,
        cdpConnector: fakeConnector(page),
        ixClient: ix,
      }),
    /打开 ixBrowser 窗口失败: 未获取到 WebSocket 端点/,
  );
});

test("引擎 connectToIxBrowser(): closeBrowserOnExit=true 时 stop() 会关窗口", async () => {
  const { page } = fakeEnginePage();
  const connector = fakeConnector(page);
  const ix = fakeIxClient();

  const engine = await BrowserUseEngine.connectToIxBrowser(370, {
    llm: fakeLlm,
    cdpConnector: connector,
    ixClient: ix,
    closeBrowserOnExit: true,
  });

  await engine.stop();

  assert.deepEqual(ix.calls.closeProfile, [370]);
  assert.equal(connector.calls.close, 1);
  assert.equal(connector.calls.dispose, 1);
  assert.equal(engine.browserId, null, "stop() 后 browserId 被清空");
});

test("引擎 本地模式: start() 拉起本地浏览器，stop() 的关闭顺序是 closeContext → close → dispose", async () => {
  const { engine, connector } = makeEngine();

  await engine.start();

  assert.equal(connector.calls.launchLocal, 1);
  assert.equal(connector.calls.connect.length, 0);
  assert.equal(engine.isInitialized, true);
  assert.equal(engine.isCdpMode, false);

  await engine.stop();

  assert.deepEqual(connector.calls.order, ["closeContext", "close", "dispose"]);
  assert.equal(engine.isInitialized, false);
});

test("引擎 本地模式: 已初始化后重复 start() 直接返回，不再拉起浏览器", async () => {
  const { engine, connector } = makeEngine();
  await engine.start();
  await engine.start();
  assert.equal(connector.calls.launchLocal, 1);
  await engine.stop();
});
