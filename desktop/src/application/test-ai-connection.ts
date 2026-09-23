/**
 * 测试 AI 提供商连接（Node 重写）
 * 对标 gui/setting_interface.py:24-124 的 TestAIConnectionWorker
 *
 * Python 用 openai / anthropic 官方 SDK；这里直接发 HTTP（fetch 可注入，便于离线测试），
 * 请求内容与 SDK 实际发出的一致：
 *   - gemini（OpenAI 兼容）：POST {base}/chat/completions，Authorization: Bearer
 *   - anthropic：POST {base 去掉末尾 /v1}/v1/messages，x-api-key + anthropic-version
 *
 * 有意偏差：Python 的 SDK 超时是 30s；桌面端主进程转发请求也有 30s 超时，
 * 若 HTTP 恰好也等满 30s，界面会先收到 TIMEOUT 而看不到真正的失败原因，
 * 因此这里把 HTTP 超时设为 25s。
 */

/** 对标 _DEFAULT_BASE_URLS（setting_interface.py:28-31） */
export const TEST_AI_DEFAULT_BASE_URLS: Readonly<Record<string, string>> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  anthropic: "https://api.anthropic.com",
};

/** 对标 _DEFAULT_MODELS（setting_interface.py:32-35） */
export const TEST_AI_DEFAULT_MODELS: Readonly<Record<string, string>> = {
  gemini: "gemini-2.0-flash",
  anthropic: "claude-sonnet-4-20250514",
};

/** 见文件头：25s 而非 Python 的 30s（有意偏差） */
export const TEST_AI_TIMEOUT_MS = 25_000;

export const TEST_AI_PROMPT = "Hi, reply with OK";
export const TEST_AI_MAX_TOKENS = 10;
export const ANTHROPIC_VERSION = "2023-06-01";

export interface TestAiConnectionInput {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider: string;
}

export interface TestAiConnectionResult {
  success: boolean;
  message: string;
  details: {
    provider?: string;
    model?: string;
    response_time_ms?: number;
    response_preview?: string;
    error?: string;
  };
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface TestAiConnectionDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: {
    model: string;
    messages: Array<{ role: "user"; content: string }>;
    max_tokens: number;
  };
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/** OpenAI SDK 把 base_url 视为目录，拼上 chat/completions */
export function buildOpenAiCompatRequest(apiKey: string, baseUrl: string, model: string): BuiltRequest {
  return {
    url: `${stripTrailingSlashes(baseUrl)}/chat/completions`,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: {
      model,
      messages: [{ role: "user", content: TEST_AI_PROMPT }],
      max_tokens: TEST_AI_MAX_TOKENS,
    },
  };
}

/** 照搬 setting_interface.py:100-103：base_url 末尾不需要 /v1（SDK 会自动拼接） */
export function buildAnthropicRequest(apiKey: string, baseUrl: string, model: string): BuiltRequest {
  let base = stripTrailingSlashes(baseUrl);
  if (base.endsWith("/v1")) base = base.slice(0, -3);
  return {
    url: `${base}/v1/messages`,
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: {
      model,
      messages: [{ role: "user", content: TEST_AI_PROMPT }],
      max_tokens: TEST_AI_MAX_TOKENS,
    },
  };
}

function errText(error: unknown, timeoutMs: number): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return `请求超时（${Math.round(timeoutMs / 1000)}s）`;
    }
    return error.message;
  }
  return String(error);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 从响应体里取文本：OpenAI 取 choices[0].message.content，Anthropic 取 content[0].text */
function extractPreview(provider: string, data: unknown): string {
  if (!isRecord(data)) return "";
  if (provider === "anthropic") {
    const content = data["content"];
    if (Array.isArray(content) && isRecord(content[0]) && typeof content[0]["text"] === "string") {
      return content[0]["text"].trim();
    }
    return "";
  }
  const choices = data["choices"];
  if (Array.isArray(choices) && isRecord(choices[0])) {
    const msg = choices[0]["message"];
    if (isRecord(msg) && typeof msg["content"] === "string") return msg["content"].trim();
  }
  return "";
}

/** 对标 TestAIConnectionWorker.run（setting_interface.py:44-63）；永不抛错 */
export async function testAiConnection(
  input: TestAiConnectionInput,
  deps: TestAiConnectionDeps = {},
): Promise<TestAiConnectionResult> {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? TEST_AI_TIMEOUT_MS;
  const provider = input.provider;

  try {
    if (!input.apiKey) {
      return { success: false, message: "请输入 API Key", details: {} };
    }

    const baseUrl = input.baseUrl || TEST_AI_DEFAULT_BASE_URLS[provider] || "";
    const model = input.model || TEST_AI_DEFAULT_MODELS[provider] || "";

    if (!baseUrl) {
      return { success: false, message: `未知提供商 '${provider}'，请手动填写 Base URL`, details: {} };
    }

    const req =
      provider === "anthropic"
        ? buildAnthropicRequest(input.apiKey, baseUrl, model)
        : buildOpenAiCompatRequest(input.apiKey, baseUrl, model);

    const start = now();
    const res = await fetchImpl(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const elapsedMs = Math.trunc(now() - start);

    if (!res.ok) {
      // 对标 SDK 抛出的 APIStatusError：「Error code: 401 - {...}」
      const body = text.length > 300 ? `${text.slice(0, 300)}...` : text;
      const msg = `Error code: ${res.status} - ${body}`;
      return { success: false, message: `测试失败: ${msg}`, details: { error: msg } };
    }

    let data: unknown = null;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      const msg = "响应不是合法的 JSON";
      return { success: false, message: `测试失败: ${msg}`, details: { error: msg } };
    }

    const content = extractPreview(provider, data);
    const actualModel = isRecord(data) && typeof data["model"] === "string" ? data["model"] : model;

    return {
      success: true,
      message: "连接测试成功",
      details: {
        provider,
        model: actualModel,
        response_time_ms: elapsedMs,
        response_preview: content.slice(0, 100),
      },
    };
  } catch (error) {
    const msg = errText(error, timeoutMs);
    return { success: false, message: `测试失败: ${msg}`, details: { error: msg } };
  }
}
