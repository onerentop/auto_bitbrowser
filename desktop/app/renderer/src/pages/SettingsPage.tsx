/**
 * 设置页（配置 / 代理 / 账号数据）—— 对标 gui/setting_interface.py 的 SettingInterface
 *
 * Python 用 Pivot + StackedWidget 切换三个标签；这里用 antd Tabs。
 * 标签切走时不卸载（antd Tabs 默认保留已渲染的面板），每个标签自带「刷新」按钮。
 */
import type { ReactElement } from "react";
import { Tabs, Typography } from "antd";
import { AccountsTab } from "./settings/AccountsTab.tsx";
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
          { key: "accounts", label: "账号数据", children: <AccountsTab /> },
          { key: "history", label: "任务历史", children: <TaskHistoryTab /> },
        ]}
      />
    </div>
  );
}
