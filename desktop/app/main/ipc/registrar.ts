/**
 * IPC 注册器 ——-Desktop main 进程里的 `handle(channel, fn)`
 *
 * 每个 invoke 通道的处理流程：
 *   1. 来源校验：请求必须来自本应用渲染层的 frame（防止被导航走的页面调用 IPC）
 *   2. 白名单校验（与预加载层双重把关）
 *   3. 先问路由：后端通道 → 直接返回后端进程的信封
 *   4. 否则执行本地 handler，结果/异常用 wrap() 包成信封
 * 任何情况下都返回信封，异常不会穿透到渲染层。
 *
 * ipcMain 通过参数注入（只用到 handle 方法），本文件不 import electron。
 */
import { ERROR_CODES, errEnvelope, wrap, type Envelope } from "../../shared/envelope.ts";
import { IPC, isAllowedChannel, type InvokeChannel } from "../../shared/ipc.ts";
import { ROUTE_LOCAL, type BackendRouter } from "../host/router.ts";

export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  removeHandler?(channel: string): void;
}

export type LocalHandler = (...args: unknown[]) => unknown | Promise<unknown>;

/** 判断请求来源是否可信；传入的是 ipcMain 的 event（真实环境为 IpcMainInvokeEvent） */
export type SenderGuard = (event: unknown) => boolean;

export interface IpcRegistrar {
  /** 登记一个本地 handler（后端通道不需要登记，路由会接管） */
  handle(channel: InvokeChannel, fn: LocalHandler): void;
  /** 把所有 invoke 通道挂到 ipcMain 上；没有本地 handler 也不走后端的通道返回 UNKNOWN_CHANNEL */
  install(): void;
  /** 供测试直接调用，不经过 ipcMain 与来源校验 */
  invoke(channel: string, args: unknown[]): Promise<Envelope<unknown>>;
}

export interface RegistrarOptions {
  /** 来源校验；不传则不校验（仅用于测试） */
  isTrustedSender?: SenderGuard;
  log?: (message: string) => void;
}

/** 从 IpcMainInvokeEvent 里取发送方 frame 的 URL（不依赖 electron 类型） */
export function senderFrameUrl(event: unknown): string | null {
  if (event === null || typeof event !== "object") return null;
  const frame = (event as { senderFrame?: { url?: unknown } | null }).senderFrame;
  return frame && typeof frame.url === "string" ? frame.url : null;
}

export function createIpcRegistrar(
  ipcMain: IpcMainLike,
  router: BackendRouter,
  options: RegistrarOptions = {},
): IpcRegistrar {
  const local = new Map<string, LocalHandler>();
  const log = options.log ?? (() => {});

  const invoke = async (channel: string, args: unknown[]): Promise<Envelope<unknown>> => {
    if (!isAllowedChannel(channel)) {
      return errEnvelope(ERROR_CODES.UNKNOWN_CHANNEL, `IPC 通道不在白名单: ${channel}`);
    }
    const routed = await router.route(channel, args);
    if (routed !== ROUTE_LOCAL) return routed;

    const fn = local.get(channel);
    if (!fn) return errEnvelope(ERROR_CODES.UNKNOWN_CHANNEL, `主进程未实现该通道: ${channel}`);
    return wrap(() => fn(...args));
  };

  return {
    handle(channel, fn) {
      if (router.isHostRouted(channel)) {
        throw new Error(`通道 ${channel} 已路由到后端进程，不能再登记本地 handler`);
      }
      local.set(channel, fn);
    },

    install() {
      for (const channel of Object.values(IPC.invoke)) {
        ipcMain.handle(channel, (event, ...args) => {
          if (options.isTrustedSender && !options.isTrustedSender(event)) {
            log(`拒绝来自非应用页面的 IPC 请求: ${channel}（来源 ${senderFrameUrl(event) ?? "未知"}）`);
            return errEnvelope(ERROR_CODES.FORBIDDEN, `请求来源不可信: ${channel}`);
          }
          return invoke(channel, args);
        });
      }
    },

    invoke,
  };
}
