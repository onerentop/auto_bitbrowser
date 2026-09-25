/**
 * 账号页「任务」抽屉：选中账号 → 选任务 → 填参数 → 执行 → 看逐账号结果
 *
 * 为什么收在抽屉里：任务只对「勾选的账号」生效，放在账号页就不必为此再开一堆页面
 * （原侧栏 6 个 AI 任务页已删除）。任务表（名称 / 说明 / 是否需要窗口 / 是否破坏性）见
 * app/shared/logic/task-panel.ts，界面只按表渲染，不硬编码文案。
 *
 * 分工：
 *   - 账号动作（批量登录 / 健康巡检 / 删除）：账号页负责「隐藏勾选确认 → precheck → 逐个确认 → 启动」
 *     （onRunAccountAction，勾选集合也由账号页取），这里只负责选择、运行时参数与结果展示；
 *     返回值是启动的任务，用户取消时为 null。
 *   - AI 任务（6 种）：这里直接经 abb/aiTasks/start 启动，破坏性的按任务表 danger 二次确认。
 * 全局进度、日志与结束汇总仍由底部任务坞（components/TaskDock.tsx）负责，这里只补「哪个账号成功 / 失败」。
 *
 * 结果按任务 id 认领：只有本抽屉启动的那次任务（ownTaskId）的条目事件会进结果表，
 * 别处启动的任务（例如任务历史里的重跑）不会串进来。启动请求返回前到达的事件先缓存再回放。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  App,
  Button,
  Checkbox,
  Drawer,
  Input,
  InputNumber,
  Radio,
  Space,
  Table,
  Tooltip,
  Typography,
  type TableColumnsType,
} from "antd";
import { PlayCircleOutlined, StopOutlined } from "@ant-design/icons";
import type { TaskFinishedEvent, TaskInfo, TaskItemEvent } from "../../../../shared/ipc.ts";
import type { AccountListRow, AccountsAction, AccountsRunOptions } from "../../../../shared/channels/accounts.ts";
import type { AiTaskKind, AiTaskStartItem } from "../../../../shared/channels/ai-tasks.ts";
import {
  TASK_PANEL_GROUPS,
  aiItemsFromAccounts,
  aiParamsFor,
  countResults,
  taskPanelDef,
  taskSummaryText,
  upsertResult,
  type TaskPanelId,
  type TaskPanelTaskDef,
  type TaskResultRow,
} from "../../../../shared/logic/task-panel.ts";
import { IPC, describeError, invoke } from "../../lib/ipc.ts";
import { aiItemTone, railClass } from "../../lib/list-tone.ts";
import { logLocal, markTaskStarted, onTaskFinished, onTaskItem, stopTask, useTaskState } from "../../stores/task.ts";
import { StatusDot } from "../../components/StatusDot.tsx";
import { usePagination } from "../../components/use-pagination.ts";
import { Section } from "../../components/Section.tsx";

const OUTCOME_TEXT: Record<TaskFinishedEvent["outcome"], string> = {
  succeeded: "已完成",
  failed: "失败",
  stopped: "已停止",
};

/** 启动请求返回前到达的事件先缓存（跨进程时事件可能先于返回值到达，同原 AI 任务页） */
interface PendingStart {
  items: TaskItemEvent[];
  finished: TaskFinishedEvent | null;
}

export interface TaskPanelProps {
  open: boolean;
  onClose: () => void;
  /** 勾选的账号（含被当前筛选隐藏的），按列表顺序 */
  rows: readonly AccountListRow[];
  /** 其中不在当前视图里的个数 */
  hiddenChecked: number;
  /** 全局有任务正在运行（后端同时只允许一个任务） */
  busy: boolean;
  concurrency: number;
  onConcurrencyChange: (n: number) => void;
  closeWindow: boolean;
  onCloseWindowChange: (v: boolean) => void;
  /**
   * 账号动作：账号页负责「隐藏勾选确认 → precheck → 逐个确认 → 启动」（勾选集合也由它自己取），
   * 返回启动的任务；未启动（用户取消 / 前置检查没过）返回 null。
   */
  onRunAccountAction: (action: AccountsAction, options: AccountsRunOptions) => Promise<TaskInfo | null>;
}

export function TaskPanel(props: TaskPanelProps): ReactElement {
  const {
    open,
    onClose,
    rows,
    hiddenChecked,
    busy,
    concurrency,
    onConcurrencyChange,
    closeWindow,
    onCloseWindowChange,
    onRunAccountAction,
  } = props;
  const { message, modal } = App.useApp();
  const tk = useTaskState();

  const [taskId, setTaskId] = useState<TaskPanelId>("login");
  /** AI 任务的额外输入（新手机号 / 新辅助邮箱）；换任务时清空，避免把上个任务的值带过去 */
  const [extra, setExtra] = useState("");
  const [results, setResults] = useState<Record<string, TaskResultRow>>({});
  /** 本次任务的账号数（汇总用） */
  const [total, setTotal] = useState(0);
  const [outcome, setOutcome] = useState<string | null>(null);
  /** 本抽屉启动的任务 id；null = 没有（结果表仍显示上一次的） */
  const [ownTaskId, setOwnTaskId] = useState<number | null>(null);
  const ownRef = useRef<number | null>(null);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const pendingRef = useRef<PendingStart | null>(null);

  const def = taskPanelDef(taskId);
  /** AI 任务条目：没有绑定窗口的账号会被跳过（数量提示给用户） */
  const aiItems = useMemo(() => aiItemsFromAccounts(rows), [rows]);
  const counts = useMemo(() => countResults(results, total), [results, total]);
  const resultRows = useMemo(() => Object.values(results), [results]);
  const pager = usePagination("accountTaskResults", resultRows.length, [taskId]);
  const running = tk.running;
  const ownRunning = running !== null && ownTaskId !== null && running.id === ownTaskId;

  const selectTask = useCallback((next: TaskPanelId): void => {
    setTaskId(next);
    setExtra("");
  }, []);

  const applyFinished = useCallback((e: TaskFinishedEvent): void => {
    ownRef.current = null;
    setOwnTaskId(null);
    setOutcome(OUTCOME_TEXT[e.outcome]);
    logLocal(`[任务] ${e.label}：${OUTCOME_TEXT[e.outcome]}${e.error ? ` — ${e.error}` : ""}`);
  }, []);

  // 逐账号结果：只认领本抽屉启动的那次任务（pendingRef 非空时先缓存，启动返回后回放）
  useEffect(
    () =>
      onTaskItem((e) => {
        if (pendingRef.current) {
          pendingRef.current.items.push(e);
          return;
        }
        if (e.taskId !== ownRef.current) return;
        setResults((prev) => upsertResult(prev, e));
      }),
    [],
  );

  useEffect(
    () =>
      onTaskFinished((e) => {
        if (pendingRef.current) {
          pendingRef.current.finished = e;
          return;
        }
        if (e.taskId !== ownRef.current) return;
        applyFinished(e);
      }),
    [applyFinished],
  );

  /** 统一启动流程：拿任务 id → 清空上一轮结果 → 回放启动期间到达的事件 */
  const launch = useCallback(
    async (count: number, run: () => Promise<TaskInfo | null>): Promise<void> => {
      if (startingRef.current) return;
      startingRef.current = true;
      setStarting(true);
      pendingRef.current = { items: [], finished: null };
      try {
        const info = await run();
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (!info) return; // 没启动（取消 / 前置检查没过）：保留上一次的结果
        setResults({});
        setTotal(count);
        setOutcome(null);
        ownRef.current = info.id;
        setOwnTaskId(info.id);
        markTaskStarted(info);
        for (const e of pending?.items ?? []) {
          if (e.taskId === info.id) setResults((prev) => upsertResult(prev, e));
        }
        const fin = pending?.finished;
        if (fin && fin.taskId === info.id) applyFinished(fin);
      } catch (e) {
        pendingRef.current = null;
        void message.error(describeError(e));
      } finally {
        startingRef.current = false;
        setStarting(false);
      }
    },
    [applyFinished, message],
  );

  /** 账号动作：交给账号页（勾选确认 / precheck / 逐个确认 / 启动都在那边），这里只要任务 id */
  const runAccountAction = useCallback(
    (d: TaskPanelTaskDef): void => {
      void launch(rows.length, () => onRunAccountAction(d.id as AccountsAction, { concurrency, closeWindow }));
    },
    [rows, concurrency, closeWindow, launch, onRunAccountAction],
  );

  /** AI 任务：这里启动（参数取当前输入） */
  const runAiTask = useCallback(
    (d: TaskPanelTaskDef, items: AiTaskStartItem[]): void => {
      void launch(items.length, () =>
        invoke(IPC.invoke.aiTasksStart, d.id as AiTaskKind, items, aiParamsFor(d, extra)),
      );
    },
    [extra, launch],
  );

  const onStart = (): void => {
    if (starting || busy) return;
    const d = taskPanelDef(taskId);
    if (rows.length === 0) {
      void message.warning("请先在列表里勾选账号");
      return;
    }
    if (d.runner === "account") {
      // 隐藏勾选的提示与二次确认由账号页负责
      runAccountAction(d);
      return;
    }
    const { items, skipped } = aiItems;
    if (items.length === 0) {
      void message.warning("勾选的账号都没有绑定窗口，无法执行这个任务");
      return;
    }
    const lines = [`将对 ${items.length} 个账号逐个执行「${d.label}」，此操作会修改账号。`];
    if (skipped > 0) lines.push(`其中 ${skipped} 个账号没有绑定窗口，会被跳过。`);
    if (hiddenChecked > 0) lines.push(`另有 ${hiddenChecked} 个已勾选账号不在当前视图里（不参与本次任务）。`);
    modal.confirm({
      title: `确认${d.label}`,
      content: <div style={{ whiteSpace: "pre-line" }}>{lines.join("\n")}</div>,
      okText: "开始",
      cancelText: "取消",
      okButtonProps: d.danger ? { danger: true } : undefined,
      onOk: () => runAiTask(d, items),
    });
  };

  const onStop = (): void => {
    logLocal(`正在停止「${running?.label ?? "任务"}」...`);
    stopTask().catch((e: unknown) => void message.error(describeError(e)));
  };

  const columns: TableColumnsType<TaskResultRow> = [
    { title: "账号", dataIndex: "email", key: "email", width: 260, fixed: "left", ellipsis: true },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (v: string) => <StatusDot tone={aiItemTone(v)} text={v} />,
    },
    { title: "消息", dataIndex: "message", key: "message", ellipsis: true },
  ];

  const paramId = `task-panel-param-${taskId}`;
  const canStart = !starting && !busy && rows.length > 0;

  return (
    <Drawer
      title="任务"
      width={760}
      open={open}
      onClose={onClose}
      extra={
        <Space>
          {ownRunning && (
            <Button danger icon={<StopOutlined />} onClick={onStop} disabled={running?.stopRequested === true}>
              停止
            </Button>
          )}
          <Tooltip title={busy && !ownRunning ? "有其它任务正在运行" : ""}>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={starting}
              onClick={onStart}
              disabled={!canStart}
              danger={def.danger}
            >
              开始{def.label}
              {rows.length > 0 ? `（${rows.length}）` : ""}
            </Button>
          </Tooltip>
        </Space>
      }
    >
      <Section
        first
        title="选择任务"
        description={
          rows.length === 0
            ? "还没有勾选账号：先在账号列表里勾选，再回来执行任务。"
            : hiddenChecked > 0
              ? `已勾选 ${rows.length} 个账号，其中 ${hiddenChecked} 个不在当前视图里。`
              : `已勾选 ${rows.length} 个账号。`
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {TASK_PANEL_GROUPS.map((g) => (
            <div key={g.title} style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <Typography.Text type="secondary" style={{ fontSize: 12, width: 210, flex: "0 0 auto" }}>
                {g.title}
              </Typography.Text>
              <Radio.Group
                value={taskId}
                onChange={(e) => selectTask(e.target.value as TaskPanelId)}
                optionType="button"
                buttonStyle="solid"
                options={g.ids.map((id) => ({ label: taskPanelDef(id).label, value: id }))}
              />
            </div>
          ))}
        </div>
      </Section>

      <Section title={def.label} description={def.description}>
        <Space size={12} wrap>
          {def.extraField && (
            <>
              <label htmlFor={paramId}>{def.extraField.label}</label>
              <Input
                id={paramId}
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                placeholder={def.extraField.placeholder}
                maxLength={200}
                disabled={busy}
                style={{ width: 320 }}
              />
            </>
          )}
          {def.runner === "account" && def.id !== "delete" && def.id !== "delete_with_windows" && (
            <Tooltip title="同时打开的窗口数">
              <Space size={8}>
                <span>并发</span>
                <InputNumber
                  min={1}
                  max={10}
                  precision={0}
                  value={concurrency}
                  onChange={(v) => onConcurrencyChange(typeof v === "number" ? v : 1)}
                  disabled={busy}
                  style={{ width: 64 }}
                />
              </Space>
            </Tooltip>
          )}
          {def.id === "login" && (
            <Tooltip title="登录成功的账号完成后自动关窗；失败的保留窗口，方便你查看原因或手动过验证码">
              <Checkbox checked={closeWindow} onChange={(e) => onCloseWindowChange(e.target.checked)} disabled={busy}>
                登录后关窗
              </Checkbox>
            </Tooltip>
          )}
          {def.runner === "ai" && aiItems.skipped > 0 && (
            <Typography.Text type="warning">{aiItems.skipped} 个勾选账号没有绑定窗口，会被跳过</Typography.Text>
          )}
        </Space>
      </Section>

      <Section
        title="本次结果"
        description={outcome ? `${taskSummaryText(counts)}（${outcome}）` : taskSummaryText(counts)}
      >
        <Table<TaskResultRow>
          size="small"
          rowKey="email"
          columns={columns}
          dataSource={resultRows}
          pagination={pager.pagination}
          rowClassName={(r) => railClass(aiItemTone(r.status))}
          locale={{ emptyText: "还没有结果。选好任务与账号后点右上角「开始」。" }}
        />
      </Section>
    </Drawer>
  );
}
