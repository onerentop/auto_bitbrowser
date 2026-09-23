/**
 * 后端路由 —— 决定一个 invoke 通道由谁处理（对标 PI-Desktop 的 backendRouter）
 *
 *   - 在 HOST_ROUTED_CHANNELS 中：转给后端进程（HostClient.request）
 *   - 否则：返回 ROUTE_LOCAL，由主进程本地 handler 执行
 *
 * 纯逻辑，不依赖 electron。
 */
import type { Envelope } from "../../shared/envelope.ts";
import { HOST_ROUTED_CHANNELS, type InvokeChannel } from "../../shared/ipc.ts";

export const ROUTE_LOCAL = Symbol("route-local");

export interface HostRequester {
  request(channel: string, args: unknown[]): Promise<Envelope<unknown>>;
}

export interface BackendRouter {
  route(channel: string, args: unknown[]): Promise<Envelope<unknown> | typeof ROUTE_LOCAL>;
  isHostRouted(channel: string): boolean;
}

export function createBackendRouter(
  host: HostRequester,
  routed: ReadonlySet<string> = HOST_ROUTED_CHANNELS as ReadonlySet<InvokeChannel>,
): BackendRouter {
  return {
    isHostRouted: (channel) => routed.has(channel),
    route: async (channel, args) => (routed.has(channel) ? host.request(channel, args) : ROUTE_LOCAL),
  };
}
