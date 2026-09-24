/**
 * 设置页（配置 / 代理 / 任务历史）
 *
 * 页头 + antd Tabs；各标签自成一块面板。切走时不卸载（antd Tabs 默认保留已渲染的面板），每个标签自带「刷新」按钮。
 * 账号数据（添加 / 编辑 / 导入 / 导出）已迁到「账号管理」页。
 */
import type { ReactElement } from "react";
import { Tabs } from "antd";
import { PageHeader } from "../components/PageHeader.tsx";
import { ConfigTab } from "./settings/ConfigTab.tsx";
import { ProxiesTab } from "./settings/ProxiesTab.tsx";
import { TaskHistoryTab } from "./settings/TaskHistoryTab.tsx";

export function SettingsPage(): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <PageHeader title="设置" description="管理 AI 服务、超时与外观等配置，维护代理池，查看历次批量任务的结果。" />
      <Tabs
        defaultActiveKey="config"
        items={[
          { key: "config", label: "配置", children: <ConfigTab /> },
          { key: "proxies", label: "代理", children: <ProxiesTab /> },
          { key: "history", label: "任务历史", children: <TaskHistoryTab /> },
        ]}
      />
    </div>
  );
}
