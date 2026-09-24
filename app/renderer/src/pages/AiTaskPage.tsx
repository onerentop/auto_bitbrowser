/**
 * 通用 AI 批量任务页
 * 驱动 6 个导航项：替换手机号 / 替换辅助邮箱 / 修改 2SV 手机 / 修改验证器 / 踢出设备 / 修改密码。
 *
 * 布局：页头（任务名 + 一句说明 + 开始 / 停止）→「任务参数」分节（仅有额外输入框的任务）→ 账号列表面板（刷新、搜索、筛选、平铺表格）。
 * 进度条与日志区由底部全局任务坞替代，界面侧日志用 logLocal。
 *
 * 6 个实例首次打开时各自自动加载一次，切走不卸载：所有状态都在组件内部，互不影响。
 * 刷新列表保留勾选（去掉已不存在的）与本次任务结果；开始新任务时才清空任务结果。
 * 任务一直是逐个账号顺序执行（没有并发数设置）。
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { App, Button, Input, Typography } from "antd";
import { PauseOutlined, PlayCircleOutlined } from "@ant-design/icons";
import {
  AI_TASK_KINDS,
  isAiTaskKind,
  type AiTaskKind,
  type AiTaskLoadResult,
  type AiTaskLoginFilter,
  type AiTaskParams,
  type AiTaskStartItem,
} from "../../../shared/channels/ai-tasks.ts";
import type { TaskFinishedEvent, TaskItemEvent } from "../../../shared/ipc.ts";
import { filterRows, isFailedRuntime, selectedItems, type RowRuntime } from "../../../shared/logic/ai-task-list.ts";
import { reconcileChecked, selectionSummary } from "../../../shared/logic/home-list.ts";
import { IPC, describeError, invoke } from "../lib/ipc.ts";
import { logLocal, markTaskStarted, onTaskFinished, onTaskItem, stopTask, useTaskState } from "../stores/task.ts";
import { useHostStatus } from "../stores/host-status.ts";
import { AccountListCard } from "./ai-tasks/AccountListCard.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { Panel, Section } from "../components/Section.tsx";

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

/** 页头说明：用户视角讲清该任务会对勾选账号做什么（依据 src/automation/auto-*.ts 与 AI_TASK_KINDS） */
const TASK_DESCRIPTIONS: Readonly<Record<AiTaskKind, string>> = {
  replace_phone: "把勾选账号的辅助手机号换成下面填写的号码；留空则移除原手机号。",
  replace_email: "把勾选账号的辅助邮箱换成下面填写的地址；留空则移除原辅助邮箱。",
  modify_2sv: "把勾选账号的两步验证（2SV）手机改成下面填写的号码。",
  modify_auth: "为勾选账号重新绑定身份验证器，新密钥保存到数据库和窗口的 2FA 设置。",
  kick_devices: "让勾选账号退出除本机以外的所有已登录设备。",
  change_password: "为勾选账号换成系统随机生成的新密码，Google 侧改成功后才写入数据库和窗口。",
};

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

  const [extraValue, setExtraValue] = useState("");

  const [list, setList] = useState<AiTaskLoadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [runtime, setRuntime] = useState<Record<string, RowRuntime>>({});
  // 只采纳最近一次加载的结果（比它更早的结果直接丢弃）
  const loadSeq = useRef(0);

  // 筛选条件
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [login, setLogin] = useState<AiTaskLoginFilter>("all");
  const [failedOnly, setFailedOnly] = useState(false);

  // 本页启动的任务 id；启动请求在途时 pending 非空
  const taskIdRef = useRef<number | null>(null);
  const pendingRef = useRef<PendingStart | null>(null);

  const rows = useMemo(() => list?.rows ?? [], [list]);
  const visible = useMemo(
    () => filterRows(rows, { groupId, login, failedOnly, text: deferredSearch }, runtime),
    [rows, groupId, login, failedOnly, deferredSearch, runtime],
  );
  const hiddenChecked = selectionSummary(checked, visible).hidden;
  const failedCount = useMemo(() => Object.values(runtime).filter(isFailedRuntime).length, [runtime]);

  /** 加载 / 刷新账号列表：保留仍存在账号的勾选与本次任务结果 */
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const res = await invoke(IPC.invoke.aiTasksLoad);
      if (seq !== loadSeq.current) return;
      if (res.error) {
        logLocal(`⚠️ 加载数据时发生错误: ${res.error}`);
        return;
      }
      setList(res);
      setChecked((prev) => reconcileChecked(prev, res.rows));
      setGroupId((g) => (g !== null && !res.groups.some((x) => x.groupId === g) ? null : g));
      logLocal(`${taskName}：加载完成，${res.totalBrowsers} 个账号`);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      logLocal(`❌ 加载账号列表失败: ${describeError(e)}`);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [taskName]);

  // 首次显示时自动加载。等后端首次就绪再发：窗口可能早于后端 ready 打开。
  const hostReady = useHostStatus()?.state === "ready";
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (!hostReady || autoLoaded.current) return;
    autoLoaded.current = true;
    void load();
  }, [hostReady, load]);

  // ---------- 任务事件 ----------

  const applyItem = useCallback((e: TaskItemEvent) => {
    setRuntime((prev) => ({ ...prev, [e.key]: { status: e.status, message: e.message } }));
  }, []);

  /** 任务结束处理；进度由全局任务坞显示 */
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

  const launch = async (items: AiTaskStartItem[]): Promise<void> => {
    const params: AiTaskParams = {};
    if (extraField) params[extraField.key] = extraValue.trim();
    pendingRef.current = { items: [], finished: null };
    // 新一轮任务：清空上一轮的逐行结果（「只看本次失败」随之复位）
    setRuntime({});
    setFailedOnly(false);
    try {
      const info = await invoke(IPC.invoke.aiTasksStart, kind, items, params);
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
   * 开始任务。
   * 这些操作都会修改账号（破坏性），开始前确认；被筛选隐藏的勾选也会执行，确认框里单独提示数量。
   */
  const onStart = (): void => {
    const items = selectedItems(rows, checked);
    if (items.length === 0) {
      void message.warning("请先勾选要处理的账号");
      return;
    }
    const hiddenLine = hiddenChecked > 0 ? `\n其中 ${hiddenChecked} 个被筛选隐藏，当前列表里看不到。` : "";
    modal.confirm({
      title: `确认${taskName}`,
      content: (
        <div style={{ whiteSpace: "pre-line" }}>{`将对 ${items.length} 个账号逐个执行${taskName}，此操作会修改账号。${hiddenLine}`}</div>
      ),
      okText: "开始",
      cancelText: "取消",
      onOk: () => {
        void launch(items);
      },
    });
  };

  /**
   * 停止任务。
   * 点停止后不立即重新启用「开始」——任务仍在跑当前账号；
   * 这里按钮状态完全跟随全局任务状态，任务真正结束后才重新可用。
   */
  const onStop = (): void => {
    logLocal(`正在停止${taskName}任务...`);
    stopTask().catch((e: unknown) => void message.error(describeError(e)));
  };

  const busy = running !== null;
  const ownRunning = running !== null && running.type === taskType;
  const paramId = `ai-task-param-${kind}`;

  return (
    // 纵向铺满：账号列表面板占剩余高度，表格随窗口大小伸缩
    <div style={{ display: "flex", flexDirection: "column", gap: 16, height: "100%", minHeight: 560 }}>
      <PageHeader
        title={taskName}
        description={TASK_DESCRIPTIONS[kind]}
        extra={
          <>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              逐个账号顺序执行
            </Typography.Text>
            <Button icon={<PauseOutlined />} onClick={onStop} disabled={!ownRunning || running?.stopRequested === true}>
              停止任务
            </Button>
            <Button type="primary" icon={<PlayCircleOutlined />} onClick={onStart} disabled={busy}>
              开始{taskName}
              {checked.length > 0 ? `（${checked.length}）` : ""}
            </Button>
          </>
        }
      />

      {extraField && (
        <Panel>
          <Section first title="任务参数">
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <label htmlFor={paramId}>{extraField.label}</label>
              <Input
                id={paramId}
                value={extraValue}
                onChange={(e) => setExtraValue(e.target.value)}
                placeholder={extraField.placeholder}
                maxLength={200}
                style={{ width: 320 }}
              />
            </div>
          </Section>
        </Panel>
      )}

      <AccountListCard
        list={list}
        visible={visible}
        loading={loading}
        onRefresh={() => void load()}
        checkedKeys={checked}
        onCheckedChange={setChecked}
        hiddenChecked={hiddenChecked}
        runtime={runtime}
        failedCount={failedCount}
        search={search}
        onSearchChange={setSearch}
        groupId={groupId}
        onGroupChange={setGroupId}
        login={login}
        onLoginChange={setLogin}
        failedOnly={failedOnly}
        onFailedOnlyChange={setFailedOnly}
      />
    </div>
  );
}
