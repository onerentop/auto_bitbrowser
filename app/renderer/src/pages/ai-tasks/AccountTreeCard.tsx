/**
 * AI 任务页的账号树（分组 / 窗口两级，带状态着色）
 *
 * 两级结构用「可展开的 Table + 行勾选」实现（与首页 BrowserListCard 相同的做法）：
 *   一级：分组 `📁 {分组名} ({数量})`，三态勾选（checkStrictly=false，由子项推导），默认展开
 *   二级：名称/邮箱 / 窗口ID / 状态 / 消息
 * 行底色按任务逐行状态着色。
 */
import { useEffect, useMemo, useState, type Key, type ReactElement } from "react";
import { Card, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { AiTaskBrowserNode } from "../../../../shared/channels/ai-tasks.ts";
import { TONE_BACKGROUND, isSelectable, statusTone, type VisibleGroup } from "./tree.ts";

/** 任务推送的逐行状态（key 为 email） */
export interface RowRuntime {
  status: string;
  message: string;
}

export interface AccountTreeCardProps {
  groups: VisibleGroup[];
  loading: boolean;
  checkedKeys: string[];
  onCheckedChange: (keys: string[]) => void;
  runtime: Readonly<Record<string, RowRuntime>>;
}

type Row =
  | { key: string; kind: "group"; group: VisibleGroup; children?: Row[] }
  | { key: string; kind: "browser"; browser: AiTaskBrowserNode };

const isBrowserKey = (k: string): boolean => k.startsWith("b:");

export function AccountTreeCard(props: AccountTreeCardProps): ReactElement {
  const { groups, runtime } = props;
  const [expanded, setExpanded] = useState<readonly Key[]>([]);

  // 重新加载 / 切换筛选后分组默认展开
  useEffect(() => {
    setExpanded(groups.map((g) => g.key));
  }, [groups]);

  const rows = useMemo<Row[]>(
    () =>
      groups.map((g) => ({
        key: g.key,
        kind: "group" as const,
        group: g,
        // 没有可见窗口的分组不给 children，避免出现无内容的展开按钮
        children: g.browsers.length
          ? g.browsers.map((b) => ({ key: b.key, kind: "browser" as const, browser: b }))
          : undefined,
      })),
    [groups],
  );

  const columns = useMemo<ColumnsType<Row>>(() => {
    const cellStyle = (row: Row): { style?: { background: string } } => {
      if (row.kind !== "browser") return {};
      const rt = runtime[row.browser.name];
      return rt ? { style: { background: TONE_BACKGROUND[statusTone(rt.status)] } } : {};
    };
    return [
      {
        title: "名称/邮箱",
        key: "name",
        width: 280,
        onCell: cellStyle,
        render: (_, row) =>
          row.kind === "group" ? (
            <Typography.Text strong>{`📁 ${row.group.groupName} (${row.group.totalInGroup})`}</Typography.Text>
          ) : (
            row.browser.name
          ),
      },
      {
        title: "窗口ID",
        key: "id",
        width: 100,
        onCell: cellStyle,
        render: (_, row) => (row.kind === "browser" ? (row.browser.profileId ?? "") : ""),
      },
      {
        title: "状态",
        key: "status",
        width: 110,
        onCell: cellStyle,
        // 任务开始前显示账号状态；任务推送后显示处理状态
        render: (_, row) => (row.kind === "browser" ? (runtime[row.browser.name]?.status ?? row.browser.status) : ""),
      },
      {
        title: "消息",
        key: "message",
        ellipsis: true,
        onCell: cellStyle,
        render: (_, row) => (row.kind === "browser" ? (runtime[row.browser.name]?.message ?? "") : ""),
      },
    ];
  }, [runtime]);

  return (
    <Card size="small" style={{ flex: 1, minHeight: 0 }}>
      <Table<Row>
        size="small"
        columns={columns}
        dataSource={rows}
        loading={{ spinning: props.loading, tip: "正在加载数据..." }}
        pagination={false}
        scroll={{ y: 480 }}
        expandable={{
          expandedRowKeys: expanded,
          onExpandedRowsChange: (keys) => setExpanded(keys),
          indentSize: 15,
        }}
        rowSelection={{
          columnTitle: "选择",
          columnWidth: 60,
          checkStrictly: false,
          selectedRowKeys: props.checkedKeys,
          onChange: (keys) => props.onCheckedChange(keys.map(String).filter(isBrowserKey)),
          getCheckboxProps: (row) => ({
            disabled:
              row.kind === "group" ? !row.group.browsers.some(isSelectable) : !isSelectable(row.browser),
          }),
        }}
      />
    </Card>
  );
}
