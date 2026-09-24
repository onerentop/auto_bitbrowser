/**
 * 后台任务 store —— 订阅后端推送的任务日志 / 进度 / 结束事件
 *
 * 后端推送三类事件：日志文本、进度值、任务结束。
 * 日志只保留最近 LOG_LIMIT 行，防止长任务把内存撑爆。
 *
 * 后端进程重启后任务必然丢失：订阅 hostStatus，进入 ready 时重新拉一次当前任务。
 */
import { useSyncExternalStore } from "react";
import type { TaskFinishedEvent, TaskInfo, TaskItemEvent } from "../../../shared/ipc.ts";
import { IPC, invoke, on } from "../lib/ipc.ts";

export const LOG_LIMIT = 2000;

export interface TaskLogLine {
  key: number;
  at: number;
  message: string;
}

export interface TaskState {
  /** 正在运行的任务；null 表示空闲 */
  running: TaskInfo | null;
  logs: TaskLogLine[];
  /** 最近一次结束的任务（用于展示结果汇总） */
  lastFinished: TaskFinishedEvent | null;
}

type Listener = () => void;

let state: TaskState = { running: null, logs: [], lastFinished: null };
const listeners = new Set<Listener>();
const finishedListeners = new Set<(e: TaskFinishedEvent) => void>();
let started = false;
let logKey = 0;

/**
 * 已结束的任务 id。
 * 跨进程时「任务结束事件」可能先于「启动请求的返回值」到达渲染层（瞬时完成的任务，
 * 两者走同一条 port 但响应要多经过几层 async）。markTaskStarted 据此忽略已结束的任务，
 * 否则 running 会被重新置为非空，页面按钮永远禁用。
 * 后端重启后任务 id 从 1 重新计数，因此后端状态变化时清空。
 */
const finishedIds = new Set<number>();

function set(next: Partial<TaskState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function appendLog(message: string, at: number): void {
  const logs = state.logs.length >= LOG_LIMIT ? state.logs.slice(-(LOG_LIMIT - 1)) : state.logs.slice();
  logs.push({ key: logKey++, at, message });
  set({ logs });
}

function refreshCurrent(): void {
  invoke(IPC.invoke.taskGetCurrent).then(
    (running) => set({ running: running && finishedIds.has(running.id) ? null : running }),
    () => set({ running: null }),
  );
}

function ensureStarted(): void {
  if (started) return;
  started = true;

  on(IPC.event.taskLog, (e) => appendLog(e.message, e.at));

  on(IPC.event.taskProgress, (e) => {
    const r = state.running;
    if (r && r.id === e.taskId) set({ running: { ...r, current: e.current, total: e.total } });
  });

  on(IPC.event.taskFinished, (e) => {
    finishedIds.add(e.taskId);
    // 只清除对应的那个任务（旧任务迟到的结束事件不应清掉新任务）
    const running = state.running && state.running.id !== e.taskId ? state.running : null;
    set({ running, lastFinished: e });
    for (const fn of finishedListeners) fn(e);
  });

  on(IPC.event.hostStatus, (s) => {
    // 后端（重）启动后任务 id 重新从 1 计数，旧的已结束集合作废
    if (s.state !== "ready") finishedIds.clear();
    if (s.state === "ready") refreshCurrent();
    else set({ running: null });
  });

  refreshCurrent();
}

function subscribe(listener: Listener): () => void {
  ensureStarted();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTaskState(): TaskState {
  return useSyncExternalStore(subscribe, () => state);
}

/** 任务启动后由页面调用：立刻标记为运行中（不必等第一条进度事件） */
export function markTaskStarted(info: TaskInfo): void {
  ensureStarted();
  appendLog(`▶ 开始任务：${info.label}`, info.startedAt);
  // 结束事件已先到：任务已经跑完，不能再标记为运行中
  if (finishedIds.has(info.id)) return;
  set({ running: info });
}

/** 界面自己产生的日志（例如校验失败、确认取消） */
export function logLocal(message: string): void {
  ensureStarted();
  appendLog(message, Date.now());
}

export function clearLogs(): void {
  set({ logs: [] });
}

export async function stopTask(): Promise<void> {
  await invoke(IPC.invoke.taskStop);
}

/** 订阅任务结束（页面据此刷新列表）；返回取消函数 */
export function onTaskFinished(fn: (e: TaskFinishedEvent) => void): () => void {
  ensureStarted();
  finishedListeners.add(fn);
  return () => finishedListeners.delete(fn);
}

/**
 * 订阅任务条目状态（逐行更新表格）。
 * 直接订阅 IPC 事件：条目状态只对发起页面有意义，不进全局 store。返回取消函数。
 */
export function onTaskItem(fn: (e: TaskItemEvent) => void): () => void {
  return on(IPC.event.taskItem, fn);
}
