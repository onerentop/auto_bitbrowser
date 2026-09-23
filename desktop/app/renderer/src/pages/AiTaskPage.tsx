/**
 * 通用 AI 批量任务页 —— 对标 gui/ai_task_interface.py AITaskInterface（:88-440）
 * 驱动 5 个导航项：替换手机号 / 替换辅助邮箱 / 修改 2SV 手机 / 修改验证器 / 踢出设备。
 *
 * 布局：「{任务名} 配置」卡片 → 按钮行（加载数据 / 开始{任务名} / 停止 … 共 N 个账号）→ 账号树。
 * Python 的进度条与日志区（:224-228）由底部全局任务坞替代，界面侧日志用 logLocal。
 *
 * 5 个实例同时挂载、切走不卸载：所有状态都在组件内部，互不影响。
 * 与原版一致，页面不自动加载，需点「加载数据」（AITaskInterface.__init__ 没有调用 _loadData）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { App, Button, Card, Input, InputNumber, Select, Space, Typography } from "antd";
import { DownloadOutlined, PauseOutlined, PlayCircleOutlined } from "@ant-design/icons";
import {
  AI_TASK_KINDS,
  AI_TASK_STATUS_FILTERS,
  isAiTaskKind,
  type AiTaskGroupNode,
  type AiTaskKind,
  type AiTaskParams,
} from "../../../shared/channels/ai-tasks.ts";
import type { TaskFinishedEvent, TaskItemEvent } from "../../../shared/ipc.ts";
import { IPC, describeError, invoke } from "../lib/ipc.ts";
import { logLocal, markTaskStarted, onTaskFinished, onTaskItem, stopTask, useTaskState } from "../stores/task.ts";
import { AccountTreeCard, type RowRuntime } from "./ai-tasks/AccountTreeCard.tsx";
import { countVisible, filterByStatus, pruneChecked, selectedItems } from "./ai-tasks/tree.ts";

export interface AiTaskPageProps {
  /** 任务种类键，见 app/shared/channels/ai-tasks.ts 的 AI_TASK_KINDS */
  kind: string;
  /** 导航名（仅用于未知 kind 的兜底提示；页面内的任务名取 AI_TASK_KINDS） */
  label: string;
}

export function AiTaskPage(props: AiTaskPageProps): ReactElement {
  if (!isAiTaskKind(props.kind)) {
    return <Typography.Text type="danger">{props.label}：未知的任务种类 {props.kind}</Typography.Text>;
  }
  return <AiTaskView kind={props.kind} />;
}

/** 启动请求返回前到达的事件先缓存（跨进程时事件可能先于返回值到达，见 stores/task.ts:37-43） */
interface PendingStart {
  items: TaskItemEvent[];
  finished: TaskFinishedEvent | null;
}

function AiTaskView({ kind }: { kind: AiTaskKind }): ReactElement {
  const def = AI_TASK_KINDS[kind];
  const { taskName, taskType, extraField } = def;
  const { message, modal } = App.useApp();
  const { running } = useTaskState();

  const [concurrency, setConcurrency] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [extraValue, setExtraValue] = useState("");

  const [groups, setGroups] = useState<AiTaskGroupNode[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [runtime, setRuntime] = useState<Record<string, RowRuntime>>({});
  // 只采纳最近一次加载的结果（对标 :239-241 停掉旧的加载线程）
  const loadSeq = useRef(0);

  // 本页启动的任务 id；启动请求在途时 pending 非空
  const taskIdRef = useRef<number | null>(null);
  const pendingRef = useRef<PendingStart | null>(null);

  const visible = useMemo(() => filterByStatus(groups, statusFilter), [groups, statusFilter]);
  const total = countVisible(visible);

  /** 对标 _loadData（:234-247）+ _onLoadFinished（:255-270） */
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setGroups([]); // :236 tree.clear()
    setChecked([]);
    setRuntime({});
    setLoaded(false);
    setLoading(true);
    logLocal("正在加载数据...");
    try {
      const res = await invoke(IPC.invoke.aiTasksLoad);
      if (seq !== loadSeq.current) return;
      if (res.error) {
        logLocal(`⚠️ 加载数据时发生错误: ${res.error}`);
        return;
      }
      setGroups(res.groups);
      setLoaded(true);
      logLocal(`加载完成: ${countVisible(filterByStatus(res.groups, statusFilter))} 个账号`);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      logLocal(`❌ 处理加载结果失败: ${describeError(e)}`);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [statusFilter]);

  /** 对标 _onStatusFilterChanged（:370-373）：已加载时按新条件重新过滤；被隐藏的行取消勾选 */
  const onFilterChange = (value: string): void => {
    setStatusFilter(value);
    const next = filterByStatus(groups, value);
    setChecked((prev) => pruneChecked(next, prev));
    if (loaded) logLocal(`加载完成: ${countVisible(next)} 个账号`);
  };

  // ---------- 任务事件 ----------

  const applyItem = useCallback((e: TaskItemEvent) => {
    setRuntime((prev) => ({ ...prev, [e.key]: { status: e.status, message: e.message } }));
  }, []);

  /** 对标 _onTaskFinished（:428-433）；进度由全局任务坞显示 */
  const applyFinished = useCallback(
    (e: TaskFinishedEvent) => {
      taskIdRef.current = null;
      if (e.outcome === "failed") {
        void message.error(`${taskName}任务异常: ${e.error ?? "未知错误"}`);
      } else {
        void message.success(`${taskName}任务已完成`);
      }
    },
    [message, taskName],
  );

  // 逐行更新：只处理本页启动的任务
  useEffect(
    () =>
      onTaskItem((e) => {
        if (e.type !== taskType) return;
        if (pendingRef.current) {
          pendingRef.current.items.push(e);
          return;
        }
        if (e.taskId === taskIdRef.current) applyItem(e);
      }),
    [taskType, applyItem],
  );

  useEffect(
    () =>
      onTaskFinished((e) => {
        if (e.type !== taskType) return;
        if (pendingRef.current) {
          pendingRef.current.finished = e;
          return;
        }
        if (e.taskId === taskIdRef.current) applyFinished(e);
      }),
    [taskType, applyFinished],
  );

  const launch = async (items: ReturnType<typeof selectedItems>): Promise<void> => {
    const params: AiTaskParams = {};
    if (extraField) params[extraField.key] = extraValue.trim();
    pendingRef.current = { items: [], finished: null };
    try {
      const info = await invoke(IPC.invoke.aiTasksStart, kind, items, params, concurrency);
      const pending = pendingRef.current;
      pendingRef.current = null;
      taskIdRef.current = info.id;
      markTaskStarted(info);
      // 回放启动返回前就到达的事件
      for (const e of pending?.items ?? []) if (e.taskId === info.id) applyItem(e);
      if (pending?.finished && pending.finished.taskId === info.id) applyFinished(pending.finished);
    } catch (e) {
      pendingRef.current = null;
      void message.error(describeError(e));
    }
  };

  /**
   * 对标 _onStartClicked（:375-395）。
   * 有意偏差：原版不确认直接开始；这些操作都会修改账号（破坏性），这里加一个确认框。
   */
  const onStart = (): void => {
    const items = selectedItems(visible, checked);
    if (items.length === 0) {
      void message.warning("请先选择要处理的账号"); // :378-380
      return;
    }
    modal.confirm({
      title: `确认${taskName}`,
      content: `将对 ${items.length} 个账号执行${taskName}，此操作会修改账号`,
      okText: "开始",
      cancelText: "取消",
      onOk: () => {
        void launch(items);
      },
    });
  };

  /**
   * 对标 _onStopClicked（:397-402）。
   * 修复原版缺陷：原版点停止后立即 setRunning(False) 重新启用「开始」，而 Worker 还在跑当前账号；
   * 这里按钮状态完全跟随全局任务状态，任务真正结束后才重新可用。
   */
  const onStop = (): void => {
    logLocal(`正在停止${taskName}任务...`);
    stopTask().catch((e: unknown) => void message.error(describeError(e)));
  };

  const busy = running !== null;
  const ownRunning = running !== null && running.type === taskType;

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      {/* 配置卡片（:135-177） */}
      <Card size="small" title={`${taskName} 配置`}>
        <Space direction="vertical" size="middle">
          <Space wrap size="large">
            <Space>
              <span>并发数:</span>
              <InputNumber
                min={1}
                max={10}
                precision={0}
                value={concurrency}
                onChange={(v) => setConcurrency(typeof v === "number" ? v : 1)}
                style={{ width: 120 }}
              />
            </Space>
            <Space>
              <span>状态筛选:</span>
              <Select
                value={statusFilter}
                onChange={onFilterChange}
                options={AI_TASK_STATUS_FILTERS.map((o) => ({ value: o.value, label: o.label }))}
                style={{ minWidth: 180 }}
              />
            </Space>
          </Space>
          {extraField && (
            <Space>
              <span>{extraField.label}:</span>
              <Input
                value={extraValue}
                onChange={(e) => setExtraValue(e.target.value)}
                placeholder={extraField.placeholder}
                maxLength={200}
                style={{ width: 320 }}
              />
            </Space>
          )}
        </Space>
      </Card>

      {/* 操作按钮（:179-204） */}
      <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
        <Space wrap>
          <Button icon={<DownloadOutlined />} onClick={() => void load()} loading={loading} disabled={busy}>
            加载数据
          </Button>
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={onStart} disabled={busy}>
            开始{taskName}
          </Button>
          <Button icon={<PauseOutlined />} onClick={onStop} disabled={!ownRunning || running?.stopRequested === true}>
            停止
          </Button>
        </Space>
        <Typography.Text type="secondary">{loaded ? `共 ${total} 个账号` : ""}</Typography.Text>
      </Space>

      <AccountTreeCard
        groups={visible}
        loading={loading}
        checkedKeys={checked}
        onCheckedChange={setChecked}
        runtime={runtime}
      />
    </Space>
  );
}
