/**
 * BrowserUse Engine - LLM 模块（Node 重写）
 * 对标 core/browseruse_engine/llm/__init__.py
 *
 * 只做 re-export。Python 的 __all__ 列了 6 + 5 个名字，这里在其基础上
 * 额外导出 Node 侧特有的 transport/纯函数类型（Python 没有对应物，
 * 因为它直接用三家官方 SDK，没有可注入的传输层抽象）。
 */

// 协议和消息类型
export {
  AGENT_OUTPUT_FORMAT,
  createAssistantMessage,
  createChatCompletion,
  createSystemMessage,
  createUserMessage,
  createUserMessageWithImage,
  isSystemMessage,
  messageContentToText,
  messageToDict,
  type AssistantMessage,
  type BaseChatModel,
  type BaseMessage,
  type ChatCompletion,
  type MessageContent,
  type MessageContentPart,
  type ResponseFormatSpec,
  type SystemMessage,
  type UserMessage,
} from "./base.ts";

// 适配器 + 工厂函数 + 传输层
export {
  AnthropicAdapter,
  createAiSdkTransport,
  createLlmAdapter,
  createLlmFromConfig,
  DEFAULT_MODELS,
  extractJsonFromContent,
  GEMINI_OPENAI_BASE_URL,
  GoogleAdapter,
  normalizeUsage,
  OpenAIAdapter,
  PROVIDER_ALIASES,
  toAnthropicRequest,
  toGoogleHistory,
  toOpenAiMessages,
  type AdapterOptions,
  type AnthropicLlmRequest,
  type AnthropicRequestPayload,
  type ChatMessageDict,
  type CreateLlmAdapterOptions,
  type CreateLlmFromConfigOptions,
  type GoogleAdapterOptions,
  type GoogleContent,
  type GoogleHistoryPayload,
  type GoogleLlmRequest,
  type LlmConfigProvider,
  type LlmProviderName,
  type LlmRawResponse,
  type LlmRequest,
  type LlmRequestBase,
  type LlmTransport,
  type OpenAiLlmRequest,
  type TokenUsage,
} from "./adapters.ts";
