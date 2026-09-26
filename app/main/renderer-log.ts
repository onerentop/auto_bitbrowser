/**
 * 渲染层错误落盘 —— 主窗口白屏（React 卸载 / 渲染进程崩溃 / 卡死）时，
 * 控制台输出会随终端滚掉，事后无从排查。这里把渲染层的 console error/warning
 * 与加载失败、进程退出、无响应、预加载报错追加到 <数据根>/logs/renderer.log。
 *
 * 约束：写日志失败一律静默（日志是诊断手段，绝不能反过来影响应用运行）。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

/** 超过这个大小就把当前文件改成 .1（只留一份历史），避免长期运行把磁盘写满 */
const MAX_BYTES = 1024 * 1024;

let logPath: string | null = null;

/** 由主进程在算出数据根后调用一次；拿不到可写目录时关闭落盘（只走控制台） */
export function initRendererLog(dataRoot: string): void {
  try {
    const dir = join(dataRoot, "logs");
    mkdirSync(dir, { recursive: true });
    logPath = join(dir, "renderer.log");
  } catch {
    logPath = null;
  }
}

/** 追加一行；tag 形如 renderer:error / abb-main */
export function logRendererEvent(tag: string, message: string): void {
  if (!logPath) return;
  try {
    const size = statSync(logPath, { throwIfNoEntry: false })?.size ?? 0;
    if (size > MAX_BYTES) renameSync(logPath, `${logPath}.1`);
    appendFileSync(logPath, `${new Date().toISOString()} [${tag}] ${message}\n`, "utf8");
  } catch {
    /* 落盘失败不影响运行 */
  }
}
