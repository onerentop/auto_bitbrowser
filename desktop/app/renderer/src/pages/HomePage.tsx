/**
 * 首页（ixBrowser 窗口管理） —— 对标 gui/home_interface.py HomeInterface
 *
 * 布局：创建参数配置卡片 → 操作按钮行 → 窗口列表卡片。
 * Python 的日志区（:222 addLogArea）由底部全局任务坞替代，界面侧日志用 logLocal。
 * 页面切走不卸载，因此挂载时的自动加载只发生一次（对应 :90-91 的 QTimer.singleShot）。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { App, Button, Space, Tooltip } from "antd";
import { AppstoreAddOutlined, PauseOutlined, PlusOutlined } from "@ant-design/icons";
import { HOME_TASK_TYPES, type HomeGroupNode, type HomeGroupOption } from "../../../shared/channels/home.ts";
import { IPC, describeError, invoke } from "../lib/ipc.ts";
import { logLocal, markTaskStarted, onTaskFinished, useTaskState } from "../stores/task.ts";
import { useHostStatus } from "../stores/host-status.ts";
import { defaultGroupOptions, refreshSummary } from "../../../../src/application/home-tree.ts";
import { ConfigCard } from "./home/ConfigCard.tsx";
import { BrowserListCard } from "./home/BrowserListCard.tsx";

const HOME_TASKS: ReadonlySet<string> = new Set(Object.values(HOME_TASK_TYPES));

export function HomePage(): ReactElement {
  const { message, modal } = App.useApp();
  const { running } = useTaskState();

  const [groupOptions, setGroupOptions] = useState<HomeGroupOption[]>(defaultGroupOptions);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [groupsLoading, setGroupsLoading] = useState(false);

  const [tree, setTree] = useState<HomeGroupNode[]>([]);
  const [listLoading, setListLoading] = useState(false);
  // 只采纳最近一次刷新的结果（对标 :254-265 清理旧线程）
  const listSeq = useRef(0);
  // 分组刷新同理：连点「刷新」时，先发后到的旧结果不能覆盖新结果
  const groupsSeq = useRef(0);

  /** 对标 refreshGroupList（:227-245） */
  const refreshGroups = useCallback(async () => {
    const seq = ++groupsSeq.current;
    setGroupsLoading(true);
    let options: HomeGroupOption[];
    try {
      const res = await invoke(IPC.invoke.homeListGroups);
      if (seq !== groupsSeq.current) return;
      options = res.options;
      if (res.error) logLocal(`[警告] 获取分组列表失败: ${res.error}`);
    } catch (e) {
      if (seq !== groupsSeq.current) return;
      logLocal(`[警告] 获取分组列表失败: ${describeError(e)}`);
      options = defaultGroupOptions();
    }
    setGroupOptions(options);
    // 刷新后若原选项还在就保留，否则选第一项（ComboBox clear 后默认选中第一项）
    setGroupId((cur) => (cur !== null && options.some((o) => o.id === cur) ? cur : (options[0]?.id ?? null)));
    setGroupsLoading(false);
  }, []);

  /** 对标 refreshBrowserList（:247）+ _onLoadFinished（:279-293） */
  const refreshList = useCallback(async () => {
    const seq = ++listSeq.current;
    setListLoading(true);
    try {
      const res = await invoke(IPC.invoke.homeListBrowsers);
      if (seq !== listSeq.current) return;
      if (res.error) logLocal(`⚠️ 加载数据时发生错误: ${res.error}`);
      setTree(res.groups);
      logLocal(refreshSummary(res.groups));
    } catch (e) {
      if (seq !== listSeq.current) return;
      logLocal(`[错误] 加载窗口列表失败: ${describeError(e)}`);
      setTree([]);
    } finally {
      if (seq === listSeq.current) setListLoading(false);
    }
  }, []);

  // 首次显示时自动加载（:90-91）。等后端首次就绪再发：窗口可能早于后端 ready 打开，
  // 过早请求会得到 HOST_UNAVAILABLE 而留下空列表。
  const hostReady = useHostStatus()?.state === "ready";
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (!hostReady || autoLoaded.current) return;
    autoLoaded.current = true;
    void refreshList();
    void refreshGroups();
  }, [hostReady, refreshList, refreshGroups]);

  // 打开 / 删除任务结束后刷新列表
  useEffect(
    () =>
      onTaskFinished((e) => {
        if (HOME_TASKS.has(e.type)) void refreshList();
      }),
    [refreshList],
  );

  const startTask = async (kind: "open" | "delete", ids: number[]): Promise<void> => {
    try {
      const info =
        kind === "open"
          ? await invoke(IPC.invoke.homeOpenBrowsers, ids)
          : await invoke(IPC.invoke.homeDeleteBrowsers, ids);
      markTaskStarted(info);
    } catch (e) {
      void message.error(describeError(e));
    }
  };

  /** 对标 _onOpenClicked（:446-454），原版为 TODO，这里接上真实实现 */
  const onOpen = (ids: number[]): void => {
    if (ids.length === 0) {
      void message.warning("请先勾选要打开的窗口");
      return;
    }
    logLocal(`准备打开 ${ids.length} 个窗口...`);
    void startTask("open", ids);
  };

  /** 对标 _onDeleteClicked（:456-466），原版为 TODO，这里接上真实实现 */
  const onDelete = (ids: number[]): void => {
    if (ids.length === 0) {
      void message.warning("请先勾选要删除的窗口");
      return;
    }
    modal.confirm({
      title: "确认删除",
      content: <div style={{ whiteSpace: "pre-line" }}>{`确定要删除选中的 ${ids.length} 个窗口吗？\n此操作不可恢复！`}</div>,
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => {
        logLocal(`准备删除 ${ids.length} 个窗口...`);
        void startTask("delete", ids);
      },
    });
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <ConfigCard
        groupOptions={groupOptions}
        groupId={groupId}
        onGroupChange={setGroupId}
        onRefreshGroups={() => void refreshGroups()}
        groupsLoading={groupsLoading}
      />

      {/* 对标 :139-161：三个按钮在原版是 TODO 桩，这里保持禁用 */}
      <Space>
        <Tooltip title="原版未实现">
          <span>
            <Button type="primary" icon={<PlusOutlined />} disabled>
              根据模板创建窗口
            </Button>
          </span>
        </Tooltip>
        <Tooltip title="原版未实现">
          <span>
            <Button icon={<AppstoreAddOutlined />} disabled>
              使用默认模板创建
            </Button>
          </span>
        </Tooltip>
        <Tooltip title="原版未实现">
          <span>
            <Button icon={<PauseOutlined />} disabled>
              停止任务
            </Button>
          </span>
        </Tooltip>
      </Space>

      <BrowserListCard
        groups={tree}
        loading={listLoading}
        busy={running !== null}
        onRefresh={() => void refreshList()}
        onOpen={onOpen}
        onDelete={onDelete}
      />
    </Space>
  );
}
