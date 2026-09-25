/**
 * 设置页（配置 / 代理 / 任务历史 / 运行状态）
 *
 * 页头 + antd Tabs；各标签自成一块面板。切走时不卸载（antd Tabs 默认保留已渲染的面板），每个标签自带「刷新」按钮。
 * 账号数据（添加 / 编辑 / 导入 / 导出）已迁到「账号管理」页；
 * 运行状态（原独立页）与「创建参数」（原首页配置卡片）也并到这里。
 *
 * 选中标签由外壳（App）持有，本页受控：侧栏状态灯与侧栏导航点的是同一份状态。
 * 曾经在本页另存一份标签 state（外壳传 requestedTab、本页 useEffect 跟随），结果是外壳第二次
 * 点「运行状态」时值没变、React 不重新渲染，effect 不跑，界面停在用户手点的标签上 —— 状态灯
 * 从此永久失效。唯一持有者放在外壳就不会有这个问题。
 */
import type { ReactElement } from "react";
import { Tabs } from "antd";
import { PageHeader } from "../components/PageHeader.tsx";
import { ConfigTab } from "./settings/ConfigTab.tsx";
import { ProxiesTab } from "./settings/ProxiesTab.tsx";
import { TaskHistoryTab } from "./settings/TaskHistoryTab.tsx";
import { StatusTab } from "./settings/StatusTab.tsx";

export type SettingsTabKey = "config" | "proxies" | "history" | "status";

export interface SettingsPageProps {
  /** 当前标签：外壳持有 */
  tab: SettingsTabKey;
  /** 用户点了别的标签 */
  onTabChange: (tab: SettingsTabKey) => void;
}

export function SettingsPage({ tab, onTabChange }: SettingsPageProps): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <PageHeader
        title="设置"
        description="管理 AI 服务、超时、外观与创建窗口参数，维护代理池，查看历次批量任务的结果与运行状态。"
      />
      <Tabs
        activeKey={tab}
        onChange={(k) => onTabChange(k as SettingsTabKey)}
        items={[
          { key: "config", label: "配置", children: <ConfigTab /> },
          { key: "proxies", label: "代理", children: <ProxiesTab /> },
          { key: "history", label: "任务历史", children: <TaskHistoryTab /> },
          { key: "status", label: "运行状态", children: <StatusTab /> },
        ]}
      />
    </div>
  );
}
