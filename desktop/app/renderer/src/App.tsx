/**
 * 应用外壳：左侧导航 + 内容区 + 底部任务坞
 *
 * 对标 Python 的 FluentWindow 左导航（gui/main_window_fluent.py）。
 * 不引路由库：页面只有几个，用 state 切换即可；切走的页面保持挂载（display:none），
 * 避免表格筛选、滚动位置等状态在切换时丢失（对标 Qt 的 StackedWidget）。
 */
import { useState, type ReactElement } from "react";
import { Layout, Menu, Typography } from "antd";
import { DashboardOutlined, HomeOutlined, SettingOutlined, TeamOutlined } from "@ant-design/icons";
import { TaskDock } from "./components/TaskDock.tsx";
import { StatusPage } from "./pages/StatusPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { AccountsPage } from "./pages/AccountsPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { useIsDark } from "./stores/theme.ts";

const { Sider, Content } = Layout;

type PageKey = "home" | "accounts" | "settings" | "status";

interface PageDef {
  key: PageKey;
  label: string;
  icon: ReactElement;
  render: () => ReactElement;
}

const PAGES: PageDef[] = [
  { key: "home", label: "首页", icon: <HomeOutlined />, render: () => <HomePage /> },
  { key: "accounts", label: "账号管理", icon: <TeamOutlined />, render: () => <AccountsPage /> },
  { key: "settings", label: "设置", icon: <SettingOutlined />, render: () => <SettingsPage /> },
  { key: "status", label: "运行状态", icon: <DashboardOutlined />, render: () => <StatusPage /> },
];

export function App(): ReactElement {
  const [page, setPage] = useState<PageKey>("home");
  const [visited, setVisited] = useState<Set<PageKey>>(() => new Set(["home"]));
  const dark = useIsDark();

  const go = (key: PageKey): void => {
    setPage(key);
    setVisited((v) => (v.has(key) ? v : new Set(v).add(key)));
  };

  return (
    <Layout style={{ height: "100vh" }}>
      <Sider width={176} theme={dark ? "dark" : "light"} style={{ borderRight: "1px solid rgba(128,128,128,0.2)" }}>
        <div style={{ padding: "16px 16px 8px" }}>
          <Typography.Text strong style={{ fontSize: 15 }}>
            ixBrowser 管理工具
          </Typography.Text>
        </div>
        <Menu
          mode="inline"
          theme={dark ? "dark" : "light"}
          selectedKeys={[page]}
          items={PAGES.map((p) => ({ key: p.key, label: p.label, icon: p.icon }))}
          onClick={(e) => go(e.key as PageKey)}
          style={{ borderInlineEnd: "none" }}
        />
      </Sider>
      <Layout>
        <Content style={{ overflow: "auto", padding: 16 }}>
          {PAGES.filter((p) => visited.has(p.key)).map((p) => (
            <div key={p.key} style={{ display: p.key === page ? "block" : "none", height: "100%" }}>
              {p.render()}
            </div>
          ))}
        </Content>
        <TaskDock />
      </Layout>
    </Layout>
  );
}
