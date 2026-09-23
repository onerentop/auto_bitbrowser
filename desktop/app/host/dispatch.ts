/**
 * 后端进程分发表 —— 纯函数，不依赖 electron，可被 node --test 直接导入
 *
 * 把「通道名 → handler」映射成一个 dispatch(channel, args) 函数：
 *   - 已登记的通道：执行 handler，结果（或异常）包成信封返回
 *   - 未登记的通道：返回 UNKNOWN_CHANNEL，而不是抛错
 *
 * 为什么不直接复用 IPC_WHITELIST：白名单管的是「渲染层允许调哪些通道」，
 * 分发表管的是「后端进程实际实现了哪些通道」。两者由 router 的
 * HOST_ROUTED_CHANNELS 衔接，单测会校验它们一致。
 */
import { ERROR_CODES, errEnvelope, wrap, type Envelope } from "../shared/envelope.ts";

export type HostHandler = (...args: unknown[]) => unknown | Promise<unknown>;
export type HostHandlerTable = Readonly<Record<string, HostHandler>>;

export type Dispatch = (channel: string, args: unknown[]) => Promise<Envelope<unknown>>;

export function createDispatcher(table: HostHandlerTable): Dispatch {
  return async (channel, args) => {
    // 用 hasOwn 而不是 `in`：避免 "toString" / "constructor" 之类原型链上的名字被当成通道
    if (!Object.prototype.hasOwnProperty.call(table, channel)) {
      return errEnvelope(ERROR_CODES.UNKNOWN_CHANNEL, `后端进程未实现该通道: ${channel}`);
    }
    const handler = table[channel] as HostHandler;
    return wrap(() => handler(...args));
  };
}

/** 分发表里实际实现了哪些通道（供单测与路由一致性校验） */
export function listChannels(table: HostHandlerTable): string[] {
  return Object.keys(table);
}
