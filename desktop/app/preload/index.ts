/**
 * 预加载脚本 —— 渲染层与主进程之间唯一的桥（-Desktop 的 preload/index.cjs）
 *
 * 暴露 window.abb = { invoke, on, channels, platform }：
 *   - invoke 只接受 invoke 通道，on 只接受 event 通道（各自单独校验；
 *     主进程还会再校验一次白名单与请求来源）
 *   - on 返回取消订阅函数，渲染层组件卸载时调用，防止监听泄漏
 *   - 回调只把载荷交给渲染层，不暴露 IpcRendererEvent（其中含 sender 等敏感对象）
 *
 * 开启 sandbox 后本文件必须打包成 CJS（electron.vite.config.ts 里配置为 index.cjs）。
 */
import { contextBridge, ipcRenderer } from "electron";
import { IPC, isEventChannel, isInvokeChannel, type AbbBridge } from "../shared/ipc.ts";

const bridge: AbbBridge = {
  invoke: async (channel, ...args) => {
    if (!isInvokeChannel(channel)) {
      throw new Error(`不是可调用的 IPC 通道: ${String(channel)}`);
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  on: (channel, listener) => {
    if (!isEventChannel(channel)) {
      throw new Error(`不是可订阅的 IPC 事件: ${String(channel)}`);
    }
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      (listener as (p: unknown) => void)(payload);
    };
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },

  channels: IPC,

  // 同步给出平台，渲染层首帧即可据此调整窗口样式，无需一次 IPC 往返
  platform: process.platform,
};

contextBridge.exposeInMainWorld("abb", bridge);
