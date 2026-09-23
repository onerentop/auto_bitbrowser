/**
 * 渲染层全局类型：预加载脚本注入的 window.abb
 */
import type { AbbBridge } from "../../shared/ipc.ts";

declare global {
  interface Window {
    /** 直接用浏览器打开页面时不存在，故为可选 */
    abb?: AbbBridge;
  }
}

export {};
