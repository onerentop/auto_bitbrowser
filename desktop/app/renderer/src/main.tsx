/**
 * 渲染层入口：挂载 React，套上 Ant Design 的中文语言包与主题
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { App } from "./App.tsx";

const container = document.getElementById("root");
if (!container) throw new Error("找不到挂载点 #root");

createRoot(container).render(
  <StrictMode>
    <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: "#1677ff", borderRadius: 6 } }}>
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </StrictMode>,
);
