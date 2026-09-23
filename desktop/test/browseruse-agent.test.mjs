/**
 * BrowserUse 引擎 - Agent 循环与动作系统单测（全离线）
 * 覆盖：单步循环与终止条件、LLM 输出的三条解析分支、
 *       动作注册表内容、ActionExecutor 的分发与错误结果形状
 *
 * 所有外部依赖都是替身：假 LLM（不发请求）、假 DomService、假 Page。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentService } from "../src/browseruse/agent/service.ts";
import { MessageManager } from "../src/browseruse/agent/message-manager.ts";
import { ActionExecutor, defaultRegistry, ActionRegistry } from "../src/browseruse/tools/index.ts";
import { createActionResult } from "../src/browseruse/protocol.ts";
import { createBrowserState, createDomTree, normalizeActionModel } from "../src/browseruse/types.ts";

// ==================== 替身 ====================

/** 假 Page：Agent 循环只用到 url()；执行器用到 goto/click/fill/keyboard */
function fakePage() {
  const calls = { goto: [], click: [], fill: [], mouse: [], keys: [] };
  const page = {
    url: () => "https://fake.example/",
    title: async () => "fake",
    goto: async (url, options) => {
      calls.goto.push({ url, options });
      if (url === "https://boom.example/") throw new Error("导航炸了");
    },
    evaluate: async () => ({}),
    click: async (selector, options) => {
      calls.click.push({ selector, options });
    },
    fill: async (selector, value, options) => {
      calls.fill.push({ selector, value, options });
    },
    screenshot: async () => new Uint8Array([9]),
    innerText: async () => "text",
    goBack: async () => {},
    viewportSize: () => ({ width: 1000, height: 600 }),
    mouse: {
      click: async (x, y) => {
        calls.mouse.push([x, y]);
      },
    },
    keyboard: {
      press: async (k) => {
        calls.keys.push(`press:${k}`);
      },
      type: async (t) => {
        calls.keys.push(`type:${t}`);
      },
    },
    context: () => ({ pages: () => [page] }),
  };
  return { page, calls };
}

/** 假 DomService：只提供 Agent 用到的 getBrowserState */
function fakeDomService() {
  const calls = [];
  return {
    calls,
    async getBrowserState(options = {}) {
      calls.push(options);
      return createBrowserState({ url: "https://fake.example/", title: "fake", dom_tree: createDomTree() });
    },
    async extractDom() {
      return createDomTree();
    },
  };
}

/** 假动作执行器：记录被执行的动作，恒定成功 */
function fakeExecutor() {
  const executed = [];
  return {
    executed,
    async execute(action) {
      executed.push(action);
      return createActionResult({ success: true, message: "已执行" });
    },
  };
}

/**
 * 假 LLM：按调用序号依次返回预置的 ChatCompletion（或抛出预置的错误）。
 * 不做任何网络请求。
 */
function fakeLlm(script) {
  const seen = [];
  return {
    model: "fake-model",
    seen,
    async ainvoke(messages, responseFormat) {
      seen.push({ messages, responseFormat });
      const item = script[Math.min(seen.length - 1, script.length - 1)];
      if (item instanceof Error) throw item;
      if (typeof item === "function") return item();
      return item;
    },
  };
}

const DONE_OUTPUT = {
  thinking: "该收尾了",
  evaluation_previous_goal: "上一步成功",
  memory: "无",
  next_goal: "结束任务",
  action: [{ done: { message: "任务已完成", success: true } }],
};

const CLICK_OUTPUT = {
  thinking: "继续点",
  evaluation_previous_goal: null,
  memory: null,
  next_goal: "点击按钮",
  action: [{ click: { index: 1 } }],
};

function makeAgent(llm, options = {}) {
  const { page } = fakePage();
  const domService = fakeDomService();
  const executor = fakeExecutor();
  const agent = new AgentService({
    llm,
    page,
    domService,
    actionExecutor: executor,
    useVision: false,
    ...options,
  });
  return { agent, domService, executor, page };
}

// ==================== 1. Agent 单步循环与终止条件 ====================

test("Agent: done 动作触发完成，并带出 extracted_content", async () => {
  const llm = fakeLlm([{ content: "", parsed: DONE_OUTPUT }]);
  const { agent, executor } = makeAgent(llm);

  const result = await agent.run("做点事", { maxSteps: 5 });

  assert.equal(result.success, true);
  assert.equal(result.extracted_content, "任务已完成");
  assert.equal(result.message, "任务已完成");
  assert.equal(result.error, null);
  assert.equal(result.total_steps, 1, "遇到 done 立即 break，不跑满 maxSteps");
  assert.equal(llm.seen.length, 1);
  assert.equal(executor.executed.length, 1);
  assert.equal(agent.state.status, "completed");
  assert.equal(result.steps[0].action_name, "done");
});

test("Agent: 达到 maxSteps 未完成 → status=failed / error=达到最大步数限制", async () => {
  const llm = fakeLlm([{ content: "", parsed: CLICK_OUTPUT }]);
  const { agent, executor } = makeAgent(llm);

  const result = await agent.run("一直点", { maxSteps: 2 });

  assert.equal(result.success, false);
  assert.equal(result.error, "达到最大步数限制");
  assert.equal(result.extracted_content, null);
  assert.equal(result.message, "");
  assert.equal(result.total_steps, 2);
  assert.equal(executor.executed.length, 2);
  assert.equal(agent.state.status, "failed");
});

test("Agent: LLM 调用抛错时记错继续，不终止外层循环", async () => {
  const llm = fakeLlm([new Error("网络炸了")]);
  const { agent, executor } = makeAgent(llm);

  const seenSteps = [];
  const result = await agent.run("会失败的任务", {
    maxSteps: 2,
    onStep: (step) => {
      seenSteps.push(step);
    },
  });

  assert.equal(llm.seen.length, 2, "第一步出错后仍然进入第二步");
  assert.equal(seenSteps.length, 2);
  assert.equal(seenSteps[0].error, "LLM 调用失败: 网络炸了");
  assert.equal(seenSteps[1].error, "LLM 调用失败: 网络炸了");
  assert.equal(executor.executed.length, 0, "没有 AgentOutput 就不执行动作");
  assert.equal(result.success, false);
  assert.equal(result.error, "达到最大步数限制", "外层循环跑满，而不是被异常中断");
});

test("Agent: 运行中 stop() → 下一轮循环前中断，status=stopped", async () => {
  const llm = fakeLlm([{ content: "", parsed: CLICK_OUTPUT }]);
  const { agent } = makeAgent(llm);

  // 注意：run() 入口会把 _stopRequested 复位，所以停止必须在运行中发出
  const result = await agent.run("跑一步就停", {
    maxSteps: 3,
    onStep: () => {
      agent.stop();
    },
  });

  assert.equal(llm.seen.length, 1, "第二轮循环开始前就被中断");
  assert.equal(agent.state.status, "stopped");
  assert.equal(result.success, false);
  assert.equal(result.error, null, "主动停止不算失败，不写 error");
  assert.equal(result.total_steps, 1);
});

// ==================== 2. LLM 输出解析的三条分支 ====================

test("LLM 输出解析分支 A: response.parsed 直接可用", async () => {
  const llm = fakeLlm([{ content: "任意文本，不会被解析", parsed: DONE_OUTPUT }]);
  const { agent, executor } = makeAgent(llm);

  const result = await agent.run("A", { maxSteps: 1 });

  assert.equal(result.success, true);
  assert.equal(result.extracted_content, "任务已完成");
  assert.deepEqual(executor.executed[0], { done: { message: "任务已完成", success: true } });
  assert.equal(result.steps[0].thinking, "该收尾了");
});

test("LLM 输出解析分支 B: content 含 ```json 围栏", async () => {
  const payload = JSON.stringify({
    thinking: "围栏 json",
    next_goal: "完成",
    action: [{ done: { message: "来自 json 围栏" } }],
  });
  const llm = fakeLlm([{ content: "解释一下：\n```json\n" + payload + "\n```\n完毕", parsed: null }]);
  const { agent, executor } = makeAgent(llm);

  const result = await agent.run("B", { maxSteps: 1 });

  assert.equal(result.success, true);
  assert.equal(result.extracted_content, "来自 json 围栏");
  assert.equal(result.steps[0].thinking, "围栏 json");
  assert.deepEqual(executor.executed[0].done, { message: "来自 json 围栏", success: true });
});

test("LLM 输出解析分支 C: content 含裸 ``` 围栏", async () => {
  const payload = JSON.stringify({
    thinking: "裸围栏",
    next_goal: "完成",
    action: [{ done: { message: "来自裸围栏", success: false } }],
  });
  const llm = fakeLlm([{ content: "```\n" + payload + "\n```", parsed: null }]);
  const { agent } = makeAgent(llm);

  const result = await agent.run("C", { maxSteps: 1 });

  assert.equal(result.success, true, "done 动作出现即视为完成，与 done.success 无关");
  assert.equal(result.extracted_content, "来自裸围栏");
  assert.equal(result.steps[0].thinking, "裸围栏");
});

test("LLM 输出解析: 三条分支都失败时步骤记 `解析 LLM 输出失败`", async () => {
  const llm = fakeLlm([{ content: "这不是 JSON", parsed: null }]);
  const { agent, executor } = makeAgent(llm);

  const steps = [];
  const result = await agent.run("D", { maxSteps: 1, onStep: (s) => steps.push(s) });

  assert.equal(steps.length, 1);
  assert.match(steps[0].error, /^解析 LLM 输出失败: /);
  assert.equal(executor.executed.length, 0);
  assert.equal(result.success, false);
});

test("Agent: 每步动作数被 maxActionsPerStep 截断", async () => {
  const output = {
    thinking: "一次干三件",
    next_goal: "批量",
    action: [{ click: { index: 1 } }, { click: { index: 2 } }, { click: { index: 3 } }],
  };
  const llm = fakeLlm([{ content: "", parsed: output }]);
  const { agent, executor } = makeAgent(llm, { maxActionsPerStep: 2 });

  await agent.run("E", { maxSteps: 1 });

  assert.equal(executor.executed.length, 2);
});

// ==================== 3. 动作注册表 ====================

test("注册表: 10 个内置动作名称与注册顺序", () => {
  assert.deepEqual(defaultRegistry.listActions(), [
    "navigate",
    "click",
    "input",
    "scroll",
    "extract",
    "screenshot",
    "wait",
    "done",
    "press_key",
    "go_back",
  ]);
});

test("注册表: 元数据与描述文本", () => {
  const navigate = defaultRegistry.getAction("navigate");
  assert.equal(navigate.description, "导航到指定 URL");
  assert.deepEqual(navigate.parameters.required, ["url"]);
  assert.equal(typeof defaultRegistry.getHandler("done"), "function");
  assert.equal(defaultRegistry.getAction("不存在"), null);
  assert.equal(defaultRegistry.getHandler("不存在"), null);

  const descriptions = defaultRegistry.getActionDescriptions().split("\n");
  assert.equal(descriptions.length, 10);
  assert.equal(descriptions[0], "- navigate: 导航到指定 URL");
  assert.equal(descriptions[9], "- go_back: 返回上一页");
});

test("注册表: getJsonSchema 对空 parameters 不输出 parameters 字段", () => {
  const schemas = defaultRegistry.getJsonSchema();
  assert.equal(schemas.length, 10);
  const goBack = schemas.find((s) => s.name === "go_back");
  assert.equal("parameters" in goBack, false);
  const input = schemas.find((s) => s.name === "input");
  assert.deepEqual(input.parameters.required, ["index", "text"]);
});

test("注册表: 自定义实例注册/清空互不影响全局", async () => {
  const registry = new ActionRegistry();
  assert.deepEqual(registry.listActions(), []);
  registry.register("my_action", async () => createActionResult({ success: true, message: "自定义" }));
  assert.deepEqual(registry.listActions(), ["my_action"]);
  assert.equal(registry.getAction("my_action").description, "执行 my_action 动作");
  registry.clear();
  assert.deepEqual(registry.listActions(), []);
  assert.equal(defaultRegistry.listActions().length, 10, "全局注册表不受影响");
});

// ==================== 4. 执行器分发 ====================

function makeExecutor(domServiceOverrides = {}) {
  const { page, calls } = fakePage();
  const domService = {
    getSelectorByIndex: () => null,
    getCoordinatesByIndex: () => null,
    ...domServiceOverrides,
  };
  const executor = new ActionExecutor({ page, domService });
  return { executor, calls, page };
}

test("执行器: navigate 分发到 page.goto", async () => {
  const { executor, calls } = makeExecutor();
  const result = await executor.execute(normalizeActionModel({ navigate: { url: "https://ok.example/" } }));

  assert.equal(result.success, true);
  assert.equal(result.message, "已导航到 https://ok.example/");
  assert.equal(calls.goto.length, 1);
  assert.equal(calls.goto[0].options.waitUntil, "domcontentloaded");
  assert.equal(calls.goto[0].options.timeout, 30000);
});

test("执行器: navigate 失败时返回 error 结果（不抛出）", async () => {
  const { executor } = makeExecutor();
  const result = await executor.execute(normalizeActionModel({ navigate: { url: "https://boom.example/" } }));

  assert.equal(result.success, false);
  assert.equal(result.error, "导航炸了");
  assert.equal(result.message, "");
});

test("执行器: click 分发 —— 优先选择器，失败回退坐标", async () => {
  const bySelector = makeExecutor({ getSelectorByIndex: () => "#btn", getCoordinatesByIndex: () => [12, 34] });
  const r1 = await bySelector.executor.execute(normalizeActionModel({ click: { index: 5 } }));
  assert.equal(r1.success, true);
  assert.equal(r1.message, "已点击元素 [5]");
  assert.deepEqual(bySelector.calls.click[0], { selector: "#btn", options: { timeout: 5000 } });

  // 没有选择器只有坐标 → 走 mouse.click
  const byCoords = makeExecutor({ getCoordinatesByIndex: () => [12.5, 34] });
  const r2 = await byCoords.executor.execute(normalizeActionModel({ click: { index: 6 } }));
  assert.equal(r2.success, true);
  assert.equal(r2.message, "已点击元素 [6] (坐标: 12, 34)");
  assert.deepEqual(byCoords.calls.mouse[0], [12.5, 34]);

  // 既无选择器也无坐标
  const none = makeExecutor();
  const r3 = await none.executor.execute(normalizeActionModel({ click: { index: 7 } }));
  assert.equal(r3.success, false);
  assert.equal(r3.error, "找不到索引为 7 的元素");
});

test("执行器: input 分发到 page.fill（clear=true）", async () => {
  const { executor, calls } = makeExecutor({ getSelectorByIndex: () => "#email" });
  const result = await executor.execute(normalizeActionModel({ input: { index: 2, text: "a@b.com" } }));

  assert.equal(result.success, true);
  assert.equal(result.message, "已在元素 [2] 输入文本");
  assert.deepEqual(calls.fill[0], { selector: "#email", value: "a@b.com", options: { timeout: 5000 } });
});

test("执行器: input 在 clear=false 时改用 click + keyboard.type", async () => {
  const { executor, calls } = makeExecutor({ getSelectorByIndex: () => "#email" });
  const result = await executor.execute(
    normalizeActionModel({ input: { index: 2, text: "追加", clear: false } }),
  );

  assert.equal(result.success, true);
  assert.equal(calls.fill.length, 0);
  assert.deepEqual(calls.keys, ["type:追加"]);
});

test("执行器: done 分发 —— success 决定 extracted_content", async () => {
  const { executor } = makeExecutor();
  const ok = await executor.execute(normalizeActionModel({ done: { message: "全部完成" } }));
  assert.deepEqual(
    { success: ok.success, message: ok.message, extracted_content: ok.extracted_content },
    { success: true, message: "全部完成", extracted_content: "全部完成" },
  );

  const failed = await executor.execute(normalizeActionModel({ done: { message: "失败收场", success: false } }));
  assert.equal(failed.success, false);
  assert.equal(failed.extracted_content, null);
  assert.equal(ActionExecutor.isDoneAction(normalizeActionModel({ done: { message: "x" } })), true);
  assert.equal(ActionExecutor.getDoneResult(normalizeActionModel({ done: { message: "x" } })), "x");
  assert.equal(ActionExecutor.isDoneAction(normalizeActionModel({ click: { index: 1 } })), false);
  assert.equal(ActionExecutor.getDoneResult(normalizeActionModel({ click: { index: 1 } })), null);
});

test("执行器: 空动作模型 → `无效的动作`；未知动作名 → `未知动作: xxx`", async () => {
  const { executor } = makeExecutor();

  const empty = await executor.execute({});
  assert.deepEqual(empty, {
    success: false,
    message: "",
    error: "无效的动作",
    extracted_content: null,
    duration_ms: 0,
  });

  const unknown = await executor.executeRaw("fly", { speed: 1 });
  assert.deepEqual(unknown, {
    success: false,
    message: "",
    error: "未知动作: fly",
    extracted_content: null,
    duration_ms: 0,
  });
});

test("执行器: 缺必需参数时被 catch 成 error 结果", async () => {
  const { executor } = makeExecutor();

  const noUrl = await executor.executeRaw("navigate", {});
  assert.equal(noUrl.success, false);
  assert.equal(noUrl.error, "缺少必需参数: url");

  const noKey = await executor.executeRaw("press_key", {});
  assert.equal(noKey.success, false);
  assert.equal(noKey.error, "缺少必需参数: key");

  // DOM 服务缺失时，click 直接返回「DOM 服务不可用」
  const { page } = fakePage();
  const noDom = new ActionExecutor({ page });
  const r = await noDom.executeRaw("click", { index: 1 });
  assert.equal(r.success, false);
  assert.equal(r.error, "DOM 服务不可用");
});

test("执行器: executeBatch 遇到 done 停止", async () => {
  const { executor, calls } = makeExecutor();
  const results = await executor.executeBatch([
    normalizeActionModel({ navigate: { url: "https://ok.example/1" } }),
    normalizeActionModel({ done: { message: "收工" } }),
    normalizeActionModel({ navigate: { url: "https://ok.example/2" } }),
  ]);

  assert.equal(results.length, 2);
  assert.equal(calls.goto.length, 1, "done 之后的动作不再执行");
});

test("执行器: executeBatch 的 stopOnError —— 默认继续，开启后遇错即停", async () => {
  const actions = () => [
    normalizeActionModel({ navigate: { url: "https://boom.example/" } }),
    normalizeActionModel({ navigate: { url: "https://ok.example/after" } }),
  ];

  // 默认 stopOnError=false：失败后仍执行后续动作
  const keepGoing = makeExecutor();
  const r1 = await keepGoing.executor.executeBatch(actions());
  assert.equal(r1.length, 2);
  assert.equal(r1[0].success, false);
  assert.equal(r1[1].success, true);
  assert.deepEqual(
    keepGoing.calls.goto.map((c) => c.url),
    ["https://boom.example/", "https://ok.example/after"],
  );

  // stopOnError=true：第一条失败后直接停
  const stopping = makeExecutor();
  const r2 = await stopping.executor.executeBatch(actions(), { stopOnError: true });
  assert.equal(r2.length, 1);
  assert.equal(r2[0].success, false);
  assert.equal(r2[0].error, "导航炸了");
  assert.deepEqual(
    stopping.calls.goto.map((c) => c.url),
    ["https://boom.example/"],
  );
});

// ==================== 5. 消息管理器（Agent 的上下文来源） ====================

test("MessageManager: 系统消息置顶、裁剪与 token 估算", () => {
  const mm = new MessageManager({ maxMessages: 2 });
  mm.addSystemMessage("你是助手");
  mm.addUserMessage("第一条");
  mm.addAssistantMessage("回应一");
  mm.addUserMessage("第二条");

  const messages = mm.getMessages();
  assert.equal(messages[0].role, "system");
  assert.equal(messages.length, 3, "系统消息 + 裁剪后 2 条");
  assert.deepEqual(
    messages.slice(1).map((m) => m.content),
    ["回应一", "第二条"],
  );
  assert.equal(mm.messageCount, 2);
  assert.equal(mm.hasSystemMessage, true);

  mm.clear();
  assert.equal(mm.messageCount, 0);
  assert.equal(mm.hasSystemMessage, true, "clear 保留系统消息");
});

test("MessageManager: 带图片的用户消息是多模态块", () => {
  const mm = new MessageManager();
  mm.addUserMessage("看图", "QUJD");
  const [msg] = mm.getMessages();
  assert.equal(msg.role, "user");
  assert.deepEqual(msg.content, [
    { type: "text", text: "看图" },
    { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
  ]);
});

test("MessageManager: estimateTokens 只统计多模态块里的 text，不算图片 url", () => {
  const mm = new MessageManager();
  // 文本 40 字符，图片 base64 串故意做得很长：若把 image_url 也算进去，结果会远大于 10
  mm.addUserMessage("A".repeat(40), "B".repeat(400));
  assert.equal(mm.estimateTokens(), Math.floor(40 / 4));

  // 系统消息与纯文本消息一并计入
  const mm2 = new MessageManager();
  mm2.addSystemMessage("S".repeat(20));
  mm2.addUserMessage("U".repeat(40));
  mm2.addAssistantMessage("A".repeat(60));
  assert.equal(mm2.estimateTokens(), Math.floor((20 + 40 + 60) / 4));
});
