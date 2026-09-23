/**
 * BrowserUse Engine - 模块入口（Node 重写）
 * 对标 core/browseruse_engine/__init__.py
 *
 * Python 侧用 `__getattr__` 延迟导入 BrowserUseEngine 以规避循环依赖；
 * TS 侧没有该问题（engine.ts 只单向依赖各子层），直接静态导出。
 */

export const VERSION = "1.0.0";

// 协议与结果类型
export {
  createActionResult,
  createAgentResult,
  createAgentStep,
  createExtractResult,
  createNavigationResult,
  createObserveResult,
  isEngine,
  OperationStatusValues,
  type ActionResult,
  type AgentResult,
  type AgentStep,
  type EngineProtocol,
  type ExtractResult,
  type NavigateOptions,
  type NavigationResult,
  type ObserveResult,
  type OperationStatus,
} from "./protocol.ts";

// 类型定义
export {
  ACTION_TYPE_ORDER,
  ActionTypeValues,
  AGENT_OUTPUT_FIELD_DESCRIPTIONS,
  createAgentConfig,
  createAgentHistory,
  createAgentStepRecord,
  createBrowserState,
  createDomElement,
  createDomTree,
  createJoinFamilyResult,
  createLLMConfig,
  DOM_ELEMENT_ATTR_ORDER,
  formatDomElement,
  getActionParams,
  getActionType,
  getDomElement,
  getHistoryDescription,
  getStateDescription,
  normalizeActionModel,
  parseAgentOutput,
  rectCenter,
  ScrollDirectionValues,
  serializeDomTree,
  type ActionModel,
  type ActionType,
  type AgentConfig,
  type AgentHistory,
  type AgentOutput,
  type AgentStepRecord,
  type BrowserState,
  type ClickAction,
  type DoneAction,
  type DOMElement,
  type DOMTree,
  type ExtractAction,
  type GoBackAction,
  type InputAction,
  type JoinFamilyResult,
  type LLMConfig,
  type NavigateAction,
  type PressKeyAction,
  type Rect,
  type ScreenshotAction,
  type ScrollAction,
  type ScrollDirection,
  type WaitAction,
} from "./types.ts";

// 页面抽象与日志
export { noopLog, type BrowserPageLike, type LogFn } from "./page.ts";

// 常量（URL / 超时 / 关键词）
export * from "./constants.ts";

// LLM 层
export {
  AGENT_OUTPUT_FORMAT,
  createAssistantMessage,
  createChatCompletion,
  createSystemMessage,
  createUserMessage,
  createUserMessageWithImage,
  messageToDict,
  type BaseChatModel,
  type BaseMessage,
  type ChatCompletion,
  type ResponseFormatSpec,
} from "./llm/base.ts";
export {
  createLlmAdapter,
  createLlmFromConfig,
  toAnthropicRequest,
  toGoogleHistory,
  toOpenAiMessages,
  AnthropicAdapter,
  GoogleAdapter,
  OpenAIAdapter,
  type LlmConfigProvider,
  type LlmRequest,
  type LlmRawResponse,
  type LlmTransport,
} from "./llm/adapters.ts";

// DOM / tools / agent 子层
export { DomService } from "./dom/service.ts";
export { DOMSerializer, serializeDom } from "./dom/serializer.ts";
export { ActionExecutor } from "./tools/executor.ts";
export { ActionRegistry, defaultRegistry } from "./tools/registry.ts";
export { AgentService } from "./agent/service.ts";
export { PromptManager, getPromptManager } from "./agent/prompts.ts";
export { MessageManager } from "./agent/message-manager.ts";

// 操作
export {
  ACCEPT_INVITE_TASK,
  CREATE_FAMILY_TASK,
  GMAIL_POPUP_TASK,
  JoinFamilyOperation,
  SEND_INVITE_TASK_TEMPLATE,
  buildSendInviteTask,
  checkInviteSent,
  checkNeedsCreateFamily,
  type JoinFamilyEngine,
} from "./operations/join-family.ts";

// 主引擎
export {
  BrowserUseEngine,
  createEngine,
  createEngineFromConfig,
  withEngine,
  type BrowserUseEngineOptions,
  type ConnectToIxBrowserOptions,
} from "./engine.ts";
export {
  createPlaywrightConnector,
  type CdpConnection,
  type CdpConnector,
} from "./playwright-cdp.ts";

// ==================== 编译期协议一致性断言 ====================

import type { ProDetectEngine } from "../automation/pro-status-detector.ts";
import type { EngineProtocol as _EngineProtocol } from "./protocol.ts";
import { BrowserUseEngine as _BrowserUseEngine } from "./engine.ts";
import { StagehandGoogleEngine as _StagehandGoogleEngine } from "../engine/stagehand-engine.ts";

/**
 * 证明 BrowserUseEngine **同时**满足统一引擎协议与 pro-status-detector 的 ProDetectEngine。
 *
 * Python 侧靠 `runtime_checkable Protocol` + `isinstance` 在运行期检查；
 * TS 侧把这件事提前到编译期：本函数只要签名不匹配，`pnpm typecheck` 立刻失败。
 * 这也是「BrowserUse 移植后可无缝接入 checkProStatusWithEngine」的机器可验证证据。
 */
export function assertEngineConformance(
  engine: _BrowserUseEngine,
): _EngineProtocol & ProDetectEngine {
  return engine;
}

/** 同一断言施加于 Stagehand 引擎的 ProDetectEngine 侧，确保两引擎在同一接口下可互换 */
export function assertStagehandProDetectConformance(
  engine: _StagehandGoogleEngine,
): ProDetectEngine {
  return engine;
}
