/**
 * 后端进程状态 store —— 基于 useSyncExternalStore 的最小实现
 *
 * 对标 PI-Desktop：不引入 zustand / redux，用 React 18+ 内置的
 * useSyncExternalStore 订阅外部数据源。
 *
 * 数据来源两路，按到达顺序合并：
 *   1. 启动时主动拉一次 abb/host/getStatus（窗口可能晚于后端 ready 才打开）
 *   2. 订阅 abb/host/event/status 推送
 * 用单调递增的 seq 去重，防止「迟到的主动拉取结果」覆盖掉更新的推送。
 * （不用 since：它是墙钟时间，系统时钟回拨后新状态会被误判为旧状态而丢弃）
 */
import { useSyncExternalStore } from "react";
import type { HostStatus } from "../../../shared/ipc.ts";
import { IPC, invoke, on } from "../lib/ipc.ts";

type Listener = () => void;

let current: HostStatus | null = null;
const listeners = new Set<Listener>();
let started = false;

function publish(next: HostStatus): void {
  if (current && next.seq < current.seq) return; // 旧数据不覆盖新数据
  current = next;
  for (const l of listeners) l();
}

/** 首次有组件订阅时才连上 IPC，避免模块加载即产生副作用 */
function ensureStarted(): void {
  if (started) return;
  started = true;
  on(IPC.event.hostStatus, publish);
  invoke(IPC.invoke.hostGetStatus).then(publish, () => {
    // 主进程本地通道，失败意味着 IPC 本身有问题；保持 null，界面显示「未知」
  });
}

function subscribe(listener: Listener): () => void {
  ensureStarted();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): HostStatus | null {
  return current;
}

export function useHostStatus(): HostStatus | null {
  return useSyncExternalStore(subscribe, getSnapshot);
}
