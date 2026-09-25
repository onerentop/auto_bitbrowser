/**
 * 「任务历史」标签 —— 本地新增能力（原本批量任务结果只打在界面日志里，关掉就没了）
 *
 * 数据来自 TaskRunner 收尾时落库的两张表：task_run_history（任务级）+ task_run_items（逐条目）。
 * 上面是任务列表（可按类型 / 结果 / 时间 / 账号筛选，筛选在后端 SQL 里做），选中一条后下面是该次运行的
 * 逐条目结果；右上角可导出 CSV。每行还能「重跑」——用该次运行的参数快照重新启动同类型任务，
 * 能不能重跑由 shared/logic/task-history.ts 判定（与后端 abb/taskhistory/rerun 同一套规则）。
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { App, Button, Empty, Input, Segmented, Select, Space, Table, Tooltip, Typography } from "antd";
import { DownloadOutlined, RedoOutlined, SyncOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import type { TaskRunItemRow, TaskRunQuery, TaskRunRow } from "../../../../shared/channels/task-history.ts";
import {
  TASK_HISTORY_OUTCOMES,
  TASK_HISTORY_RANGES,
  rangeBounds,
  rerunBlockReason,
  taskTypeLabel,
  taskTypeOptions,
  type TaskHistoryRangeKey,
} from "../../../../shared/logic/task-history.ts";
import { IPC, describeError, invoke } from "../../lib/ipc.ts";
import { markTaskStarted, onTaskFinished, useTaskState } from "../../stores/task.ts";
import { useHostStatus } from "../../stores/host-status.ts";
import { Panel, Section } from "../../components/Section.tsx";
import { rowSelect } from "../../components/row-select.ts";
import { usePagination } from "../../components/use-pagination.ts";
import { StatusDot } from "../../components/StatusDot.tsx";
import { historyItemTone, railClass, runOutcomeTone } from "../../lib/list-tone.ts";

/** 任务结果的文字（色调见 lib/list-tone.ts 的 runOutcomeTone） */
function outcomeLabel(outcome: string | null): string {
  if (outcome === "succeeded") return "成功";
  if (outcome === "stopped") return "已停止";
  if (outcome === "failed") return "失败";
  return outcome || "—";
}

export function TaskHistoryTab(): ReactElement {
  const { message, modal } = App.useApp();
  const { running } = useTaskState();
  const [runs, setRuns] = useState<TaskRunRow[]>([]);
  const [items, setItems] = useState<TaskRunItemRow[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  // 筛选：类型 / 结果 / 时间范围（都下推到后端 SQL），账号按回车或点搜索才应用
  const [taskType, setTaskType] = useState<string>("");
  const [outcome, setOutcome] = useState<string>("");
  const [range, setRange] = useState<TaskHistoryRangeKey>("all");
  const [emailInput, setEmailInput] = useState("");
  const [email, setEmail] = useState("");
  const hasFilter = taskType !== "" || outcome !== "" || range !== "all" || email !== "";

  /** 当前筛选对应的查询（等价于「筛选条件 → 查询」，见 test/task-history-logic.test.mjs） */
  const query = useMemo((): TaskRunQuery => {
    const q: TaskRunQuery = {};
    if (taskType) q.taskType = taskType;
    if (outcome) q.outcome = outcome;
    if (email) q.itemEmail = email;
    Object.assign(q, rangeBounds(range, new Date()));
    return q;
  }, [taskType, outcome, email, range]);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const rows = await invoke(IPC.invoke.taskHistoryList, query);
      setRuns(rows);
      // 选中的那条可能已经不在了（被筛掉 / 换了数据目录），退回第一条
      setSelectedRunId((current) =>
        current !== null && rows.some((r) => r.id === current) ? current : (rows[0]?.id ?? null),
      );
    } catch (error) {
      message.error(describeError(error));
    } finally {
      setLoading(false);
    }
  }, [message, query]);

  // 后端就绪后加载；筛选条件变了（query 变）也要重新拉——所以这里不能加「只跑一次」的守卫，
  // 它会把筛选后的重拉一起挡掉（真机踩过：点了「今天」列表纹丝不动）。就绪前的挂载不发请求，
  // 避免拿到 HOST_UNAVAILABLE 后一片空白。
  const hostReady = useHostStatus()?.state === "ready";
  useEffect(() => {
    if (!hostReady) return;
    void refresh();
  }, [hostReady, refresh]);

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

  /** 重跑：用该次运行的参数快照重新启动同类型任务（同时只能有一个任务） */
  const rerun = (row: TaskRunRow): void => {
    const blocked = rerunBlockReason(row);
    if (blocked) {
      void message.warning(blocked);
      return;
    }
    modal.confirm({
      title: "确认重跑",
      content: `用这次运行的参数快照再跑一次「${row.label ?? taskTypeLabel(row.task_type)}」。\n\n会立刻启动新任务（后端同时只允许一个任务），请确认当前没有别的重要任务在跑。`,
      okText: "开始",
      cancelText: "取消",
      onOk: async () => {
        try {
          const info = await invoke(IPC.invoke.taskHistoryRerun, row.id);
          markTaskStarted(info);
          void message.success(`已启动：${info.label}`);
        } catch (error) {
          void message.error(describeError(error));
        }
      },
    });
  };

  const resetFilters = (): void => {
    setTaskType("");
    setOutcome("");
    setRange("all");
    setEmailInput("");
    setEmail("");
  };

  const typeOptions = useMemo(
    () => [{ value: "", label: "全部任务" }, ...taskTypeOptions(runs)],
    [runs],
  );

  const runColumns: ColumnsType<TaskRunRow> = [
    {
      title: "结束时间",
      dataIndex: "finished_at",
      width: 170,
      render: (v: string | null) => <Typography.Text type="secondary" className="abb-num">{v ?? "—"}</Typography.Text>,
    },
    { title: "任务", dataIndex: "label", ellipsis: true, render: (v: string | null) => v ?? "—" },
    {
      title: "结果",
      dataIndex: "outcome",
      width: 96,
      render: (v: string | null) => <StatusDot tone={runOutcomeTone(v)} text={outcomeLabel(v)} />,
    },
    { title: "总数", dataIndex: "total", width: 70, align: "right", className: "abb-num" },
    { title: "成功", dataIndex: "success_count", width: 70, align: "right", className: "abb-num" },
    {
      title: "失败",
      dataIndex: "failed_count",
      width: 70,
      align: "right",
      className: "abb-num",
      // 有失败时用失败色，0 时淡化
      render: (v: number) => <Typography.Text type={v > 0 ? "danger" : "secondary"}>{v}</Typography.Text>,
    },
    {
      title: "错误",
      dataIndex: "error",
      ellipsis: { showTitle: true },
      render: (v: string | null) => <Typography.Text type="secondary">{v ?? ""}</Typography.Text>,
    },
    {
      title: "操作",
      key: "action",
      width: 90,
      fixed: "right",
      render: (_, r) => {
        const blocked = rerunBlockReason(r);
        return (
          <Tooltip title={blocked ?? "用这次的参数快照重新跑一次"}>
            {/* disabled 的按钮收不到鼠标事件，包一层 span 才能挂上 Tooltip */}
            <span style={{ display: "inline-block" }}>
              <Button
                type="link"
                size="small"
                icon={<RedoOutlined />}
                disabled={blocked !== null || running !== null}
                onClick={() => rerun(r)}
              >
                重跑
              </Button>
            </span>
          </Tooltip>
        );
      },
    },
  ];

  const itemColumns: ColumnsType<TaskRunItemRow> = [
    { title: "账号", dataIndex: "item_key", ellipsis: true, render: (v: string | null) => (v ? <span className="abb-id">{v}</span> : "—") },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (v: string | null) => <StatusDot tone={historyItemTone(v)} text={v || "—"} />,
    },
    { title: "消息", dataIndex: "message", ellipsis: { showTitle: true }, render: (v: string | null) => v ?? "" },
  ];

  // 点行即选中；任务历史是单选表，再点已选行不会取消（与 radio 一致）
  const historyRow = rowSelect<TaskRunRow, number>({
    keyOf: (row) => row.id,
    keys: selectedRunId === null ? [] : [selectedRunId],
    onChange: (next) => setSelectedRunId(next[0] ?? null),
    mode: "always",
  });

  // 分页：任务列表刷新不跳页（数据变少时夹到最后一页）；换一条任务时逐条目结果回到第 1 页
  const runsPager = usePagination("taskHistory", runs.length, [query]);
  const itemsPager = usePagination("taskHistoryItems", items.length, [selectedRunId]);

  return (
    <Panel>
      <Section
        first
        title="最近任务"
        description={
          <>
            每次批量任务（登录 / 6 个 AI 任务 / 导入 TOTP / 打开与删除窗口等）结束后，运行结果会落库；这里查看最近 100 次。
            选中一行可看该次的逐账号结果，同一账号只保留最终状态。「总数」是条目数，「成功」「失败」只统计终态条目，
            因此「跳过」等中间状态不计入这两列。筛选与重跑都基于落库的参数快照。
          </>
        }
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
        <Space wrap style={{ marginBottom: 12 }}>
          <Select
            value={taskType}
            onChange={setTaskType}
            options={typeOptions}
            style={{ width: 180 }}
            placeholder="全部任务"
          />
          <Select
            value={outcome}
            onChange={setOutcome}
            options={[{ value: "", label: "全部结果" }, ...TASK_HISTORY_OUTCOMES]}
            style={{ width: 140 }}
          />
          <Segmented<TaskHistoryRangeKey>
            value={range}
            onChange={setRange}
            options={TASK_HISTORY_RANGES.map((r) => ({ value: r.value, label: r.label }))}
          />
          <Input.Search
            placeholder="按账号（邮箱）筛选"
            allowClear
            style={{ width: 220 }}
            value={emailInput}
            onChange={(e) => {
              setEmailInput(e.target.value);
              // 清空时立即生效，免得筛完了还以为没筛
              if (e.target.value === "") setEmail("");
            }}
            onSearch={(v) => setEmail(v.trim())}
          />
          <Button onClick={resetFilters} disabled={!hasFilter}>
            重置筛选
          </Button>
        </Space>

        <Table<TaskRunRow>
          rowKey="id"
          size="small"
          columns={runColumns}
          dataSource={runs}
          loading={loading}
          locale={{ emptyText: <Empty description={hasFilter ? "没有符合条件的记录" : "还没有任务记录"} /> }}
          pagination={runsPager.pagination}
          rowSelection={{
            type: "radio",
            selectedRowKeys: selectedRunId === null ? [] : [selectedRunId],
            onChange: (keys) => setSelectedRunId(Number(keys[0])),
          }}
          rowClassName={(r) => railClass(runOutcomeTone(r.outcome))}
          onRow={historyRow}
          // 筛选栏多了以后表格更宽：横向放不下时在表格内部滚动，操作列固定在右侧
          scroll={{ x: "max-content" }}
        />
      </Section>

      <Section title="逐条目结果">
        {selectedRunId === null ? (
          <Empty description="选中上面的一条任务" />
        ) : (
          <Table<TaskRunItemRow>
            rowKey="id"
            size="small"
            columns={itemColumns}
            dataSource={items}
            pagination={itemsPager.pagination}
            rowClassName={(r) => railClass(historyItemTone(r.status))}
          />
        )}
      </Section>
    </Panel>
  );
}
