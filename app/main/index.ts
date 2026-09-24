/**
 * Electron 主进程入口 —— 薄壳（-Desktop）
 *
 * 只做四件事：
 *   1. 生命周期与单实例锁
 *   2. 创建主窗口（安全选项见 window.ts）
 *   3. 拉起后端进程（utilityProcess），把状态变化推给渲染层
 *   4. 安装 IPC：白名单 → 路由（后端通道转发）→ 本地 handler
 *
 * 主进程**不 import 任何业务模块**（src/**）：批量任务、引擎、数据库
 * 全部跑在后端进程里，崩了也不影响窗口。
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { IPC, isEventChannel, type AppVersionInfo, type HostStatus } from "../shared/ipc.ts";
import { resolveDataRoot } from "./data-root.ts";
import { HostClient } from "./host/host-client.ts";
import { createBackendRouter } from "./host/router.ts";
import { createUtilitySpawner } from "./host/spawn-utility.ts";
import { createIpcRegistrar, senderFrameUrl } from "./ipc/registrar.ts";
import { registerAppHandlers } from "./ipc/app-handlers.ts";
import { isAppUrl } from "./navigation.ts";
import { createMainWindow, resolveAppOrigin } from "./window.ts";

/** 打包后本文件位于 out/main/index.js；后端入口与之同目录 */
const mainDir = dirname(fileURLToPath(import.meta.url));
const HOST_ENTRY = join(mainDir, "host.js");

const log = (message: string): void => {
  process.stdout.write(`[abb-main] ${message}\n`);
};

// ==================== 单实例 ====================

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap(): void {
  let mainWindow: BrowserWindow | null = null;

  const windowOptions = {
    mainDir,
    devServerUrl: process.env["ELECTRON_RENDERER_URL"],
  };
  const appOrigin = resolveAppOrigin(windowOptions);

  // 数据根目录只在这里决定一次，经环境变量交给后端进程
  const dataRoot = resolveDataRoot({
    env: process.env,
    isPackaged: app.isPackaged,
    exePath: process.execPath,
    appPath: app.getAppPath(),
  });
  log(`数据目录: ${dataRoot}`);

  const host = new HostClient({
    spawn: createUtilitySpawner({ entry: HOST_ENTRY, env: { ABB_DATA_ROOT: dataRoot } }),
    log: (m) => log(`host: ${m}`),
    // stop 超时后补一刀，避免不响应的后端进程残留
    forceKill: (pid) => process.kill(pid, "SIGKILL"),
  });

  /** 状态变化推给渲染层（窗口可能尚未创建或已关闭，需判空） */
  host.onStatus((status: HostStatus) => {
    log(`后端状态 → ${status.state}${status.detail ? `（${status.detail}）` : ""}`);
    const wc = mainWindow?.webContents;
    if (wc && !wc.isDestroyed()) wc.send(IPC.event.hostStatus, status);
  });

  /** 后端主动推送的事件（任务日志 / 进度 / 结束）：只转发白名单里的事件通道 */
  host.onEvent((channel, payload) => {
    if (!isEventChannel(channel)) {
      log(`丢弃后端推送的未登记事件: ${channel}`);
      return;
    }
    const wc = mainWindow?.webContents;
    if (wc && !wc.isDestroyed()) wc.send(channel, payload);
  });

  const registrar = createIpcRegistrar(ipcMain, createBackendRouter(host), {
    // 只接受本应用渲染层页面发来的请求（与窗口的导航拦截双重把关）
    isTrustedSender: (event) => isAppUrl(senderFrameUrl(event), appOrigin),
    log,
  });
  registerAppHandlers(registrar, {
    getVersionInfo: (): AppVersionInfo => ({
      appName: app.getName(),
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      dataRoot,
    }),
    host: {
      getStatus: () => host.getStatus(),
      restart: () => host.restart(),
    },
  });
  registrar.install();

  const openWindow = (): void => {
    mainWindow = createMainWindow(windowOptions);
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  };

  // 第二个实例启动时，把已有窗口拉到前台
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    void host.start();
    openWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) openWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // 有序退出：进入关闭流程（此后「重启」不会再拉起新进程），停掉后端进程，再真正退出
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void host.shutdown().finally(() => app.quit());
  });
}
