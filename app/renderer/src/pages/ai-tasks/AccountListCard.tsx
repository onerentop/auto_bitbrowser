/**
 * AI 任务页的账号列表卡片：工具栏 + 分组标签 + 筛选条 + 平铺表格（虚拟滚动）
 *
 * 结构与首页 BrowserListCard 相同。行底色按本次任务逐行结果着色。
 * 勾选与筛选状态由父组件（AiTaskPage）持有：开始任务时要用。
 * 纯逻辑在 app/shared/logic/ai-task-list.ts 与 home-list.ts。
 */
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Button, Card, Empty, Input, Segmented, Space, Switch, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { CheckCircleFilled, MinusCircleOutlined, SyncOutlined } from "@ant-design/icons";
import {
  AI_TASK_LOGIN_FILTERS,
  type AiTaskLoadResult,
  type AiTaskLoginFilter,
  type AiTaskRow,
} from "../../../../shared/channels/ai-tasks.ts";
import {
  TONE_BACKGROUND,
  isSelectable,
  loginStatusLabel,
  rowSorter,
  statusTone,
  type RowRuntime,
} from "../../../../shared/logic/ai-task-list.ts";

export interface AccountListCardProps {
  list: AiTaskLoadResult | null;
  /** 当前可见行（父组件按筛选条件算好） */
  visible: readonly AiTaskRow[];
  loading: boolean;
  onRefresh: () => void;
  checkedKeys: string[];
  onCheckedChange: (keys: string[]) => void;
  /** 勾选里有几个不在当前视图 */
  hiddenChecked: number;
  runtime: Readonly<Record<string, RowRuntime>>;
  /** 本次任务里失败 / 错误的行数（「只看本次失败」旁显示） */
  failedCount: number;

  search: string;
  onSearchChange: (text: string) => void;
  groupId: number | null;
  onGroupChange: (groupId: number | null) => void;
  login: AiTaskLoginFilter;
  onLoginChange: (login: AiTaskLoginFilter) => void;
  failedOnly: boolean;
  onFailedOnlyChange: (value: boolean) => void;
}

/** 表格外框与表头占用的高度（表体高度 = 容器高度 - 该值） */
const TABLE_CHROME = 40;

/** 有 / 无 的小图标 */
function Flag({ on, onTip, offTip }: { on: boolean; onTip: string; offTip: string }): ReactNode {
  return (
    <Tooltip title={on ? onTip : offTip}>
      {on ? <CheckCircleFilled style={{ color: "#52c41a" }} /> : <MinusCircleOutlined style={{ color: "rgba(128,128,128,0.6)" }} />}
    </Tooltip>
  );
}

const LOGIN_COLOR: Record<string, string> = { 已登录: "green", 登录失败: "red", 不在数据库: "default" };

export function AccountListCard(props: AccountListCardProps): ReactElement {
  const { runtime, visible } = props;
  const total = props.list?.totalBrowsers ?? 0;

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

  const columns = useMemo<ColumnsType<AiTaskRow>>(() => {
    const cellStyle = (r: AiTaskRow): { style?: { background: string } } => {
      const rt = runtime[r.email];
      return rt ? { style: { background: TONE_BACKGROUND[statusTone(rt.status)] } } : {};
    };
    return [
      {
        title: "邮箱",
        key: "email",
        width: 250,
        ellipsis: true,
        sorter: rowSorter("email"),
        onCell: cellStyle,
        render: (_, r) => r.email || <Typography.Text type="secondary">（空）</Typography.Text>,
      },
      {
        title: "窗口ID",
        key: "id",
        width: 90,
        sorter: rowSorter("profileId"),
        defaultSortOrder: "descend",
        onCell: cellStyle,
        render: (_, r) => r.profileId ?? <Typography.Text type="secondary">—</Typography.Text>,
      },
      {
        title: "分组",
        key: "group",
        width: 110,
        ellipsis: true,
        onCell: cellStyle,
        render: (_, r) => <Tag bordered={false}>{r.groupName}</Tag>,
      },
      {
        title: "登录状态",
        key: "login",
        width: 100,
        onCell: cellStyle,
        render: (_, r) => {
          const label = loginStatusLabel(r);
          return (
            <Tag bordered={false} color={LOGIN_COLOR[label]}>
              {label}
            </Tag>
          );
        },
      },
      {
        title: "辅助邮箱",
        key: "recovery",
        width: 76,
        align: "center",
        onCell: cellStyle,
        render: (_, r) => <Flag on={r.hasRecoveryEmail} onTip="数据库里有辅助邮箱" offTip="数据库里没有辅助邮箱" />,
      },
      {
        title: "2FA 密钥",
        key: "secret",
        width: 76,
        align: "center",
        onCell: cellStyle,
        render: (_, r) => <Flag on={r.hasSecret} onTip="数据库里有 2FA 密钥" offTip="数据库里没有 2FA 密钥" />,
      },
      {
        title: "最后登录",
        key: "lastLogin",
        width: 150,
        sorter: rowSorter("lastLoginAt"),
        onCell: cellStyle,
        render: (_, r) => r.lastLoginAt ?? <Typography.Text type="secondary">—</Typography.Text>,
      },
      {
        title: "任务状态",
        key: "status",
        width: 84,
        onCell: cellStyle,
        render: (_, r) => runtime[r.email]?.status ?? "",
      },
      {
        title: "消息",
        key: "message",
        ellipsis: { showTitle: true },
        onCell: cellStyle,
        render: (_, r) => runtime[r.email]?.message ?? "",
      },
    ];
  }, [runtime]);

  const filtered = visible.length !== (props.list?.rows.length ?? 0);

  return (
    <Card
      size="small"
      style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      styles={{ body: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 10 } }}
    >
      {/* 工具栏：刷新 + 搜索 + 账号状态 + 只看本次失败 */}
      <Space style={{ width: "100%", justifyContent: "space-between" }} wrap>
        <Space wrap>
          <Button icon={<SyncOutlined />} onClick={props.onRefresh} loading={props.loading}>
            刷新列表
          </Button>
          <Input.Search
            placeholder="搜索 邮箱 / 窗口ID"
            allowClear
            style={{ width: 240 }}
            value={props.search}
            onChange={(e) => props.onSearchChange(e.target.value)}
          />
          <Segmented<AiTaskLoginFilter>
            value={props.login}
            onChange={props.onLoginChange}
            options={AI_TASK_LOGIN_FILTERS.map((o) => ({ value: o.value, label: o.label }))}
          />
          <Space size={6}>
            <Switch size="small" checked={props.failedOnly} onChange={props.onFailedOnlyChange} disabled={props.failedCount === 0 && !props.failedOnly} />
            <span>只看本次失败{props.failedCount > 0 ? ` (${props.failedCount})` : ""}</span>
          </Space>
        </Space>
        <Space wrap>
          {props.checkedKeys.length > 0 && (
            <Typography.Text>
              已选 <b>{props.checkedKeys.length}</b> 个
              {props.hiddenChecked > 0 && (
                <Typography.Text type="warning">（其中 {props.hiddenChecked} 个不在当前视图）</Typography.Text>
              )}
              <Button type="link" size="small" onClick={() => props.onCheckedChange([])}>
                清空
              </Button>
            </Typography.Text>
          )}
          <Typography.Text type="secondary">
            {filtered ? `显示 ${visible.length} / 共 ${total}` : `共 ${total} 个账号`}
          </Typography.Text>
        </Space>
      </Space>

      {/* 分组标签：单选；数量为分组内账号总数（不随其它筛选变化） */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <Tag.CheckableTag checked={props.groupId === null} onChange={() => props.onGroupChange(null)}>
          全部 ({total})
        </Tag.CheckableTag>
        {(props.list?.groups ?? []).map((g) => (
          <Tag.CheckableTag key={g.groupId} checked={props.groupId === g.groupId} onChange={() => props.onGroupChange(g.groupId)}>
            {g.groupName} ({g.count})
          </Tag.CheckableTag>
        ))}
      </div>

      <div ref={boxRef} style={{ flex: 1, minHeight: 240 }}>
        <Table<AiTaskRow>
          size="small"
          rowKey="key"
          columns={columns}
          dataSource={visible as AiTaskRow[]}
          loading={{ spinning: props.loading, tip: "正在加载账号..." }}
          pagination={false}
          showSorterTooltip={false}
          // 虚拟滚动：只渲染可视区域的行；虚拟表要求 scroll.x 是数字，容器更宽时各列按容器宽度补齐
          virtual
          scroll={{ x: 1150, y: bodyHeight }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  !props.list ? (props.loading ? "加载中..." : "暂无数据，点「刷新列表」加载") : "没有匹配的账号"
                }
              />
            ),
          }}
          rowSelection={{
            columnWidth: 40,
            selectedRowKeys: props.checkedKeys,
            // 被筛选隐藏的勾选也要保留（antd 默认会丢掉不在 dataSource 里的 key）
            preserveSelectedRowKeys: true,
            onChange: (keys) => props.onCheckedChange(keys.map(String)),
            getCheckboxProps: (r) => ({ disabled: !isSelectable(r) }),
          }}
        />
      </div>
    </Card>
  );
}
