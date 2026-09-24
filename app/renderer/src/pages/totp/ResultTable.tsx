/**
 * 匹配结果表格（放在导入 TOTP 页的结果面板里，高度跟随面板）
 *
 * 7 列：选择 / 提取邮箱 / 来源 / 密钥(前16位) / 匹配账号 / 当前密钥(前8位) / 状态。
 * 「未匹配」行不可勾选。
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Empty, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { TOTP_STATUS_TEXT, type TotpEntry, type TotpMatchRow, type TotpMatchStatus } from "../../../../shared/channels/totp.ts";

export interface ResultRow {
  /** 在 entries 里的下标（行键） */
  index: number;
  entry: TotpEntry;
  match: TotpMatchRow;
}

/** 匹配状态 → antd 语义色（可导入绿、已有密钥橙、未匹配灰），颜色由主题令牌注入 */
const STATUS_TAG_COLOR: Readonly<Record<TotpMatchStatus, string | undefined>> = {
  can_import: "success",
  has_secret: "warning",
  no_match: undefined,
};

/** 密钥显示前 16 位 */
function secretDisplay(secret: string): string {
  return secret.length > 16 ? `${secret.slice(0, 16)}...` : secret;
}

const columns: ColumnsType<ResultRow> = [
  {
    title: "提取邮箱",
    key: "email",
    ellipsis: true,
    // 优先显示提取出的邮箱，否则用条目名
    render: (_, r) => r.entry.email || r.entry.name,
  },
  {
    title: "来源",
    key: "issuer",
    width: 100,
    ellipsis: true,
    // 来源，缺省显示 "-"
    render: (_, r) => r.entry.issuer || <Typography.Text type="secondary">-</Typography.Text>,
  },
  {
    title: "密钥",
    key: "secret",
    width: 190,
    render: (_, r) => (
      <Tooltip title={<span className="abb-mono">{r.entry.secret}</span>}>
        <span className="abb-mono">{secretDisplay(r.entry.secret)}</span>
      </Tooltip>
    ),
  },
  {
    title: "匹配账号",
    key: "matched",
    ellipsis: true,
    render: (_, r) =>
      r.match.matchedEmail ? r.match.matchedEmail : <Typography.Text type="secondary">未匹配</Typography.Text>,
  },
  {
    title: "当前密钥",
    key: "current",
    width: 120,
    // 匹配到且有密钥 → 前 8 位；匹配到无密钥 → 灰色「无」；未匹配 → "-"
    render: (_, r) => {
      if (r.match.currentSecret === null) return <Typography.Text type="secondary">-</Typography.Text>;
      if (!r.match.currentSecret) return <Typography.Text type="secondary">无</Typography.Text>;
      return <span className="abb-mono">{r.match.currentSecret}</span>;
    },
  },
  {
    title: "状态",
    key: "status",
    width: 90,
    render: (_, r) => (
      <Tag bordered={false} color={STATUS_TAG_COLOR[r.match.status]}>
        {TOTP_STATUS_TEXT[r.match.status]}
      </Tag>
    ),
  },
];

export interface ResultTableProps {
  rows: ResultRow[];
  selected: ReadonlySet<number>;
  onSelectedChange: (next: Set<number>) => void;
}

/** 表头占用的高度（表体高度 = 容器高度 - 该值） */
const TABLE_CHROME = 40;

export function ResultTable({ rows, selected, onSelectedChange }: ResultTableProps): ReactElement {
  // 表格高度跟随容器（结果面板占满页面剩余高度）
  const boxRef = useRef<HTMLDivElement>(null);
  const [bodyHeight, setBodyHeight] = useState(360);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setBodyHeight(Math.max(160, Math.floor(entry.contentRect.height) - TABLE_CHROME));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={boxRef} style={{ flex: 1, minHeight: 200 }}>
      <Table<ResultRow>
        size="small"
        rowKey="index"
        columns={columns}
        dataSource={rows}
        pagination={false}
        scroll={{ y: bodyHeight }}
        locale={{
          emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据，先选择 QR 码截图或解析文本" />,
        }}
        rowSelection={{
          // 表头用文字「选择」代替 antd 自带的全选框（全选由结果面板工具栏的「全选」复选框负责）
          columnTitle: "选择",
          columnWidth: 56,
          selectedRowKeys: rows.filter((r) => selected.has(r.index)).map((r) => r.index),
          getCheckboxProps: (r) => ({ disabled: r.match.status === "no_match" }),
          onChange: (keys) => {
            // 只替换当前可见行的勾选状态，隐藏行保持不变
            const next = new Set(selected);
            for (const r of rows) next.delete(r.index);
            for (const k of keys) next.add(Number(k));
            onSelectedChange(next);
          },
        }}
      />
    </div>
  );
}
