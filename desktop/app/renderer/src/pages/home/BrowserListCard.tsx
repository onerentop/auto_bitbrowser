/**
 * 窗口列表卡片 —— 对标 gui/home_interface.py:163-219（工具栏 + 树形控件 + 加载进度）
 *
 * 两级结构用「可展开的 Table + 行勾选」实现：
 *   一级：分组 `📁 {分组名} ({数量})`，三态勾选（checkStrictly=false，由子项推导），默认展开
 *   二级：名称 / 窗口ID / 2FA验证码（恒为空） / 备注
 * 勾选状态只记录窗口 key；分组的全选 / 半选由 antd 自动推导。
 * 过滤 / 全选 / 取选中 ID 全部走 src/application/home-tree.ts 的纯函数。
 */
import { useEffect, useMemo, useState, type Key, type ReactElement } from "react";
import { Button, Card, Checkbox, Input, Space, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DeleteOutlined, EyeOutlined, SyncOutlined } from "@ant-design/icons";
import type { HomeBrowserNode, HomeGroupNode } from "../../../../shared/channels/home.ts";
import {
  filterBrowserTree,
  groupLabel,
  selectAllVisible,
  selectedProfileIds,
} from "../../../../../src/application/home-tree.ts";

export interface BrowserListCardProps {
  groups: HomeGroupNode[];
  loading: boolean;
  /** 有任务在运行时禁用打开 / 删除（全局单任务互斥） */
  busy: boolean;
  onRefresh: () => void;
  onOpen: (ids: number[]) => void;
  onDelete: (ids: number[]) => void;
}

type Row =
  | { key: string; kind: "group"; group: HomeGroupNode; children?: Row[] }
  | { key: string; kind: "browser"; browser: HomeBrowserNode };

const isBrowserKey = (k: string): boolean => k.startsWith("b:");

const columns: ColumnsType<Row> = [
  {
    title: "名称",
    key: "name",
    width: 260,
    render: (_, row) =>
      row.kind === "group" ? <Typography.Text strong>{groupLabel(row.group)}</Typography.Text> : row.browser.name,
  },
  {
    title: "窗口ID",
    key: "id",
    width: 110,
    render: (_, row) => (row.kind === "browser" ? (row.browser.profileId ?? "") : ""),
  },
  {
    title: "2FA验证码",
    key: "tfa",
    width: 110,
    render: (_, row) => (row.kind === "browser" ? row.browser.tfaCode : ""),
  },
  {
    title: "备注",
    key: "note",
    ellipsis: true,
    render: (_, row) => (row.kind === "browser" ? row.browser.note : ""),
  },
];

export function BrowserListCard(props: BrowserListCardProps): ReactElement {
  const { groups } = props;
  const [search, setSearch] = useState("");
  const [checked, setChecked] = useState<string[]>([]);
  const [selectAll, setSelectAll] = useState(false);
  const [expanded, setExpanded] = useState<readonly Key[]>([]);

  // 对标 refreshBrowserList（:249-250）：刷新后清空勾选、取消「全选」；分组默认展开（:340）
  useEffect(() => {
    setChecked([]);
    setSelectAll(false);
    setExpanded(groups.map((g) => g.key));
  }, [groups]);

  const visible = useMemo(() => filterBrowserTree(groups, search, []).groups, [groups, search]);

  const rows = useMemo<Row[]>(
    () =>
      visible.map((g) => ({
        key: g.key,
        kind: "group" as const,
        group: g,
        // 空分组不给 children，避免出现无内容的展开按钮
        children: g.browsers.length
          ? g.browsers.map((b) => ({ key: b.key, kind: "browser" as const, browser: b }))
          : undefined,
      })),
    [visible],
  );

  /** 对标 _filterBrowserTree（:369-399）：被隐藏的项取消勾选，「全选」复位 */
  const onSearch = (text: string): void => {
    setSearch(text);
    setChecked((prev) => filterBrowserTree(groups, text, prev).checkedKeys);
    setSelectAll(false);
  };

  /** 对标 _toggleSelectAll（:401-411）：只作用于可见项 */
  const onSelectAll = (value: boolean): void => {
    setSelectAll(value);
    setChecked((prev) => selectAllVisible(visible, prev, value));
  };

  const ids = selectedProfileIds(visible, checked);

  return (
    <Card size="small" style={{ flex: 1, minHeight: 0 }}>
      <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 12 }} wrap>
        <Space wrap>
          <Button icon={<SyncOutlined />} onClick={props.onRefresh} loading={props.loading}>
            刷新列表
          </Button>
          <Checkbox checked={selectAll} onChange={(e) => onSelectAll(e.target.checked)}>
            全选
          </Checkbox>
          <Input.Search
            placeholder="搜索邮箱/名称..."
            allowClear
            style={{ width: 200 }}
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
          <Typography.Text type="secondary">已选 {ids.length} 个</Typography.Text>
        </Space>
        <Space wrap>
          <Button icon={<EyeOutlined />} disabled={props.busy} onClick={() => props.onOpen(ids)}>
            打开选中
          </Button>
          <Button danger icon={<DeleteOutlined />} disabled={props.busy} onClick={() => props.onDelete(ids)}>
            删除选中
          </Button>
        </Space>
      </Space>

      <Table<Row>
        size="small"
        columns={columns}
        dataSource={rows}
        loading={{ spinning: props.loading, tip: "正在加载窗口列表..." }}
        pagination={false}
        scroll={{ y: 480 }}
        expandable={{
          expandedRowKeys: expanded,
          onExpandedRowsChange: (keys) => setExpanded(keys),
          indentSize: 15,
        }}
        rowSelection={{
          checkStrictly: false,
          selectedRowKeys: checked,
          onChange: (keys) => setChecked(keys.map(String).filter(isBrowserKey)),
          getCheckboxProps: (row) => ({
            disabled: row.kind === "group" && row.group.browsers.length === 0,
          }),
        }}
      />
    </Card>
  );
}
