/**
 * 渲染层入口：挂载 React，套上 Ant Design 的中文语言包与「值班台」主题（深浅色随 theme store 切换）
 */
import { StrictMode, useLayoutEffect, useMemo, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { App } from "./App.tsx";
import { useIsDark } from "./stores/theme.ts";
import { applyCssVars, buildTheme } from "./theme/tokens.ts";
import "./theme/app.css";

/** 系统「减少动态效果」设置（启动时读取；改系统设置后重开应用生效） */
const REDUCE_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function Root(): ReactElement {
  const dark = useIsDark();
  const themeConfig = useMemo(() => buildTheme(dark, REDUCE_MOTION), [dark]);
  // 自绘元素（任务坞进度条、焦点框、滚动条）用的 CSS 变量，绘制前写好，避免切换时闪一下
  useLayoutEffect(() => applyCssVars(dark), [dark]);
  return (
    <ConfigProvider locale={zhCN} theme={themeConfig}>
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("找不到挂载点 #root");

/**
 * 容器已有 root 时复用。
 * dev 模式下 HMR 会就地重新求值本模块：再调一次 createRoot 会撞上 React 的
 * "container has already been passed to createRoot()"，React 拒绝挂载，界面直接变空白。
 */
const rootHost = window as unknown as { __abbRoot?: Root };
const root = rootHost.__abbRoot ?? createRoot(container);
rootHost.__abbRoot = root;

root.render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
