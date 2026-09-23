/**
 * BrowserUse Engine - Agent 模块（Node 重写）
 * 对标 core/browseruse_engine/agent/__init__.py
 *
 * 提供 Agent 循环调度和状态管理。
 *
 * 移植说明：Python 的 __all__ 白名单 → 显式 re-export。
 * dataclass 对应的工厂函数与 @property 对应的纯函数是 TS 侧新增的必要导出，
 * 一并放出，Python 侧没有对应条目。
 */

// 服务
export { AgentService } from "./service.ts";
export type { AgentServiceOptions, AgentRunOptions } from "./service.ts";

// 消息管理
export { MessageManager } from "./message-manager.ts";
export type { MessageManagerOptions } from "./message-manager.ts";

// 视图模型
export {
  AgentStatusValues,
  createAgentState,
  createStepResult,
  createAgentRunResult,
  agentRunResultToDict,
  agentProgress,
  isAgentRunning,
  isAgentCompleted,
  isStepSuccess,
  isStepDone,
  getStepDoneMessage,
} from "./views.ts";
export type { AgentState, AgentStatus, StepResult, AgentRunResult } from "./views.ts";

// 提示词
export { PromptManager, getPromptManager, getSystemPrompt, PROMPTS_DIR } from "./prompts.ts";
export type {
  PromptManagerOptions,
  GetSystemPromptOptions,
  GetUserPromptOptions,
} from "./prompts.ts";
