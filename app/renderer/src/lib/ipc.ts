/**
 * 渲染层 IPC 封装
 *
 * window.abb.invoke 返回的是信封 {ok, data | error}。这里把信封拆开：
 *   成功 → 直接返回 data（类型由 InvokeMap 自动推导）
 *   失败 → 抛 IpcError（带 code），调用方按需 catch
 * 组件里因此不需要到处写 `if (res.ok)`，也不需要 any。
 */
import type { EnvelopeError } from "../../../shared/envelope.ts";
import {
  IPC,
  type AbbBridge,
  type EventChannel,
  type EventPayload,
  type InvokeArgs,
  type InvokeChannel,
  type InvokeResult,
} from "../../../shared/ipc.ts";

export { IPC };

export class IpcError extends Error {
  readonly code: string;
  readonly channel: string;

  constructor(channel: string, error: EnvelopeError) {
    super(error.message);
    this.name = "IpcError";
    this.code = error.code;
    this.channel = channel;
  }
}

function bridge(): AbbBridge {
  const b = window.abb;
  if (!b) {
    // 直接用浏览器打开渲染层页面（没有预加载脚本）时会走到这里
    throw new Error("window.abb 不存在：页面必须在 Electron 中通过预加载脚本加载");
  }
  return b;
}

export async function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeArgs<C>
): Promise<InvokeResult<C>> {
  const envelope = await bridge().invoke(channel, ...args);
  if (envelope.ok) return envelope.data;
  throw new IpcError(channel, envelope.error);
}

export function on<C extends EventChannel>(
  channel: C,
  listener: (payload: EventPayload<C>) => void,
): () => void {
  return bridge().on(channel, listener);
}

/** 把任意错误转成适合展示给用户的一行文字 */
export function describeError(error: unknown): string {
  if (error instanceof IpcError) return `[${error.code}] ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
