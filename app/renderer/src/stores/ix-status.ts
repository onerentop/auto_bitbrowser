/**
 * ixBrowser 本地服务状态 store（侧栏状态灯 + 运行状态页共用）
 *
 * 后端就绪后每 30 秒调用一次只读的 abb/ixbrowser/ping；运行状态页的「检测」也走 refreshIxStatus()，
 * 两处看到的永远是同一份结果。
 * 用 useSyncExternalStore 的最小实现，与 host-status.ts 同一写法。
 */
import { useSyncExternalStore } from "react";
import type { IxBrowserPingResult } from "../../../shared/ipc.ts";
import { IPC, describeError, invoke } from "../lib/ipc.ts";

export interface IxStatus {
  /** 是否有请求在途 */
  loading: boolean;
  /** 最近一次成功返回的结果（请求本身失败时为 null） */
  data: IxBrowserPingResult | null;
  /** 请求本身失败的原因（如后端未就绪） */
  error: string | null;
  /** 最近一次完成的时间（毫秒）；从未检测过为 null */
  checkedAt: number | null;
}

export const IX_POLL_MS = 30_000;

type Listener = () => void;
const listeners = new Set<Listener>();
let current: IxStatus = { loading: false, data: null, error: null, checkedAt: null };
let seq = 0;

function set(next: IxStatus): void {
  current = next;
  for (const l of listeners) l();
}

/** 立即检测一次；并发调用时只采纳最后一次的结果 */
export async function refreshIxStatus(): Promise<void> {
  const my = ++seq;
  set({ ...current, loading: true });
  try {
    const data = await invoke(IPC.invoke.ixbrowserPing);
    if (my === seq) set({ loading: false, data, error: null, checkedAt: Date.now() });
  } catch (e) {
    if (my === seq) set({ loading: false, data: null, error: describeError(e), checkedAt: Date.now() });
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** 开始 / 停止轮询（由外壳在后端就绪状态变化时调用） */
export function setIxPolling(on: boolean): void {
  if (on && !timer) {
    void refreshIxStatus();
    timer = setInterval(() => void refreshIxStatus(), IX_POLL_MS);
  } else if (!on && timer) {
    clearInterval(timer);
    timer = null;
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useIxStatus(): IxStatus {
  return useSyncExternalStore(subscribe, () => current);
}
