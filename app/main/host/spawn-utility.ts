/**
 * 用 Electron `utilityProcess.fork()` 拉起后端进程，并适配成 HostProcessHandle
 *
 * -Desktop 的 spawnUtilityProcess：serviceName 便于在任务管理器里辨认 
 * stdio 设为 pipe 以便把后端日志转打到主进程控制台。
 */
import { utilityProcess } from "electron";
import type { HostProcessHandle } from "./host-client.ts";

export interface SpawnUtilityOptions {
  /** 打包后的后端入口（out/main/host.js）的绝对路径 */
  entry: string;
  /** 额外的环境变量（与主进程环境合并后传给后端进程） */
  env?: Record<string, string>;
  log?: (line: string) => void;
}

export function createUtilitySpawner(options: SpawnUtilityOptions): () => HostProcessHandle {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));

  return () => {
    const child = utilityProcess.fork(options.entry, [], {
      serviceName: "abb-host",
      stdio: "pipe",
      env: { ...process.env, ...options.env },
    });

    child.stdout?.on("data", (chunk: Buffer) => log(`[host] ${chunk.toString().trimEnd()}`));
    child.stderr?.on("data", (chunk: Buffer) => log(`[host:err] ${chunk.toString().trimEnd()}`));

    // UtilityProcess 在 V8 致命错误（如 OOM）时 emit 'error'。它是 EventEmitter：
    // 没有监听器时 emit('error') 会在**主进程**抛出未捕获异常，把整个应用带崩。
    // 这里只记日志；进程随后的退出仍由 'exit' 事件处理（状态会标为 crashed）。
    child.on("error", (type: string, location: string, report?: string) => {
      log(`[host:fatal] ${type} @ ${location}${report ? `\n${report}` : ""}`);
    });

    return {
      get pid() {
        return child.pid;
      },
      postMessage: (message) => child.postMessage(message),
      onMessage: (listener) => {
        child.on("message", listener);
      },
      onExit: (listener) => {
        child.on("exit", (code) => listener(code ?? 0));
      },
      kill: () => child.kill(),
    };
  };
}
