/**
 * 健康检查类 handler —— 运行在后端进程（utilityProcess）
 *
 * 两个通道：
 *   - abb/host/ping          后端进程自报 pid / Node 版本 / 运行时长，证明进程活着
 * - abb/ixbrowser/ping 真实调用已的 IxBrowserClient，证明后端进程
 *                            能 import 并运行 desktop/src/ 下的业务模块
 *
 * ixBrowser 本地服务没开是常态（尤其是开发时），因此 ixbrowser/ping
 * **不抛错**：不可达时返回 reachable=false + 原因，由界面展示。
 * 依赖全部可注入，便于离线单测。
 */
import { IxBrowserClient } from "../../../src/ixbrowser/client.ts";
import { IX_DEFAULT_HOST, IX_DEFAULT_PORT } from "../../../src/ixbrowser/types.ts";
import { IPC, type HostPingResult, type IxBrowserPingResult } from "../../shared/ipc.ts";
import type { HostHandlerTable } from "../dispatch.ts";

/** 探活用的超时：界面上点一下就要有结果，不能沿用业务调用的 20s */
export const IXBROWSER_PING_TIMEOUT_MS = 5_000;

/** handler 只用到 IxBrowserClient 的这一个方法 */
export interface IxProbeClient {
  getProfileList(query: { limit?: number }): Promise<unknown[]>;
}

export interface HealthDeps {
  ixClient?: IxProbeClient;
  /** 展示给用户的服务地址 */
  ixEndpoint?: string;
  now?: () => number;
  pid?: number;
  nodeVersion?: string;
  uptimeSec?: () => number;
}

export function createHealthHandlers(deps: HealthDeps = {}): HostHandlerTable {
  const now = deps.now ?? (() => Date.now());
  const ixClient = deps.ixClient ?? new IxBrowserClient({ timeoutMs: IXBROWSER_PING_TIMEOUT_MS });
  const ixEndpoint = deps.ixEndpoint ?? `http://${IX_DEFAULT_HOST}:${IX_DEFAULT_PORT}`;
  const pid = deps.pid ?? process.pid;
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const uptimeSec = deps.uptimeSec ?? (() => process.uptime());

  return {
    [IPC.invoke.hostPing]: (): HostPingResult => ({
      pid,
      node: nodeVersion,
      uptimeSec: Math.round(uptimeSec() * 10) / 10,
      at: now(),
    }),

    [IPC.invoke.ixbrowserPing]: async (): Promise<IxBrowserPingResult> => {
      const started = now();
      try {
        const list = await ixClient.getProfileList({ limit: 1 });
        return {
          reachable: true,
          endpoint: ixEndpoint,
          sampleCount: Array.isArray(list) ? list.length : 0,
          error: null,
          elapsedMs: now() - started,
        };
      } catch (error) {
        return {
          reachable: false,
          endpoint: ixEndpoint,
          sampleCount: null,
          error: error instanceof Error ? error.message : String(error),
          elapsedMs: now() - started,
        };
      }
    },
  };
}
