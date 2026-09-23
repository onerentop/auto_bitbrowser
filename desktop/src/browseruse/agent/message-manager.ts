/**
 * BrowserUse Engine - 消息历史管理器（Node 重写）
 * 对标 core/browseruse_engine/agent/message_manager.py
 *
 * 移植说明：
 *   - Python 的 SystemMessage/UserMessage/AssistantMessage 类实例化 →
 *     ../llm/base.ts 的 createSystemMessage / createUserMessage /
 *     createUserMessageWithImage / createAssistantMessage 工厂
 *   - Python 用 isinstance(msg, UserMessage) 区分消息类型；TS 侧没有类，
 *     改用 msg.role === "user" / "assistant" 判定（语义等价）
 *   - 构造参数 max_messages/max_tokens_estimate → 对象形式的 camelCase 选项，
 *     与 AgentService 的构造风格保持一致；默认值逐字照搬（50 / 100000）
 *   - logger.debug → 注入的 LogFn（默认 noopLog）
 *   - str(content) 在 Node 没有等价 repr，非字符串内容用 JSON.stringify
 *     （只影响 compressHistory 的摘要文本，不影响判定逻辑）
 *   - len() 按 Unicode 码点、String.length 按 UTF-16 码元，
 *     estimateTokens 的字符统计在星形平面字符上会略有差异（本身就是粗估）
 */

import type { BaseMessage } from "../llm/base.ts";
import {
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
  createUserMessageWithImage,
} from "../llm/base.ts";
import { noopLog, type LogFn } from "../page.ts";

export interface MessageManagerOptions {
  /** 最大消息数量 */
  maxMessages?: number;
  /** 估计的最大 token 数 */
  maxTokensEstimate?: number;
  log?: LogFn;
}

/**
 * 消息历史管理器
 *
 * 负责维护 LLM 对话历史，支持：
 * - 消息添加和获取
 * - 历史截断
 * - 上下文压缩
 */
export class MessageManager {
  readonly maxMessages: number;
  readonly maxTokensEstimate: number;
  private readonly log: LogFn;
  private _messages: BaseMessage[] = [];
  private _systemMessage: BaseMessage | null = null;

  constructor(options: MessageManagerOptions = {}) {
    this.maxMessages = options.maxMessages ?? 50;
    this.maxTokensEstimate = options.maxTokensEstimate ?? 100000;
    this.log = options.log ?? noopLog;
  }

  /** 设置系统消息（系统消息始终位于对话开头） */
  addSystemMessage(content: string): void {
    this._systemMessage = createSystemMessage(content);
  }

  /**
   * 添加用户消息
   *
   * @param content 消息内容
   * @param imageBase64 图片 base64 编码 (可选)
   */
  addUserMessage(content: string, imageBase64?: string | null): void {
    let message: BaseMessage;
    if (imageBase64) {
      message = createUserMessageWithImage(content, imageBase64);
    } else {
      message = createUserMessage(content);
    }
    this._messages.push(message);
    this._trimIfNeeded();
  }

  /** 添加助手消息 */
  addAssistantMessage(content: string): void {
    this._messages.push(createAssistantMessage(content));
    this._trimIfNeeded();
  }

  /** 获取完整消息列表（系统消息 + 历史消息） */
  getMessages(): BaseMessage[] {
    const messages: BaseMessage[] = [];
    if (this._systemMessage) {
      messages.push(this._systemMessage);
    }
    messages.push(...this._messages);
    return messages;
  }

  /** 获取最近 n 条消息 */
  getLastNMessages(n: number): BaseMessage[] {
    const messages: BaseMessage[] = [];
    if (this._systemMessage) {
      messages.push(this._systemMessage);
    }
    // Python 的 self._messages[-n:]：n=0 时取全量，slice(-0) 行为一致
    messages.push(...this._messages.slice(-n));
    return messages;
  }

  /** 如果超过限制，裁剪消息 */
  private _trimIfNeeded(): void {
    if (this._messages.length > this.maxMessages) {
      // 保留最近的消息
      const trimCount = this._messages.length - this.maxMessages;
      this._messages = this._messages.slice(trimCount);
      this.log(`裁剪了 ${trimCount} 条消息`);
    }
  }

  /** 清空消息历史 (保留系统消息) */
  clear(): void {
    this._messages = [];
  }

  /**
   * 压缩历史记录：将旧消息压缩为摘要，保留最近的消息。
   *
   * @param keepRecent 保留最近的消息数量
   * @returns 压缩后的摘要
   */
  compressHistory(keepRecent = 10): string {
    if (this._messages.length <= keepRecent) {
      return "";
    }

    // 提取要压缩的消息
    const toCompress = this._messages.slice(0, this._messages.length - keepRecent);
    const kept = this._messages.slice(-keepRecent);

    // 生成摘要 (简单版本)
    const summaryParts: string[] = [];
    for (const msg of toCompress) {
      if (msg.role === "user") {
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        summaryParts.push(`User: ${content.slice(0, 100)}...`);
      } else if (msg.role === "assistant") {
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        summaryParts.push(`Assistant: ${content.slice(0, 100)}...`);
      }
    }

    const summary = summaryParts.slice(-5).join("\n"); // 只保留最后 5 条摘要

    // 更新消息列表
    this._messages = kept;

    return summary;
  }

  /** 消息数量 */
  get messageCount(): number {
    return this._messages.length;
  }

  /** 是否有系统消息 */
  get hasSystemMessage(): boolean {
    return this._systemMessage !== null;
  }

  /**
   * 估计当前消息的 token 数
   *
   * 使用简单的字符数估计 (1 token ≈ 4 字符)
   */
  estimateTokens(): number {
    let totalChars = 0;
    if (this._systemMessage) {
      const content = this._systemMessage.content;
      if (typeof content === "string") {
        totalChars += content.length;
      }
    }

    for (const msg of this._messages) {
      const content = msg.content;
      if (typeof content === "string") {
        totalChars += content.length;
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (item !== null && typeof item === "object" && "text" in item) {
            const text = (item as { text?: unknown }).text;
            if (typeof text === "string") totalChars += text.length;
          }
        }
      }
    }

    return Math.floor(totalChars / 4);
  }
}
