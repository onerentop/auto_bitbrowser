/**
 * BrowserUse Engine - 统一引擎协议（Node 重写）
 * 对标 core/browseruse_engine/protocol.py
 *
 * BrowserUseEngine 与 StagehandGoogleEngine 都实现此协议，两者可互换。
 *
 * 移植约定（与 engine/types.ts 一致）：
 *   - dataclass 字段一律**必需**，默认值由 createXxx() 工厂提供
 *   - 字段名保留 Python 的 snake_case（duration_ms 等），便于逐字对拍
 */

/** 操作状态 —— 对标 protocol.py 的 OperationStatus */
export type OperationStatus = "success" | "failed" | "partial" | "timeout" | "blocked";
export const OperationStatusValues = {
  SUCCESS: "success",
  FAILED: "failed",
  PARTIAL: "partial",
  TIMEOUT: "timeout",
  BLOCKED: "blocked",
} as const;

/** 导航结果 */
export interface NavigationResult {
  success: boolean;
  url: string;
  final_url: string | null;
  error: string | null;
  duration_ms: number;
}

export function createNavigationResult(overrides: Partial<NavigationResult> = {}): NavigationResult {
  const base: NavigationResult = {
    success: false,
    url: "",
    final_url: null,
    error: null,
    duration_ms: 0,
  };
  return applyOverrides(base, overrides);
}

/** 动作执行结果 */
export interface ActionResult {
  success: boolean;
  message: string;
  error: string | null;
  extracted_content: string | null;
  duration_ms: number;
}

export function createActionResult(overrides: Partial<ActionResult> = {}): ActionResult {
  const base: ActionResult = {
    success: false,
    message: "",
    error: null,
    extracted_content: null,
    duration_ms: 0,
  };
  return applyOverrides(base, overrides);
}

/** 数据提取结果 */
export interface ExtractResult<T = Record<string, unknown>> {
  success: boolean;
  data: T | null;
  error: string | null;
  duration_ms: number;
}

export function createExtractResult<T = Record<string, unknown>>(
  overrides: Partial<ExtractResult<T>> = {},
): ExtractResult<T> {
  const base: ExtractResult<T> = {
    success: false,
    data: null,
    error: null,
    duration_ms: 0,
  };
  return applyOverrides(base, overrides);
}

/** 页面观察结果 */
export interface ObserveResult {
  success: boolean;
  elements: Record<string, unknown>[];
  error: string | null;
  duration_ms: number;
}

export function createObserveResult(overrides: Partial<ObserveResult> = {}): ObserveResult {
  const base: ObserveResult = {
    success: false,
    elements: [],
    error: null,
    duration_ms: 0,
  };
  return applyOverrides(base, overrides);
}

/** Agent 执行步骤记录 */
export interface AgentStep {
  step_number: number;
  thinking: string;
  action_name: string;
  action_params: Record<string, unknown>;
  result: ActionResult | null;
  browser_url: string;
  timestamp: number;
}

export function createAgentStep(overrides: Partial<AgentStep> = {}): AgentStep {
  const base: AgentStep = {
    step_number: 0,
    thinking: "",
    action_name: "",
    action_params: {},
    result: null,
    browser_url: "",
    timestamp: 0,
  };
  return applyOverrides(base, overrides);
}

/** Agent 任务执行结果 */
export interface AgentResult {
  success: boolean;
  message: string;
  error: string | null;
  extracted_content: string | null;
  steps: AgentStep[];
  total_steps: number;
  duration_ms: number;
}

export function createAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  const base: AgentResult = {
    success: false,
    message: "",
    error: null,
    extracted_content: null,
    steps: [],
    total_steps: 0,
    duration_ms: 0,
  };
  return applyOverrides(base, overrides);
}

/** 覆盖时跳过 undefined，等价于 Python 的「不传即取默认」 */
function applyOverrides<T extends object>(base: T, overrides: Partial<T>): T {
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (base as unknown as Record<string, unknown>)[k] = v;
  }
  return base;
}

/** 导航参数（Python 的 wait_until / timeout 关键字参数） */
export interface NavigateOptions {
  waitUntil?: string;
  /** 毫秒；对应 Python 的 timeout */
  timeoutMs?: number;
}

/**
 * AI 浏览器引擎统一协议 —— 对标 protocol.py 的 EngineProtocol。
 *
 * Python 用 runtime_checkable Protocol + isinstance 检查；
 * TS 侧改为结构化接口，一致性在编译期由 `satisfies` 断言保证
 * （见 engine.ts 末尾的 __protocolConformance）。
 */
export interface EngineProtocol {
  readonly isInitialized: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  navigate(url: string, options?: NavigateOptions): Promise<NavigationResult>;
  act(instruction: string, timeoutMs?: number): Promise<ActionResult>;
  extract<T = Record<string, unknown>>(
    instruction: string,
    schema?: unknown,
    options?: { timeoutMs?: number; maxSteps?: number },
  ): Promise<ExtractResult<T>>;
  observe(instruction: string, timeoutMs?: number): Promise<ObserveResult>;
  run(
    task: string,
    options?: { maxSteps?: number; onStep?: (step: Record<string, unknown>) => void },
  ): Promise<AgentResult>;
}

/**
 * 检查对象是否实现了 EngineProtocol —— 对标 protocol.py 的 is_engine()。
 * Python 靠 runtime_checkable 只校验方法存在性，这里做同样的鸭子检查。
 */
export function isEngine(obj: unknown): boolean {
  if (obj === null || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  const methods = ["start", "stop", "navigate", "act", "extract", "observe", "run"];
  return methods.every((m) => typeof o[m] === "function");
}
