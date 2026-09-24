/**
 * 账号管理页（账号列表 / 添加编辑导入导出 / 绑定窗口 / 批量任务）
 *
 * 布局：PageHeader（添加 / 批量导入 / 导出选中）→ 列表面板（筛选工具栏、批量操作栏、分组标签、平铺虚拟表格）。
 *   - 账号数据（添加 / 编辑 / 批量导入 / 导出）从原设置页「账号数据」迁来；列表直接带出明文密码（可复制）、
 *     2FA 验证码（按数据库密钥算）与窗口备注（点击可编辑）；2FA 密钥与辅助邮箱原文仍只在编辑弹窗里取
 *   - 标签来自 ixBrowser 窗口：读窗口 tag_id + 词表，写走 profile-update 的 tag；显示哪些列可在工具栏「列」里
 *     自己勾选，勾选结果记在 localStorage（邮箱与操作两列始终显示）
 *   - 筛选全部在前端叠加（分组 / 登录状态 / 搜索）；被筛选隐藏的勾选保留，批量操作作用于全部勾选，确认前提示隐藏数
 *   - 批量操作：先 precheck（后端做候选筛选、生成提示 / 确认文案），逐个确认后 start（后台任务）
 *   - 任务运行中写操作禁用；停止用底部任务坞；任务结束后刷新列表
 *   - 右键菜单：编辑 / 绑定（或重新绑定）窗口 / 登录 / 删除 / 删除+窗口
 *   - 导入 / 添加后后端按窗口名自动绑定（同名窗口多个时不猜，列表标出「同名×n」由用户右键确认）
 * 按用户要求已删除：OAuth、检测 Pro、家庭组、403 相关、独立的「停止」按钮与「全选」复选框。
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  App,
  Button,
  Checkbox,
  Dropdown,
  Empty,
  Input,
  InputNumber,
  Segmented,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  type MenuProps,
  type TableColumnsType,
} from "antd";
import {
  CheckCircleFilled,
  CloudDownloadOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  MinusCircleOutlined,
  PlusOutlined,
  SyncOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import type {
  AccountListRow,
  AccountsAction,
  AccountsListResult,
  AutoBindSummary,
  ConfirmStep,
  SelectedRow,
} from "../../../shared/channels/accounts.ts";
import {
  ACCOUNT_LOGIN_FILTERS,
  accountSorter,
  countLogin,
  filterAccounts,
  hasSameNameWindows,
  autoBindNotice,
  applyLoginItem,
  applyNoteUpdate,
  applyTagsUpdate,
  type AccountLoginFilter,
} from "../../../shared/logic/account-list.ts";
import {
  ACCOUNT_IMPORT_FORMAT_HINT,
  ACCOUNT_PREVIEW_COLUMNS,
  formatAccountPreviewRow,
  parseAccountImportLine,
} from "../../../shared/logic/settings-data.ts";
import { IPC, describeError, invoke } from "../lib/ipc.ts";
import { logLocal, markTaskStarted, onTaskFinished, onTaskItem, useTaskState } from "../stores/task.ts";
import { useHostStatus } from "../stores/host-status.ts";
import { BatchImportModal } from "../components/BatchImportModal.tsx";
import { AccountEditModal } from "./accounts/AccountEditModal.tsx";
import { BindWindowModal } from "./accounts/BindWindowModal.tsx";
import { loginView } from "./accounts/status.ts";
import { finishedNotice } from "./accounts/finished-notice.ts";
import { TfaCell, useTfaCodes } from "../components/TfaCodeCell.tsx";
import { NoteModal, type NoteTarget } from "./accounts/NoteModal.tsx";
import { TagEditModal, type TagEditTarget } from "./accounts/TagEditModal.tsx";
import { TagManagerModal } from "./accounts/TagManagerModal.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { Panel } from "../components/Section.tsx";
import { useTokens } from "../theme/tokens.ts";

/** 任务结束后值得刷新账号列表的类型（health_check 会改动 login_status / last_error） */
const ACCOUNT_TASK_TYPES = new Set(["login", "batch_delete", "health_check"]);

const EXPORT_FILE_NAME = "accounts_export.txt";

/** 表格外框与表头占用的高度（表体高度 = 容器高度 - 该值） */
const TABLE_CHROME = 40;

const EMPTY_LIST: readonly AccountListRow[] = [];
/** 列设置（显示哪些列）在 localStorage 里的键 */
const HIDDEN_COLUMNS_KEY = "abb/accounts/hiddenColumns";
/** 默认隐藏的列：分组 / 辅助邮箱 / 最后登录 */
const DEFAULT_HIDDEN_COLUMNS = ["group", "recovery", "lastLogin"];
/** 始终显示的列（不出现在「列」里，也不能取消勾选） */
const ALWAYS_VISIBLE_COLUMNS = ["email", "action"];
/** 勾选列（rowSelection）的宽度：横向滚动宽度 = 可见列宽之和 + 它 */
const SELECTION_COLUMN_WIDTH = 40;

/** 读列设置：localStorage 里必须是字符串数组，否则回落默认值 */
function readHiddenColumns(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_COLUMNS_KEY);
    if (raw === null) return [...DEFAULT_HIDDEN_COLUMNS];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) return [...DEFAULT_HIDDEN_COLUMNS];
    return parsed as string[];
  } catch {
    // 读不到（禁用 localStorage / 存的不是合法 JSON）时用默认值，界面照常可用
    return [...DEFAULT_HIDDEN_COLUMNS];
  }
}

/** 写列设置（只在用户改动时调用；写不进去也只是这次会话不记住） */
function writeHiddenColumns(keys: string[]): void {
  try {
    localStorage.setItem(HIDDEN_COLUMNS_KEY, JSON.stringify(keys));
  } catch {
    logLocal("列设置保存失败：localStorage 不可写");
  }
}

function toSelected(row: AccountListRow): SelectedRow {
  return { email: row.email, browserId: row.browser_profile_id };
}

/** 多行文案：保留换行 */
function Multiline({ text }: { text: string }): ReactElement {
  return <div style={{ whiteSpace: "pre-wrap" }}>{text}</div>;
}

/** 有 / 无 的小图标（有 = ok 色，无 = idle 色） */
function Flag({ on, label }: { on: boolean; label: string }): ReactNode {
  const t = useTokens();
  return (
    <Tooltip title={on ? `有${label}` : `没有${label}`}>
      {on ? <CheckCircleFilled style={{ color: t.ok }} /> : <MinusCircleOutlined style={{ color: t.idle }} />}
    </Tooltip>
  );
}

/** 用 Blob + <a download> 触发下载（桌面端不走文件保存对话框） */
function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 工具栏里的「下拉勾选」面板（「列」与「标签筛选」共用）：把 Checkbox 放进 Dropdown 的菜单项里。
 * Dropdown 默认点一下菜单项就关闭，勾选要连点几次很不方便，所以这里自己托管 open——
 * 只认触发按钮与点空白处的开关，点菜单里的 Checkbox 不关。
 */
function CheckDropdown({
  button,
  items,
  disabled,
}: {
  /** 触发按钮 */
  button: ReactElement;
  items: MenuProps["items"];
  disabled?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  // 变禁用（例如标签词表取不到）时，把已经打开的面板收起来
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <Dropdown
      open={open}
      disabled={disabled}
      trigger={["click"]}
      menu={{ items }}
      onOpenChange={(next, info) => {
        if (info.source === "menu") return;
        setOpen(next);
      }}
    >
      {button}
    </Dropdown>
  );
}

interface ContextMenuState {
  row: AccountListRow;
  x: number;
  y: number;
}

export function AccountsPage(): ReactElement {
  const { modal, notification, message } = App.useApp();
  const { running } = useTaskState();
  const busy = running !== null;
  const tk = useTokens();

  const [list, setList] = useState<AccountsListResult | null>(null);
  /** 每次列表加载成功 +1：让 2FA 验证码跟着重取 */
  const [listVersion, setListVersion] = useState(0);
  /** 备注编辑小窗的目标行；null = 关闭 */
  const [noteTarget, setNoteTarget] = useState<NoteTarget | null>(null);
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [concurrency, setConcurrency] = useState(3);
  /** 登录成功后是否关闭该账号的窗口（失败的保留，便于人工查看） */
  const [closeWindow, setCloseWindow] = useState(true);
  const [bindEmail, setBindEmail] = useState<string | null>(null);
  /** null = 关闭；"" = 添加；邮箱 = 编辑 */
  const [editEmail, setEditEmail] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const closeBind = useCallback(() => setBindEmail(null), []);
  const closeEdit = useCallback(() => setEditEmail(null), []);
  const closeNote = useCallback(() => setNoteTarget(null), []);
  /** 标签编辑小窗的目标行；null = 关闭 */
  const [tagEdit, setTagEdit] = useState<TagEditTarget | null>(null);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const closeTagEdit = useCallback(() => setTagEdit(null), []);

  // 筛选条件
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [login, setLogin] = useState<AccountLoginFilter>("all");
  const [sameNameOnly, setSameNameOnly] = useState(false);

  // 标签筛选（多选，命中任一即显示；空数组 = 不筛）
  const [tagFilter, setTagFilter] = useState<number[]>([]);
  // 自己勾选要显示哪些列（默认隐藏分组 / 辅助邮箱 / 最后登录），改动记在 localStorage
  const [hiddenColumns, setHiddenColumns] = useState<string[]>(readHiddenColumns);

  // ---------- 数据加载 ----------

  // 自增序号：只采纳最后一次请求的结果（连续刷新时旧请求晚到不会覆盖新数据）
  const loadSeq = useRef(0);
  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const r = await invoke(IPC.invoke.accountsList);
      if (seq !== loadSeq.current) return;
      if (r.windowError) logLocal(`获取窗口列表失败: ${r.windowError}`);
      setList(r);
      setListVersion((v) => v + 1);
      // 刷新后保留仍存在账号的勾选
      const emails = new Set(r.rows.map((x) => x.email));
      setChecked((prev) => prev.filter((e) => emails.has(e)));
      setGroupId((g) => (g !== null && !r.groups.some((x) => x.groupId === g) ? null : g));
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
        // 任务成功后弹提示；failed / stopped 由全局任务坞提示
        const notice = finishedNotice(e);
        if (notice) notification.info({ message: notice.title, description: <Multiline text={notice.message} /> });
      }),
    [load, notification],
  );

  // 批量登录运行中逐行更新：后端每完成一个账号就发一条条目事件，这里立刻改那一行的登录状态
  useEffect(
    () =>
      onTaskItem((e) => {
        if (e.type !== "login") return;
        setList((prev) => (prev ? { ...prev, rows: applyLoginItem(prev.rows, e) as AccountListRow[] } : prev));
      }),
    [],
  );

  // ---------- 筛选与勾选 ----------

  const rows = list?.rows ?? EMPTY_LIST;
  const visible = useMemo(
    () => filterAccounts(rows, { groupId, login, text: deferredSearch, sameNameOnly, tagIds: tagFilter }),
    [rows, groupId, login, deferredSearch, sameNameOnly, tagFilter],
  );
  const loginCounts = useMemo(() => countLogin(rows), [rows]);
  const sameNameCount = useMemo(() => rows.filter(hasSameNameWindows).length, [rows]);

  /** 标签 → 使用它的窗口数（按当前列表统计；标签筛选与标签管理共用） */
  const tagUsage = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of rows) {
      for (const t of r.tags) m.set(t.id, (m.get(t.id) ?? 0) + 1);
    }
    return m;
  }, [rows]);

  /** 标签词表与取词表的失败原因（列表接口一次带回） */
  const vocabulary = list?.tags ?? [];
  const tagError = list?.tagError ?? null;
  /** 标签相关操作是否不可用：没有词表，或词表取不到 */
  const tagsUnavailable = tagError !== null || vocabulary.length === 0;
  const checkedSet = useMemo(() => new Set(checked), [checked]);
  /** 全部勾选（含被筛选隐藏的），按列表顺序 */
  const checkedRows = useMemo(() => rows.filter((r) => checkedSet.has(r.email)), [rows, checkedSet]);
  const hiddenChecked = useMemo(() => {
    const shown = new Set(visible.map((r) => r.email));
    return checkedRows.filter((r) => !shown.has(r.email)).length;
  }, [visible, checkedRows]);

  // 表格高度跟随容器（卡片占满页面剩余高度）
  const boxRef = useRef<HTMLDivElement>(null);
  const [bodyHeight, setBodyHeight] = useState(400);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setBodyHeight(Math.max(200, Math.floor(entry.contentRect.height) - TABLE_CHROME));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---------- 提示与确认 ----------

  const notify = useCallback(
    (level: "success" | "info" | "warning" | "error", title: string, text: string): void => {
      notification[level]({ message: title, description: <Multiline text={text} /> });
    },
    [notification],
  );

  /** 导入 / 添加后自动绑定窗口的结果提示（全部本来就已绑定时不提示） */
  const showAutoBind = useCallback(
    (s: AutoBindSummary): void => {
      const n = autoBindNotice(s);
      if (n) notify(n.level, n.title, n.text);
    },
    [notify],
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

  /**
   * 批量操作统一入口：（有隐藏勾选时先确认）→ precheck → 逐个确认 → start。
   * 不传 target 时作用于全部勾选（含被筛选隐藏的）。
   */
  const runAction = useCallback(
    async (action: AccountsAction, target?: SelectedRow[]): Promise<void> => {
      if (actionPending.current) return;
      actionPending.current = true;
      const targetRows = target ?? checkedRows.map(toSelected);
      try {
        if (!target && hiddenChecked > 0 && targetRows.length > 0) {
          const ok = await confirm({
            title: "包含看不到的账号",
            message: `已勾选 ${targetRows.length} 个账号，其中 ${hiddenChecked} 个被筛选隐藏，当前列表里看不到。\n\n确定对全部 ${targetRows.length} 个继续吗？`,
          });
          if (!ok) return;
        }
        const pre = await invoke(IPC.invoke.accountsPrecheck, action, targetRows);
        if (!pre.ok) {
          notify(pre.level, pre.title, pre.message);
          return;
        }
        for (const line of pre.logs) logLocal(line);
        for (const step of pre.confirms) {
          if (!(await confirm(step))) return;
        }
        const info = await invoke(IPC.invoke.accountsStart, action, targetRows, { concurrency, closeWindow });
        markTaskStarted(info);
      } catch (e) {
        logLocal(`错误: ${describeError(e)}`);
        notify("error", "错误", `任务执行出错:\n${describeError(e)}`);
      } finally {
        actionPending.current = false;
      }
    },
    [checkedRows, hiddenChecked, concurrency, closeWindow, notify, confirm],
  );

  /** 导出选中（含隐藏的勾选）：后端生成文本，这里只负责下载 */
  const exportSelected = async (): Promise<void> => {
    if (checkedRows.length === 0) {
      void message.info("请先勾选要导出的账号");
      return;
    }
    try {
      const r = await invoke(
        IPC.invoke.accountsExportText,
        checkedRows.map((x) => x.email),
      );
      downloadText(EXPORT_FILE_NAME, r.text);
      void message.success(`已导出 ${r.count} 个账号到: ${EXPORT_FILE_NAME}`);
    } catch (e) {
      void message.error(`导出失败: ${describeError(e)}`);
    }
  };

  // ---------- 单条操作（右键菜单 / 行内按钮） ----------

  /** 删除单个账号 */
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
    // 没有「解绑」：解绑后账号无法登录 / 巡检，没有功能需要它；换窗口用「重新绑定」
    const items: NonNullable<MenuProps["items"]> = [
      { key: "edit", label: "编辑账号" },
      { type: "divider" },
      { key: "bind", label: hasBrowser ? "重新绑定窗口" : "绑定窗口", disabled: busy },
    ];
    items.push(
      { type: "divider" },
      { key: "login", label: "登录", disabled: busy },
      { type: "divider" },
      { key: "delete", label: "删除账号", danger: true, disabled: busy },
    );
    if (hasBrowser) items.push({ key: "deleteWithWindow", label: "删除账号和窗口", danger: true, disabled: busy });
    return items;
  };

  const onMenuClick = (row: AccountListRow, key: string): void => {
    setCtxMenu(null);
    switch (key) {
      case "edit":
        setEditEmail(row.email);
        break;
      case "bind":
        setBindEmail(row.email);
        break;
      case "login":
        void runAction("single_login", [toSelected(row)]);
        break;
      case "delete":
        void deleteOne(row);
        break;
      case "deleteWithWindow":
        void runAction("delete_one_with_window", [toSelected(row)]);
        break;
    }
  };

  // ---------- 表格列 ----------

  // 验证码：密钥在后端，只问「可见行里有密钥」的账号；列表刷新后 version 变化会重新取
  const tfaEmails = useMemo(() => visible.filter((r) => r.has_secret).map((r) => r.email), [visible]);
  const tfa = useTfaCodes(tfaEmails, listVersion, (emails) => invoke(IPC.invoke.accountsTfaCodes, emails));
  const invalidTfa = useMemo(() => new Set(tfa?.invalid ?? []), [tfa]);

  // 列的定义：数组顺序就是显示顺序；每列都必须有数字 width（横向滚动宽度由可见列宽算出）
  const allColumns = useMemo<TableColumnsType<AccountListRow>>(
    () => [
      { title: "邮箱", key: "email", width: 240, ellipsis: true, sorter: accountSorter("email"), render: (_, r) => r.email },
      {
        title: "登录状态",
        key: "login",
        width: 170,
        ellipsis: true,
        render: (_, r) => {
          const v = loginView(r);
          const t = (
            <Tag bordered={false} color={v.color}>
              {v.text}
            </Tag>
          );
          return v.tooltip ? <Tooltip title={v.tooltip}>{t}</Tooltip> : t;
        },
      },
      {
        title: "密码",
        key: "pw",
        width: 170,
        render: (_, r) =>
          r.password ? (
            <Typography.Text
              className="abb-mono"
              style={{ maxWidth: 140 }}
              ellipsis={{ tooltip: r.password }}
              copyable={{ text: r.password, tooltips: ["复制密码", "已复制"] }}
            >
              {r.password}
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary">—</Typography.Text>
          ),
      },
      {
        title: "验证码",
        key: "tfaCode",
        width: 150,
        render: (_, r) => (
          <TfaCell
            hasTfa={r.has_secret}
            code={tfa?.codes[r.email]}
            invalid={invalidTfa.has(r.email)}
            periodEndsAt={tfa?.periodEndsAt ?? null}
          />
        ),
      },
      {
        title: "标签",
        key: "tags",
        width: 200,
        render: (_, r) => {
          // 标签挂在 ixBrowser 窗口上：没绑定窗口就无从编辑
          if (!/^\d+$/.test(r.browser_profile_id)) {
            return (
              <Tooltip title="账号未绑定窗口，标签挂在窗口上">
                <Typography.Text type="secondary">—</Typography.Text>
              </Tooltip>
            );
          }
          return (
            <Tooltip title={r.tags.length > 0 ? r.tags.map((t) => t.title).join("、") : "点击设置标签"}>
              <span
                onClick={() => setTagEdit({ email: r.email, windowName: r.window_name, tagIds: r.tags.map((t) => t.id) })}
                style={{ display: "block", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {r.tags.length === 0 ? (
                  <Typography.Text type="secondary">—</Typography.Text>
                ) : (
                  <Space size={4}>
                    {r.tags.map((t) => (
                      <Tag key={t.id} color={t.color || undefined} bordered={false}>
                        {t.title}
                      </Tag>
                    ))}
                  </Space>
                )}
              </span>
            </Tooltip>
          );
        },
      },
      {
        title: "窗口ID",
        key: "windowId",
        width: 90,
        sorter: accountSorter("windowId"),
        defaultSortOrder: "descend",
        render: (_, r) =>
          r.browser_profile_id ? <span className="abb-mono">{r.browser_profile_id}</span> : <Typography.Text type="secondary">—</Typography.Text>,
      },
      {
        title: "窗口名",
        key: "windowName",
        width: 180,
        ellipsis: true,
        render: (_, r) => (
          <>
            {hasSameNameWindows(r) && (
              <Tooltip title={`有 ${r.same_name_windows} 个同名窗口，右键「重新绑定窗口」可确认或更换`}>
                <Tag bordered={false} color="warning" style={{ marginInlineEnd: 4 }}>
                  同名×{r.same_name_windows}
                </Tag>
              </Tooltip>
            )}
            {r.window_name || "—"}
          </>
        ),
      },
      { title: "分组", key: "group", width: 120, ellipsis: true, render: (_, r) => <Tag bordered={false}>{r.group_name}</Tag> },
      {
        title: "备注",
        key: "note",
        width: 220,
        render: (_, r) => {
          // 备注在 ixBrowser 窗口上：没绑定窗口就无从修改
          if (!/^\d+$/.test(r.browser_profile_id)) {
            return (
              <Tooltip title="账号未绑定窗口，窗口备注无从修改">
                <Typography.Text type="secondary">—</Typography.Text>
              </Tooltip>
            );
          }
          return (
            <Tooltip title={<span style={{ whiteSpace: "pre-line" }}>{r.note || "点击添加备注"}</span>}>
              <span
                onClick={() => setNoteTarget({ email: r.email, windowName: r.window_name, note: r.note })}
                style={{ display: "block", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {r.note || <Typography.Text type="secondary">添加备注</Typography.Text>}
              </span>
            </Tooltip>
          );
        },
      },
      { title: "辅助邮箱", key: "recovery", width: 76, align: "center", render: (_, r) => <Flag on={r.has_recovery_email} label="辅助邮箱" /> },
      {
        title: "最后登录",
        key: "lastLogin",
        width: 150,
        sorter: accountSorter("lastLogin"),
        render: (_, r) => r.last_login_at ?? <Typography.Text type="secondary">—</Typography.Text>,
      },
      {
        title: "操作",
        key: "action",
        width: 130,
        render: (_, r) => (
          <Space size={0}>
            <Button type="link" size="small" icon={<EditOutlined />} onClick={() => setEditEmail(r.email)}>
              编辑
            </Button>
            {r.login_status !== "logged_in" && (
              <Button
                type="link"
                size="small"
                disabled={busy}
                onClick={() => void runAction("single_login", [toSelected(r)])}
              >
                登录
              </Button>
            )}
          </Space>
        ),
      },
    ],
    [busy, runAction, tfa, invalidTfa],
  );

  /** 实际显示的列：邮箱与操作始终显示，其余看「列」里的勾选 */
  const visibleColumns = useMemo(
    () => allColumns.filter((c) => ALWAYS_VISIBLE_COLUMNS.includes(String(c.key)) || !hiddenColumns.includes(String(c.key))),
    [allColumns, hiddenColumns],
  );

  /** 表格横向滚动宽度：按可见列宽之和算（隐藏列后右侧不再留白 / 显示不全） */
  const visibleColumnsWidth = useMemo(
    () => visibleColumns.reduce((sum, c) => sum + (typeof c.width === "number" ? c.width : 0), 0),
    [visibleColumns],
  );

  /** 勾选 / 取消一列并记住（邮箱与操作不在「列」里，永远显示） */
  const toggleColumn = (key: string, show: boolean): void => {
    const next = show ? hiddenColumns.filter((k) => k !== key) : [...hiddenColumns, key];
    setHiddenColumns(next);
    writeHiddenColumns(next);
  };

  /** 「列」下拉的项：可隐藏列各一项，勾选 = 显示（顺序与显示顺序一致） */
  const columnItems: MenuProps["items"] = allColumns
    .filter((c) => !ALWAYS_VISIBLE_COLUMNS.includes(String(c.key)))
    .map((c) => {
      const key = String(c.key);
      return {
        key,
        label: (
          <Checkbox checked={!hiddenColumns.includes(key)} onChange={(e) => toggleColumn(key, e.target.checked)}>
            {String(c.title)}
          </Checkbox>
        ),
      };
    });

  /** 标签筛选下拉的项：多选（命中任一即显示）；词表取不到时只显示原因 */
  const tagFilterItems: MenuProps["items"] =
    tagError !== null
      ? [{ key: "tagError", disabled: true, label: <Typography.Text type="secondary">标签词表获取失败：{tagError}</Typography.Text> }]
      : [
          ...vocabulary.map((t) => ({
            key: String(t.id),
            label: (
              <Checkbox
                checked={tagFilter.includes(t.id)}
                onChange={(e) => setTagFilter((prev) => (e.target.checked ? [...prev, t.id] : prev.filter((id) => id !== t.id)))}
              >
                <Space size={4}>
                  <Tag color={t.color || undefined} bordered={false}>
                    {t.title}
                  </Tag>
                  <Typography.Text type="secondary">({tagUsage.get(t.id) ?? 0})</Typography.Text>
                </Space>
              </Checkbox>
            ),
          })),
          { type: "divider" },
          {
            key: "clear",
            label: (
              <Button type="link" size="small" disabled={tagFilter.length === 0} onClick={() => setTagFilter([])}>
                清空
              </Button>
            ),
          },
        ];

  // ---------- 渲染 ----------

  const actionBtn = (
    label: string,
    action: AccountsAction,
    tooltip: string,
    extra?: { primary?: boolean; danger?: boolean; icon?: ReactNode },
  ): ReactNode => (
    <Tooltip title={tooltip}>
      <Button
        type={extra?.primary ? "primary" : "default"}
        danger={extra?.danger}
        icon={extra?.icon}
        disabled={busy}
        onClick={() => void runAction(action)}
      >
        {label}
      </Button>
    </Tooltip>
  );

  const total = rows.length;
  const filtered = visible.length !== total;
  const hasChecked = checked.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, height: "100%", minHeight: 600 }}>
      <PageHeader
        title="账号"
        description="Google 账号与绑定的 ixBrowser 窗口。勾选后可以批量登录、巡检或删除，右键单个账号有更多操作；显示哪些列可在工具栏「列」里自己勾选。"
        extra={
          <>
            <Button icon={<PlusOutlined />} onClick={() => setEditEmail("")}>
              添加账号
            </Button>
            <Button icon={<DownloadOutlined />} onClick={() => setImportOpen(true)}>
              批量导入
            </Button>
            <Tooltip title="导出勾选的账号（含密码 / 辅助邮箱 / 2FA 密钥原文）">
              <Button icon={<UploadOutlined />} onClick={() => void exportSelected()}>
                导出选中
              </Button>
            </Tooltip>
          </>
        }
      />

      <Panel fill>
        {/* 筛选工具栏：刷新 + 搜索 + 登录状态 + 同名 + 标签筛选 / 标签管理 / 列设置 | 计数 */}
        <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
          <Space wrap>
            <Button icon={<SyncOutlined />} loading={loading} onClick={() => void load()}>
              刷新
            </Button>
            <Input.Search
              placeholder="搜索 邮箱 / 窗口ID / 窗口名"
              allowClear
              style={{ width: 260 }}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Segmented<AccountLoginFilter>
              value={login}
              onChange={setLogin}
              options={ACCOUNT_LOGIN_FILTERS.map((o) => ({ value: o.value, label: `${o.label} ${loginCounts[o.value]}` }))}
            />
            {/* 勾着时即使刷新后计数归零也保留开关，否则筛选关不掉 */}
            {(sameNameCount > 0 || sameNameOnly) && (
              <Tooltip title="窗口名与邮箱相同的窗口有多个，自动绑定不会替你选，需要确认绑的是哪一个">
                <Checkbox checked={sameNameOnly} onChange={(e) => setSameNameOnly(e.target.checked)}>
                  只看同名窗口 ({sameNameCount})
                </Checkbox>
              </Tooltip>
            )}

            {/* 标签筛选（多选，命中任一即显示） / 标签管理 / 列设置 */}
            <CheckDropdown
              disabled={tagsUnavailable}
              button={<Button>{tagFilter.length > 0 ? `标签筛选 (${tagFilter.length})` : "标签筛选"}</Button>}
              items={tagFilterItems}
            />
            <Tooltip title={tagError !== null ? `标签词表获取失败：${tagError}` : "新建 / 改名 / 删除标签（改的是 ixBrowser 里的词表）"}>
              {/* disabled 的按钮自己收不到鼠标事件，包一层 span 才能挂上 Tooltip */}
              <span style={{ display: "inline-block" }}>
                <Button disabled={tagsUnavailable} onClick={() => setTagManagerOpen(true)}>
                  标签管理
                </Button>
              </span>
            </Tooltip>
            <CheckDropdown button={<Button>列</Button>} items={columnItems} />
          </Space>
          <Typography.Text type="secondary">{filtered ? `显示 ${visible.length} / 共 ${total}` : `共 ${total} 个账号`}</Typography.Text>
        </Space>

        {/* 批量操作栏：左侧已选摘要，右侧批量任务与删除；有勾选时底色换成主色浅底，更醒目。
            可用条件与原来一致（只受 busy 控制，未勾选时由 precheck 给出提示） */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "6px 8px",
            borderRadius: 6,
            background: hasChecked ? tk.indigoSoft : tk.canvas,
          }}
        >
          {hasChecked ? (
            <Typography.Text>
              已选 <b className="abb-num">{checked.length}</b> 个
              {hiddenChecked > 0 && <Typography.Text type="warning">（其中 {hiddenChecked} 个不在当前视图）</Typography.Text>}
              <Button type="link" size="small" onClick={() => setChecked([])}>
                清空
              </Button>
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary">勾选账号后批量操作</Typography.Text>
          )}
          <Space wrap size={16}>
            <Space wrap>
              {actionBtn(`批量登录${hasChecked ? `（${checked.length}）` : ""}`, "login", "批量登录勾选的账号", {
                primary: hasChecked,
                icon: <CloudDownloadOutlined />,
              })}
              <Tooltip title="批量登录时同时打开的窗口数">
                <Space size={8}>
                  <span>并发</span>
                  <InputNumber
                    min={1}
                    max={10}
                    precision={0}
                    value={concurrency}
                    onChange={(v) => setConcurrency(typeof v === "number" ? v : 1)}
                    disabled={busy}
                    style={{ width: 64 }}
                  />
                </Space>
              </Tooltip>
              <Tooltip title="登录成功的账号完成后自动关窗；失败的保留窗口，方便你查看原因或手动过验证码">
                <Checkbox checked={closeWindow} onChange={(e) => setCloseWindow(e.target.checked)} disabled={busy}>
                  登录后关窗
                </Checkbox>
              </Tooltip>
              {actionBtn("健康巡检", "health_check", "只读检查勾选账号在窗口里的登录状态（不提交密码，不产生新登录）")}
            </Space>
            <Space wrap>
              {actionBtn("删除选中", "delete", "只删除账号记录，不删浏览器窗口", { icon: <DeleteOutlined /> })}
              {actionBtn("删除+窗口", "delete_with_windows", "删除勾选账号及其绑定的浏览器窗口", { danger: true })}
            </Space>
          </Space>
        </div>

        {/* 分组标签：单选；数量为分组内账号总数（不随其它筛选变化） */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Tag.CheckableTag checked={groupId === null} onChange={() => setGroupId(null)}>
            全部 ({total})
          </Tag.CheckableTag>
          {(list?.groups ?? []).map((g) => (
            <Tag.CheckableTag key={g.groupId} checked={groupId === g.groupId} onChange={() => setGroupId(g.groupId)}>
              {g.groupName} ({g.count})
            </Tag.CheckableTag>
          ))}
        </div>

        <div ref={boxRef} style={{ flex: 1, minHeight: 240 }}>
          <Table<AccountListRow>
            size="small"
            rowKey="email"
            columns={visibleColumns}
            dataSource={visible as AccountListRow[]}
            loading={loading}
            pagination={false}
            showSorterTooltip={false}
            // 虚拟滚动：只渲染可视区域的行；虚拟表要求 scroll.x 是数字，所以按可见列宽之和算（含勾选列），
            // 容器更宽时 antd 会让各列按容器宽度补齐
            virtual
            scroll={{ x: visibleColumnsWidth + SELECTION_COLUMN_WIDTH, y: bodyHeight }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={!list ? (loading ? "加载中..." : "暂无数据，点「刷新」加载") : total === 0 ? "还没有账号，点「添加账号」或「批量导入」" : "没有匹配的账号"}
                />
              ),
            }}
            rowSelection={{
              columnWidth: SELECTION_COLUMN_WIDTH,
              selectedRowKeys: checked,
              // 被筛选隐藏的勾选也要保留（antd 默认会丢掉不在 dataSource 里的 key）
              preserveSelectedRowKeys: true,
              onChange: (keys) => setChecked(keys.map(String)),
            }}
            onRow={(record) => ({
              onContextMenu: (e) => {
                e.preventDefault();
                setCtxMenu({ row: record, x: e.clientX, y: e.clientY });
              },
            })}
          />
        </div>
      </Panel>

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

      <BindWindowModal email={bindEmail} onClose={closeBind} onBound={() => void load()} />
      <AccountEditModal
        email={editEmail}
        onClose={closeEdit}
        onSaved={(bind) => {
          if (bind) showAutoBind(bind);
          void load();
        }}
      />
      <NoteModal
        target={noteTarget}
        onClose={closeNote}
        onSaved={(email, note) =>
          setList((prev) => (prev ? { ...prev, rows: applyNoteUpdate(prev.rows, email, note) as AccountListRow[] } : prev))
        }
      />

      <TagEditModal
        target={tagEdit}
        vocabulary={vocabulary}
        onClose={closeTagEdit}
        onSaved={(email, tags) =>
          setList((prev) => (prev ? { ...prev, rows: applyTagsUpdate(prev.rows, email, tags) as AccountListRow[] } : prev))
        }
        onVocabularyChanged={() => void load()}
      />
      <TagManagerModal
        open={tagManagerOpen}
        vocabulary={vocabulary}
        usage={tagUsage}
        onClose={() => setTagManagerOpen(false)}
        onChanged={() => void load()}
      />
      <BatchImportModal
        open={importOpen}
        title="批量导入账号"
        formatHint={ACCOUNT_IMPORT_FORMAT_HINT}
        columns={ACCOUNT_PREVIEW_COLUMNS}
        parseLine={parseAccountImportLine}
        formatPreviewRow={formatAccountPreviewRow}
        onImport={async (text) => {
          const r = await invoke(IPC.invoke.accountsImport, text);
          showAutoBind(r.bind);
          return r;
        }}
        onClose={() => setImportOpen(false)}
        onDone={() => void load()}
      />
    </div>
  );
}
