/**
 * 批量导入对话框（多行文本 → 实时解析预览 → 导入）
 *
 * 多行文本 → 实时解析预览（#、各列、状态）→ 有效 / 无效计数 → 「导入」。
 * 预览用 app/shared/logic/settings-data.ts 的纯函数；后端导入时用同一函数重新解析，不信任预览结果。
 */
import { useDeferredValue, useMemo, useState, type ReactElement } from "react";
import { App, Input, Modal, Space, Table, Typography } from "antd";
import type { ImportResultDto } from "../../../shared/channels/settings.ts";
import {
  countImportRows,
  parseImportText,
  truncateInvalidLine,
  type LineParseResult,
} from "../../../shared/logic/settings-data.ts";
import { describeError } from "../lib/ipc.ts";
import { useTokens } from "../theme/tokens.ts";
import { usePagination } from "./use-pagination.ts";

export interface BatchImportModalProps<T> {
  open: boolean;
  title: string;
  formatHint: string;
  columns: readonly string[];
  parseLine: (line: string) => LineParseResult<T>;
  formatPreviewRow: (data: T) => readonly string[];
  /** 提交原始文本给后端；返回导入统计 */
  onImport: (text: string) => Promise<ImportResultDto>;
  onClose: () => void;
  /** 导入完成后回调（刷新列表） */
  onDone: () => void;
}

interface PreviewRow {
  key: number;
  cells: string[];
  ok: boolean;
  status: string;
}

export function BatchImportModal<T>(props: BatchImportModalProps<T>): ReactElement {
  const { message } = App.useApp();
  const t = useTokens();
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const deferredText = useDeferredValue(text);
  const { parseLine, formatPreviewRow, columns } = props;

  const rows = useMemo(() => parseImportText(deferredText, parseLine), [deferredText, parseLine]);
  const counts = countImportRows(rows);

  const preview: PreviewRow[] = useMemo(
    () =>
      rows.map((r) => {
        if (r.result.ok) {
          return { key: r.no, cells: [...formatPreviewRow(r.result.data)], ok: true, status: "✓" };
        }
        // 无效行只在第一列显示截断后的原文
        return { key: r.no, cells: [truncateInvalidLine(r.line)], ok: false, status: `✗ ${r.result.error}` };
      }),
    [rows, formatPreviewRow],
  );
  // 分页：粘贴内容变化（预览重新解析）时回到第 1 页
  const pager = usePagination("importPreview", preview.length, [preview]);

  const close = (): void => {
    setText("");
    props.onClose();
  };

  /** 提交导入；后端会用同一纯函数重新解析，不信任预览结果 */
  const submit = async (): Promise<void> => {
    const current = parseImportText(text, parseLine);
    if (countImportRows(current).valid === 0) {
      message.warning("没有可导入的有效数据");
      return;
    }
    setSubmitting(true);
    try {
      const r = await props.onImport(text);
      message.success(`成功导入 ${r.success_count} 条记录` + (r.fail_count > 0 ? `，失败 ${r.fail_count} 条` : ""));
      close();
      props.onDone();
    } catch (e) {
      message.error(`导入失败: ${describeError(e)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const tableColumns = [
    { title: "#", key: "no", width: 50, className: "abb-num", render: (_: unknown, r: PreviewRow) => r.key },
    ...columns.map((c, i) => ({
      title: c,
      key: `c${i}`,
      ellipsis: true,
      render: (_: unknown, r: PreviewRow) => r.cells[i] ?? "",
    })),
    {
      title: "状态",
      key: "status",
      // 状态色走 antd 语义色（主题中映射到 ok / bad 令牌）
      render: (_: unknown, r: PreviewRow) => (
        <Typography.Text type={r.ok ? "success" : "danger"}>{r.status}</Typography.Text>
      ),
    },
  ];

  return (
    <Modal
      open={props.open}
      title={props.title}
      width={760}
      okText="导入"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={() => void submit()}
      onCancel={close}
      destroyOnHidden
      maskClosable={false}
    >
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        {/* 格式说明：浅底提示条，不再用卡片 */}
        <div style={{ background: t.canvas, border: `1px solid ${t.line}`, borderRadius: 6, padding: "8px 12px" }}>
          <Typography.Text type="secondary">格式: {props.formatHint}</Typography.Text>
        </div>
        <Typography.Text>粘贴数据，每行一条记录</Typography.Text>
        <Input.TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="在此粘贴数据..."
          autoSize={{ minRows: 4, maxRows: 6 }}
        />
        <Typography.Text style={{ marginTop: 4 }}>解析预览</Typography.Text>
        <Table<PreviewRow>
          size="small"
          rowKey="key"
          columns={tableColumns}
          dataSource={preview}
          pagination={pager.pagination}
          scroll={{ y: 240 }}
        />
        <Typography.Text type="secondary">
          有效 <Typography.Text type="success" className="abb-num">{counts.valid}</Typography.Text> 条，无效{" "}
          <Typography.Text type={counts.invalid > 0 ? "danger" : "secondary"} className="abb-num">
            {counts.invalid}
          </Typography.Text>{" "}
          条
        </Typography.Text>
      </Space>
    </Modal>
  );
}
