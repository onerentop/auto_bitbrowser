/**
 * IPC 通道表 —— 三端共用的单一事实来源
 *
 * -Desktop 的 `IPC = { invoke, event }` 结构 
 *   - 命名 `abb/领域/动作`；事件额外带 `/event/` 段
 *   - 预加载层与主进程都用 IPC_WHITELIST 校验，任何未登记的通道一律拒绝
 *   - InvokeMap / EventMap 把「通道 → 参数/返回类型」绑定起来，
 *     渲染层 `invoke(IPC.invoke.xxx)` 可自动推出返回类型
 *
 * 同时定义主进程 ⇄ 后端进程（utilityProcess）之间的消息协议 HostMessage。
 *
 * 本文件是纯 TS，不依赖 electron。
 */
import type { Envelope } from "./envelope.ts";
import { ACCOUNTS_INVOKE, type AccountsInvokeMap } from "./channels/accounts.ts";
import { HOME_INVOKE, type HomeInvokeMap } from "./channels/home.ts";
import { SETTINGS_INVOKE, type SettingsInvokeMap } from "./channels/settings.ts";
import { AI_TASKS_INVOKE, type AiTasksInvokeMap } from "./channels/ai-tasks.ts";
import { TOTP_INVOKE, type TotpInvokeMap } from "./channels/totp.ts";
import { TASK_HISTORY_INVOKE, type TaskHistoryInvokeMap } from "./channels/task-history.ts";

// ==================== 通道表 ====================

export const IPC = {
  invoke: {
    /** 应用与运行时版本（主进程本地） */
    appGetVersion: "abb/app/getVersion",
    /** 后端进程当前状态（主进程本地） */
    hostGetStatus: "abb/host/getStatus",
    /** 手动重启后端进程（主进程本地） */
    hostRestart: "abb/host/restart",
    /** 后端进程往返探活（转给后端进程） */
    hostPing: "abb/host/ping",
    /** ixBrowser 本地服务可达性（转给后端进程） */
    ixbrowserPing: "abb/ixbrowser/ping",
    /** 当前运行中的任务（无则 null） */
    taskGetCurrent: "abb/task/getCurrent",
    /** 请求停止当前任务（协作式） */
    taskStop: "abb/task/stop",
    // 业务领域通道（定义见 channels/*.ts）
    ...SETTINGS_INVOKE,
    ...HOME_INVOKE,
    ...ACCOUNTS_INVOKE,
    ...AI_TASKS_INVOKE,
    ...TOTP_INVOKE,
    ...TASK_HISTORY_INVOKE,
  },
  event: {
    /** 后端进程状态变化推送 */
    hostStatus: "abb/host/event/status",
    /** 任务日志（一行一条） */
    taskLog: "abb/task/event/log",
    /** 任务进度 current/total */
    taskProgress: "abb/task/event/progress",
    /** 任务结束（成功 / 失败 / 已停止） */
    taskFinished: "abb/task/event/finished",
    /** 任务中单个条目的状态（逐行更新表格） */
    taskItem: "abb/task/event/item",
  },
} as const;

export type InvokeChannel = (typeof IPC.invoke)[keyof typeof IPC.invoke];
export type EventChannel = (typeof IPC.event)[keyof typeof IPC.event];
export type Channel = InvokeChannel | EventChannel;

/** 白名单：预加载层与主进程共同使用 */
export const IPC_WHITELIST: ReadonlySet<string> = new Set<string>([
  ...Object.values(IPC.invoke),
  ...Object.values(IPC.event),
]);

export function isAllowedChannel(channel: unknown): channel is Channel {
  return typeof channel === "string" && IPC_WHITELIST.has(channel);
}

export function isEventChannel(channel: unknown): channel is EventChannel {
  return (
    typeof channel === "string" &&
    (Object.values(IPC.event) as readonly string[]).includes(channel)
  );
}

export function isInvokeChannel(channel: unknown): channel is InvokeChannel {
  return (
    typeof channel === "string" &&
    (Object.values(IPC.invoke) as readonly string[]).includes(channel)
  );
}

/**
 * 由主进程本地执行的通道。其余 invoke 通道一律转给后端进程（ 的 backendRouter）。
 * 用「本地白名单」而不是「后端白名单」：业务通道会越来越多，而本地通道只有这几个。
 */
export const LOCAL_CHANNELS: ReadonlySet<InvokeChannel> = new Set<InvokeChannel>([
  IPC.invoke.appGetVersion,
  IPC.invoke.hostGetStatus,
  IPC.invoke.hostRestart,
]);

/** 需要转给后端进程处理的通道 */
export const HOST_ROUTED_CHANNELS: ReadonlySet<InvokeChannel> = new Set<InvokeChannel>(
  (Object.values(IPC.invoke) as InvokeChannel[]).filter((c) => !LOCAL_CHANNELS.has(c)),
);

// ==================== 数据类型 ====================

export interface AppVersionInfo {
  appName: string;
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  /** 数据根目录（accounts.db / config.json 所在处） */
  dataRoot: string;
}

/** 后端进程状态机：stopped → starting → ready → (crashed | stopped) */
export type HostState = "stopped" | "starting" | "ready" | "crashed";

export interface HostStatus {
  state: HostState;
  /** 后端进程 pid（未运行时为 null） */
  pid: number | null;
  /** 最近一次状态变化的时间戳（毫秒） */
  since: number;
  /**
   * 单调递增的状态序号。渲染层用它判断新旧，而不是 since：
   * since 是墙钟时间，系统时钟被回拨（手动修改 / NTP 校正）后会让新状态看起来比旧状态更早。
   */
  seq: number;
  /** 进入 crashed 状态时的退出码或错误原因 */
  detail: string | null;
}

export interface HostPingResult {
  /** 后端进程自报的 pid */
  pid: number;
  /** 后端进程里的 Node 版本（证明跑在 Electron 自带的 Node 上） */
  node: string;
  /** 后端进程已运行时长（秒） */
  uptimeSec: number;
  /** 后端处理本次请求时的时间戳（毫秒） */
  at: number;
}

export interface IxBrowserPingResult {
  reachable: boolean;
  /** 服务地址（便于界面提示用户检查） */
  endpoint: string;
  /** 本次请求取回的窗口条数（limit=1，所以只是 0 或 1） */
  sampleCount: number | null;
  /** 不可达时的原因 */
  error: string | null;
  elapsedMs: number;
}

// ==================== 任务 ====================

/** 正在运行的任务 */
export interface TaskInfo {
  id: number;
  /** 任务类型，如 login / batch_delete / health_check */
  type: string;
  /** 展示用名称 */
  label: string;
  startedAt: number;
  stopRequested: boolean;
  current: number;
  total: number;
}

export interface TaskLogEvent {
  taskId: number;
  type: string;
  message: string;
  at: number;
}

export interface TaskProgressEvent {
  taskId: number;
  type: string;
  current: number;
  total: number;
}

export type TaskOutcome = "succeeded" | "failed" | "stopped";

export interface TaskFinishedEvent {
  taskId: number;
  type: string;
  label: string;
  outcome: TaskOutcome;
  /** 任务返回值（结构由各任务自定义），失败时为 null */
  result: unknown;
  error: string | null;
  startedAt: number;
  finishedAt: number;
}

/**
 * 任务中单个条目（账号 / 窗口）的状态变化。
 * 携带条目键、状态与消息，渲染层据此逐行更新表格的「状态 / 消息」列。
 */
export interface TaskItemEvent {
  taskId: number;
  type: string;
  /** 条目键（由任务自定，通常是 email 或窗口 ID） */
  key: string;
  /** 处理中 / 成功 / 失败 / 错误 等 */
  status: string;
  message: string;
}

// ==================== 通道 → 类型 ====================

/**
 * invoke 通道的参数元组与返回类型。
 * 业务领域的通道类型分散在 channels/*.ts，这里通过 extends 合并。
 */
export interface InvokeMap
  extends SettingsInvokeMap,
    HomeInvokeMap,
    AccountsInvokeMap,
    AiTasksInvokeMap,
    TotpInvokeMap,
    TaskHistoryInvokeMap {
  "abb/app/getVersion": { args: []; result: AppVersionInfo };
  "abb/host/getStatus": { args: []; result: HostStatus };
  "abb/host/restart": { args: []; result: HostStatus };
  "abb/host/ping": { args: []; result: HostPingResult };
  "abb/ixbrowser/ping": { args: []; result: IxBrowserPingResult };
  "abb/task/getCurrent": { args: []; result: TaskInfo | null };
  "abb/task/stop": { args: []; result: boolean };
}

/** event 通道的载荷类型 */
export interface EventMap {
  "abb/host/event/status": HostStatus;
  "abb/task/event/log": TaskLogEvent;
  "abb/task/event/progress": TaskProgressEvent;
  "abb/task/event/finished": TaskFinishedEvent;
  "abb/task/event/item": TaskItemEvent;
}

export type InvokeArgs<C extends InvokeChannel> = InvokeMap[C]["args"];
export type InvokeResult<C extends InvokeChannel> = InvokeMap[C]["result"];
export type EventPayload<C extends EventChannel> = EventMap[C];

/** 预加载层暴露给渲染层的 API 形状（window.abb） */
export interface AbbBridge {
  invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<Envelope<InvokeResult<C>>>;
  on<C extends EventChannel>(channel: C, listener: (payload: EventPayload<C>) => void): () => void;
  channels: typeof IPC;
  platform: string;
}

// ==================== 主进程 ⇄ 后端进程 消息协议 ====================

/** 主进程 → 后端进程：请求 */
export interface HostRequestMessage {
  type: "request";
  id: number;
  channel: string;
  args: unknown[];
}

/** 后端进程 → 主进程：响应（按 id 与请求配对） */
export interface HostResponseMessage {
  type: "response";
  id: number;
  envelope: Envelope<unknown>;
}

/** 后端进程 → 主进程：启动完成 */
export interface HostReadyMessage {
  type: "ready";
  pid: number;
}

/** 后端进程 → 主进程：主动推送的事件（为以后的任务进度预留） */
export interface HostEventMessage {
  type: "event";
  channel: string;
  payload: unknown;
}

export type HostInboundMessage = HostRequestMessage;
export type HostOutboundMessage = HostResponseMessage | HostReadyMessage | HostEventMessage;

export function isHostOutboundMessage(value: unknown): value is HostOutboundMessage {
  if (value === null || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  switch (o["type"]) {
    case "response":
      return typeof o["id"] === "number" && typeof o["envelope"] === "object" && o["envelope"] !== null;
    case "ready":
      return typeof o["pid"] === "number";
    case "event":
      return typeof o["channel"] === "string";
    default:
      return false;
  }
}

export function isHostRequestMessage(value: unknown): value is HostRequestMessage {
  if (value === null || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    o["type"] === "request" &&
    typeof o["id"] === "number" &&
    typeof o["channel"] === "string" &&
    Array.isArray(o["args"])
  );
}
