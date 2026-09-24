/**
 * 窗口列表面板：工具栏 + 分组筛选标签 + 平铺表格（虚拟滚动），同在一块 surface 面板里
 *
 * - 搜索：窗口ID前缀 / 名称 / 备注，不区分大小写；与分组标签叠加
 * - 排序：窗口ID（默认降序，新建的在上面）/ 名称 / 最近打开
 * - 勾选：以行 key 记录；筛选隐藏的行**保留勾选**，工具栏提示「其中 M 个不在当前视图」
 * - 双击行打开该窗口；点窗口ID / 验证码可复制
 * 纯逻辑全部在 app/shared/logic/home-list.ts。
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Button, Empty, Input, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DeleteOutlined, EyeOutlined, SyncOutlined } from "@ant-design/icons";
import type { HomeBrowserList, HomeBrowserNode } from "../../../../shared/channels/home.ts";
import {
  filterBrowsers,
  formatOpenTime,
  reconcileChecked,
  selectedProfileIds,
  selectionSummary,
  tableSorter as sorter,
} from "../../../../shared/logic/home-list.ts";
import { Panel } from "../../components/Section.tsx";
import { TfaCell, useTfaCodes } from "../../components/TfaCodeCell.tsx";
import { rowSelect } from "../../components/row-select.ts";
import { IPC, invoke } from "../../lib/ipc.ts";

export interface BrowserListCardProps {
  list: HomeBrowserList | null;
  /** 每次刷新完成 +1：用于让验证码跟着重取 */
  version: number;
  loading: boolean;
  /** 有任务在运行时禁用打开 / 删除（全局单任务互斥） */
  busy: boolean;
  onRefresh: () => void;
  onOpen: (ids: number[]) => void;
  /** hidden：勾选里有多少个不在当前视图（删除确认框提示用） */
  onDelete: (ids: number[], hidden: number) => void;
}

const EMPTY: readonly HomeBrowserNode[] = [];

/** 表格外框与表头占用的高度（表体高度 = 容器高度 - 该值） */
const TABLE_CHROME = 40;

export function BrowserListCard(props: BrowserListCardProps): ReactElement {
  const all = props.list?.browsers ?? EMPTY;
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [checked, setChecked] = useState<string[]>([]);

  // 刷新后：去掉已不存在的窗口的勾选；当前分组没了就回到「全部」
  useEffect(() => {
    setChecked((prev) => reconcileChecked(prev, all));
    setGroupId((g) => (g !== null && !props.list?.groups.some((x) => x.groupId === g) ? null : g));
  }, [all, props.list]);

  const visible = useMemo(
    () => filterBrowsers(all, { groupId, text: deferredSearch }),
    [all, groupId, deferredSearch],
  );

  // 验证码：只要可见行里有密钥的
  const tfaIds = useMemo(
    () => visible.filter((b) => b.hasTfa && b.profileId !== null).map((b) => b.profileId as number),
    [visible],
  );
  const tfa = useTfaCodes(tfaIds, props.version, (keys) => invoke(IPC.invoke.homeTfaCodes, keys.map(Number)));
  const invalidSet = useMemo(() => new Set(tfa?.invalid ?? []), [tfa]);

  // 表格高度跟随容器（面板占满页面剩余高度）
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

  const summary = selectionSummary(checked, visible);
  const ids = selectedProfileIds(all, checked);

  const columns: ColumnsType<HomeBrowserNode> = [
    {
      title: "窗口ID",
      key: "id",
      width: 100,
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
      width: 260,
      ellipsis: true,
      sorter: sorter("name"),
      render: (_, b) => b.name || <Typography.Text type="secondary">（无名称）</Typography.Text>,
    },
    {
      title: "分组",
      key: "group",
      width: 130,
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

  const total = props.list?.totalBrowsers ?? 0;
  const filtered = visible.length !== all.length;

  // 点行即选中（再点取消）；未绑定窗口的行不可选，双击仍是打开窗口
  const browserRow = rowSelect<HomeBrowserNode, string>({
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
          <Button icon={<SyncOutlined />} onClick={props.onRefresh} loading={props.loading}>
            刷新列表
          </Button>
          <Input.Search
            placeholder="搜索 窗口ID / 名称 / 备注"
            allowClear
            style={{ width: 260 }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Typography.Text type="secondary">
            {filtered ? `显示 ${visible.length} / 共 ${total}` : `共 ${total} 个窗口`}
          </Typography.Text>
        </Space>
        <Space wrap>
          {summary.total > 0 && (
            <Typography.Text>
              已选 <b>{summary.total}</b> 个
              {summary.hidden > 0 && <Typography.Text type="warning">（其中 {summary.hidden} 个不在当前视图）</Typography.Text>}
              <Button type="link" size="small" onClick={() => setChecked([])}>
                清空
              </Button>
            </Typography.Text>
          )}
          <Button icon={<EyeOutlined />} disabled={props.busy || ids.length === 0} onClick={() => props.onOpen(ids)}>
            打开选中
          </Button>
          <Button
            danger
            icon={<DeleteOutlined />}
            disabled={props.busy || ids.length === 0}
            onClick={() => props.onDelete(ids, summary.hidden)}
          >
            删除选中
          </Button>
        </Space>
      </Space>

      {/* 分组筛选标签：单选；数量为分组内窗口总数（不随搜索变化） */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Tag.CheckableTag checked={groupId === null} onChange={() => setGroupId(null)}>
          全部 ({total})
        </Tag.CheckableTag>
        {(props.list?.groups ?? []).map((g) => (
          <Tag.CheckableTag key={g.groupId} checked={groupId === g.groupId} onChange={() => setGroupId(g.groupId)}>
            {g.groupName} ({g.count})
          </Tag.CheckableTag>
        ))}
      </div>

      <div ref={boxRef} style={{ flex: 1, minHeight: 240 }}>
        <Table<HomeBrowserNode>
          size="small"
          rowKey="key"
          columns={columns}
          dataSource={visible as HomeBrowserNode[]}
          loading={{ spinning: props.loading, tip: "正在加载窗口列表..." }}
          pagination={false}
          showSorterTooltip={false}
          // 虚拟滚动：只渲染可视区域的行；虚拟表要求 scroll.x 是数字，容器更宽时各列按容器宽度补齐
          virtual
          scroll={{ x: 940, y: bodyHeight }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={all.length === 0 ? (props.loading ? "加载中..." : "暂无窗口，点「刷新列表」加载") : "没有匹配的窗口"}
              />
            ),
          }}
          onRow={(b) => ({
            ...browserRow(b),
            onDoubleClick: () => {
              if (b.profileId !== null && !props.busy) props.onOpen([b.profileId]);
            },
          })}
          rowSelection={{
            selectedRowKeys: checked,
            // 被筛选隐藏的勾选也要保留（antd 默认会丢掉不在 dataSource 里的 key）
            preserveSelectedRowKeys: true,
            onChange: (keys) => setChecked(keys.map(String)),
            getCheckboxProps: (b) => ({ disabled: b.profileId === null }),
          }}
        />
      </div>
    </Panel>
  );
}
