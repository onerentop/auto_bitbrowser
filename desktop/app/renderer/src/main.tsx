/**
 * 渲染层入口：挂载 React，套上 Ant Design 的中文语言包与主题（深浅色随 theme store 切换）
 */
import { StrictMode, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { App as AntApp, ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { App } from "./App.tsx";
import { useIsDark } from "./stores/theme.ts";

function Root(): ReactElement {
  const dark = useIsDark();
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { colorPrimary: "#1677ff", borderRadius: 6 },
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("找不到挂载点 #root");

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
