/**
 * 账号管理页 —— 对标 gui/account_manager_interface.py（AccountManagerInterface）
 *
 * 布局用 antd 重新组织，功能与文案照搬 Python：
 *   - 两行工具栏（:170-310）、全选 + 已选计数（:121-134）、10 列表格（:312-365）、底部统计（:486）
 *   - 筛选 14 项在前端过滤（:591-636），勾选只对当前筛选可见的行生效（:715-735）
 *   - 右键菜单（:638-711）
 *   - 批量操作：先 precheck（后端做候选筛选、生成提示 / 确认文案），逐个确认后 start（后台任务）
 *   - 任务运行中，除「停止」外所有操作禁用（:1445-1460）；任务结束后刷新列表
 *   - 「一键加入家庭组」与右键「加入家庭组」：用户确认不需要，桌面版不提供（Python 侧保留）
 * 日志区与进度条由全局 TaskDock 承担。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  App,
  Button,
  Card,
  Checkbox,
  Dropdown,
  InputNumber,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  type MenuProps,
  type TableColumnsType,
} from "antd";
import {
  CloudDownloadOutlined,
  DeleteOutlined,
  LinkOutlined,
  PauseOutlined,
  ReloadOutlined,
  SendOutlined,
} from "@ant-design/icons";
import type {
  AccountListRow,
  AccountsAction,
  ConfirmStep,
  SelectedRow,
} from "../../../shared/channels/accounts.ts";
import { IPC, describeError, invoke } from "../lib/ipc.ts";
import { logLocal, markTaskStarted, onTaskFinished, stopTask, useTaskState } from "../stores/task.ts";
import { useHostStatus } from "../stores/host-status.ts";
import { BindWindowModal } from "./accounts/BindWindowModal.tsx";
import {
  FILTER_OPTIONS,
  loginView,
  matchesFilter,
  proView,
  statsText,
  sub2apiView,
  unlockView,
  type FilterOption,
} from "./accounts/status.ts";
import { finishedNotice } from "./accounts/finished-notice.ts";

/** 本页启动的任务类型：结束后刷新列表（对标各 finished 回调里的 _loadData） */
const ACCOUNT_TASK_TYPES = new Set([
  "login",
  "oauth",
  "login_and_oauth",
  "unlock_403",
  "detect_pro",
  "refresh_membership_info",
  "batch_bind",
  "batch_delete",
  "detect_403",
  "enable_family_sharing",
]);


function toSelected(row: AccountListRow): SelectedRow {
  return { email: row.email, browserId: row.browser_profile_id };
}

/** 多行文案：保留换行 */
function Multiline({ text }: { text: string }): ReactElement {
  return <div style={{ whiteSpace: "pre-wrap" }}>{text}</div>;
}

interface ContextMenuState {
  row: AccountListRow;
  x: number;
  y: number;
}

export function AccountsPage(): ReactElement {
  const { modal, notification } = App.useApp();
  const { running } = useTaskState();
  const busy = running !== null;

  const [rows, setRows] = useState<AccountListRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<FilterOption>("全部");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [concurrency, setConcurrency] = useState(3);
  const [autoBindProxy, setAutoBindProxy] = useState(true);
  const [bindEmail, setBindEmail] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const closeBind = useCallback(() => setBindEmail(null), []);

  // ---------- 数据加载（对标 _loadData，:367） ----------

  // 自增序号：只采纳最后一次请求的结果（连续刷新时旧请求晚到不会覆盖新数据）
  const loadSeq = useRef(0);
  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const r = await invoke(IPC.invoke.accountsList);
      if (seq !== loadSeq.current) return;
      if (r.windowError) logLocal(`获取窗口列表失败: ${r.windowError}`);
      setRows(r.rows);
      // 表格重建后勾选全部清空（:494-501）
      setSelected(new Set());
      logLocal(`加载完成，共 ${r.rows.length} 个账号`);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      logLocal(`加载账号失败: ${describeError(e)}`);
      notification.error({ message: "错误", description: `加载账号失败:\n${describeError(e)}` });
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [notification]);

  // 等后端首次就绪再自动加载（窗口可能早于后端 ready 打开，过早请求得到 HOST_UNAVAILABLE）
  const hostReady = useHostStatus()?.state === "ready";
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (!hostReady || autoLoaded.current) return;
    autoLoaded.current = true;
    void load();
    invoke(IPC.invoke.accountsGetDefaults).then(
      (d) => setConcurrency(d.loginConcurrency),
      () => {},
    );
  }, [hostReady, load]);

  useEffect(
    () =>
      onTaskFinished((e) => {
        if (!ACCOUNT_TASK_TYPES.has(e.type)) return;
        void load();
        // 对标各 finished 回调里的 _showInfo；failed / stopped 由全局任务坞提示
        const notice = finishedNotice(e);
        if (notice) notification.info({ message: notice.title, description: <Multiline text={notice.message} /> });
      }),
    [load, notification],
  );

  // ---------- 筛选与勾选 ----------

  const visibleRows = useMemo(() => rows.filter((r) => matchesFilter(r, filter)), [rows, filter]);
  /** 只算当前可见行里的勾选（对标 _getSelectedRows 跳过隐藏行） */
  const checkedRows = useMemo(() => visibleRows.filter((r) => selected.has(r.email)), [visibleRows, selected]);
  const allVisibleChecked = visibleRows.length > 0 && checkedRows.length === visibleRows.length;

  const toggleAllVisible = (checked: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of visibleRows) {
        if (checked) next.add(r.email);
        else next.delete(r.email);
      }
      return next;
    });
  };

  // ---------- 提示与确认 ----------

  const notify = useCallback(
    (level: "info" | "warning" | "error", title: string, text: string): void => {
      notification[level]({ message: title, description: <Multiline text={text} /> });
    },
    [notification],
  );

  const confirm = useCallback(
    (step: ConfirmStep): Promise<boolean> =>
      new Promise((resolve) => {
        modal.confirm({
          title: step.title,
          content: <Multiline text={step.message} />,
          okText: "确定",
          cancelText: "取消",
          width: 480,
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      }),
    [modal],
  );

  /** precheck → 确认 → start 进行中（防止重复点击触发两轮确认） */
  const actionPending = useRef(false);

  /** 批量操作统一入口：precheck → 逐个确认 → start */
  const runAction = useCallback(
    async (action: AccountsAction, target?: SelectedRow[]): Promise<void> => {
      if (actionPending.current) return;
      actionPending.current = true;
      const targetRows = target ?? checkedRows.map(toSelected);
      try {
        const pre = await invoke(IPC.invoke.accountsPrecheck, action, targetRows);
        if (!pre.ok) {
          notify(pre.level, pre.title, pre.message);
          return;
        }
        for (const line of pre.logs) logLocal(line);
        for (const step of pre.confirms) {
          if (!(await confirm(step))) return;
        }
        const info = await invoke(IPC.invoke.accountsStart, action, targetRows, { concurrency, autoBindProxy });
        markTaskStarted(info);
      } catch (e) {
        logLocal(`错误: ${describeError(e)}`);
        notify("error", "错误", `任务执行出错:\n${describeError(e)}`);
      } finally {
        actionPending.current = false;
      }
    },
    [checkedRows, concurrency, autoBindProxy, notify, confirm],
  );

  // ---------- 单条操作（右键菜单） ----------

  /** 对标 _unbindBrowser（:1600） */
  const unbind = async (row: AccountListRow): Promise<void> => {
    if (!row.browser_profile_id) {
      logLocal(`账号 ${row.email} 未绑定窗口`);
      return;
    }
    const ok = await confirm({
      title: "确认解绑",
      message: `确定要解绑账号 ${row.email} 与窗口 ${row.browser_profile_id} 的绑定吗？`,
    });
    if (!ok) return;
    try {
      const r = await invoke(IPC.invoke.accountsUnbind, row.email);
      logLocal(`已解绑账号 ${row.email} 与窗口 ${r.browserId}`);
      void load();
    } catch (e) {
      logLocal(`解绑窗口失败: ${describeError(e)}`);
      notify("error", "错误", `解绑窗口失败:\n${describeError(e)}`);
    }
  };

  /** 对标 _deleteSingleAccount（:1631） */
  const deleteOne = async (row: AccountListRow): Promise<void> => {
    const ok = await confirm({
      title: "确认删除",
      message: `确定要删除账号 ${row.email} 吗？\n\n注意：仅删除账号记录，不会删除对应的浏览器窗口。`,
    });
    if (!ok) return;
    try {
      await invoke(IPC.invoke.accountsDeleteOne, row.email);
      logLocal(`已删除账号: ${row.email}`);
      void load();
    } catch (e) {
      logLocal(`删除账号失败: ${describeError(e)}`);
      notify("error", "错误", `删除账号失败:\n${describeError(e)}`);
    }
  };

  const menuItems = (row: AccountListRow): MenuProps["items"] => {
    const hasBrowser = row.browser_profile_id !== "";
    const items: NonNullable<MenuProps["items"]> = hasBrowser
      ? [
          { key: "rebind", label: "重新绑定窗口", disabled: busy },
          { key: "unbind", label: "解绑窗口", disabled: busy },
        ]
      : [{ key: "bind", label: "绑定窗口", disabled: busy }];
    items.push(
      { type: "divider" },
      { key: "login", label: "登录", disabled: busy },
      { key: "oauth", label: "OAuth", disabled: busy },
    );
    // Python :685 在此处还有「加入家庭组」—— 用户确认不需要该功能，桌面版不提供
    items.push(
      { type: "divider" },
      { key: "refresh", label: "刷新" },
      { type: "divider" },
      { key: "delete", label: "删除账号", danger: true, disabled: busy },
    );
    if (hasBrowser) items.push({ key: "deleteWithWindow", label: "删除账号和窗口", danger: true, disabled: busy });
    return items;
  };

  const onMenuClick = (row: AccountListRow, key: string): void => {
    setCtxMenu(null);
    switch (key) {
      case "bind":
      case "rebind":
        setBindEmail(row.email);
        break;
      case "unbind":
        void unbind(row);
        break;
      case "login":
        void runAction("single_login", [toSelected(row)]);
        break;
      case "oauth":
        void runAction("single_oauth", [toSelected(row)]);
        break;
      case "refresh":
        void load();
        break;
      case "delete":
        void deleteOne(row);
        break;
      case "deleteWithWindow":
        void runAction("delete_one_with_window", [toSelected(row)]);
        break;
    }
  };

  // ---------- 表格列（:316-356） ----------

  const tag = (text: string, color: string, tooltip?: string | null): ReactNode => {
    const t = <Tag color={color}>{text}</Tag>;
    return tooltip ? <Tooltip title={tooltip}>{t}</Tooltip> : t;
  };

  const columns: TableColumnsType<AccountListRow> = [
    { title: "邮箱", dataIndex: "email", width: 240, ellipsis: true },
    {
      title: "登录状态",
      key: "login",
      width: 190,
      render: (_, r) => {
        const v = loginView(r);
        return tag(v.text, v.color, v.tooltip);
      },
    },
    {
      title: "Pro",
      key: "pro",
      width: 90,
      render: (_, r) => {
        const v = proView(r.is_pro);
        return tag(v.text, v.color, v.tooltip);
      },
    },
    { title: "窗口名称", key: "windowName", ellipsis: true, render: (_, r) => r.window_name || "-" },
    { title: "窗口ID", key: "windowId", width: 100, render: (_, r) => r.browser_profile_id || "-" },
    {
      title: "Sub2API",
      key: "sub2api",
      width: 90,
      render: (_, r) => {
        const v = sub2apiView(r.sub2api_status);
        return tag(v.text, v.color);
      },
    },
    {
      title: "解锁状态",
      key: "unlock",
      width: 90,
      render: (_, r) => {
        const v = unlockView(r.unlock_status);
        return tag(v.text, v.color);
      },
    },
    { title: "更新时间", key: "updatedAt", width: 170, render: (_, r) => r.updated_at || "-" },
    {
      title: "操作",
      key: "action",
      width: 100,
      fixed: "right",
      // 对标 :475-480：未登录显示「登录」，已登录显示「OAuth」
      render: (_, r) =>
        r.login_status !== "logged_in" ? (
          <Button
            type="link"
            size="small"
            icon={<CloudDownloadOutlined />}
            disabled={busy}
            onClick={() => void runAction("single_login", [toSelected(r)])}
          >
            登录
          </Button>
        ) : (
          <Button
            type="link"
            size="small"
            icon={<LinkOutlined />}
            disabled={busy}
            onClick={() => void runAction("single_oauth", [toSelected(r)])}
          >
            OAuth
          </Button>
        ),
    },
  ];

  // ---------- 工具栏 ----------

  const btn = (label: string, action: AccountsAction, tooltip?: string, extra?: { primary?: boolean; icon?: ReactNode }) => {
    const b = (
      <Button
        type={extra?.primary ? "primary" : "default"}
        icon={extra?.icon}
        disabled={busy}
        onClick={() => void runAction(action)}
      >
        {label}
      </Button>
    );
    return tooltip ? <Tooltip title={tooltip}>{b}</Tooltip> : b;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        Google 账号管理
      </Typography.Title>

      <Card size="small">
        <Space wrap>
          {btn("批量登录", "login", "批量登录选中的账号", { primary: true, icon: <CloudDownloadOutlined /> })}
          {btn("批量 OAuth", "oauth", "批量进行 OAuth 授权", { icon: <LinkOutlined /> })}
          {btn("一键登录+OAuth", "login_and_oauth", "一键完成登录和OAuth", { icon: <SendOutlined /> })}
          <span style={{ width: 8 }} />
          {btn("批量绑定窗口", "batch_bind", "根据窗口名称匹配邮箱自动绑定")}
          {btn("检测 Pro", "detect_pro", "检测选中已登录账号的 Google One Pro 会员状态")}
          {btn("刷新家庭组", "refresh_membership_info", "刷新选中账号的完整会员信息（Pro状态、家庭组、国家）")}
          {btn("开启共享", "enable_family_sharing", "为普通 Pro 账户开启家庭组共享功能")}
        </Space>
      </Card>

      <Card size="small">
        <Space wrap>
          {btn("检测 403", "detect_403")}
          {btn("批量解锁 403", "unlock_403")}
          <span style={{ width: 8 }} />
          <Button icon={<ReloadOutlined />} disabled={busy} loading={loading} onClick={() => void load()}>
            刷新
          </Button>
          <Button
            icon={<PauseOutlined />}
            disabled={!busy}
            onClick={() => {
              logLocal("正在停止...");
              stopTask().catch((e: unknown) => notify("error", "停止失败", describeError(e)));
            }}
          >
            停止
          </Button>
          <span style={{ width: 8 }} />
          <Button icon={<DeleteOutlined />} disabled={busy} onClick={() => void runAction("delete")}>
            删除选中
          </Button>
          <Tooltip title="删除选中账号及其对应的浏览器窗口">
            <Button danger disabled={busy} onClick={() => void runAction("delete_with_windows")}>
              删除+窗口
            </Button>
          </Tooltip>
          <span style={{ width: 8 }} />
          <Typography.Text type="secondary">筛选:</Typography.Text>
          <Select
            style={{ minWidth: 130 }}
            value={filter}
            onChange={(v: FilterOption) => setFilter(v)}
            options={FILTER_OPTIONS.map((f) => ({ value: f, label: f }))}
          />
          <Typography.Text type="secondary">并发数:</Typography.Text>
          <InputNumber
            min={1}
            max={10}
            precision={0}
            value={concurrency}
            onChange={(v) => setConcurrency(typeof v === "number" ? v : 1)}
            disabled={busy}
          />
          <Tooltip title="OAuth 成功后自动绑定到使用量最少的代理">
            <Checkbox checked={autoBindProxy} onChange={(e) => setAutoBindProxy(e.target.checked)} disabled={busy}>
              自动绑定代理
            </Checkbox>
          </Tooltip>
        </Space>
      </Card>

      <Space size={12}>
        <Tooltip title="全选/取消全选当前显示的账号">
          <Checkbox
            checked={allVisibleChecked}
            indeterminate={checkedRows.length > 0 && !allVisibleChecked}
            onChange={(e) => toggleAllVisible(e.target.checked)}
          >
            全选
          </Checkbox>
        </Tooltip>
        <Typography.Text type="secondary">已选: {checkedRows.length}</Typography.Text>
      </Space>

      <Table<AccountListRow>
        size="small"
        rowKey="email"
        loading={loading}
        columns={columns}
        dataSource={visibleRows}
        scroll={{ x: 1200 }}
        pagination={{ defaultPageSize: 50, showSizeChanger: true, pageSizeOptions: [20, 50, 100, 200, 500] }}
        rowSelection={{
          hideSelectAll: true,
          selectedRowKeys: checkedRows.map((r) => r.email),
          onSelect: (record, checked) =>
            setSelected((prev) => {
              const next = new Set(prev);
              if (checked) next.add(record.email);
              else next.delete(record.email);
              return next;
            }),
        }}
        onRow={(record) => ({
          onContextMenu: (e) => {
            e.preventDefault();
            setCtxMenu({ row: record, x: e.clientX, y: e.clientY });
          },
        })}
      />

      <Typography.Text type="secondary">{statsText(rows)}</Typography.Text>

      {/* 右键菜单：在鼠标位置放一个 1px 锚点，受控打开 */}
      <Dropdown
        open={ctxMenu !== null}
        onOpenChange={(open) => {
          if (!open) setCtxMenu(null);
        }}
        trigger={["contextMenu"]}
        menu={{
          items: ctxMenu ? menuItems(ctxMenu.row) : [],
          onClick: ({ key }) => {
            if (ctxMenu) onMenuClick(ctxMenu.row, key);
          },
        }}
      >
        <div
          style={{
            position: "fixed",
            left: ctxMenu?.x ?? 0,
            top: ctxMenu?.y ?? 0,
            width: 1,
            height: 1,
            pointerEvents: "none",
          }}
        />
      </Dropdown>

      <BindWindowModal
        email={bindEmail}
        onClose={closeBind}
        onBound={() => void load()}
      />
    </div>
  );
}
