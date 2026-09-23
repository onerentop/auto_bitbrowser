/**
 * BrowserUse Engine - Agent 视图模型（Node 重写）
 * 对标 core/browseruse_engine/agent/views.py
 *
 * 移植说明：
 *   - Python Enum AgentStatus → 字符串字面量联合 + AgentStatusValues 常量对象（与 types.ts 一致）
 *   - Python dataclass → TS 接口（字段全必需）+ createXxx() 工厂（默认值放工厂里）
 *   - @property（is_running / progress / success / is_done / done_message）→ 独立的纯函数，
 *     因为接口没有方法体；语义逐字照搬
 *   - AgentRunResult.__bool__ 在 TS 无对应语法，直接读 .success，不另造函数
 *
 * 注意：主要的 AgentOutput 等模型定义在 ../types.ts 中。
 */

import type { AgentOutput, AgentHistory, BrowserState } from "../types.ts";
import type { ActionResult } from "../protocol.ts";

/** Agent 状态 */
export type AgentStatus = "idle" | "running" | "paused" | "completed" | "failed" | "stopped";

export const AgentStatusValues = {
  IDLE: "idle",
  RUNNING: "running",
  PAUSED: "paused",
  COMPLETED: "completed",
  FAILED: "failed",
  STOPPED: "stopped",
} as const;

/** Agent 当前状态 —— 包含 Agent 的运行时状态信息 */
export interface AgentState {
  status: AgentStatus;
  current_step: number;
  max_steps: number;
  task: string;
  /** 当前浏览器状态 */
  browser_state: BrowserState | null;
  /** 最后的输出 */
  last_output: AgentOutput | null;
  last_results: ActionResult[];
  /** 历史 */
  history: AgentHistory | null;
  /** 错误信息 */
  error: string | null;
}

export function createAgentState(overrides: Partial<AgentState> = {}): AgentState {
  const base: AgentState = {
    status: AgentStatusValues.IDLE,
    current_step: 0,
    max_steps: 50,
    task: "",
    browser_state: null,
    last_output: null,
    last_results: [],
    history: null,
    error: null,
  };
  return applyOverrides(base, overrides);
}

/** 对标 AgentState.is_running */
export function isAgentRunning(state: AgentState): boolean {
  return state.status === AgentStatusValues.RUNNING;
}

/** 对标 AgentState.is_completed */
export function isAgentCompleted(state: AgentState): boolean {
  return (
    state.status === AgentStatusValues.COMPLETED ||
    state.status === AgentStatusValues.FAILED ||
    state.status === AgentStatusValues.STOPPED
  );
}

/** 进度 (0-1) —— 对标 AgentState.progress */
export function agentProgress(state: AgentState): number {
  if (state.max_steps <= 0) {
    return 0.0;
  }
  return Math.min(state.current_step / state.max_steps, 1.0);
}

/** 单步执行结果 —— 包含一个完整步骤的所有信息 */
export interface StepResult {
  step_number: number;
  agent_output: AgentOutput | null;
  action_results: ActionResult[];
  browser_state_before: BrowserState | null;
  browser_state_after: BrowserState | null;
  error: string | null;
  duration_ms: number;
}

export function createStepResult(
  overrides: Partial<StepResult> & { step_number: number },
): StepResult {
  const base: StepResult = {
    step_number: overrides.step_number,
    agent_output: null,
    action_results: [],
    browser_state_before: null,
    browser_state_after: null,
    error: null,
    duration_ms: 0.0,
  };
  return applyOverrides(base, overrides);
}

/** 步骤是否成功 —— 对标 StepResult.success */
export function isStepSuccess(step: StepResult): boolean {
  if (step.error) {
    return false;
  }
  if (step.action_results.length === 0) {
    return true;
  }
  return step.action_results.every((r) => r.success);
}

/** 是否包含 done 动作 —— 对标 StepResult.is_done */
export function isStepDone(step: StepResult): boolean {
  if (step.agent_output && step.agent_output.action.length > 0) {
    for (const action of step.agent_output.action) {
      if (action.done !== undefined && action.done !== null) {
        return true;
      }
    }
  }
  return false;
}

/** 获取 done 动作的消息 —— 对标 StepResult.done_message */
export function getStepDoneMessage(step: StepResult): string | null {
  if (step.agent_output && step.agent_output.action.length > 0) {
    for (const action of step.agent_output.action) {
      if (action.done !== undefined && action.done !== null) {
        return action.done.message;
      }
    }
  }
  return null;
}

/** Agent 运行结果 —— 完整任务执行的最终结果 */
export interface AgentRunResult {
  success: boolean;
  message: string;
  error: string | null;
  /** 提取的内容 */
  extracted_content: string | null;
  /** 执行统计 */
  total_steps: number;
  total_actions: number;
  duration_ms: number;
  /** 详细历史 */
  steps: StepResult[];
  /** 最终状态 */
  final_url: string;
  final_state: AgentState | null;
}

export function createAgentRunResult(
  overrides: Partial<AgentRunResult> & { success: boolean },
): AgentRunResult {
  const base: AgentRunResult = {
    success: overrides.success,
    message: "",
    error: null,
    extracted_content: null,
    total_steps: 0,
    total_actions: 0,
    duration_ms: 0.0,
    steps: [],
    final_url: "",
    final_state: null,
  };
  return applyOverrides(base, overrides);
}

/** 转换为字典 —— 对标 AgentRunResult.to_dict()，键顺序逐字一致 */
export function agentRunResultToDict(result: AgentRunResult): Record<string, unknown> {
  return {
    success: result.success,
    message: result.message,
    error: result.error,
    extracted_content: result.extracted_content,
    total_steps: result.total_steps,
    total_actions: result.total_actions,
    duration_ms: result.duration_ms,
    final_url: result.final_url,
  };
}

/** 覆盖时跳过 undefined，等价于 Python 的「不传即取默认」 */
function applyOverrides<T extends object>(base: T, overrides: Partial<T>): T {
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (base as Record<string, unknown>)[k] = v;
  }
  return base;
}
