/**
 * 主窗口创建 —— 安全选项照 PI-Desktop：
 *   contextIsolation: true / nodeIntegration: false / sandbox: true
 * 开了 sandbox 后预加载脚本必须是 CJS，所以 preload 打包成 index.cjs。
 *
 * 导航只放行本应用的渲染层入口（见 navigation.ts）：预加载脚本会注入到
 * 该 webContents 加载的每个页面，放行任意 file:// 等于把 window.abb 交给任意页面。
 */
import { BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isAppUrl, type AppOrigin } from "./navigation.ts";

/** 与 Python 版 GUI（gui/main_window_fluent.py）的窗口标题保持一致 */
export const WINDOW_TITLE = "ixBrowser 窗口管理工具";

export interface CreateWindowOptions {
  /** 编译后 main 目录（out/main） */
  mainDir: string;
  /** electron-vite dev 时的渲染层地址 */
  devServerUrl?: string | undefined;
}

/** 由窗口参数计算本应用的合法来源（供窗口导航与 IPC 来源校验共用） */
export function resolveAppOrigin(options: CreateWindowOptions): AppOrigin {
  return {
    devServerUrl: options.devServerUrl,
    entryFileUrl: pathToFileURL(rendererIndexPath(options.mainDir)).href,
  };
}

function rendererIndexPath(mainDir: string): string {
  return join(mainDir, "../renderer/index.html");
}

export function createMainWindow(options: CreateWindowOptions): BrowserWindow {
  const origin = resolveAppOrigin(options);

  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: WINDOW_TITLE,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(options.mainDir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });

  // 等首帧就绪再显示，避免白屏闪烁
  window.once("ready-to-show", () => window.show());

  // HTML 里的 <title> 会覆盖窗口标题；这里固定住，保持与 Python 版一致
  window.on("page-title-updated", (event) => event.preventDefault());

  // 渲染层里的外链一律交给系统浏览器，不在应用内打开新窗口。
  // 只放行 http(s)，挡住 file:、ms-*:、javascript: 等协议
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // 禁止页面把自己导航走：只放行本应用入口。
  // 这同时挡住了「把本机 .html 拖进窗口」导致的导航（Chromium 默认会打开被拖入的文件）
  const guardNavigation = (event: Electron.Event, url: string): void => {
    if (!isAppUrl(url, origin)) {
      event.preventDefault();
      process.stdout.write(`[abb-main] 已拦截导航: ${url}\n`);
    }
  };
  window.webContents.on("will-navigate", guardNavigation);
  window.webContents.on("will-redirect", guardNavigation);

  // 不允许嵌入 <webview>（webviewTag 已关，这里再兜底一次）
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());

  // 渲染层加载失败 / 崩溃 / 控制台错误都打到主进程日志，否则窗口不出现时无从排查
  window.webContents.on("did-fail-load", (_e, code, desc, url) => {
    process.stdout.write(`[abb-main] 渲染层加载失败 ${code} ${desc} ${url}\n`);
  });
  window.webContents.on("render-process-gone", (_e, details) => {
    process.stdout.write(`[abb-main] 渲染进程退出: ${details.reason} (exitCode=${details.exitCode})\n`);
  });
  window.webContents.on("preload-error", (_e, path, error) => {
    process.stdout.write(`[abb-main] 预加载脚本出错 ${path}: ${error.message}\n`);
  });
  window.webContents.on("console-message", (event) => {
    if (event.level === "error" || event.level === "warning") {
      process.stdout.write(`[renderer:${event.level}] ${event.message}\n`);
    }
  });

  if (options.devServerUrl) {
    void window.loadURL(options.devServerUrl);
  } else {
    void window.loadFile(rendererIndexPath(options.mainDir));
  }

  return window;
}
