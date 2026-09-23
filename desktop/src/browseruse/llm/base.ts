/**
 * BrowserUse Engine - LLM 基础协议（Node 重写）
 * 对标 core/browseruse_engine/llm/base.py
 *
 * 移植约定（与 browseruse/types.ts、engine/types.ts 一致）：
 *   - Python 的 dataclass → TS 接口 + createXxx() 工厂（字段全必需，工厂给默认值）
 *   - 字段名保留 Python 的 snake_case（finish_reason / prompt_tokens），便于逐字对拍
 *   - Python 的 Protocol（runtime_checkable）→ TS 接口，编译期结构化匹配
 *
 * 与 Python 的差异：
 *   1. SystemMessage/UserMessage/AssistantMessage 在 Python 里是三个 dataclass 子类，
 *      适配器用 isinstance() 判定；TS 里是**按 role 字段判别的联合类型**，
 *      判定函数 isSystemMessage() 看的是 role === "system"。
 *      后果：手工构造 { role: "system", content } 的裸 BaseMessage 在 TS 侧会被当成
 *      系统消息，Python 侧则不会（isinstance 为 False）。实际调用方都走工厂函数，无差异。
 *   2. BaseChatModel.invoke()（Python 的同步版，内部 asyncio.run）**不移植**：
 *      Node 没有「在同步函数里跑完一个 Promise」的等价物，强行实现只能阻塞事件循环。
 *      所有调用点都用 ainvoke()。
 *   3. response_format 在 Python 里是 pydantic 类（既当 schema 又当构造器），
 *      TS 里用 ResponseFormatSpec 描述符表达（name + parse）。
 */

import { parseAgentOutput, type AgentOutput } from "../types.ts";

// ==================== 消息类型 ====================

/** 多模态消息的单个内容块（对应 Python 的 Dict[str, Any]） */
export type MessageContentPart = Record<string, unknown>;

/** 消息内容：纯文本或多模态块列表 —— 对应 Union[str, List[Dict[str, Any]]] */
export type MessageContent = string | MessageContentPart[];

/** 消息基类 */
export interface BaseMessage {
  role: string;
  content: MessageContent;
}

/** 系统消息 */
export interface SystemMessage extends BaseMessage {
  role: "system";
  content: string;
}

/** 用户消息 */
export interface UserMessage extends BaseMessage {
  role: "user";
}

/** 助手消息 */
export interface AssistantMessage extends BaseMessage {
  role: "assistant";
  content: string;
}

/** 对标 BaseMessage.to_dict() */
export function messageToDict(msg: BaseMessage): { role: string; content: MessageContent } {
  return { role: msg.role, content: msg.content };
}

/** 对标 SystemMessage(content) */
export function createSystemMessage(content: string): SystemMessage {
  return { role: "system", content };
}

/** 对标 UserMessage(content) */
export function createUserMessage(content: MessageContent): UserMessage {
  return { role: "user", content };
}

/** 对标 UserMessage.with_image() —— 图片块格式逐字照搬 */
export function createUserMessageWithImage(text: string, imageBase64: string): UserMessage {
  const content: MessageContentPart[] = [
    { type: "text", text },
    {
      type: "image_url",
      image_url: { url: `data:image/png;base64,${imageBase64}` },
    },
  ];
  return { role: "user", content };
}

/** 对标 AssistantMessage(content) */
export function createAssistantMessage(content: string): AssistantMessage {
  return { role: "assistant", content };
}

/** 对标 Python 的 isinstance(msg, SystemMessage)（差异见文件头第 1 条） */
export function isSystemMessage(msg: BaseMessage): msg is SystemMessage {
  return msg.role === "system";
}

/**
 * 把消息内容规整成字符串。
 * 对标 Python 的 `msg.content if isinstance(msg.content, str) else str(msg.content)`。
 * 差异：Python 的 str(list) 是 repr（单引号），这里用 JSON.stringify（双引号）。
 * 只影响「内容本该是字符串却传了列表」这种异常路径的文本呈现，不影响判定逻辑。
 */
export function messageContentToText(content: MessageContent): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

// ==================== 响应类型 ====================

/** 聊天完成响应 —— 对标 ChatCompletion dataclass */
export interface ChatCompletion {
  content: string;
  /** 解析后的结构化对象 */
  parsed: unknown;
  model: string;
  usage: Record<string, number>;
  finish_reason: string;
}

export function createChatCompletion(
  overrides: Partial<ChatCompletion> & { content: string },
): ChatCompletion {
  const base: ChatCompletion = {
    content: overrides.content,
    parsed: null,
    model: "",
    usage: {},
    finish_reason: "",
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (base as unknown as Record<string, unknown>)[k] = v;
  }
  return base;
}

// ==================== 结构化输出描述符 ====================

/**
 * 对标 Python 传给 ainvoke 的 `response_format: Type[T]`（pydantic 模型类）。
 * pydantic 类同时承担「schema 名字」和「构造 + 校验」两件事，
 * TS 里拆成 name（给日志/SDK 用）与 parse（校验失败必须抛错，语义同 pydantic）。
 */
export interface ResponseFormatSpec<T = unknown> {
  name: string;
  parse(data: unknown): T;
}

/** AgentOutput 的结构化输出描述符 —— 对应 Python 直接传 AgentOutput 类 */
export const AGENT_OUTPUT_FORMAT: ResponseFormatSpec<AgentOutput> = {
  name: "AgentOutput",
  parse: (data: unknown): AgentOutput => parseAgentOutput(data),
};

// ==================== LLM 协议 ====================

/**
 * LLM 聊天模型协议 —— 对标 BaseChatModel Protocol
 *
 * 参数名用 camelCase（responseFormat / maxTokens），因为它们是函数形参而非
 * 需要对拍的数据字段；ChatCompletion 里的数据字段仍保持 snake_case。
 */
export interface BaseChatModel {
  model: string;

  ainvoke(
    messages: BaseMessage[],
    responseFormat?: ResponseFormatSpec | null,
    temperature?: number | null,
    maxTokens?: number | null,
  ): Promise<ChatCompletion>;
}
