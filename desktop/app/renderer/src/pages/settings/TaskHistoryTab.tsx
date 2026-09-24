/**
 * 「任务历史」标签 —— 本地新增能力（原本批量任务结果只打在界面日志里，关掉就没了）
 *
 * 数据来自 TaskRunner 收尾时落库的两张表：task_run_history（任务级）+ task_run_items（逐条目）。
 * 上面是任务列表，选中一条后下面是该次运行的逐条目结果；右上角可导出 CSV。
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { App, Button, Card, Empty, Space, Table, Tag, Typography } from "antd";
import { DownloadOutlined, SyncOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import type { TaskRunItemRow, TaskRunRow } from "../../../../shared/channels/task-history.ts";
import { IPC, describeError, invoke } from "../../lib/ipc.ts";
import { onTaskFinished } from "../../stores/task.ts";

/** 任务结果的颜色（与界面其它地方的成功/失败口径一致） */
function outcomeTag(outcome: string | null): ReactElement {
  const value = outcome ?? "";
  const color = value === "succeeded" ? "green" : value === "stopped" ? "orange" : "red";
  const label = value === "succeeded" ? "成功" : value === "stopped" ? "已停止" : value === "failed" ? "失败" : value || "-";
  return <Tag color={color}>{label}</Tag>;
}

function itemStatusTag(status: string | null): ReactElement {
  const value = status ?? "";
  // 「跳过」等中间状态用中性色：它们既不算成功也不算失败
  const color =
    value === "成功" ? "green" : value === "失败" || value === "错误" ? "red" : value === "处理中" ? "blue" : "default";
  return <Tag color={color}>{value || "-"}</Tag>;
}

export function TaskHistoryTab(): ReactElement {
  const { message } = App.useApp();
  const [runs, setRuns] = useState<TaskRunRow[]>([]);
  const [items, setItems] = useState<TaskRunItemRow[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const rows = await invoke(IPC.invoke.taskHistoryList);
      setRuns(rows);
      // 选中的那条可能已经不在了（例如换了数据目录），退回第一条
      setSelectedRunId((current) =>
        current !== null && rows.some((r) => r.id === current) ? current : (rows[0]?.id ?? null),
      );
    } catch (error) {
      message.error(describeError(error));
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 任务刚结束时历史里已经有这一条：自动刷新，免得用户以为没记上
  useEffect(() => onTaskFinished(() => void refresh()), [refresh]);

  useEffect(() => {
    if (selectedRunId === null) {
      setItems([]);
      return;
    }
    const runId = selectedRunId;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await invoke(IPC.invoke.taskHistoryItems, runId);
        // 快速切换选中行时，先发的请求可能后返回：丢弃已经不是当前选中那条的结果
        if (!cancelled) setItems(rows);
      } catch (error) {
        if (!cancelled) message.error(describeError(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedRunId, message]);

  const exportCsv = useCallback(async (): Promise<void> => {
    try {
      const text = await invoke(IPC.invoke.taskHistoryExport);
      // 带 BOM 让 Excel 正确识别 UTF-8
      const blob = new Blob([`\ufeff${text}`], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `task-history-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // 立刻 revoke 有可能赶在下载真正开始之前，推迟一点更稳（与账号导入导出同一写法）
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      message.success("已导出 CSV");
    } catch (error) {
      message.error(describeError(error));
    }
  }, [message]);

  const runColumns: ColumnsType<TaskRunRow> = [
    { title: "结束时间", dataIndex: "finished_at", width: 170, render: (v: string | null) => v ?? "-" },
    { title: "任务", dataIndex: "label", ellipsis: true, render: (v: string | null) => v ?? "-" },
    { title: "结果", dataIndex: "outcome", width: 90, render: (v: string | null) => outcomeTag(v) },
    { title: "总数", dataIndex: "total", width: 70 },
    { title: "成功", dataIndex: "success_count", width: 70 },
    { title: "失败", dataIndex: "failed_count", width: 70 },
    { title: "错误", dataIndex: "error", ellipsis: true, render: (v: string | null) => v ?? "" },
  ];

  const itemColumns: ColumnsType<TaskRunItemRow> = [
    { title: "账号", dataIndex: "item_key", ellipsis: true, render: (v: string | null) => v ?? "-" },
    { title: "状态", dataIndex: "status", width: 100, render: (v: string | null) => itemStatusTag(v) },
    { title: "消息", dataIndex: "message", ellipsis: true, render: (v: string | null) => v ?? "" },
  ];

  return (
    <Space direction="vertical" style={{ width: "100%" }} size="middle">
      <Card
        size="small"
        title="任务历史"
        extra={
          <Space>
            <Button icon={<SyncOutlined />} onClick={() => void refresh()} loading={loading}>
              刷新
            </Button>
            <Button icon={<DownloadOutlined />} onClick={() => void exportCsv()} disabled={runs.length === 0}>
              导出 CSV
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          每次批量任务（登录 / 5 个 AI 任务 / 导入 TOTP / 打开与删除窗口等）结束后，运行结果会落库；
          这里查看最近 100 次。选中一行可看该次的逐账号结果，同一账号只保留**最终**状态。
          「总数」是条目数，「成功」「失败」只统计终态条目，因此「跳过」等中间状态不计入这两列。
        </Typography.Paragraph>
        {runs.length === 0 ? (
          <Empty description="还没有任务记录" />
        ) : (
          <Table<TaskRunRow>
            rowKey="id"
            size="small"
            columns={runColumns}
            dataSource={runs}
            pagination={{ pageSize: 20, size: "small" }}
            rowSelection={{
              type: "radio",
              selectedRowKeys: selectedRunId === null ? [] : [selectedRunId],
              onChange: (keys) => setSelectedRunId(Number(keys[0])),
            }}
            onRow={(row) => ({ onClick: () => setSelectedRunId(row.id) })}
          />
        )}
      </Card>

      <Card size="small" title="逐条目结果">
        {selectedRunId === null ? (
          <Empty description="选中上面的一条任务" />
        ) : (
          <Table<TaskRunItemRow>
            rowKey="id"
            size="small"
            columns={itemColumns}
            dataSource={items}
            pagination={{ pageSize: 20, size: "small" }}
          />
        )}
      </Card>
    </Space>
  );
}
