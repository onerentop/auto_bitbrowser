/**
 * 应用外壳：左侧分组导航（可收起为图标窄栏）+ 状态灯 + 内容区 + 底部任务坞
 *
 * 侧栏按 工作台 / Google 操作 / 系统 分组。
 * 2026-09-26 收敛：原「窗口」页并入账号页（窗口视角）、「导入 TOTP」并入账号页动作、
 * 「运行状态」并入设置页标签，侧栏因此只剩三条主入口。
 * 底部状态灯显示后端与 ixBrowser，点击进入设置页的「运行状态」标签。
 * 不引路由库：页面只有几个，用 state 切换即可；切走的页面保持挂载（display:none），
 * 避免表格筛选、滚动位置等状态在切换时丢失。
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Button, Layout, Menu, Tooltip, Typography, type MenuProps } from "antd";
import {
  DisconnectOutlined,
  KeyOutlined,
  LockOutlined,
  MailOutlined,
  PhoneOutlined,
  SafetyOutlined,
  SettingOutlined,
  TeamOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from "@ant-design/icons";
import { TaskDock } from "./components/TaskDock.tsx";
import { AccountsPage } from "./pages/AccountsPage.tsx";
import { SettingsPage, type SettingsTabKey } from "./pages/SettingsPage.tsx";
import { AiTaskPage } from "./pages/AiTaskPage.tsx";
import { StatusLights } from "./components/StatusLights.tsx";
import { useHostStatus } from "./stores/host-status.ts";
import { setIxPolling } from "./stores/ix-status.ts";
import { useTokens } from "./theme/tokens.ts";
import { initThemeFromConfig } from "./pages/settings/theme-init.ts";
import { SIDER_COLLAPSED_KEY, parseCollapsed } from "./lib/ui-prefs.ts";
import type { AiTaskKind } from "../../shared/channels/ai-tasks.ts";

const { Sider, Content } = Layout;

type PageKey =
  | "accounts"
  | "ai_replace_phone"
  | "ai_replace_email"
  | "ai_modify_2sv"
  | "ai_modify_auth"
  | "ai_kick_devices"
  | "ai_change_password"
  | "settings";

interface PageDef {
  key: PageKey;
  group: PageGroup;
  label: string;
  icon: ReactElement;
  /** AI 任务页用它渲染；其余页面按 key 渲染 */
  kind?: AiTaskKind;
}

/** 侧栏分组（顺序即显示顺序） */
const PAGE_GROUPS = ["工作台", "Google 操作", "系统"] as const;
type PageGroup = (typeof PAGE_GROUPS)[number];

/** AI 任务页（6 个导航项共用一个组件） */
const aiPage = (key: PageKey, kind: AiTaskKind, label: string, icon: ReactElement): PageDef => ({
  key,
  group: "Google 操作",
  label,
  icon,
  kind,
});

/** 导航顺序与文案 */
const PAGES: PageDef[] = [
  { key: "accounts", group: "工作台", label: "账号", icon: <TeamOutlined /> },
  aiPage("ai_replace_phone", "replace_phone", "替换手机号", <PhoneOutlined />),
  aiPage("ai_replace_email", "replace_email", "替换辅助邮箱", <MailOutlined />),
  aiPage("ai_modify_2sv", "modify_2sv", "修改 2SV 手机", <SafetyOutlined />),
  aiPage("ai_modify_auth", "modify_auth", "修改验证器", <KeyOutlined />),
  aiPage("ai_kick_devices", "kick_devices", "踢出设备", <DisconnectOutlined />),
  aiPage("ai_change_password", "change_password", "修改密码", <LockOutlined />),
  { key: "settings", group: "系统", label: "设置", icon: <SettingOutlined /> },
];

/** 侧栏菜单：按分组组装，分组标题用 antd Menu 的 group */
const MENU_ITEMS: MenuProps["items"] = PAGE_GROUPS.map((g) => ({
  type: "group" as const,
  key: `group:${g}`,
  label: g,
  children: PAGES.filter((p) => p.group === g).map((p) => ({ key: p.key, label: p.label, icon: p.icon })),
}));

/** 侧栏收起时的菜单：只剩图标，分组标题换成分隔线（菜单名由 antd 在悬停时提示） */
const MENU_ITEMS_COLLAPSED: MenuProps["items"] = PAGE_GROUPS.flatMap((g, i) => [
  ...(i > 0 ? [{ type: "divider" as const, key: `divider:${g}` }] : []),
  ...PAGES.filter((p) => p.group === g).map((p) => ({ key: p.key, label: p.label, icon: p.icon })),
]);

/** 侧栏收起后的宽度 */
const SIDER_COLLAPSED_WIDTH = 64;

/** 默认落地页：账号（原「窗口」页已并入它的窗口视角） */
const DEFAULT_PAGE: PageKey = "accounts";

function readCollapsed(): boolean {
  try {
    return parseCollapsed(localStorage.getItem(SIDER_COLLAPSED_KEY));
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDER_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // 写不进去只是下次不记住，界面照常可用
  }
}

export function App(): ReactElement {
  const [page, setPage] = useState<PageKey>(DEFAULT_PAGE);
  const [visited, setVisited] = useState<Set<PageKey>>(() => new Set([DEFAULT_PAGE]));
  /**
   * 设置页当前标签：与 SettingsPage 共用同一份状态（页面受控）。
   * 由外壳持有，侧栏状态灯与侧栏导航才点得动第二次——见 SettingsPage 顶部注释。
   */
  const [settingsTab, setSettingsTab] = useState<SettingsTabKey>("config");
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

  /** 状态灯：进设置页的「运行状态」标签 */
  const openStatus = (): void => {
    setSettingsTab("status");
    go("settings");
  };

  const renderPage = (p: PageDef): ReactElement => {
    if (p.kind) return <AiTaskPage kind={p.kind} label={p.label} />;
    if (p.key === "accounts") return <AccountsPage />;
    return <SettingsPage tab={settingsTab} onTabChange={setSettingsTab} />;
  };

  // 侧栏收起：记在 localStorage（纯界面偏好）
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const toggleCollapsed = (): void => {
    const next = !collapsed;
    setCollapsed(next);
    writeCollapsed(next);
  };

  return (
    <Layout style={{ height: "100vh" }}>
      <Sider
        width={208}
        collapsible
        collapsed={collapsed}
        collapsedWidth={SIDER_COLLAPSED_WIDTH}
        trigger={null}
        style={{ borderRight: `1px solid ${t.line}` }}
      >
        <nav aria-label="主导航" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: collapsed ? "center" : "space-between",
              gap: 4,
              padding: collapsed ? "16px 0 8px" : "18px 8px 10px 20px",
            }}
          >
            {!collapsed && (
              <div style={{ minWidth: 0 }}>
                <Typography.Text strong style={{ fontSize: 14, display: "block" }}>
                  ixBrowser 管理工具
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Google 账号批量管理
                </Typography.Text>
              </div>
            )}
            <Tooltip title={collapsed ? "展开侧栏" : "收起侧栏"} placement="right">
              <Button
                type="text"
                aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
                icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                onClick={toggleCollapsed}
              />
            </Tooltip>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
            <Menu
              mode="inline"
              selectedKeys={[page]}
              items={collapsed ? MENU_ITEMS_COLLAPSED : MENU_ITEMS}
              onClick={(e) => go(e.key as PageKey)}
              style={{ borderInlineEnd: "none" }}
            />
          </div>
          <StatusLights onOpen={openStatus} compact={collapsed} />
        </nav>
      </Sider>
      {/* minWidth: 0：flex 子项默认 min-width:auto，会被宽表格撑破窗口；宽表格应在表格内部横向滚动 */}
      <Layout style={{ minWidth: 0 }}>
        <Content style={{ overflow: "auto", padding: "20px 24px" }}>
          {PAGES.filter((p) => visited.has(p.key)).map((p) => (
            <div key={p.key} style={{ display: p.key === page ? "block" : "none", height: "100%" }}>
              {renderPage(p)}
            </div>
          ))}
        </Content>
        <TaskDock />
      </Layout>
    </Layout>
  );
}
