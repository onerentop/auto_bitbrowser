/**
 * BrowserUse 引擎 - 核心数据层单测（全离线）
 * 覆盖：常量与 Python 对齐、动作模型归一化、AgentOutput 解析、
 *       DOM 文本序列化、DomService 的索引→选择器/坐标映射
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FAMILY_INVITE_URL,
  FAMILY_DETAILS_URL,
  GMAIL_URL,
  CREATE_FAMILY_KEYWORDS,
  FAMILY_FULL_KEYWORDS,
  INVITE_SENT_KEYWORDS,
  JOIN_SUCCESS_KEYWORDS,
  ALREADY_IN_FAMILY_KEYWORDS,
  FAMILY_MEMBERS_KEYWORDS,
  matchesAnyKeyword,
} from "../src/browseruse/constants.ts";
import {
  ACTION_TYPE_ORDER,
  DOM_ELEMENT_ATTR_ORDER,
  createAgentHistory,
  createAgentStepRecord,
  createBrowserState,
  createDomElement,
  createDomTree,
  formatDomElement,
  getActionParams,
  getActionType,
  getDomElement,
  getHistoryDescription,
  getStateDescription,
  normalizeActionModel,
  parseAgentOutput,
  rectCenter,
  serializeDomTree,
} from "../src/browseruse/types.ts";
import { DOMSerializer, serializeDom } from "../src/browseruse/dom/serializer.ts";
import { DomService } from "../src/browseruse/dom/service.ts";
import { isEngine, createAgentResult, createNavigationResult } from "../src/browseruse/protocol.ts";

// ==================== 假页面（全离线，不碰 playwright / 网络） ====================

/**
 * 假 Playwright Page：evaluate 返回预置的「注入脚本结果」，
 * 其余方法只记录调用，不做任何真实 IO。
 */
function fakePage(extractResult, opts = {}) {
  const calls = { evaluate: [], goto: [], click: [], fill: [], mouse: [], keys: [] };
  const page = {
    url: () => opts.url ?? "https://page.example/home",
    title: async () => opts.title ?? "示例页面",
    goto: async (url, options) => {
      calls.goto.push({ url, options });
    },
    evaluate: async (fn, arg) => {
      calls.evaluate.push({ fn, arg });
      if (opts.evaluateThrows) throw new Error("evaluate boom");
      return extractResult;
    },
    click: async (selector, options) => {
      calls.click.push({ selector, options });
    },
    fill: async (selector, value, options) => {
      calls.fill.push({ selector, value, options });
    },
    screenshot: async () => new Uint8Array([1, 2, 3]),
    innerText: async () => opts.innerText ?? "body text",
    goBack: async () => {},
    viewportSize: () => ({ width: 1280, height: 720 }),
    mouse: {
      click: async (x, y) => {
        calls.mouse.push([x, y]);
      },
    },
    keyboard: {
      press: async (key) => {
        calls.keys.push(key);
      },
      type: async (text) => {
        calls.keys.push(text);
      },
    },
    context: () => ({ pages: () => [page] }),
  };
  return { page, calls };
}

const SAMPLE_EXTRACT = {
  elements: [
    {
      index: 1,
      tag_name: "input",
      text: "Enter email",
      role: "textbox",
      attributes: { placeholder: "Enter email" },
      is_interactive: true,
      is_visible: true,
      bounding_box: { x: 10, y: 20, width: 100, height: 40 },
      selector: "#email",
      center_x: 60,
      center_y: 40,
    },
    {
      index: 2,
      tag_name: "button",
      text: "Send",
      role: "button",
      attributes: {},
      is_interactive: true,
      is_visible: true,
      bounding_box: { x: 0, y: 0, width: 50, height: 20 },
      selector: "button.send",
      center_x: 25,
      center_y: 10,
    },
    {
      // selector 为空串 —— 验证 get_selector 的 `or` 回退语义
      index: 3,
      tag_name: "div",
      text: "",
      role: "",
      attributes: {},
      bounding_box: null,
      selector: "",
      center_x: 5,
      center_y: 6,
    },
  ],
  page_url: "https://page.example/home",
  page_title: "示例页面",
  viewport: { width: 1280, height: 720 },
  scroll_position: { x: 0, y: 0 },
};

// ==================== 1. 常量与 Python 侧逐条对齐 ====================
// 期望值全部硬编码自 core/browseruse_engine/operations/join_family.py

test("常量: 三个 URL 与 join_family.py L19-21 一致", () => {
  assert.equal(FAMILY_INVITE_URL, "https://myaccount.google.com/family/invitemembers");
  assert.equal(FAMILY_DETAILS_URL, "https://families.google.com/families");
  assert.equal(GMAIL_URL, "https://mail.google.com");
});

test("常量: CREATE_FAMILY_KEYWORDS 内容与顺序对齐 Python L268-285", () => {
  assert.deepEqual(
    [...CREATE_FAMILY_KEYWORDS],
    [
      "create a family",
      "create family",
      "create a family group",
      "bring your family together",
      "start a family",
      "no family group",
      "you don't have a family",
      "get more with a family group",
      "crear un grupo familiar",
      "comenzar",
      "创建家庭",
      "创建家庭组",
      "创建家庭群组",
    ],
  );
});

test("常量: FAMILY_FULL_KEYWORDS 内容与顺序对齐 Python L317-323", () => {
  assert.deepEqual(
    [...FAMILY_FULL_KEYWORDS],
    ["family is full", "已达上限", "maximum members", "6 members", "no more members"],
  );
});

test("常量: INVITE_SENT_KEYWORDS 内容与顺序对齐 Python L331-338", () => {
  assert.deepEqual(
    [...INVITE_SENT_KEYWORDS],
    ["invitation sent", "invite sent", "已发送邀请", "邀请已发送", "pending", "待处理"],
  );
});

test("常量: JOIN_SUCCESS_KEYWORDS 内容与顺序对齐 Python L372-379", () => {
  assert.deepEqual(
    [...JOIN_SUCCESS_KEYWORDS],
    ["welcome", "欢迎", "joined", "已加入", "family members", "家庭成员"],
  );
});

test("常量: already_in / family_members 判定词对齐 Python L384、L395", () => {
  assert.deepEqual([...ALREADY_IN_FAMILY_KEYWORDS], ["already in", "已在"]);
  assert.deepEqual([...FAMILY_MEMBERS_KEYWORDS], ["family members", "家庭成员"]);
  assert.equal(matchesAnyKeyword("you are already in a family".toLowerCase(), ALREADY_IN_FAMILY_KEYWORDS), true);
  assert.equal(matchesAnyKeyword("nothing matches here", ALREADY_IN_FAMILY_KEYWORDS), false);
});

// ==================== 2. 动作模型归一化 ====================

test("normalizeActionModel: 缺省字段补默认值（input.clear / scroll / wait / done）", () => {
  const a = normalizeActionModel({ input: { index: 2, text: "hi" } });
  assert.deepEqual(a.input, { index: 2, text: "hi", clear: true });

  const b = normalizeActionModel({ scroll: {} });
  assert.deepEqual(b.scroll, { direction: "down", amount: 0.5 });

  const c = normalizeActionModel({ wait: {} });
  assert.deepEqual(c.wait, { milliseconds: 1000 });

  const d = normalizeActionModel({ done: { message: "ok" } });
  assert.deepEqual(d.done, { message: "ok", success: true });

  const e = normalizeActionModel({ screenshot: {} });
  assert.deepEqual(e.screenshot, { filename: null });
});

test("normalizeActionModel: 缺必填字段返回 null（等价 pydantic 校验失败）", () => {
  assert.equal(normalizeActionModel({ navigate: {} }), null);
  assert.equal(normalizeActionModel({ click: {} }), null);
  assert.equal(normalizeActionModel({ input: { index: 1 } }), null);
  assert.equal(normalizeActionModel("not an object"), null);
  assert.equal(normalizeActionModel(null), null);
});

test("getActionType 按固定顺序取首个非空字段，getActionParams 返回副本", () => {
  assert.deepEqual(
    [...ACTION_TYPE_ORDER],
    ["navigate", "click", "input", "scroll", "extract", "screenshot", "wait", "done", "press_key", "go_back"],
  );
  const action = normalizeActionModel({ click: { index: 7 }, navigate: { url: "https://x.io" } });
  assert.equal(getActionType(action), "navigate", "navigate 在检测顺序中更靠前");
  const params = getActionParams(action);
  assert.deepEqual(params, { url: "https://x.io" });
  params.url = "changed";
  assert.equal(action.navigate.url, "https://x.io", "getActionParams 返回的是副本");
  assert.equal(getActionType({}), null);
  assert.deepEqual(getActionParams({}), {});
});

// ==================== 3. AgentOutput 解析 ====================

test("parseAgentOutput: 正常解析并补齐可空字段", () => {
  const out = parseAgentOutput({
    thinking: "想一想",
    next_goal: "点击按钮",
    action: [{ click: { index: 3 } }],
  });
  assert.equal(out.thinking, "想一想");
  assert.equal(out.next_goal, "点击按钮");
  assert.equal(out.evaluation_previous_goal, null);
  assert.equal(out.memory, null);
  assert.deepEqual(out.action[0].click, { index: 3 });
});

test("parseAgentOutput: 缺必填字段或动作非法时抛错", () => {
  assert.throws(() => parseAgentOutput({ next_goal: "x" }), /缺少 thinking/);
  assert.throws(() => parseAgentOutput({ thinking: "x" }), /缺少 next_goal/);
  assert.throws(() => parseAgentOutput("nope"), /不是对象/);
  assert.throws(
    () => parseAgentOutput({ thinking: "a", next_goal: "b", action: [{ navigate: {} }] }),
    /动作字段不合法/,
  );
});

// ==================== 4. DOM 文本序列化 ====================

test("formatDomElement: `*` 新元素前缀 + role 与 tag 同名时省略", () => {
  const el = createDomElement({
    index: 3,
    tag_name: "button",
    text: "Continue",
    role: "button",
    attributes: { type: "submit" },
    is_new: true,
  });
  assert.equal(formatDomElement(el), '*[3] button "Continue" type="submit"');
});

test("formatDomElement: role 与 tag 不同则输出 role=，非新元素无 `*`", () => {
  const el = createDomElement({ index: 1, tag_name: "div", role: "link" });
  assert.equal(formatDomElement(el), "[1] div role=link");
});

test("formatDomElement: 属性顺序固定 placeholder/value/href/type", () => {
  const el = createDomElement({
    index: 2,
    tag_name: "a",
    attributes: { type: "t", href: "h", value: "v", placeholder: "p", name: "忽略" },
  });
  assert.deepEqual([...DOM_ELEMENT_ATTR_ORDER], ["placeholder", "value", "href", "type"]);
  assert.equal(formatDomElement(el), '[2] a placeholder="p" value="v" href="h" type="t"');
});

test("formatDomElement: 文本截断 50 字、属性截断 30 字（无省略号）", () => {
  const el = createDomElement({
    index: 1,
    tag_name: "input",
    text: "A".repeat(60),
    attributes: { placeholder: "B".repeat(40) },
  });
  assert.equal(formatDomElement(el), `[1] input "${"A".repeat(50)}" placeholder="${"B".repeat(30)}"`);
});

test("serializeDomTree: 逐元素换行拼接；getDomElement 按索引取元素", () => {
  const tree = createDomTree({
    elements: [
      createDomElement({ index: 1, tag_name: "button", text: "OK" }),
      createDomElement({ index: 2, tag_name: "a", attributes: { href: "/about" }, is_new: true }),
    ],
  });
  assert.equal(serializeDomTree(tree), '[1] button "OK"\n*[2] a href="/about"');
  assert.equal(getDomElement(tree, 2).tag_name, "a");
  assert.equal(getDomElement(tree, 99), null);
});

test("DOMSerializer: 超长文本/属性补省略号，role 大小写不敏感比较", () => {
  const s = new DOMSerializer();
  const el = createDomElement({
    index: 4,
    tag_name: "input",
    text: "C".repeat(60),
    role: "INPUT",
    attributes: { placeholder: "D".repeat(40) },
  });
  assert.equal(s.serializeElement(el), `[4] input "${"C".repeat(50)}..." placeholder="${"D".repeat(30)}..."`);
});

test("DOMSerializer: 超过 max_elements 追加 `... and N more elements`", () => {
  const tree = createDomTree({
    elements: [1, 2, 3].map((i) => createDomElement({ index: i, tag_name: "button", text: `B${i}` })),
  });
  const s = new DOMSerializer({ max_elements: 2 });
  assert.equal(s.serialize(tree), '[1] button "B1"\n[2] button "B2"\n... and 1 more elements');
  assert.equal(serializeDom(tree, true), '[1] button "B1"\n[2] button "B2"\n[3] button "B3"');
});

test("getStateDescription / getHistoryDescription 文本格式", () => {
  const state = createBrowserState({
    url: "https://x.io",
    title: "T",
    dom_tree: createDomTree({ elements: [createDomElement({ index: 1, tag_name: "button", text: "Go" })] }),
  });
  assert.equal(getStateDescription(state), 'URL: https://x.io\nTitle: T\n\nInteractive Elements (1):\n[1] button "Go"');

  assert.equal(getHistoryDescription(createAgentHistory({ task: "t" })), "No previous actions.");

  const history = createAgentHistory({
    task: "t",
    steps: [
      createAgentStepRecord({
        step_number: 0,
        agent_output: {
          thinking: "t",
          evaluation_previous_goal: null,
          memory: null,
          next_goal: "打开页面",
          action: [normalizeActionModel({ navigate: { url: "https://x.io" } })],
        },
        action_results: [{ success: true, message: "已导航" }],
      }),
    ],
  });
  // 动作参数用 Python dict repr（单引号 + ": " 分隔），与 Python 侧提示词字节一致
  assert.equal(
    getHistoryDescription(history),
    "Step 0:\n  Goal: 打开页面\n  Action 1: navigate {'url': 'https://x.io'}\n  Result: ✓ 已导航",
  );
});

// ==================== 5. DomService 索引映射 ====================

test("DomService.extractDom: 转换元素并标记新元素", async () => {
  const { page } = fakePage(SAMPLE_EXTRACT);
  const svc = new DomService(page);
  const tree = await svc.extractDom();

  assert.equal(tree.elements.length, 3);
  assert.equal(tree.page_url, "https://page.example/home");
  assert.equal(tree.page_title, "示例页面");
  assert.equal(tree.elements[0].is_new, true, "首次提取时全部是新元素");
  assert.deepEqual(tree.elements[0].bounding_box, { x: 10, y: 20, width: 100, height: 40 });
  assert.equal(tree.elements[2].bounding_box, null, "bounding_box 为 null 时不造 Rect");

  // 第二次提取，索引已存在 → is_new 为 false
  const tree2 = await svc.extractDom();
  assert.equal(tree2.elements[0].is_new, false);
  // markNew=false 时一律不标记
  const tree3 = await svc.extractDom(false);
  assert.equal(tree3.elements[0].is_new, false);
});

test("DomService.getSelectorByIndex / getCoordinatesByIndex 按注入结果映射", async () => {
  const { page } = fakePage(SAMPLE_EXTRACT);
  const svc = new DomService(page);

  // 未提取前一律为 null
  assert.equal(svc.getSelectorByIndex(1), null);
  assert.equal(svc.getCoordinatesByIndex(1), null);
  assert.equal(svc.getElementByIndex(1), null);

  await svc.extractDom();

  assert.equal(svc.getSelectorByIndex(1), "#email");
  assert.equal(svc.getSelectorByIndex(2), "button.send");
  assert.equal(svc.getSelectorByIndex(3), null, "空串选择器走 `or` 回退，最终为 null");
  assert.equal(svc.getSelectorByIndex(99), null);

  assert.deepEqual(svc.getCoordinatesByIndex(1), [60, 40]);
  assert.deepEqual(svc.getCoordinatesByIndex(3), [5, 6]);
  assert.equal(svc.getCoordinatesByIndex(99), null);

  assert.equal(svc.getElementByIndex(2).tag_name, "button");
});

test("DomService: 注入脚本抛错时返回空树；getBrowserState 汇总页面信息", async () => {
  const bad = fakePage(SAMPLE_EXTRACT, { evaluateThrows: true });
  const badSvc = new DomService(bad.page);
  const emptyTree = await badSvc.extractDom();
  assert.deepEqual(emptyTree.elements, []);
  assert.equal(emptyTree.page_url, "");

  const ok = fakePage(SAMPLE_EXTRACT);
  const svc = new DomService(ok.page);
  const state = await svc.getBrowserState();
  assert.equal(state.url, "https://page.example/home");
  assert.equal(state.title, "示例页面");
  assert.equal(state.screenshot_base64, null, "默认不截图");
  assert.equal(state.dom_tree.elements.length, 3);
  assert.equal(state.tabs.length, 1);

  const withShot = await svc.getBrowserState({ includeScreenshot: true });
  assert.equal(withShot.screenshot_base64, Buffer.from([1, 2, 3]).toString("base64"));
});

// ==================== 6. protocol 工厂 ====================

test("protocol: 工厂补默认值，isEngine 做鸭子检查", () => {
  assert.deepEqual(createNavigationResult({ success: true, url: "u" }), {
    success: true,
    url: "u",
    final_url: null,
    error: null,
    duration_ms: 0,
  });
  assert.deepEqual(createAgentResult().steps, []);
  assert.equal(isEngine({}), false);
  assert.equal(isEngine(null), false);
  const fake = {};
  for (const m of ["start", "stop", "navigate", "act", "extract", "observe", "run"]) fake[m] = () => {};
  assert.equal(isEngine(fake), true);
  assert.deepEqual(rectCenter({ x: 10, y: 20, width: 100, height: 40 }), [60, 40]);
});
