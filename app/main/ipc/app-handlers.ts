/**
 * 主进程本地 handler：不需要后端进程参与的通道
 *
 *   abb/app/getVersion   应用与运行时版本
 *   abb/host/getStatus   后端进程当前状态
 *   abb/host/restart     手动重启后端进程
 *   abb/app/notify       系统通知（任务完成 / 失败时由渲染层调用）
 *
 * 依赖注入，便于测试；不 import electron。
 */
import { IPC, type AppNotifyPayload, type AppVersionInfo, type HostStatus } from "../../shared/ipc.ts";
import type { IpcRegistrar } from "./registrar.ts";

export interface AppHandlerDeps {
  getVersionInfo: () => AppVersionInfo;
  host: {
    getStatus(): HostStatus;
    restart(): Promise<HostStatus>;
  };
  /** 系统通知：主进程用 Electron Notification 弹；失败必须静默（不能让通知把任务流程带崩） */
  notify: (payload: AppNotifyPayload) => boolean;
}

export function registerAppHandlers(registrar: IpcRegistrar, deps: AppHandlerDeps): void {
  registrar.handle(IPC.invoke.appGetVersion, () => deps.getVersionInfo());
  registrar.handle(IPC.invoke.hostGetStatus, () => deps.host.getStatus());
  registrar.handle(IPC.invoke.hostRestart, () => deps.host.restart());
  registrar.handle(IPC.invoke.appNotify, (payload: unknown) => {
    const p = (payload ?? {}) as Partial<AppNotifyPayload>;
    return deps.notify({ title: String(p.title ?? ""), body: String(p.body ?? "") });
  });
}
