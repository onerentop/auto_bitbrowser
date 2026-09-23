/**
 * 匹配结果表格 —— 对标 _createTable（:486-525）+ _updateTable（:753-826）
 *
 * 7 列：选择 / 提取邮箱 / 来源 / 密钥(前16位) / 匹配账号 / 当前密钥(前8位) / 状态。
 * 「未匹配」行不可勾选（:774）。
 */
import type { ReactElement } from "react";
import { Table, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  TOTP_STATUS_COLORS,
  TOTP_STATUS_TEXT,
  type TotpEntry,
  type TotpMatchRow,
} from "../../../../shared/channels/totp.ts";

export interface ResultRow {
  /** 在 entries 里的下标（行键） */
  index: number;
  entry: TotpEntry;
  match: TotpMatchRow;
}

const GREY = "#888888";

/** 密钥显示前 16 位（:792-793） */
function secretDisplay(secret: string): string {
  return secret.length > 16 ? `${secret.slice(0, 16)}...` : secret;
}

const columns: ColumnsType<ResultRow> = [
  {
    title: "提取邮箱",
    key: "email",
    ellipsis: true,
    // :784 extracted_email or otp_acc.name
    render: (_, r) => r.entry.email || r.entry.name,
  },
  {
    title: "来源",
    key: "issuer",
    width: 100,
    ellipsis: true,
    // :788 issuer or "-"
    render: (_, r) => r.entry.issuer || "-",
  },
  {
    title: "密钥",
    key: "secret",
    width: 190,
    render: (_, r) => (
      <Tooltip title={r.entry.secret}>
        <Typography.Text code>{secretDisplay(r.entry.secret)}</Typography.Text>
      </Tooltip>
    ),
  },
  {
    title: "匹配账号",
    key: "matched",
    ellipsis: true,
    render: (_, r) =>
      r.match.matchedEmail ? r.match.matchedEmail : <span style={{ color: GREY }}>未匹配</span>,
  },
  {
    title: "当前密钥",
    key: "current",
    width: 120,
    // :806-817：匹配到且有密钥 → 前 8 位；匹配到无密钥 → 灰色「无」；未匹配 → "-"
    render: (_, r) => {
      if (r.match.currentSecret === null) return "-";
      if (!r.match.currentSecret) return <span style={{ color: GREY }}>无</span>;
      return r.match.currentSecret;
    },
  },
  {
    title: "状态",
    key: "status",
    width: 90,
    render: (_, r) => (
      <span style={{ color: TOTP_STATUS_COLORS[r.match.status] }}>{TOTP_STATUS_TEXT[r.match.status]}</span>
    ),
  },
];

export interface ResultTableProps {
  rows: ResultRow[];
  selected: ReadonlySet<number>;
  onSelectedChange: (next: Set<number>) => void;
}

export function ResultTable({ rows, selected, onSelectedChange }: ResultTableProps): ReactElement {
  return (
    <Table<ResultRow>
      size="small"
      rowKey="index"
      columns={columns}
      dataSource={rows}
      pagination={false}
      scroll={{ y: 360 }}
      locale={{ emptyText: "暂无数据" }}
      rowSelection={{
        // 表头用文字「选择」代替 antd 自带的全选框（全选由上方的「全选」复选框负责，:246）
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
  );
}
