/**
 * 账号页的「窗口视角」：ixBrowser 全部窗口（含未绑定账号的），承接原首页窗口列表
 *
 * 与账号视角的分工：账号视角回答「这个账号怎么样」，窗口视角回答「这个窗口/这台环境怎么样」，
 * 并多给一列「绑定账号」——原来两页分着看是看不出「哪些窗口还没绑账号」的。
 *
 * - 搜索：窗口ID 前缀 / 名称 / 备注 / **绑定账号**，不区分大小写；与分组标签、未绑定标签叠加
 * - 勾选：以行 key 记录；被筛选隐藏的行保留勾选，工具栏提示「其中 M 个不在当前视图」
 * - 创建窗口：模板 / 前缀 / 目标分组来自设置页「创建参数」（这里只给个数）
 * 纯逻辑在 app/shared/logic/home-list.ts 与 unified-list.ts。
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { App, Button, Empty, Input, InputNumber, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DeleteOutlined, EyeOutlined, PlusOutlined, SyncOutlined } from "@ant-design/icons";
import {
  HOME_TASK_TYPES,
  MAX_CREATE_COUNT,
  type HomeBrowserList,
  type HomeConfig,
  type HomeGroupOption,
} from "../../../../shared/channels/home.ts";
import {
  defaultGroupOptions,
  formatOpenTime,
  reconcileChecked,
  refreshSummary,
  selectedProfileIds,
  selectionSummary,
  tableSorter as sorter,
} from "../../../../shared/logic/home-list.ts";
import {
  attachBoundEmails,
  filterUnifiedWindows,
  windowViewSummary,
  windowViewSummaryText,
  type AccountBinding,
  type UnifiedWindowRow,
} from "../../../../shared/logic/unified-list.ts";
import { Panel } from "../../components/Section.tsx";
import { TfaCell, useTfaCodes } from "../../components/TfaCodeCell.tsx";
import { rowSelect } from "../../components/row-select.ts";
import { PAGINATION_HEIGHT, crossPageSelections, usePagination } from "../../components/use-pagination.ts";
import { IPC, describeError, invoke } from "../../lib/ipc.ts";
import { logLocal, markTaskStarted, onTaskFinished } from "../../stores/task.ts";

const HOME_TASKS: ReadonlySet<string> = new Set(Object.values(HOME_TASK_TYPES));
/** 表格外框与表头占用的高度（表体高度 = 容器高度 - 该值） */
const TABLE_CHROME = 40;

export interface WindowsViewProps {
  /** 账号行（只用到 email 与 browser_profile_id）：用来给窗口标出「绑的是哪个账号」 */
  accounts: readonly AccountBinding[];
  /** 有任务在运行时禁用打开 / 删除 / 创建（全局单任务互斥） */
  busy: boolean;
}

export function WindowsView({ accounts, busy }: WindowsViewProps): ReactElement {
  const { message, modal } = App.useApp();

  const [groupOptions, setGroupOptions] = useState<HomeGroupOption[]>(defaultGroupOptions);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [list, setList] = useState<HomeBrowserList | null>(null);
  // 每次刷新完成 +1：让 2FA 验证码跟着重新取（密钥可能在 ixBrowser 里改过）
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [createCount, setCreateCount] = useState(1);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [onlyUnbound, setOnlyUnbound] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);

  // 只采纳最近一次刷新的结果（比它更早的结果直接丢弃）
  const listSeq = useRef(0);
  const groupsSeq = useRef(0);
  const autoLoaded = useRef(false);

  /** 刷新分组选项（创建窗口时要按分组标签筛选，这里只用来展示与提示） */
  const refreshGroups = async (): Promise<void> => {
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
    } finally {
      if (seq === groupsSeq.current) setGroupsLoading(false);
    }
    setGroupOptions(options);
  };

  const refreshList = async (): Promise<void> => {
    const seq = ++listSeq.current;
    setLoading(true);
    try {
      const res = await invoke(IPC.invoke.homeListBrowsers);
      if (seq !== listSeq.current) return;
      if (res.error) logLocal(`⚠️ 加载数据时发生错误: ${res.error}`);
      setList(res);
      setVersion((v) => v + 1);
      logLocal(refreshSummary(res));
    } catch (e) {
      if (seq !== listSeq.current) return;
      logLocal(`[错误] 加载窗口列表失败: ${describeError(e)}`);
      setList(null);
    } finally {
      if (seq === listSeq.current) setLoading(false);
    }
  };

  // 首次挂载自动加载一次（后端就绪由外壳保证；这里失败也只是列表为空，可手动刷新）
  useEffect(() => {
    if (autoLoaded.current) return;
    autoLoaded.current = true;
    void refreshList();
    void refreshGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 打开 / 删除任务结束后刷新列表
  useEffect(
    () =>
      onTaskFinished((e) => {
        if (HOME_TASKS.has(e.type)) void refreshList();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const rows = useMemo(
    () => attachBoundEmails(list?.browsers ?? [], accounts),
    [list, accounts],
  );

  // 刷新后：去掉已不存在的窗口的勾选；当前分组没了就回到「全部」
  useEffect(() => {
    setChecked((prev) => reconcileChecked(prev, rows));
    setGroupId((g) => (g !== null && !(list?.groups.some((x) => x.groupId === g) ?? false) ? null : g));
  }, [rows, list]);

  const visible = useMemo(
    () => filterUnifiedWindows(rows, { groupId, text: deferredSearch, onlyUnbound }),
    [rows, groupId, deferredSearch, onlyUnbound],
  );
  const summary = windowViewSummary(rows);
  // 分页：分组 / 搜索 / 未绑定变化回到第 1 页
  const pager = usePagination("accountsWindows", visible.length, [groupId, deferredSearch, onlyUnbound]);

  // 验证码：只要可见行里有密钥的
  const tfaIds = useMemo(
    () => visible.filter((b) => b.hasTfa && b.profileId !== null).map((b) => b.profileId as number),
    [visible],
  );
  const tfa = useTfaCodes(tfaIds, version, (keys) => invoke(IPC.invoke.homeTfaCodes, keys.map(Number)));
  const invalidSet = useMemo(() => new Set(tfa?.invalid ?? []), [tfa]);

  // 表格高度跟随容器（面板占满页面剩余高度）
  const boxRef = useRef<HTMLDivElement>(null);
  const [bodyHeight, setBodyHeight] = useState(400);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setBodyHeight(Math.max(200, Math.floor(entry.contentRect.height) - TABLE_CHROME - PAGINATION_HEIGHT));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pick = selectionSummary(checked, visible);
  const ids = selectedProfileIds(rows, checked);

  const startBatch = async (kind: "open" | "delete", target: number[]): Promise<void> => {
    try {
      const info =
        kind === "open"
          ? await invoke(IPC.invoke.homeOpenBrowsers, target)
          : await invoke(IPC.invoke.homeDeleteBrowsers, target);
      markTaskStarted(info);
    } catch (e) {
      void message.error(describeError(e));
    }
  };

  const onOpen = (target: number[]): void => {
    if (target.length === 0) {
      void message.warning("请先勾选要打开的窗口");
      return;
    }
    logLocal(`准备打开 ${target.length} 个窗口...`);
    void startBatch("open", target);
  };

  /** hidden：勾选里有多少个不在当前视图（确认框里单独提示，避免误删看不见的窗口） */
  const onDelete = (target: number[], hidden: number): void => {
    if (target.length === 0) {
      void message.warning("请先勾选要删除的窗口");
      return;
    }
    const hiddenLine = hidden > 0 ? `\n其中 ${hidden} 个被筛选隐藏，当前列表里看不到。` : "";
    modal.confirm({
      title: "确认删除",
      content: (
        <div style={{ whiteSpace: "pre-line" }}>{`确定要删除选中的 ${target.length} 个窗口吗？${hiddenLine}\n此操作不可恢复！`}</div>
      ),
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => {
        logLocal(`准备删除 ${target.length} 个窗口...`);
        void startBatch("delete", target);
      },
    });
  };

  /**
   * 按设置页里保存的「创建参数」创建 N 个窗口。
   * 现读配置（不是挂载时缓存）——用户可能刚在设置页改过。
   */
  const onCreate = async (): Promise<void> => {
    let config: HomeConfig;
    try {
      config = await invoke(IPC.invoke.homeGetConfig);
    } catch (e) {
      void message.error(`读取创建参数失败：${describeError(e)}`);
      return;
    }
    const templateId = Number.parseInt(config.templateId.trim(), 10);
    if (!Number.isInteger(templateId) || templateId <= 0) {
      void message.warning("请先在「设置 → 配置 → 创建参数」里填写模板窗口ID");
      return;
    }
    const prefix = config.namePrefix.trim();
    const groupLabel =
      config.groupId === null
        ? "沿用模板窗口的分组"
        : (groupOptions.find((o) => o.id === config.groupId)?.label ?? String(config.groupId));
    modal.confirm({
      title: "确认创建",
      content: (
        <div style={{ whiteSpace: "pre-line" }}>{`将按模板窗口 ${templateId} 创建 ${createCount} 个窗口。\n命名：${
          prefix ? `${prefix}_序号` : "按模板窗口名 + 序号"
        }\n目标分组：${groupLabel}`}</div>
      ),
      okText: "创建",
      cancelText: "取消",
      onOk: async () => {
        logLocal(`开始按模板 ${templateId} 创建 ${createCount} 个窗口...`);
        try {
          const info = await invoke(IPC.invoke.homeCreateBrowsers, {
            templateId,
            count: createCount,
            namePrefix: prefix,
            groupId: config.groupId,
          });
          markTaskStarted(info);
        } catch (e) {
          void message.error(describeError(e));
        }
      },
    });
  };

  const columns: ColumnsType<UnifiedWindowRow> = [
    {
      title: "窗口ID",
      key: "id",
      width: 100,
      fixed: "left",
      sorter: sorter("profileId"),
      defaultSortOrder: "descend",
      render: (_, b) =>
        b.profileId === null ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <span onDoubleClick={(e) => e.stopPropagation()}>
            <Typography.Text className="abb-mono" copyable={{ text: String(b.profileId), tooltips: ["复制窗口ID", "已复制"] }}>
              {b.profileId}
            </Typography.Text>
          </span>
        ),
    },
    {
      title: "名称",
      key: "name",
      width: 240,
      ellipsis: true,
      sorter: sorter("name"),
      render: (_, b) => (b.name ? <span className="abb-id">{b.name}</span> : <Typography.Text type="secondary">（无名称）</Typography.Text>),
    },
    {
      title: "绑定账号",
      key: "bound",
      width: 240,
      ellipsis: true,
      render: (_, b) =>
        b.boundEmail ? (
          <span className="abb-id">{b.boundEmail}</span>
        ) : (
          <Typography.Text type="secondary">未绑定</Typography.Text>
        ),
    },
    {
      title: "分组",
      key: "group",
      width: 120,
      ellipsis: true,
      render: (_, b) => <Tag bordered={false}>{b.groupName}</Tag>,
    },
    {
      title: "2FA 验证码",
      key: "tfa",
      width: 150,
      render: (_, b) => (
        <TfaCell
          hasTfa={b.hasTfa}
          code={b.profileId === null ? undefined : tfa?.codes[b.profileId]}
          invalid={b.profileId !== null && invalidSet.has(b.profileId)}
          periodEndsAt={tfa?.periodEndsAt ?? null}
        />
      ),
    },
    {
      title: "备注",
      key: "note",
      ellipsis: { showTitle: true },
      render: (_, b) => b.note,
    },
    {
      title: "最近打开",
      key: "lastOpen",
      width: 150,
      sorter: sorter("lastOpenTime"),
      render: (_, b) => (
        <Typography.Text type={b.lastOpenTime === null ? "secondary" : undefined}>{formatOpenTime(b.lastOpenTime)}</Typography.Text>
      ),
    },
  ];

  const total = list?.totalBrowsers ?? 0;
  const filtered = visible.length !== rows.length;

  // 点行即选中（再点取消）；没有窗口 ID 的行不可选，双击仍是打开窗口
  const browserRow = rowSelect<UnifiedWindowRow, string>({
    keyOf: (b) => b.key,
    keys: checked,
    onChange: setChecked,
    disabled: (b) => b.profileId === null,
  });

  return (
    <Panel fill>
      {/* 工具栏 */}
      <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
        <Space wrap>
          <Button icon={<SyncOutlined />} onClick={() => void refreshList()} loading={loading}>
            刷新列表
          </Button>
          <Input.Search
            placeholder="搜索 窗口ID / 名称 / 备注 / 绑定账号"
            allowClear
            style={{ width: 280 }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Typography.Text type="secondary">
            {filtered ? `显示 ${visible.length} / ${windowViewSummaryText(rows)}` : windowViewSummaryText(rows)}
          </Typography.Text>
        </Space>
        <Space wrap>
          {pick.total > 0 && (
            <Typography.Text>
              已选 <b>{pick.total}</b> 个
              {pick.hidden > 0 && <Typography.Text type="warning">（其中 {pick.hidden} 个不在当前视图）</Typography.Text>}
              <Button type="link" size="small" onClick={() => setChecked([])}>
                清空
              </Button>
            </Typography.Text>
          )}
          <Button icon={<EyeOutlined />} disabled={busy || ids.length === 0} onClick={() => onOpen(ids)}>
            打开选中
          </Button>
          <Button danger icon={<DeleteOutlined />} disabled={busy || ids.length === 0} onClick={() => onDelete(ids, pick.hidden)}>
            删除选中
          </Button>
        </Space>
      </Space>

      {/* 分组筛选标签：单选；数量为分组内窗口总数（不随搜索变化） */}
      <Space wrap>
        <Tag.CheckableTag checked={groupId === null} onChange={() => setGroupId(null)}>
          全部 ({total})
        </Tag.CheckableTag>
        <Tag.CheckableTag checked={onlyUnbound} onChange={() => setOnlyUnbound((v) => !v)}>
          未绑定账号 ({summary.unbound})
        </Tag.CheckableTag>
        {(list?.groups ?? []).map((g) => (
          <Tag.CheckableTag key={g.groupId} checked={groupId === g.groupId} onChange={() => setGroupId(g.groupId)}>
            {g.groupName} ({g.count})
          </Tag.CheckableTag>
        ))}
      </Space>

      {/* 创建窗口：模板 / 前缀 / 目标分组取自设置页的「创建参数」，这里只给个数 */}
      <Space wrap>
        <Space size={8}>
          <span>个数</span>
          <InputNumber
            min={1}
            max={MAX_CREATE_COUNT}
            value={createCount}
            onChange={(v) => setCreateCount(typeof v === "number" ? v : 1)}
            disabled={busy}
            style={{ width: 80 }}
          />
        </Space>
        <Tooltip title="按「设置 → 配置 → 创建参数」里的模板窗口ID创建，名字为「前缀_序号」">
          <span>
            <Button type="primary" icon={<PlusOutlined />} disabled={busy} onClick={() => void onCreate()}>
              创建窗口
            </Button>
          </span>
        </Tooltip>
        <Button size="small" onClick={() => void refreshGroups()} loading={groupsLoading}>
          刷新分组
        </Button>
      </Space>

      <div ref={boxRef} style={{ flex: 1, minHeight: 240 }}>
        <Table<UnifiedWindowRow>
          size="small"
          rowKey="key"
          columns={columns}
          dataSource={visible as UnifiedWindowRow[]}
          loading={{ spinning: loading, tip: "正在加载窗口列表..." }}
          pagination={pager.pagination}
          showSorterTooltip={false}
          // 虚拟滚动：只渲染可视区域的行；虚拟表要求 scroll.x 是数字，容器更宽时各列按容器宽度补齐
          virtual
          scroll={{ x: 1080, y: bodyHeight }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  rows.length === 0 ? (loading ? "加载中..." : "暂无窗口，点「刷新列表」加载") : "没有匹配的窗口"
                }
              />
            ),
          }}
          onRow={(b) => ({
            ...browserRow(b),
            onDoubleClick: () => {
              if (b.profileId !== null && !busy) onOpen([b.profileId]);
            },
          })}
          rowSelection={{
            // 与固定在左的窗口ID 列一起固定：横向滚动时勾选框一直可见
            fixed: "left",
            selectedRowKeys: checked,
            // 被筛选隐藏的勾选也要保留（antd 默认会丢掉不在 dataSource 里的 key）
            preserveSelectedRowKeys: true,
            onChange: (keys) => setChecked(keys.map(String)),
            getCheckboxProps: (b) => ({ disabled: b.profileId === null }),
            // 表头勾选框只勾当前页；跨页全选走下拉里的「勾选全部筛选结果」
            selections: crossPageSelections(
              visible.filter((b) => b.profileId !== null).map((b) => b.key),
              checked,
              setChecked,
            ),
          }}
        />
      </div>
    </Panel>
  );
}
