/**
 * 主进程本地 handler：不需要后端进程参与的通道
 *
 *   abb/app/getVersion   应用与运行时版本
 *   abb/host/getStatus   后端进程当前状态
 *   abb/host/restart     手动重启后端进程
 *
 * 依赖注入，便于测试；不 import electron。
 */
import { IPC, type AppVersionInfo, type HostStatus } from "../../shared/ipc.ts";
import type { IpcRegistrar } from "./registrar.ts";

export interface AppHandlerDeps {
  getVersionInfo: () => AppVersionInfo;
  host: {
    getStatus(): HostStatus;
    restart(): Promise<HostStatus>;
  };
}

export function registerAppHandlers(registrar: IpcRegistrar, deps: AppHandlerDeps): void {
  registrar.handle(IPC.invoke.appGetVersion, () => deps.getVersionInfo());
  registrar.handle(IPC.invoke.hostGetStatus, () => deps.host.getStatus());
  registrar.handle(IPC.invoke.hostRestart, () => deps.host.restart());
}
