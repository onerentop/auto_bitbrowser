/**
 * 「代理」标签（列表 / 增删改 / 批量导入 / 绑定详情）
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Alert, App, Button, Empty, Form, Input, List, Modal, Select, Space, Table, Tooltip, Typography } from "antd";
import {
  ApiOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  InfoCircleOutlined,
  PlusOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import {
  PROXY_TYPES,
  type ProxyBindingDto,
  type ProxyInputDto,
  type ProxyListItemDto,
} from "../../../../shared/channels/settings.ts";
import {
  PROXY_IMPORT_FORMAT_HINT,
  PROXY_PREVIEW_COLUMNS,
  formatProxyPreviewRow,
  parseProxyImportLine,
} from "../../../../shared/logic/settings-data.ts";
import { IPC, describeError, invoke } from "../../lib/ipc.ts";
import { useHostStatus } from "../../stores/host-status.ts";
import { BatchImportModal } from "../../components/BatchImportModal.tsx";
import { Panel } from "../../components/Section.tsx";
import { useTokens, type Palette } from "../../theme/tokens.ts";
import { rowSelect } from "../../components/row-select.ts";
import { usePagination } from "../../components/use-pagination.ts";
import { StatusDot } from "../../components/StatusDot.tsx";
import { proxyCheckTone, railClass } from "../../lib/list-tone.ts";

const EMPTY_PROXY: ProxyInputDto = { proxy_type: "socks5", host: "", port: "", username: "", password: "" };

/** 使用情况颜色（满 / 已用 / 空闲），取状态令牌 */
function usageColor(t: Palette, p: ProxyListItemDto): string {
  if (p.is_full) return t.bad;
  if (p.used_count > 0) return t.warn;
  return t.ok;
}

/** 「连通性」列的悬停说明：上次检测时间 / 出站 IP / 失败原因（都没有时不显示 tooltip） */
function checkReason(p: ProxyListItemDto): string | null {
  const parts: string[] = [];
  if (p.last_check_at) parts.push(`上次检测：${p.last_check_at}`);
  if (p.outbound_ip) parts.push(`出站 IP：${p.outbound_ip}`);
  if (p.last_check_error) parts.push(`原因：${p.last_check_error}`);
  return parts.length > 0 ? parts.join("\n") : null;
}

/** 新增 / 编辑代理弹窗 */
function ProxyEditModal(props: {
  editing: ProxyListItemDto | null;
  open: boolean;
  onCancel: () => void;
  onSubmit: (data: ProxyInputDto) => Promise<void>;
}): ReactElement {
  const [form] = Form.useForm<ProxyInputDto>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    const e = props.editing;
    form.setFieldsValue(
      e
        ? { proxy_type: e.proxy_type, host: e.host, port: e.port, username: e.username, password: e.password }
        : EMPTY_PROXY,
    );
  }, [props.open, props.editing, form]);

  const ok = async (): Promise<void> => {
    const v = form.getFieldsValue(true) as ProxyInputDto;
    // 除类型外全部 strip
    const data: ProxyInputDto = {
      proxy_type: v.proxy_type,
      host: (v.host ?? "").trim(),
      port: (v.port ?? "").trim(),
      username: (v.username ?? "").trim(),
      password: (v.password ?? "").trim(),
    };
    setSubmitting(true);
    try {
      await props.onSubmit(data);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={props.open}
      title={props.editing ? "编辑代理" : "添加代理"}
      okText="确定"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={() => void ok()}
      onCancel={props.onCancel}
      forceRender
    >
      <Form form={form} layout="horizontal" labelCol={{ flex: "70px" }} initialValues={EMPTY_PROXY}>
        <Form.Item name="proxy_type" label="类型">
          <Select options={PROXY_TYPES.map((t) => ({ value: t, label: t }))} />
        </Form.Item>
        <Form.Item name="host" label="主机">
          <Input placeholder="127.0.0.1" />
        </Form.Item>
        <Form.Item name="port" label="端口">
          <Input placeholder="1080" />
        </Form.Item>
        <Form.Item name="username" label="用户名">
          <Input placeholder="用户名（可选）" />
        </Form.Item>
        <Form.Item name="password" label="密码">
          <Input placeholder="密码（可选）" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/**
 * 代理详情弹窗：显示该代理绑定的窗口与邮箱。
 * 绑定表里没有窗口名，直接显示窗口 ID 与邮箱。
 */
function ProxyDetailModal(props: { proxyId: number | null; onClose: () => void }): ReactElement {
  const { message } = App.useApp();
  const [bindings, setBindings] = useState<ProxyBindingDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 分页：换一个代理时回到第 1 页
  const bindingsPager = usePagination("proxyBindings", bindings?.length ?? 0, [props.proxyId]);

  useEffect(() => {
    if (props.proxyId === null) return;
    setBindings(null);
    setError(null);
    invoke(IPC.invoke.settingsProxiesBindings, props.proxyId).then(setBindings, (e: unknown) =>
      setError(describeError(e)),
    );
  }, [props.proxyId]);

  const unbind = async (browserId: string): Promise<void> => {
    try {
      const ok = await invoke(IPC.invoke.settingsProxiesUnbind, browserId);
      if (!ok) {
        // 后端返回 false = 写库失败：提示失败，保留弹窗便于重试
        message.error("解绑失败");
        return;
      }
      message.success("已解绑窗口");
      props.onClose();
    } catch (e) {
      message.error(`解绑失败: ${describeError(e)}`);
    }
  };

  let body: ReactElement;
  if (error) body = <Typography.Text type="danger">加载失败: {error}</Typography.Text>;
  else if (bindings === null) body = <Typography.Text type="secondary">加载中...</Typography.Text>;
  else if (bindings.length === 0) body = <Typography.Text type="secondary">暂无关联窗口</Typography.Text>;
  else
    body = (
      <Space direction="vertical" style={{ width: "100%" }}>
        <Typography.Text type="secondary">已关联 {bindings.length} 个窗口:</Typography.Text>
        <List
          size="small"
          bordered
          dataSource={bindings}
          pagination={bindingsPager.pagination}
          renderItem={(b) => (
            <List.Item
              actions={[
                <Button key="unbind" type="text" danger icon={<DeleteOutlined />} onClick={() => void unbind(b.browser_id)}>
                  解绑
                </Button>,
              ]}
            >
              <Space direction="vertical" size={0}>
                <Typography.Text className="abb-mono">{b.browser_id}</Typography.Text>
                {b.email ? <Typography.Text type="secondary">{b.email}</Typography.Text> : null}
              </Space>
            </List.Item>
          )}
        />
      </Space>
    );

  return (
    <Modal
      open={props.proxyId !== null}
      title="代理详情"
      onCancel={() => props.onClose()}
      footer={<Button onClick={() => props.onClose()}>关闭</Button>}
      destroyOnHidden
    >
      {body}
    </Modal>
  );
}

export function ProxiesTab(): ReactElement {
  const { message, modal } = App.useApp();
  const [items, setItems] = useState<ProxyListItemDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  /** 「测试选中」进行中 */
  const [checking, setChecking] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<ProxyListItemDto | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const hostReady = useHostStatus()?.state === "ready";
  const t = useTokens();
  // 分页：刷新不跳页（数据变少时夹到最后一页）
  const pager = usePagination("proxies", items.length, []);

  /** 加载列表数据 */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await invoke(IPC.invoke.settingsProxiesList);
      setItems(list);
      setSelected([]);
      setError(null);
      setLoaded(true);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, []);


  /** 检测选中的代理：逐条经代理出网回读出站 IP，结果由后端写回数据库 */
  const checkSelected = async (): Promise<void> => {
    const rows = items.filter((p) => selected.includes(p.index));
    if (rows.length === 0) {
      message.info("请先选择要检测的代理");
      return;
    }
    setChecking(true);
    try {
      const results = await invoke(
        IPC.invoke.settingsProxiesCheck,
        rows.map((p) => ({ index: p.index, key: p.key })),
      );
      const ok = results.filter((r) => r.ok).length;
      const bad = results.length - ok;
      const head = `已检测 ${results.length} 个代理：可达 ${ok} 个${bad > 0 ? `，不可达 ${bad} 个` : ""}`;
      if (bad > 0) {
        const lines = [head, ...results.filter((r) => !r.ok).slice(0, 5).map((r) => `${r.key}：${r.error ?? "不可达"}`)];
        if (bad > 5) lines.push(`…还有 ${bad - 5} 个不可达`);
        modal.warning({ title: "代理检测结果", content: <div style={{ whiteSpace: "pre-line" }}>{lines.join("\n")}</div> });
      } else {
        void message.success(head);
      }
      // 检测结果已写回库：重新拉一次，状态灯与悬停说明跟着更新
      await load();
    } catch (e) {
      void message.error(`检测失败：${describeError(e)}`);
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    if (hostReady && !loaded) void load();
  }, [hostReady, loaded, load]);

  const openAdd = (): void => {
    setEditing(null);
    setEditOpen(true);
  };

  const openEdit = (p: ProxyListItemDto): void => {
    setEditing(p);
    setEditOpen(true);
  };

  /** 提交新增 / 编辑 */
  const submitEdit = async (data: ProxyInputDto): Promise<void> => {
    try {
      if (editing) {
        await invoke(IPC.invoke.settingsProxiesUpdate, { index: editing.index, key: editing.key }, data);
      } else {
        if (!data.host || !data.port) {
          message.warning("主机和端口不能为空");
          setEditOpen(false);
          return;
        }
        await invoke(IPC.invoke.settingsProxiesAdd, data);
        message.success("代理已添加");
      }
      setEditOpen(false);
      await load();
    } catch (e) {
      message.error(describeError(e));
    }
  };

  /** 删除选中代理 */
  const deleteSelected = (): void => {
    const rows = items.filter((p) => selected.includes(p.index));
    if (rows.length === 0) {
      message.info("请先选择要删除的代理");
      return;
    }
    modal.confirm({
      title: "确认删除",
      content: `确定要删除选中的 ${rows.length} 个代理吗？`,
      okText: "确定",
      cancelText: "取消",
      onOk: async () => {
        try {
          const n = await invoke(
            IPC.invoke.settingsProxiesDelete,
            rows.map((p) => ({ index: p.index, key: p.key })),
          );
          message.success(`已删除 ${n} 个代理`);
        } catch (e) {
          message.error(describeError(e));
        }
        await load();
      },
    });
  };

  const columns: ColumnsType<ProxyListItemDto> = [
    { title: "类型", dataIndex: "proxy_type", width: 80 },
    { title: "主机", dataIndex: "host", ellipsis: true, render: (v: string) => <span className="abb-mono">{v}</span> },
    { title: "端口", dataIndex: "port", width: 80, align: "right", render: (v: string) => <span className="abb-mono">{v}</span> },
    {
      title: "用户名",
      dataIndex: "username",
      ellipsis: true,
      render: (v: string) => v || <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: "密码",
      key: "password",
      width: 80,
      render: (_, p) => (p.password ? "***" : <Typography.Text type="secondary">—</Typography.Text>),
    },
    {
      title: "使用情况",
      key: "usage",
      width: 90,
      align: "right",
      render: (_, p) => (
        <span className="abb-num" style={{ color: usageColor(t, p) }}>{`${p.used_count}/${p.max_count}`}</span>
      ),
    },
    {
      title: "连通性",
      key: "check",
      width: 110,
      render: (_, p) => (
        <StatusDot
          tone={proxyCheckTone(p.last_check_ok)}
          text={p.last_check_ok === null ? "未检测" : p.last_check_ok ? "可达" : "不可达"}
          reason={checkReason(p)}
        />
      ),
    },
    {
      title: "操作",
      key: "actions",
      width: 110,
      fixed: "right",
      render: (_, p) => (
        <Space size={0}>
          <Button type="link" size="small" icon={<EditOutlined />} onClick={() => openEdit(p)}>
            编辑
          </Button>
          {/* 有 proxy_id 且已使用时才显示详情 */}
          {p.proxy_id && p.used_count > 0 ? (
            <Button type="link" size="small" icon={<InfoCircleOutlined />} onClick={() => setDetailId(p.proxy_id)}>
              详情
            </Button>
          ) : null}
        </Space>
      ),
    },
  ];

  // 点行即选中（再点取消）
  const proxyRow = rowSelect<ProxyListItemDto, number>({
    keyOf: (p) => p.index,
    keys: selected,
    onChange: setSelected,
  });

  return (
    <Panel>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <Space wrap>
          <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>
            添加代理
          </Button>
          <Button icon={<DownloadOutlined />} onClick={() => setImportOpen(true)}>
            批量导入
          </Button>
          <Tooltip title="经每个选中的代理出网并回读出站 IP（结果写回数据库，状态灯随之更新）">
            <Button
              icon={<ApiOutlined />}
              loading={checking}
              disabled={selected.length === 0}
              onClick={() => void checkSelected()}
            >
              测试选中{selected.length > 0 ? `（${selected.length}）` : ""}
            </Button>
          </Tooltip>
          <Button icon={<DeleteOutlined />} onClick={deleteSelected}>
            删除选中
          </Button>
          <Button type="text" icon={<SyncOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        </Space>
        <Typography.Text type="secondary">
          {selected.length > 0 ? `已选 ${selected.length} 个，` : ""}共 <span className="abb-num">{items.length}</span> 个代理
        </Typography.Text>
      </div>

      {error ? <Alert type="error" showIcon message={`加载代理失败: ${error}`} style={{ marginTop: 12 }} /> : null}

      <Table<ProxyListItemDto>
        size="small"
        rowKey="index"
        columns={columns}
        dataSource={items}
        loading={loading}
        rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys as number[]) }}
        onRow={proxyRow}
        pagination={pager.pagination}
        locale={{ emptyText: <Empty description="暂无代理" /> }}
        rowClassName={(p) => railClass(proxyCheckTone(p.last_check_ok))}
        // 横向放不下时表格内部滚动，操作列固定在右侧
        scroll={{ x: "max-content" }}
        style={{ marginTop: 12 }}
      />

      <ProxyEditModal editing={editing} open={editOpen} onCancel={() => setEditOpen(false)} onSubmit={submitEdit} />

      <ProxyDetailModal
        proxyId={detailId}
        onClose={() => {
          setDetailId(null);
          // 关闭详情后总是刷新
          void load();
        }}
      />

      <BatchImportModal
        open={importOpen}
        title="批量导入代理"
        formatHint={PROXY_IMPORT_FORMAT_HINT}
        columns={PROXY_PREVIEW_COLUMNS}
        parseLine={parseProxyImportLine}
        formatPreviewRow={formatProxyPreviewRow}
        onImport={(text) => invoke(IPC.invoke.settingsProxiesImport, text)}
        onClose={() => setImportOpen(false)}
        onDone={() => void load()}
      />
    </Panel>
  );
}
