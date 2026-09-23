/**
 * BrowserUse Engine - 类型定义（Node 重写）
 * 对标 core/browseruse_engine/types.py
 *
 * 移植说明：
 *   - Python 的 Enum → 字符串字面量联合 + Values 常量对象（与 engine/types.ts 一致）
 *   - Python 的 pydantic BaseModel → TS 接口 + parse/normalize 函数
 *     （pydantic 会给缺省字段补默认值，这里由 normalizeActionModel 做同一件事）
 *   - Python 的 dataclass 字段一律**必需**，默认值由 createXxx() 工厂提供
 *   - __str__ / serialize / get_*_description 这些文本生成方法是提示词的一部分，
 *     逐字照搬，不做"优化"
 */

// ==================== 枚举类型 ====================

/** 动作类型 */
export type ActionType =
  | "navigate"
  | "click"
  | "input"
  | "scroll"
  | "extract"
  | "screenshot"
  | "wait"
  | "done"
  | "press_key"
  | "go_back";

export const ActionTypeValues = {
  NAVIGATE: "navigate",
  CLICK: "click",
  INPUT: "input",
  SCROLL: "scroll",
  EXTRACT: "extract",
  SCREENSHOT: "screenshot",
  WAIT: "wait",
  DONE: "done",
  PRESS_KEY: "press_key",
  GO_BACK: "go_back",
} as const;

/** 滚动方向 */
export type ScrollDirection = "up" | "down" | "left" | "right";
export const ScrollDirectionValues = {
  UP: "up",
  DOWN: "down",
  LEFT: "left",
  RIGHT: "right",
} as const;

// ==================== 动作模型（对应 pydantic BaseModel） ====================

export interface NavigateAction {
  url: string;
}

export interface ClickAction {
  index: number;
}

export interface InputAction {
  index: number;
  text: string;
  clear: boolean;
}

export interface ScrollAction {
  direction: string;
  amount: number;
}

export interface ExtractAction {
  query: string;
}

export interface ScreenshotAction {
  filename: string | null;
}

export interface WaitAction {
  milliseconds: number;
}

export interface DoneAction {
  message: string;
  success: boolean;
}

export interface PressKeyAction {
  key: string;
}

/** GoBackAction 在 Python 里是空模型（pass） */
export interface GoBackAction {
  [key: string]: never;
}

/** 统一动作模型 —— 每次只会有一个字段非空 */
export interface ActionModel {
  navigate?: NavigateAction | null;
  click?: ClickAction | null;
  input?: InputAction | null;
  scroll?: ScrollAction | null;
  extract?: ExtractAction | null;
  screenshot?: ScreenshotAction | null;
  wait?: WaitAction | null;
  done?: DoneAction | null;
  press_key?: PressKeyAction | null;
  go_back?: GoBackAction | null;
}

/**
 * 动作类型检测顺序 —— 与 Python get_action_type() 的列表逐字一致，顺序不可调换
 */
export const ACTION_TYPE_ORDER: readonly ActionType[] = [
  "navigate",
  "click",
  "input",
  "scroll",
  "extract",
  "screenshot",
  "wait",
  "done",
  "press_key",
  "go_back",
];

/** 获取当前动作类型 —— 对标 ActionModel.get_action_type() */
export function getActionType(action: ActionModel): ActionType | null {
  for (const t of ACTION_TYPE_ORDER) {
    const v = (action as Record<string, unknown>)[t];
    if (v !== undefined && v !== null) return t;
  }
  return null;
}

/** 获取动作参数 —— 对标 ActionModel.get_action_params()（pydantic model_dump） */
export function getActionParams(action: ActionModel): Record<string, unknown> {
  const t = getActionType(action);
  if (!t) return {};
  const v = (action as Record<string, unknown>)[t];
  if (v === undefined || v === null) return {};
  return { ...(v as Record<string, unknown>) };
}

/**
 * 把 LLM 返回的原始动作补齐默认值并做类型强制。
 *
 * 对标 pydantic v2 的 **lax 模式**（Python 侧 `AgentOutput(**data)` 走的就是它）：
 *   - 缺省字段取 Field(default=...)：
 *     InputAction.clear=True / ScrollAction.direction="down",amount=0.5
 *     ScreenshotAction.filename=None / WaitAction.milliseconds=1000 / DoneAction.success=True
 *   - **可转换的类型会被强制**："3" → 3、"true" → true、1 → true
 *     （LLM 把数字写成字符串很常见，Python 侧能正常执行，TS 必须一致）
 *   - 字段存在但无法转换、或必填字段缺失 → 返回 null（等价 pydantic 的 ValidationError）
 */
export function normalizeActionModel(raw: unknown): ActionModel | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const out: ActionModel = {};

  /** 缺失标记：区分「字段没给」与「字段给了但不合法」 */
  const MISSING = Symbol("missing");

  const asStr = (v: unknown): string | null => (typeof v === "string" ? v : null);

  /** 数字强制：number 原样；数字字符串转换；其余不合法 */
  const coerceNum = (v: unknown): number | typeof MISSING | null => {
    if (v === undefined) return MISSING;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string") {
      const s = v.trim();
      if (s === "") return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };

  /** 布尔强制：对齐 pydantic lax 认可的取值集合 */
  const TRUE_WORDS = new Set(["true", "yes", "on", "1", "t", "y"]);
  const FALSE_WORDS = new Set(["false", "no", "off", "0", "f", "n"]);
  const coerceBool = (v: unknown): boolean | typeof MISSING | null => {
    if (v === undefined) return MISSING;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (v === 1) return true;
      if (v === 0) return false;
      return null;
    }
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (TRUE_WORDS.has(s)) return true;
      if (FALSE_WORDS.has(s)) return false;
      return null;
    }
    return null;
  };

  for (const t of ACTION_TYPE_ORDER) {
    const v = o[t];
    if (v === undefined || v === null) continue;
    const p = (typeof v === "object" ? (v as Record<string, unknown>) : {}) as Record<string, unknown>;

    switch (t) {
      case "navigate": {
        const url = asStr(p["url"]);
        if (url === null) return null;
        out.navigate = { url };
        break;
      }
      case "click": {
        const index = coerceNum(p["index"]);
        if (index === MISSING || index === null) return null;
        out.click = { index };
        break;
      }
      case "input": {
        const index = coerceNum(p["index"]);
        const text = asStr(p["text"]);
        if (index === MISSING || index === null || text === null) return null;
        const clear = coerceBool(p["clear"]);
        if (clear === null) return null;
        out.input = { index, text, clear: clear === MISSING ? true : clear };
        break;
      }
      case "scroll": {
        const direction = p["direction"] === undefined ? "down" : asStr(p["direction"]);
        if (direction === null) return null;
        const amount = coerceNum(p["amount"]);
        if (amount === null) return null;
        out.scroll = { direction, amount: amount === MISSING ? 0.5 : amount };
        break;
      }
      case "extract": {
        const query = asStr(p["query"]);
        if (query === null) return null;
        out.extract = { query };
        break;
      }
      case "screenshot": {
        // Python 的 Optional[str]：给了非字符串非 None 才算不合法
        const raw2 = p["filename"];
        if (raw2 !== undefined && raw2 !== null && typeof raw2 !== "string") return null;
        out.screenshot = { filename: asStr(raw2) };
        break;
      }
      case "wait": {
        const ms = coerceNum(p["milliseconds"]);
        if (ms === null) return null;
        // pydantic 的 int 字段对 1000.7 这类小数会报错，这里同样只接受整数值
        if (ms !== MISSING && !Number.isInteger(ms)) return null;
        out.wait = { milliseconds: ms === MISSING ? 1000 : ms };
        break;
      }
      case "done": {
        const message = asStr(p["message"]);
        if (message === null) return null;
        const success = coerceBool(p["success"]);
        if (success === null) return null;
        out.done = { message, success: success === MISSING ? true : success };
        break;
      }
      case "press_key": {
        const key = asStr(p["key"]);
        if (key === null) return null;
        out.press_key = { key };
        break;
      }
      case "go_back": {
        out.go_back = {} as GoBackAction;
        break;
      }
    }
    // Python 的 ActionModel 允许多个字段共存，但 get_action_type 只取第一个；
    // 这里同样保留全部已解析字段，不提前 break。
  }

  return out;
}

// ==================== Agent 输出模型 ====================

/**
 * LLM Agent 输出结构 —— 对标 types.py 的 AgentOutput（pydantic）
 * thinking / next_goal 必填，其余可空
 */
export interface AgentOutput {
  thinking: string;
  evaluation_previous_goal: string | null;
  memory: string | null;
  next_goal: string;
  action: ActionModel[];
}

/** AgentOutput 各字段的 description —— 与 Python Field(description=...) 逐字一致 */
export const AGENT_OUTPUT_FIELD_DESCRIPTIONS: Record<string, string> = {
  thinking: "推理过程：分析当前状态，思考下一步该做什么",
  evaluation_previous_goal: "评估上一步目标是否达成",
  memory: "需要记住的重要信息",
  next_goal: "下一步的具体目标",
  action: "要执行的动作序列（最多3个）",
};

/**
 * 解析 LLM 返回的结构化输出。
 * 对标 pydantic 的 AgentOutput(**data)：缺少必填字段抛错。
 */
export function parseAgentOutput(raw: unknown): AgentOutput {
  if (raw === null || typeof raw !== "object") {
    throw new Error("AgentOutput 解析失败: 不是对象");
  }
  const o = raw as Record<string, unknown>;
  const thinking = o["thinking"];
  const nextGoal = o["next_goal"];
  if (typeof thinking !== "string") throw new Error("AgentOutput 解析失败: 缺少 thinking");
  if (typeof nextGoal !== "string") throw new Error("AgentOutput 解析失败: 缺少 next_goal");

  const rawActions = Array.isArray(o["action"]) ? (o["action"] as unknown[]) : [];
  const actions: ActionModel[] = [];
  for (const a of rawActions) {
    const normalized = normalizeActionModel(a);
    if (normalized === null) throw new Error("AgentOutput 解析失败: 动作字段不合法");
    actions.push(normalized);
  }

  return {
    thinking,
    evaluation_previous_goal:
      typeof o["evaluation_previous_goal"] === "string" ? (o["evaluation_previous_goal"] as string) : null,
    memory: typeof o["memory"] === "string" ? (o["memory"] as string) : null,
    next_goal: nextGoal,
    action: actions,
  };
}

// ==================== DOM 相关类型 ====================

/** 矩形区域 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 矩形中心点 —— 对标 Rect.center 属性 */
export function rectCenter(r: Rect): [number, number] {
  return [r.x + r.width / 2, r.y + r.height / 2];
}

/** DOM 元素 */
export interface DOMElement {
  /** 元素索引 [1], [2], ... */
  index: number;
  tag_name: string;
  text: string;
  role: string;
  attributes: Record<string, string>;
  is_interactive: boolean;
  is_visible: boolean;
  is_new: boolean;
  bounding_box: Rect | null;
  selector: string;
}

export function createDomElement(overrides: Partial<DOMElement> & { index: number; tag_name: string }): DOMElement {
  const base: DOMElement = {
    index: overrides.index,
    tag_name: overrides.tag_name,
    text: "",
    role: "",
    attributes: {},
    is_interactive: true,
    is_visible: true,
    is_new: false,
    bounding_box: null,
    selector: "",
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (base as unknown as Record<string, unknown>)[k] = v;
  }
  return base;
}

/** 属性输出顺序 —— 与 Python __str__ 的 for key in [...] 逐字一致 */
export const DOM_ELEMENT_ATTR_ORDER: readonly string[] = ["placeholder", "value", "href", "type"];

/**
 * 生成 LLM 可读的元素描述 —— 对标 DOMElement.__str__()
 * 形如：`*[3] button "Continue" role=button type="submit"`
 */
export function formatDomElement(el: DOMElement): string {
  const prefix = el.is_new ? "*" : "";
  const parts: string[] = [`${prefix}[${el.index}]`, el.tag_name];

  if (el.text) parts.push(`"${el.text.slice(0, 50)}"`);
  if (el.role && el.role !== el.tag_name) parts.push(`role=${el.role}`);
  for (const key of DOM_ELEMENT_ATTR_ORDER) {
    const val = el.attributes[key];
    if (val) parts.push(`${key}="${val.slice(0, 30)}"`);
  }

  return parts.join(" ");
}

/** DOM 树 */
export interface DOMTree {
  elements: DOMElement[];
  page_url: string;
  page_title: string;
  timestamp: number;
}

export function createDomTree(overrides: Partial<DOMTree> = {}): DOMTree {
  const base: DOMTree = { elements: [], page_url: "", page_title: "", timestamp: 0 };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (base as unknown as Record<string, unknown>)[k] = v;
  }
  return base;
}

/** 根据索引获取元素 —— 对标 DOMTree.get_element() */
export function getDomElement(tree: DOMTree, index: number): DOMElement | null {
  for (const el of tree.elements) {
    if (el.index === index) return el;
  }
  return null;
}

/** 序列化为文本格式 —— 对标 DOMTree.serialize() */
export function serializeDomTree(tree: DOMTree): string {
  return tree.elements.map((el) => formatDomElement(el)).join("\n");
}

// ==================== 浏览器状态 ====================

export interface BrowserState {
  url: string;
  title: string;
  dom_tree: DOMTree | null;
  screenshot_base64: string | null;
  tabs: Record<string, string>[];
  active_tab_index: number;
}

export function createBrowserState(overrides: Partial<BrowserState> = {}): BrowserState {
  const base: BrowserState = {
    url: "",
    title: "",
    dom_tree: null,
    screenshot_base64: null,
    tabs: [],
    active_tab_index: 0,
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (base as unknown as Record<string, unknown>)[k] = v;
  }
  return base;
}

/** 生成状态描述文本 —— 对标 BrowserState.get_state_description() */
export function getStateDescription(state: BrowserState): string {
  const lines: string[] = [`URL: ${state.url}`, `Title: ${state.title}`];
  if (state.tabs.length > 1) {
    lines.push(`Tabs: ${state.tabs.length} (active: ${state.active_tab_index})`);
  }
  if (state.dom_tree) {
    lines.push(`\nInteractive Elements (${state.dom_tree.elements.length}):`);
    lines.push(serializeDomTree(state.dom_tree));
  }
  return lines.join("\n");
}

// ==================== Agent 状态 ====================

export interface AgentStepRecord {
  step_number: number;
  agent_output: AgentOutput | null;
  action_results: Record<string, unknown>[];
  browser_state: BrowserState | null;
  error: string | null;
  timestamp: number;
}

export function createAgentStepRecord(
  overrides: Partial<AgentStepRecord> & { step_number: number },
): AgentStepRecord {
  const base: AgentStepRecord = {
    step_number: overrides.step_number,
    agent_output: null,
    action_results: [],
    browser_state: null,
    error: null,
    timestamp: 0,
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (base as unknown as Record<string, unknown>)[k] = v;
  }
  return base;
}

export interface AgentHistory {
  task: string;
  steps: AgentStepRecord[];
  start_time: number;
  end_time: number | null;
}

export function createAgentHistory(overrides: Partial<AgentHistory> & { task: string }): AgentHistory {
  const base: AgentHistory = { task: overrides.task, steps: [], start_time: 0, end_time: null };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (base as unknown as Record<string, unknown>)[k] = v;
  }
  return base;
}

/**
 * 动作参数的文本化 —— 复刻 Python dict 的 repr。
 *
 * 这段文本会进 `<agent_history>` 提示词，因此不能用 JSON.stringify
 * （`{"url":"x"}` 与 Python 的 `{'url': 'x'}` 字节不同）。
 * 规则：单引号字符串、`: ` 分隔键值、`, ` 分隔项、True/False/None 大写，
 * 与 pydantic model_dump() 出来的 dict 打印结果一致。
 */
export function formatActionParams(params: Record<string, unknown>): string {
  return pythonRepr(params);
}

/** Python repr 的最小实现，只覆盖动作参数会出现的类型 */
export function pythonRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    // Python 默认用单引号；串内含单引号时才改用双引号
    if (value.includes("'") && !value.includes('"')) {
      return `"${value}"`;
    }
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => pythonRepr(v)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([k, v]) => `${pythonRepr(k)}: ${pythonRepr(v)}`).join(", ")}}`;
  }
  return String(value);
}

/** 生成历史描述（用于提示词） —— 对标 AgentHistory.get_history_description() */
export function getHistoryDescription(history: AgentHistory, maxSteps = 10): string {
  if (history.steps.length === 0) {
    return "No previous actions.";
  }

  const recentSteps = history.steps.slice(-maxSteps);
  const lines: string[] = [];
  for (const step of recentSteps) {
    if (step.agent_output) {
      lines.push(`Step ${step.step_number}:`);
      lines.push(`  Goal: ${step.agent_output.next_goal}`);
      step.agent_output.action.forEach((action, i) => {
        const actionType = getActionType(action);
        if (actionType) {
          lines.push(`  Action ${i + 1}: ${actionType} ${formatActionParams(getActionParams(action))}`);
        }
      });
      if (step.action_results.length > 0) {
        for (const result of step.action_results) {
          const success = result["success"] === true;
          const msg = (result["message"] as string | undefined) ?? "";
          lines.push(`  Result: ${success ? "✓" : "✗"} ${msg}`);
        }
      }
    }
  }
  return lines.join("\n");
}

// ==================== 配置类型 ====================

export interface AgentConfig {
  max_steps: number;
  max_actions_per_step: number;
  use_vision: boolean;
  /** "en" 或 "zh" */
  language: string;
  retry_on_error: boolean;
  max_retries: number;
}

export function createAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const base: AgentConfig = {
    max_steps: 50,
    max_actions_per_step: 3,
    use_vision: true,
    language: "en",
    retry_on_error: true,
    max_retries: 3,
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (base as unknown as Record<string, unknown>)[k] = v;
  }
  return base;
}

export interface LLMConfig {
  model_name: string;
  api_key: string;
  base_url: string | null;
  temperature: number;
  max_tokens: number;
}

export function createLLMConfig(overrides: Partial<LLMConfig> = {}): LLMConfig {
  const base: LLMConfig = {
    model_name: "",
    api_key: "",
    base_url: null,
    temperature: 0.0,
    max_tokens: 4096,
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (base as unknown as Record<string, unknown>)[k] = v;
  }
  return base;
}

// ==================== 操作结果类型 ====================

/** 加入家庭组操作结果 */
export interface JoinFamilyResult {
  success: boolean;
  message: string;
  error: string | null;
  error_type: string | null;
  duration_ms: number;
  inviter_email: string | null;
  already_in_family: boolean;
  invite_sent: boolean;
  invite_accepted: boolean;
}

export function createJoinFamilyResult(overrides: Partial<JoinFamilyResult> = {}): JoinFamilyResult {
  const base: JoinFamilyResult = {
    success: false,
    message: "",
    error: null,
    error_type: null,
    duration_ms: 0,
    inviter_email: null,
    already_in_family: false,
    invite_sent: false,
    invite_accepted: false,
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (base as unknown as Record<string, unknown>)[k] = v;
  }
  return base;
}
