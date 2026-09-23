/**
 * BrowserUse 引擎 - LLM 适配层单测（全离线）
 * 覆盖：三家消息格式转换、围栏剥离、适配器结构化输出/回退、工厂分支
 *
 * 所有适配器都注入假 transport，**不会**加载 ai-sdk，也不发任何网络请求。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AnthropicAdapter,
  DEFAULT_MODELS,
  GEMINI_OPENAI_BASE_URL,
  GoogleAdapter,
  OpenAIAdapter,
  PROVIDER_ALIASES,
  createLlmAdapter,
  createLlmFromConfig,
  extractJsonFromContent,
  normalizeUsage,
  toAnthropicRequest,
  toGoogleHistory,
  toOpenAiMessages,
} from "../src/browseruse/llm/adapters.ts";
import {
  AGENT_OUTPUT_FORMAT,
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
  createUserMessageWithImage,
  messageContentToText,
} from "../src/browseruse/llm/base.ts";

// ==================== 假 transport（唯一的外部依赖出口） ====================

/**
 * 假 LlmTransport：记录收到的请求，按调用序号返回预置响应；
 * 响应项可以是 Error（用于触发结构化输出失败回退）。
 */
function fakeTransport(script) {
  const requests = [];
  return {
    requests,
    async generate(request) {
      requests.push(request);
      const item = script[Math.min(requests.length - 1, script.length - 1)];
      if (item instanceof Error) throw item;
      return item;
    },
  };
}

function rawResponse(overrides = {}) {
  return {
    content: "",
    parsed_raw: null,
    model: "server-model",
    usage: null,
    finish_reason: "",
    ...overrides,
  };
}

const ECHO_FORMAT = { name: "Echo", parse: (data) => data };

const AGENT_JSON = {
  thinking: "想",
  next_goal: "做",
  action: [{ done: { message: "完事", success: true } }],
};

// ==================== 1. 三家消息格式转换 ====================

test("toOpenAiMessages: system 消息留在消息列表里", () => {
  const messages = [
    createSystemMessage("你是助手"),
    createUserMessage("你好"),
    createAssistantMessage("在的"),
  ];
  assert.deepEqual(toOpenAiMessages(messages), [
    { role: "system", content: "你是助手" },
    { role: "user", content: "你好" },
    { role: "assistant", content: "在的" },
  ]);
});

test("toOpenAiMessages: 多模态内容原样透传", () => {
  const messages = [createUserMessageWithImage("看图", "QUJD")];
  assert.deepEqual(toOpenAiMessages(messages), [
    {
      role: "user",
      content: [
        { type: "text", text: "看图" },
        { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
      ],
    },
  ]);
});

test("toAnthropicRequest: system 抽成独立字段，其余进 messages", () => {
  const payload = toAnthropicRequest([
    createSystemMessage("系统提示"),
    createUserMessage("问题"),
    createAssistantMessage("回答"),
  ]);
  assert.equal(payload.system, "系统提示");
  assert.deepEqual(payload.messages, [
    { role: "user", content: "问题" },
    { role: "assistant", content: "回答" },
  ]);
});

test("toAnthropicRequest: 无 system 时为空串；多条 system 后者覆盖前者", () => {
  assert.equal(toAnthropicRequest([createUserMessage("只有用户")]).system, "");
  const payload = toAnthropicRequest([
    createSystemMessage("第一条"),
    createSystemMessage("第二条"),
    createUserMessage("u"),
  ]);
  assert.equal(payload.system, "第二条", "Python 是直接赋值而非拼接");
  assert.equal(payload.messages.length, 1);
});

test("toGoogleHistory: system→system_instruction，assistant→model", () => {
  const payload = toGoogleHistory([
    createSystemMessage("系统指令"),
    createUserMessage("用户说"),
    createAssistantMessage("模型说"),
  ]);
  assert.equal(payload.system_instruction, "系统指令");
  assert.deepEqual(payload.history, [
    { role: "user", parts: ["用户说"] },
    { role: "model", parts: ["模型说"] },
  ]);
});

test("toGoogleHistory: 多模态 list 用换行拼成一段文本", () => {
  const payload = toGoogleHistory([createUserMessageWithImage("描述这张图", "QUJD")]);
  assert.deepEqual(payload.history, [
    { role: "user", parts: ["描述这张图\ndata:image/png;base64,QUJD"] },
  ]);

  // 空 parts 退化成空串
  const empty = toGoogleHistory([{ role: "user", content: [] }]);
  assert.deepEqual(empty.history, [{ role: "user", parts: [""] }]);
});

test("toGoogleHistory: 其他 role 被直接丢弃（Python 的 if/elif 行为）", () => {
  const payload = toGoogleHistory([
    createUserMessage("保留"),
    { role: "tool", content: "丢弃" },
    createAssistantMessage("保留"),
  ]);
  assert.equal(payload.history.length, 2);
  assert.equal(payload.system_instruction, "");
  assert.equal(messageContentToText(["a"]), '["a"]', "非字符串内容走 JSON 序列化");
});

// ==================== 2. 围栏剥离 ====================

test("extractJsonFromContent: ```json 围栏 / 裸 ``` 围栏 / 无围栏", () => {
  assert.equal(extractJsonFromContent('这是结果：\n```json\n{"a":1}\n```\n结束'), '{"a":1}');
  assert.equal(extractJsonFromContent('```\n{"b":2}\n```'), '{"b":2}');
  assert.equal(extractJsonFromContent('{"c":3}'), '{"c":3}');
});

// Python 的 "...```".split("```") 得到 2 个元素，[1] 是空串，不会 IndexError；
// 真正的失败发生在随后的 json.loads("")。TS 侧 split 结果一致，JSON.parse("") 抛错，
// 两边都落到同一个 except/catch → parsed 为 None/null。
test("extractJsonFromContent: 只有一个围栏时得到空串（后续 JSON 解析才会失败）", () => {
  assert.equal(extractJsonFromContent("尾部只有一个围栏 ```"), "");
});

// ==================== 3. 适配器行为 ====================

test("OpenAIAdapter: 结构化输出成功路径", async () => {
  const transport = fakeTransport([
    rawResponse({
      content: "{}",
      parsed_raw: AGENT_JSON,
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      finish_reason: "stop",
    }),
  ]);
  const adapter = new OpenAIAdapter({ model: "gpt-4o", api_key: "k", transport });

  const result = await adapter.ainvoke([createUserMessage("hi")], AGENT_OUTPUT_FORMAT);

  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0].provider, "openai");
  assert.equal(transport.requests[0].structured_output, true);
  assert.equal(transport.requests[0].response_format_name, "AgentOutput");
  assert.equal(result.parsed.thinking, "想");
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.equal(result.finish_reason, "stop");
  assert.equal(result.model, "server-model");
});

test("OpenAIAdapter: 结构化输出失败 → 回退普通调用 + JSON 解析", async () => {
  const logs = [];
  const transport = fakeTransport([
    new Error("SDK 不支持"),
    rawResponse({ content: JSON.stringify(AGENT_JSON) }),
  ]);
  const adapter = new OpenAIAdapter({ api_key: "k", transport, log: (m) => logs.push(m) });

  const result = await adapter.ainvoke([createUserMessage("hi")], AGENT_OUTPUT_FORMAT);

  assert.equal(transport.requests.length, 2);
  assert.equal(transport.requests[0].structured_output, true);
  assert.equal(transport.requests[1].structured_output, false);
  assert.equal(transport.requests[1].json_object_mode, true, "回退时启用 json_object 模式");
  assert.equal(result.parsed.next_goal, "做");
  assert.match(logs[0], /^结构化输出失败，尝试普通调用: /);
});

test("OpenAIAdapter: 无 responseFormat 时不解析，usage 缺失补 0", async () => {
  const transport = fakeTransport([rawResponse({ content: "纯文本回复" })]);
  const adapter = new OpenAIAdapter({ api_key: "k", transport });

  const result = await adapter.ainvoke([createUserMessage("hi")]);

  assert.equal(transport.requests[0].response_format_name, null);
  assert.equal(result.content, "纯文本回复");
  assert.equal(result.parsed, null);
  assert.deepEqual(result.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test("AnthropicAdapter: system 抽出 + 围栏剥离，total_tokens 为两者之和", async () => {
  const transport = fakeTransport([
    rawResponse({
      content: "好的：\n```json\n" + JSON.stringify(AGENT_JSON) + "\n```",
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 999 },
    }),
  ]);
  const adapter = new AnthropicAdapter({ api_key: "k", transport });

  const result = await adapter.ainvoke(
    [createSystemMessage("系统"), createUserMessage("问")],
    AGENT_OUTPUT_FORMAT,
  );

  assert.equal(transport.requests[0].provider, "anthropic");
  assert.equal(transport.requests[0].system, "系统");
  assert.deepEqual(transport.requests[0].messages, [{ role: "user", content: "问" }]);
  assert.equal(result.parsed.thinking, "想");
  assert.deepEqual(result.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
});

test("AnthropicAdapter: JSON 解析失败只记日志，parsed 保持 null", async () => {
  const logs = [];
  const transport = fakeTransport([rawResponse({ content: "抱歉我不会输出 JSON" })]);
  const adapter = new AnthropicAdapter({ api_key: "k", transport, log: (m) => logs.push(m) });

  const result = await adapter.ainvoke([createUserMessage("问")], ECHO_FORMAT);

  assert.equal(result.parsed, null);
  assert.equal(result.content, "抱歉我不会输出 JSON");
  assert.match(logs[0], /^JSON 解析失败: /);
});

test("GoogleAdapter: 请求带 system_instruction/response_mime_type，响应字段固定", async () => {
  const transport = fakeTransport([
    rawResponse({ content: JSON.stringify({ ok: 1 }), model: "忽略", finish_reason: "length" }),
  ]);
  const adapter = new GoogleAdapter({ model: "gemini-2.0-flash", api_key: "k", transport });

  const result = await adapter.ainvoke(
    [createSystemMessage("系统"), createUserMessage("问")],
    ECHO_FORMAT,
  );

  assert.equal(transport.requests[0].provider, "google");
  assert.equal(transport.requests[0].system_instruction, "系统");
  assert.equal(transport.requests[0].response_mime_type, "application/json");
  assert.deepEqual(transport.requests[0].history, [{ role: "user", parts: ["问"] }]);
  assert.deepEqual(result.parsed, { ok: 1 });
  assert.equal(result.model, "gemini-2.0-flash", "Python 固定返回 self.model");
  assert.deepEqual(result.usage, {});
  assert.equal(result.finish_reason, "stop", "Python 固定返回 stop");
});

test("normalizeUsage: 缺字段一律补 0", () => {
  assert.deepEqual(normalizeUsage(null), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  assert.deepEqual(normalizeUsage({ prompt_tokens: 3 }), {
    prompt_tokens: 3,
    completion_tokens: 0,
    total_tokens: 0,
  });
});

// ==================== 4. 工厂分支 ====================

test("createLlmAdapter: openai / azure 分支", () => {
  const openai = createLlmAdapter({ provider: "openai", api_key: "k", transport: fakeTransport([]) });
  assert.ok(openai instanceof OpenAIAdapter);
  assert.equal(openai.model, DEFAULT_MODELS["openai"]);
  assert.equal(openai.base_url, null);

  const azure = createLlmAdapter({ provider: "azure", api_key: "k", base_url: "https://azure.example/v1" });
  assert.ok(azure instanceof OpenAIAdapter);
  assert.equal(azure.model, "gpt-4o", "azure 不在 DEFAULT_MODELS 里，兜底 gpt-4o");
  assert.equal(azure.base_url, "https://azure.example/v1");
});

test("createLlmAdapter: anthropic 分支使用默认模型", () => {
  const adapter = createLlmAdapter({ provider: "anthropic", api_key: "k" });
  assert.ok(adapter instanceof AnthropicAdapter);
  assert.equal(adapter.model, "claude-sonnet-4-20250514");
  assert.equal(DEFAULT_MODELS["anthropic"], "claude-sonnet-4-20250514");
});

test("createLlmAdapter: google / gemini 别名都走 OpenAI 兼容端点", () => {
  assert.equal(PROVIDER_ALIASES["gemini"], "google");

  const google = createLlmAdapter({ provider: "google", api_key: "k" });
  assert.ok(google instanceof OpenAIAdapter, "Python 的 google 分支返回的就是 OpenAIAdapter");
  assert.equal(google.model, "gemini-2.0-flash");
  assert.equal(google.base_url, GEMINI_OPENAI_BASE_URL);

  const gemini = createLlmAdapter({ provider: "gemini", api_key: "k" });
  assert.ok(gemini instanceof OpenAIAdapter);
  assert.equal(gemini.base_url, GEMINI_OPENAI_BASE_URL);
});

test("createLlmAdapter: model_name 形如 provider/model 时拆分", () => {
  const a = createLlmAdapter({ model_name: "anthropic/claude-3-5-haiku", api_key: "k" });
  assert.ok(a instanceof AnthropicAdapter);
  assert.equal(a.model, "claude-3-5-haiku");

  const b = createLlmAdapter({ model_name: "gpt-4o-mini", api_key: "k" });
  assert.ok(b instanceof OpenAIAdapter);
  assert.equal(b.model, "gpt-4o-mini", "不含 `/` 时整体当成模型名，provider 兜底 openai");
});

test("createLlmAdapter: 不支持的 provider 抛错", () => {
  assert.throws(
    () => createLlmAdapter({ provider: "cohere", api_key: "k" }),
    /不支持的 LLM 提供商: cohere\. 支持的提供商: openai, anthropic, google/,
  );
});

test("createLlmFromConfig: 有配置源时按配置建适配器", () => {
  const config = {
    getDefaultProvider: () => "anthropic",
    getProviderApiKey: () => "cfg-key",
    getProviderModel: () => "claude-x",
    getProviderBaseUrl: () => "https://anthropic.example",
  };
  const adapter = createLlmFromConfig(config);
  assert.ok(adapter instanceof AnthropicAdapter);
  assert.equal(adapter.model, "claude-x");
  assert.equal(adapter.api_key, "cfg-key");
  assert.equal(adapter.base_url, "https://anthropic.example");
});

test("createLlmFromConfig: 无配置源时回退环境变量并打日志", () => {
  const saved = {
    MODEL_NAME: process.env["MODEL_NAME"],
    MODEL_API_KEY: process.env["MODEL_API_KEY"],
    MODEL_BASE_URL: process.env["MODEL_BASE_URL"],
  };
  process.env["MODEL_NAME"] = "openai/gpt-4o-mini";
  process.env["MODEL_API_KEY"] = "env-key";
  process.env["MODEL_BASE_URL"] = "https://env.example/v1";
  try {
    const logs = [];
    const adapter = createLlmFromConfig(null, { log: (m) => logs.push(m) });
    assert.deepEqual(logs, ["ConfigManager 不可用，使用环境变量配置"]);
    assert.ok(adapter instanceof OpenAIAdapter);
    assert.equal(adapter.model, "gpt-4o-mini");
    assert.equal(adapter.api_key, "env-key");
    assert.equal(adapter.base_url, "https://env.example/v1");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
