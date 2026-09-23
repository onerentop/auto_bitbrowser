/**
 * BrowserUse Engine - LLM 适配器（Node 重写）
 * 对标 core/browseruse_engine/llm/adapters.py
 *
 * 结构与 Python 一一对应：OpenAIAdapter / AnthropicAdapter / GoogleAdapter
 * + create_llm_adapter / create_llm_from_config。默认模型名、provider 别名表、
 * base_url 兜底值、错误文案、工厂函数的分支顺序全部逐字照搬。
 *
 * 与 Python 的结构性差异（逐条说明原因）：
 *   1. 三家官方 SDK（openai / anthropic / google-generativeai）不引入，
 *      底层统一走 ai-sdk（ai + @ai-sdk/*）。为了让适配器可离线单测，
 *      HTTP 调用被抽到 LlmTransport 接口后面：构造参数可注入 transport，
 *      不注入时才**惰性**创建默认的 ai-sdk transport（用变量说明符 import()，
 *      模块顶层绝不 import ai-sdk，测试加载本文件不会去解析这些依赖）。
 *   2. 消息格式转换从 ainvoke 里抽成三个导出的纯函数
 *      （toOpenAiMessages / toAnthropicRequest / toGoogleHistory），
 *      转换规则逐字对齐 Python，便于离线断言。
 *   3. invoke()（Python 的同步版，内部 asyncio.run）不移植，见 base.ts 文件头。
 *   4. logger.warning → 注入的 LogFn（默认 noopLog），日志文案与 Python 一致。
 *   5. create_llm_from_config 的 Python 版直接 import ConfigManager；
 *      Node 侧没有 ConfigManager，改为接收 LlmConfigProvider 参数，
 *      不传（或传 null）时走 Python 的 ImportError 分支：环境变量兜底。
 *   6. Python 的 google 分支实际走的是 **OpenAI 兼容端点**
 *      （https://generativelanguage.googleapis.com/v1beta/openai + OpenAIAdapter），
 *      GoogleAdapter 类反而没被工厂用到。这是 Python 现状，照搬不"修正"。
 */

import { noopLog, type LogFn } from "../page.ts";
import {
  createChatCompletion,
  isSystemMessage,
  messageContentToText,
  messageToDict,
  type BaseChatModel,
  type BaseMessage,
  type ChatCompletion,
  type MessageContent,
  type MessageContentPart,
  type ResponseFormatSpec,
} from "./base.ts";

// ==================== Transport 抽象 ====================

/** 受支持的 provider（工厂函数归一化之后的取值） */
export type LlmProviderName = "openai" | "anthropic" | "google";

/** 消息字典 —— 对应 Python 的 msg.to_dict() 结果 */
export interface ChatMessageDict {
  role: string;
  content: MessageContent;
}

/** Gemini 的一段内容 —— 对应 Python 的 {"role": ..., "parts": [...]} */
export interface GoogleContent {
  role: "user" | "model";
  parts: string[];
}

export interface LlmRequestBase {
  model: string;
  api_key: string;
  base_url: string | null;
  temperature: number;
  max_tokens: number;
  /** 非 null 表示 Python 侧的 `response_format is not None` */
  response_format_name: string | null;
}

export interface OpenAiLlmRequest extends LlmRequestBase {
  provider: "openai";
  messages: ChatMessageDict[];
  /** 对应 client.beta.chat.completions.parse(response_format=Model)；失败后适配器用 false 重试 */
  structured_output: boolean;
  /** 对应回退时的 kwargs["response_format"] = {"type": "json_object"} */
  json_object_mode: boolean;
}

export interface AnthropicLlmRequest extends LlmRequestBase {
  provider: "anthropic";
  /** 空串表示 Python 侧不塞 kwargs["system"] */
  system: string;
  messages: ChatMessageDict[];
}

export interface GoogleLlmRequest extends LlmRequestBase {
  provider: "google";
  /** 空串表示 Python 侧不重建带 system_instruction 的 GenerativeModel */
  system_instruction: string;
  history: GoogleContent[];
  /** 对应 generation_config["response_mime_type"]；max_tokens 对应 max_output_tokens */
  response_mime_type: string | null;
}

export type LlmRequest = OpenAiLlmRequest | AnthropicLlmRequest | GoogleLlmRequest;

/** SDK 原始响应的归一化形态 */
export interface LlmRawResponse {
  content: string;
  /** SDK 已经解析好的结构化对象（只有 OpenAI 结构化输出路径会非空） */
  parsed_raw: unknown;
  model: string;
  usage: Record<string, number> | null;
  finish_reason: string;
}

/** 底层 HTTP 调用抽象 —— 测试注入假实现即可全程离线 */
export interface LlmTransport {
  generate(request: LlmRequest): Promise<LlmRawResponse>;
}

/** token 用量 —— 字段名保留 Python 的 snake_case */
export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * 对应 Python 里那串 `response.usage.prompt_tokens if response.usage else 0`。
 * transport 没给 usage（或缺字段）时一律补 0。
 */
export function normalizeUsage(usage?: Record<string, number> | null): TokenUsage {
  const u = usage ?? {};
  return {
    prompt_tokens: u["prompt_tokens"] ?? 0,
    completion_tokens: u["completion_tokens"] ?? 0,
    total_tokens: u["total_tokens"] ?? 0,
  };
}

/** 异常文本化 —— 对应 Python f-string 里的 {e} */
function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readEnv(name: string): string {
  return process.env[name] ?? "";
}

// ==================== 消息格式转换（纯函数，无 IO） ====================

/**
 * OpenAI：直接把每条消息 to_dict() 展开，system 消息**留在**消息列表里。
 * 对标 `api_messages = [msg.to_dict() for msg in messages]`。
 */
export function toOpenAiMessages(messages: BaseMessage[]): ChatMessageDict[] {
  return messages.map((msg) => messageToDict(msg));
}

/** toAnthropicRequest 的返回形态 */
export interface AnthropicRequestPayload {
  /** 空串表示没有系统消息 */
  system: string;
  messages: ChatMessageDict[];
}

/**
 * Anthropic：分离出 system 字符串，其余消息进 messages。
 * 对标 AnthropicAdapter.ainvoke 里的那段 for 循环——多条系统消息时
 * **后者覆盖前者**（Python 是直接赋值，不是拼接），照搬。
 */
export function toAnthropicRequest(messages: BaseMessage[]): AnthropicRequestPayload {
  let system = "";
  const apiMessages: ChatMessageDict[] = [];
  for (const msg of messages) {
    if (isSystemMessage(msg)) {
      system = messageContentToText(msg.content);
    } else {
      apiMessages.push(messageToDict(msg));
    }
  }
  return { system, messages: apiMessages };
}

/** toGoogleHistory 的返回形态 */
export interface GoogleHistoryPayload {
  /** 空串表示没有系统指令 */
  system_instruction: string;
  history: GoogleContent[];
}

/**
 * Google：system 抽成 system_instruction，user 保留、assistant 变 "model"。
 * 多模态 list 内容按 Python 规则拼成一段文本：
 *   type=="text" 取 item["text"]，type=="image_url" 取 item["image_url"]["url"]，
 *   再 "\n".join；parts 为空时退化成 ""。
 * 其他 role（既非 system/user/assistant）被直接丢弃 —— Python 的 if/elif 就是这样。
 */
export function toGoogleHistory(messages: BaseMessage[]): GoogleHistoryPayload {
  const history: GoogleContent[] = [];
  let systemInstruction = "";

  for (const msg of messages) {
    if (isSystemMessage(msg)) {
      systemInstruction = messageContentToText(msg.content);
    } else if (msg.role === "user") {
      let content: string;
      if (Array.isArray(msg.content)) {
        const parts: string[] = [];
        for (const item of msg.content as MessageContentPart[]) {
          if (item["type"] === "text") {
            parts.push(String(item["text"]));
          } else if (item["type"] === "image_url") {
            // Gemini 需要不同的图片格式处理（Python 原注释）：这里只把 url 当文本塞进去
            const imageUrl = item["image_url"] as { url?: unknown } | undefined;
            parts.push(String(imageUrl?.url));
          }
        }
        content = parts.length > 0 ? parts.join("\n") : "";
      } else {
        content = msg.content;
      }
      history.push({ role: "user", parts: [content] });
    } else if (msg.role === "assistant") {
      history.push({ role: "model", parts: [messageContentToText(msg.content)] });
    }
  }

  return { system_instruction: systemInstruction, history };
}

/**
 * 从模型回复里抠出 JSON 文本 —— 对标 AnthropicAdapter 的围栏剥离逻辑。
 * 逐字照搬 Python，包括两处可疑写法（均保留，不"修正"）：
 *   - `content.split("```")[1].split("```")[0]` 的第二次 split 是空操作；
 *   - 只有一个 ``` 围栏时，Python 的 split 得到 2 段、取 [1] 是空串，
 *     真正的失败发生在随后的 `json.loads("")`，被外层 except 吞掉 → parsed=None。
 *     TS 里同样得到空串并交给 JSON.parse("") 抛错，落到同一个 catch，结果一致。
 */
export function extractJsonFromContent(content: string): string {
  if (content.includes("```json")) {
    const after = content.split("```json")[1] ?? "";
    return (after.split("```")[0] ?? "").trim();
  }
  if (content.includes("```")) {
    const segment = content.split("```")[1] ?? "";
    return (segment.split("```")[0] ?? "").trim();
  }
  return content;
}

// ==================== OpenAI 适配器 ====================

export interface AdapterOptions {
  model?: string;
  api_key?: string | null;
  base_url?: string | null;
  temperature?: number;
  max_tokens?: number;
  /** 注入底层调用实现；不传则惰性创建默认的 ai-sdk transport */
  transport?: LlmTransport | null;
  /** 对应 Python 的 logger.warning */
  log?: LogFn | null;
}

/**
 * OpenAI API 适配器
 *
 * 支持 OpenAI API 及兼容接口 (如 Azure OpenAI, 第三方代理等)。
 */
export class OpenAIAdapter implements BaseChatModel {
  model: string;
  api_key: string;
  base_url: string | null;
  temperature: number;
  max_tokens: number;

  private _transport: LlmTransport | null;
  private readonly _log: LogFn;

  constructor(options: AdapterOptions = {}) {
    this.model = options.model ?? "gpt-4o";
    this.api_key = options.api_key || readEnv("OPENAI_API_KEY");
    this.base_url = options.base_url ?? null;
    this.temperature = options.temperature ?? 0.0;
    this.max_tokens = options.max_tokens ?? 4096;
    this._transport = options.transport ?? null;
    this._log = options.log ?? noopLog;
  }

  /** 对标 _get_client()：首次调用时才创建，之后缓存 */
  async getTransport(): Promise<LlmTransport> {
    if (this._transport === null) {
      this._transport = await createAiSdkTransport();
    }
    return this._transport;
  }

  async ainvoke(
    messages: BaseMessage[],
    responseFormat: ResponseFormatSpec | null = null,
    temperature: number | null = null,
    maxTokens: number | null = null,
  ): Promise<ChatCompletion> {
    const transport = await this.getTransport();

    // 转换消息格式
    const apiMessages = toOpenAiMessages(messages);

    // 构建请求参数（`max_tokens or self.max_tokens` 的 0 也会走兜底，用 || 保持一致）
    const request: OpenAiLlmRequest = {
      provider: "openai",
      model: this.model,
      api_key: this.api_key,
      base_url: this.base_url,
      temperature: temperature ?? this.temperature,
      max_tokens: maxTokens || this.max_tokens,
      messages: apiMessages,
      response_format_name: responseFormat ? responseFormat.name : null,
      structured_output: false,
      json_object_mode: false,
    };

    let jsonObjectMode = false;

    // 如果有 response_format，使用结构化输出
    if (responseFormat) {
      try {
        const response = await transport.generate({ ...request, structured_output: true });
        // responseFormat.parse 放在 try 内：pydantic 的校验错误在 Python 里同样
        // 由 SDK 的 parse() 抛出并落进这个 except，从而触发回退。
        const parsed =
          response.parsed_raw === null || response.parsed_raw === undefined
            ? null
            : responseFormat.parse(response.parsed_raw);
        const usage = normalizeUsage(response.usage);
        return createChatCompletion({
          content: response.content || "",
          parsed,
          model: response.model,
          usage: {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
          },
          finish_reason: response.finish_reason || "",
        });
      } catch (e) {
        this._log(`结构化输出失败，尝试普通调用: ${formatError(e)}`);
        // 回退到普通调用 + JSON 解析
        jsonObjectMode = true;
      }
    }

    // 普通调用
    const response = await transport.generate({ ...request, json_object_mode: jsonObjectMode });
    const content = response.content || "";

    // 尝试解析 JSON
    let parsed: unknown = null;
    if (responseFormat && content) {
      try {
        parsed = responseFormat.parse(JSON.parse(content));
      } catch (e) {
        this._log(`JSON 解析失败: ${formatError(e)}`);
      }
    }

    const usage = normalizeUsage(response.usage);
    return createChatCompletion({
      content,
      parsed,
      model: response.model,
      usage: {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
      },
      finish_reason: response.finish_reason || "",
    });
  }
}

// ==================== Anthropic 适配器 ====================

/**
 * Anthropic Claude API 适配器
 */
export class AnthropicAdapter implements BaseChatModel {
  model: string;
  api_key: string;
  base_url: string | null;
  temperature: number;
  max_tokens: number;

  private _transport: LlmTransport | null;
  private readonly _log: LogFn;

  constructor(options: AdapterOptions = {}) {
    this.model = options.model ?? "claude-sonnet-4-20250514";
    this.api_key = options.api_key || readEnv("ANTHROPIC_API_KEY");
    this.base_url = options.base_url ?? null;
    this.temperature = options.temperature ?? 0.0;
    this.max_tokens = options.max_tokens ?? 4096;
    this._transport = options.transport ?? null;
    this._log = options.log ?? noopLog;
  }

  /** 对标 _get_client() */
  async getTransport(): Promise<LlmTransport> {
    if (this._transport === null) {
      this._transport = await createAiSdkTransport();
    }
    return this._transport;
  }

  async ainvoke(
    messages: BaseMessage[],
    responseFormat: ResponseFormatSpec | null = null,
    temperature: number | null = null,
    maxTokens: number | null = null,
  ): Promise<ChatCompletion> {
    const transport = await this.getTransport();

    // 分离系统消息和其他消息
    const payload = toAnthropicRequest(messages);

    const request: AnthropicLlmRequest = {
      provider: "anthropic",
      model: this.model,
      api_key: this.api_key,
      base_url: this.base_url,
      temperature: temperature ?? this.temperature,
      max_tokens: maxTokens || this.max_tokens,
      system: payload.system,
      messages: payload.messages,
      response_format_name: responseFormat ? responseFormat.name : null,
    };

    // 调用 API（Python 这里没有结构化输出模式，只靠下面的围栏剥离 + JSON 解析）
    const response = await transport.generate(request);
    const content = response.content || "";

    // 尝试解析 JSON
    let parsed: unknown = null;
    if (responseFormat && content) {
      try {
        const jsonStr = extractJsonFromContent(content);
        parsed = responseFormat.parse(JSON.parse(jsonStr));
      } catch (e) {
        this._log(`JSON 解析失败: ${formatError(e)}`);
      }
    }

    // Python 用 input_tokens / output_tokens，total 是两者之和（不是 SDK 给的字段）
    const usage = normalizeUsage(response.usage);
    return createChatCompletion({
      content,
      parsed,
      model: response.model,
      usage: {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.prompt_tokens + usage.completion_tokens,
      },
      finish_reason: response.finish_reason || "",
    });
  }
}

// ==================== Google Gemini 适配器 ====================

/** GoogleAdapter 没有 base_url 参数（Python 构造函数就没有） */
export type GoogleAdapterOptions = Omit<AdapterOptions, "base_url">;

/**
 * Google Gemini API 适配器
 *
 * 注意：create_llm_adapter 的 google 分支**不会**用到这个类，
 * 它走的是 OpenAI 兼容端点 + OpenAIAdapter。这里照搬 Python 保留该类。
 */
export class GoogleAdapter implements BaseChatModel {
  model: string;
  api_key: string;
  temperature: number;
  max_tokens: number;

  private _transport: LlmTransport | null;
  private readonly _log: LogFn;

  constructor(options: GoogleAdapterOptions = {}) {
    this.model = options.model ?? "gemini-2.0-flash";
    this.api_key = options.api_key || readEnv("GOOGLE_API_KEY") || readEnv("GEMINI_API_KEY");
    this.temperature = options.temperature ?? 0.0;
    this.max_tokens = options.max_tokens ?? 4096;
    this._transport = options.transport ?? null;
    this._log = options.log ?? noopLog;
  }

  /** 对标 _get_client() */
  async getTransport(): Promise<LlmTransport> {
    if (this._transport === null) {
      this._transport = await createAiSdkTransport();
    }
    return this._transport;
  }

  async ainvoke(
    messages: BaseMessage[],
    responseFormat: ResponseFormatSpec | null = null,
    temperature: number | null = null,
    maxTokens: number | null = null,
  ): Promise<ChatCompletion> {
    const transport = await this.getTransport();

    // 转换消息格式
    const payload = toGoogleHistory(messages);

    const request: GoogleLlmRequest = {
      provider: "google",
      model: this.model,
      api_key: this.api_key,
      base_url: null,
      temperature: temperature ?? this.temperature,
      max_tokens: maxTokens || this.max_tokens,
      system_instruction: payload.system_instruction,
      history: payload.history,
      response_format_name: responseFormat ? responseFormat.name : null,
      response_mime_type: responseFormat ? "application/json" : null,
    };

    const response = await transport.generate(request);
    const content = response.content || "";

    // 尝试解析 JSON（Python 这里不剥围栏，因为已经要求 response_mime_type=json）
    let parsed: unknown = null;
    if (responseFormat && content) {
      try {
        parsed = responseFormat.parse(JSON.parse(content));
      } catch (e) {
        this._log(`JSON 解析失败: ${formatError(e)}`);
      }
    }

    // Python 这里固定返回 self.model / 空 usage / "stop"，不取 SDK 的真实值，照搬
    return createChatCompletion({
      content,
      parsed,
      model: this.model,
      usage: {},
      finish_reason: "stop",
    });
  }
}

// ==================== 默认 transport（ai-sdk，惰性加载） ====================

/**
 * 用变量说明符做动态 import：
 *   - TS 不会对它做静态模块解析，ai-sdk 未安装时不影响本文件 typecheck；
 *   - 只有真正发请求时才加载，测试里注入 transport 就完全不触发。
 */
async function importDynamic(specifier: string): Promise<Record<string, unknown>> {
  const moduleName = specifier;
  return (await import(moduleName)) as Record<string, unknown>;
}

type AnyFn = (...args: unknown[]) => unknown;

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** ai-sdk 结果里的 usage → Python 风格的三件套（v5 用 inputTokens，v4 用 promptTokens） */
function readSdkUsage(result: Record<string, unknown>): TokenUsage {
  const usage = (result["usage"] ?? {}) as Record<string, unknown>;
  const prompt = readNumber(usage["inputTokens"] ?? usage["promptTokens"]);
  const completion = readNumber(usage["outputTokens"] ?? usage["completionTokens"]);
  const total = readNumber(usage["totalTokens"]) || prompt + completion;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function readSdkModelId(result: Record<string, unknown>, fallback: string): string {
  const response = result["response"] as Record<string, unknown> | undefined;
  const modelId = response?.["modelId"];
  return typeof modelId === "string" && modelId ? modelId : fallback;
}

function readSdkFinishReason(result: Record<string, unknown>): string {
  const reason = result["finishReason"];
  return typeof reason === "string" ? reason : "";
}

/** 消息内容 → ai-sdk 的 parts（image_url 块转成 image part） */
function toSdkContent(content: MessageContent): unknown {
  if (typeof content === "string") return content;
  return content.map((item) => {
    if (item["type"] === "image_url") {
      const imageUrl = item["image_url"] as { url?: unknown } | undefined;
      return { type: "image", image: String(imageUrl?.url ?? "") };
    }
    return { type: "text", text: String(item["text"] ?? "") };
  });
}

function toSdkMessages(request: LlmRequest): unknown[] {
  if (request.provider === "google") {
    // history 的 role 是 user/model，ai-sdk 用 user/assistant
    return request.history.map((item) => ({
      role: item.role === "model" ? "assistant" : "user",
      content: item.parts.join("\n"),
    }));
  }
  return request.messages.map((msg) => ({ role: msg.role, content: toSdkContent(msg.content) }));
}

/** 该请求是否需要 JSON 输出（决定用 generateObject 还是 generateText） */
function needsJsonOutput(request: LlmRequest): boolean {
  if (request.provider === "openai") return request.structured_output || request.json_object_mode;
  if (request.provider === "google") return request.response_mime_type === "application/json";
  return false; // anthropic：Python 侧就是普通调用 + 围栏剥离
}

async function resolveSdkModel(request: LlmRequest): Promise<unknown> {
  const settings: Record<string, unknown> = { apiKey: request.api_key };
  if (request.base_url) settings["baseURL"] = request.base_url;

  if (request.provider === "anthropic") {
    const mod = await importDynamic("@ai-sdk/anthropic");
    return (mod["createAnthropic"] as AnyFn)(settings) as unknown as AnyFn;
  }
  if (request.provider === "google") {
    const mod = await importDynamic("@ai-sdk/google");
    return (mod["createGoogleGenerativeAI"] as AnyFn)(settings) as unknown as AnyFn;
  }
  const mod = await importDynamic("@ai-sdk/openai");
  return (mod["createOpenAI"] as AnyFn)(settings) as unknown as AnyFn;
}

/**
 * 默认 transport：ai-sdk 实现。
 *
 * 与 Python 的差异：
 *   - Python 的 OpenAI 结构化输出用 beta.chat.completions.parse(pydantic 类)，
 *     ai-sdk 对应 generateObject；ResponseFormatSpec 没有 schema，
 *     因此用 output:"no-schema"（强制 JSON，但不下发字段约束），
 *     校验仍由 ResponseFormatSpec.parse 完成。
 *   - Python 回退时设 response_format={"type":"json_object"}，
 *     ai-sdk 没有对应的 generateText 开关，这里同样走 generateObject no-schema，
 *     content 用 JSON.stringify(object) 填充。
 *   - Python 的 Gemini system_instruction 是重建 GenerativeModel，
 *     这里映射成 ai-sdk 的 system 参数。
 *
 * 本函数不做联网自测，真机验证留给上层。
 */
export async function createAiSdkTransport(): Promise<LlmTransport> {
  const ai = await importDynamic("ai");
  const generateText = ai["generateText"] as AnyFn;
  const generateObject = ai["generateObject"] as AnyFn;

  return {
    async generate(request: LlmRequest): Promise<LlmRawResponse> {
      const providerFactory = (await resolveSdkModel(request)) as AnyFn;
      const model = providerFactory(request.model);

      const params: Record<string, unknown> = {
        model,
        messages: toSdkMessages(request),
        temperature: request.temperature,
        maxOutputTokens: request.max_tokens,
      };
      if (request.provider === "anthropic" && request.system) params["system"] = request.system;
      if (request.provider === "google" && request.system_instruction) {
        params["system"] = request.system_instruction;
      }

      if (needsJsonOutput(request)) {
        const result = (await generateObject({ ...params, output: "no-schema" })) as Record<string, unknown>;
        const object = result["object"];
        const usage = readSdkUsage(result);
        return {
          content: object === undefined ? "" : JSON.stringify(object),
          parsed_raw: object ?? null,
          model: readSdkModelId(result, request.model),
          usage: { ...usage },
          finish_reason: readSdkFinishReason(result),
        };
      }

      const result = (await generateText(params)) as Record<string, unknown>;
      const usage = readSdkUsage(result);
      return {
        content: typeof result["text"] === "string" ? (result["text"] as string) : "",
        parsed_raw: null,
        model: readSdkModelId(result, request.model),
        usage: { ...usage },
        finish_reason: readSdkFinishReason(result),
      };
    },
  };
}

// ==================== 工厂函数 ====================

/** 提供商别名映射 (ConfigManager 用 "gemini"，适配器用 "google") */
export const PROVIDER_ALIASES: Record<string, string> = { gemini: "google" };

/** 各 provider 的默认模型 —— 与 Python default_models 逐字一致 */
export const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4-20250514",
  google: "gemini-2.0-flash",
};

/** Gemini 的 OpenAI 兼容端点 —— 逐字照搬 Python 的兜底值 */
export const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

export interface CreateLlmAdapterOptions {
  /** LLM 提供商 ("openai", "anthropic", "google") */
  provider?: string | null;
  /** API 密钥 */
  api_key?: string | null;
  /** 模型名称 (如 "gpt-4o") */
  model?: string | null;
  /** API 基础 URL (可选) */
  base_url?: string | null;
  temperature?: number;
  max_tokens?: number;
  /** 完整模型名称 (格式: "provider/model")，用于兼容 */
  model_name?: string | null;
  /** 注入底层调用实现（Python 无此参数，Node 侧为了离线测试） */
  transport?: LlmTransport | null;
  /** 对应 Python 的 logger */
  log?: LogFn | null;
}

/**
 * 创建 LLM 适配器 —— 对标 create_llm_adapter()
 *
 * 支持两种调用方式:
 *   1. createLlmAdapter({ provider: "openai", model: "gpt-4o", api_key: "..." })
 *   2. createLlmAdapter({ model_name: "openai/gpt-4o", api_key: "..." })
 *
 * 差异：Python 是关键字参数，TS 收敛成一个 options 对象；分支顺序与文案照搬。
 * provider 无效时抛 Error（对应 Python 的 ValueError）。
 */
export function createLlmAdapter(options: CreateLlmAdapterOptions = {}): BaseChatModel {
  let provider = options.provider ?? null;
  let model = options.model ?? null;
  const modelName = options.model_name ?? null;
  const apiKey = options.api_key ?? null;
  const baseUrl = options.base_url ?? null;
  const temperature = options.temperature ?? 0.0;
  const maxTokens = options.max_tokens ?? 4096;
  const transport = options.transport ?? null;
  const log = options.log ?? null;

  // 兼容 model_name 参数
  if (modelName && modelName.includes("/")) {
    const splitAt = modelName.indexOf("/");
    const head = modelName.slice(0, splitAt);
    const tail = modelName.slice(splitAt + 1);
    provider = provider || head.toLowerCase();
    model = model || tail;
  } else if (modelName) {
    model = model || modelName;
  }

  // 默认值
  provider = (provider || "openai").toLowerCase();

  // 提供商别名映射 (ConfigManager 用 "gemini"，适配器用 "google")
  provider = PROVIDER_ALIASES[provider] ?? provider;

  // 默认模型
  model = model || (DEFAULT_MODELS[provider] ?? "gpt-4o");

  // 根据 provider 创建适配器
  if (provider === "anthropic") {
    return new AnthropicAdapter({
      model,
      api_key: apiKey,
      base_url: baseUrl,
      temperature,
      max_tokens: maxTokens,
      transport,
      log,
    });
  } else if (provider === "google") {
    // 使用 Gemini 的 OpenAI 兼容端点，无需安装 google-generativeai
    const geminiBaseUrl = baseUrl || GEMINI_OPENAI_BASE_URL;
    const geminiApiKey = apiKey || readEnv("GOOGLE_API_KEY") || readEnv("GEMINI_API_KEY");
    return new OpenAIAdapter({
      model,
      api_key: geminiApiKey,
      base_url: geminiBaseUrl,
      temperature,
      max_tokens: maxTokens,
      transport,
      log,
    });
  } else if (provider === "openai" || provider === "azure") {
    return new OpenAIAdapter({
      model,
      api_key: apiKey,
      base_url: baseUrl,
      temperature,
      max_tokens: maxTokens,
      transport,
      log,
    });
  } else {
    throw new Error(`不支持的 LLM 提供商: ${provider}. 支持的提供商: openai, anthropic, google`);
  }
}

/**
 * AI 配置读取接口 —— 替代 Python 的 ConfigManager。
 * 形状与 automation/pro-status-detector.ts 的 AiConfigProvider 完全一致，
 * 可以直接把那个对象传进来（结构化类型，无需转换）。
 * 这里重新声明而不是跨层 import，避免 browseruse/ 反向依赖 automation/。
 */
export interface LlmConfigProvider {
  getDefaultProvider(): string;
  getProviderApiKey(provider: string): string;
  getProviderModel(provider: string): string;
  getProviderBaseUrl(provider: string): string;
}

export interface CreateLlmFromConfigOptions {
  transport?: LlmTransport | null;
  log?: LogFn | null;
}

/**
 * 从配置创建 LLM 适配器 —— 对标 create_llm_from_config()
 *
 * 差异：Python 内部 `from core.config_manager import ConfigManager`，失败走 ImportError 分支；
 * Node 侧把配置源作为参数注入，config 为 null/undefined 时等价于那条 ImportError 分支
 * （打印「ConfigManager 不可用，使用环境变量配置」并回退环境变量）。
 */
export function createLlmFromConfig(
  config?: LlmConfigProvider | null,
  options: CreateLlmFromConfigOptions = {},
): BaseChatModel {
  const transport = options.transport ?? null;
  const log = options.log ?? null;

  if (config) {
    // 获取配置
    const provider = config.getDefaultProvider() || "google";
    const apiKey = config.getProviderApiKey(provider);
    const model = config.getProviderModel(provider);
    const baseUrl = config.getProviderBaseUrl(provider);

    return createLlmAdapter({
      provider,
      api_key: apiKey,
      model,
      base_url: baseUrl,
      transport,
      log,
    });
  }

  (log ?? noopLog)("ConfigManager 不可用，使用环境变量配置");
  const modelName = process.env["MODEL_NAME"] || "openai/gpt-4o";
  return createLlmAdapter({
    model_name: modelName,
    api_key: process.env["MODEL_API_KEY"] ?? null,
    base_url: process.env["MODEL_BASE_URL"] ?? null,
    transport,
    log,
  });
}
