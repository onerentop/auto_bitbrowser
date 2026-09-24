/**
 * 应用外壳：左侧分组导航 + 状态灯 + 内容区 + 底部任务坞
 *
 * 侧栏按 工作台 / Google 操作 / 工具 / 系统 分组；底部状态灯显示后端与 ixBrowser，点击进入运行状态页。
 * 不引路由库：页面只有几个，用 state 切换即可；切走的页面保持挂载（display:none），
 * 避免表格筛选、滚动位置等状态在切换时丢失。
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Layout, Menu, Typography, type MenuProps } from "antd";
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
import { StatusLights } from "./components/StatusLights.tsx";
import { useHostStatus } from "./stores/host-status.ts";
import { setIxPolling } from "./stores/ix-status.ts";
import { useTokens } from "./theme/tokens.ts";
import { initThemeFromConfig } from "./pages/settings/theme-init.ts";
import type { AiTaskKind } from "../../shared/channels/ai-tasks.ts";

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
  group: PageGroup;
  label: string;
  icon: ReactElement;
  render: () => ReactElement;
}

/** 侧栏分组（顺序即显示顺序） */
const PAGE_GROUPS = ["工作台", "Google 操作", "工具", "系统"] as const;
type PageGroup = (typeof PAGE_GROUPS)[number];

/** AI 任务页（6 个导航项共用一个组件） */
const aiPage = (key: PageKey, kind: AiTaskKind, label: string, icon: ReactElement): PageDef => ({
  key,
  group: "Google 操作",
  label,
  icon,
  render: () => <AiTaskPage kind={kind} label={label} />,
});

/** 导航顺序与文案 */
const PAGES: PageDef[] = [
  { key: "home", group: "工作台", label: "窗口", icon: <HomeOutlined />, render: () => <HomePage /> },
  { key: "accounts", group: "工作台", label: "账号", icon: <TeamOutlined />, render: () => <AccountsPage /> },
  aiPage("ai_replace_phone", "replace_phone", "替换手机号", <PhoneOutlined />),
  aiPage("ai_replace_email", "replace_email", "替换辅助邮箱", <MailOutlined />),
  aiPage("ai_modify_2sv", "modify_2sv", "修改 2SV 手机", <SafetyOutlined />),
  aiPage("ai_modify_auth", "modify_auth", "修改验证器", <KeyOutlined />),
  aiPage("ai_kick_devices", "kick_devices", "踢出设备", <DisconnectOutlined />),
  aiPage("ai_change_password", "change_password", "修改密码", <LockOutlined />),
  { key: "totp", group: "工具", label: "导入 TOTP", icon: <QrcodeOutlined />, render: () => <TotpImportPage /> },
  { key: "settings", group: "系统", label: "设置", icon: <SettingOutlined />, render: () => <SettingsPage /> },
  { key: "status", group: "系统", label: "运行状态", icon: <DashboardOutlined />, render: () => <StatusPage /> },
];

/** 侧栏菜单：按分组组装，分组标题用 antd Menu 的 group */
const MENU_ITEMS: MenuProps["items"] = PAGE_GROUPS.map((g) => ({
  type: "group" as const,
  key: `group:${g}`,
  label: g,
  children: PAGES.filter((p) => p.group === g).map((p) => ({ key: p.key, label: p.label, icon: p.icon })),
}));

export function App(): ReactElement {
  const [page, setPage] = useState<PageKey>("home");
  const [visited, setVisited] = useState<Set<PageKey>>(() => new Set(["home"]));
  const t = useTokens();
  const hostReady = useHostStatus()?.state === "ready";

  // 启动时读取已保存的主题配置。
  // 只在后端首次就绪时读一次：之后的重启不再覆盖用户在设置页里尚未保存的主题选择。
  const themeLoaded = useRef(false);
  useEffect(() => {
    if (!hostReady || themeLoaded.current) return;
    themeLoaded.current = true;
    void initThemeFromConfig();
  }, [hostReady]);

  // 侧栏的 ixBrowser 状态灯：后端就绪时轮询，未就绪时停
  useEffect(() => {
    setIxPolling(hostReady);
    return () => setIxPolling(false);
  }, [hostReady]);

  const go = (key: PageKey): void => {
    setPage(key);
    setVisited((v) => (v.has(key) ? v : new Set(v).add(key)));
  };

  return (
    <Layout style={{ height: "100vh" }}>
      <Sider width={208} style={{ borderRight: `1px solid ${t.line}` }}>
        <nav aria-label="主导航" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <div style={{ padding: "18px 20px 10px" }}>
            <Typography.Text strong style={{ fontSize: 14, display: "block" }}>
              ixBrowser 管理工具
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Google 账号批量管理
            </Typography.Text>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            <Menu
              mode="inline"
              selectedKeys={[page]}
              items={MENU_ITEMS}
              onClick={(e) => go(e.key as PageKey)}
              style={{ borderInlineEnd: "none" }}
            />
          </div>
          <StatusLights onOpen={() => go("status")} />
        </nav>
      </Sider>
      <Layout>
        <Content style={{ overflow: "auto", padding: "20px 24px" }}>
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
