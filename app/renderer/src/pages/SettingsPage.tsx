/**
 * 设置页（配置 / 代理 / 任务历史）
 *
 * 各标签用 antd Tabs 切换，切走时不卸载（antd Tabs 默认保留已渲染的面板），每个标签自带「刷新」按钮。
 * 账号数据（添加 / 编辑 / 导入 / 导出）已迁到「账号管理」页。
 */
import type { ReactElement } from "react";
import { Tabs, Typography } from "antd";
import { ConfigTab } from "./settings/ConfigTab.tsx";
import { ProxiesTab } from "./settings/ProxiesTab.tsx";
import { TaskHistoryTab } from "./settings/TaskHistoryTab.tsx";

export function SettingsPage(): ReactElement {
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        设置
      </Typography.Title>
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
