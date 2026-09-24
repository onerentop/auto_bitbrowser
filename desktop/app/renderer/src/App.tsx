/**
 * 应用外壳：左侧导航 + 内容区 + 底部任务坞
 *
 * 对标 Python 的 FluentWindow 左导航（gui/main_window_fluent.py）。
 * 不引路由库：页面只有几个，用 state 切换即可；切走的页面保持挂载（display:none），
 * 避免表格筛选、滚动位置等状态在切换时丢失（对标 Qt 的 StackedWidget）。
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Layout, Menu, Typography } from "antd";
import {
  DashboardOutlined,
  DisconnectOutlined,
  HomeOutlined,
  KeyOutlined,
  LockOutlined,
  MailOutlined,
  PhoneOutlined,
  QrcodeOutlined,
  SafetyOutlined,
  SettingOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { TaskDock } from "./components/TaskDock.tsx";
import { StatusPage } from "./pages/StatusPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { AccountsPage } from "./pages/AccountsPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { AiTaskPage } from "./pages/AiTaskPage.tsx";
import { TotpImportPage } from "./pages/TotpImportPage.tsx";
import { useIsDark } from "./stores/theme.ts";
import { useHostStatus } from "./stores/host-status.ts";
import { initThemeFromConfig } from "./pages/settings/theme-init.ts";

const { Sider, Content } = Layout;

type PageKey =
  | "home"
  | "ai_replace_phone"
  | "ai_replace_email"
  | "ai_modify_2sv"
  | "ai_modify_auth"
  | "ai_kick_devices"
  | "ai_change_password"
  | "accounts"
  | "totp"
  | "settings"
  | "status";

interface PageDef {
  key: PageKey;
  label: string;
  icon: ReactElement;
  render: () => ReactElement;
}

/** 导航顺序与文案照搬 gui/main_window_fluent.py:89-149（首页 → Google 专区 5 项 → 账号管理 → 导入 TOTP → 设置） */
const PAGES: PageDef[] = [
  { key: "home", label: "首页", icon: <HomeOutlined />, render: () => <HomePage /> },
  {
    key: "ai_replace_phone",
    label: "替换手机号",
    icon: <PhoneOutlined />,
    render: () => <AiTaskPage kind="replace_phone" label="替换手机号" />,
  },
  {
    key: "ai_replace_email",
    label: "替换辅助邮箱",
    icon: <MailOutlined />,
    render: () => <AiTaskPage kind="replace_email" label="替换辅助邮箱" />,
  },
  {
    key: "ai_modify_2sv",
    label: "修改 2SV 手机",
    icon: <SafetyOutlined />,
    render: () => <AiTaskPage kind="modify_2sv" label="修改 2SV 手机" />,
  },
  {
    key: "ai_modify_auth",
    label: "修改验证器",
    icon: <KeyOutlined />,
    render: () => <AiTaskPage kind="modify_auth" label="修改验证器" />,
  },
  {
    key: "ai_kick_devices",
    label: "踢出设备",
    icon: <DisconnectOutlined />,
    render: () => <AiTaskPage kind="kick_devices" label="踢出设备" />,
  },
  {
    key: "ai_change_password",
    label: "修改密码",
    icon: <LockOutlined />,
    render: () => <AiTaskPage kind="change_password" label="修改密码" />,
  },
  { key: "accounts", label: "账号管理", icon: <TeamOutlined />, render: () => <AccountsPage /> },
  { key: "totp", label: "导入 TOTP", icon: <QrcodeOutlined />, render: () => <TotpImportPage /> },
  { key: "settings", label: "设置", icon: <SettingOutlined />, render: () => <SettingsPage /> },
  { key: "status", label: "运行状态", icon: <DashboardOutlined />, render: () => <StatusPage /> },
];

export function App(): ReactElement {
  const [page, setPage] = useState<PageKey>("home");
  const [visited, setVisited] = useState<Set<PageKey>>(() => new Set(["home"]));
  const dark = useIsDark();
  const hostReady = useHostStatus()?.state === "ready";

  // 对标 Python 启动时读取 theme（main_window_fluent.py:151-160）。
  // 只在后端首次就绪时读一次：之后的重启不再覆盖用户在设置页里尚未保存的主题选择。
  const themeLoaded = useRef(false);
  useEffect(() => {
    if (!hostReady || themeLoaded.current) return;
    themeLoaded.current = true;
    void initThemeFromConfig();
  }, [hostReady]);

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
