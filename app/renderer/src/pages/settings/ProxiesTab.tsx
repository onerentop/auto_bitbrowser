/**
 * 「代理」标签（列表 / 增删改 / 批量导入 / 绑定详情）
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Alert, App, Button, Card, Empty, Form, Input, List, Modal, Select, Space, Table, Tooltip, Typography } from "antd";
import {
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
import { BatchImportModal } from "./BatchImportModal.tsx";

const EMPTY_PROXY: ProxyInputDto = { proxy_type: "socks5", host: "", port: "", username: "", password: "" };

/** 使用情况颜色（满 / 已用 / 空闲） */
function usageColor(p: ProxyListItemDto): string {
  if (p.is_full) return "#f44336";
  if (p.used_count > 0) return "#ff9800";
  return "#4caf50";
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
          renderItem={(b) => (
            <List.Item
              actions={[
                <Button key="unbind" type="text" danger icon={<DeleteOutlined />} onClick={() => void unbind(b.browser_id)}>
                  解绑
                </Button>,
              ]}
            >
              <Space direction="vertical" size={0}>
                <Typography.Text>{b.browser_id}</Typography.Text>
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
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<ProxyListItemDto | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const hostReady = useHostStatus()?.state === "ready";

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
    { title: "主机", dataIndex: "host", ellipsis: true },
    { title: "端口", dataIndex: "port", width: 80 },
    { title: "用户名", dataIndex: "username", ellipsis: true },
    { title: "密码", key: "password", width: 80, render: (_, p) => (p.password ? "***" : "") },
    {
      title: "使用情况",
      key: "usage",
      width: 90,
      render: (_, p) => <span style={{ color: usageColor(p) }}>{`${p.used_count}/${p.max_count}`}</span>,
    },
    {
      title: "操作",
      key: "actions",
      width: 100,
      render: (_, p) => (
        <Space size={0}>
          <Tooltip title="编辑">
            <Button type="text" icon={<EditOutlined />} onClick={() => openEdit(p)} />
          </Tooltip>
          {/* 有 proxy_id 且已使用时才显示详情 */}
          {p.proxy_id && p.used_count > 0 ? (
            <Tooltip title="详情">
              <Button type="text" icon={<InfoCircleOutlined />} onClick={() => setDetailId(p.proxy_id)} />
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Card size="small">
        <Space wrap style={{ width: "100%", justifyContent: "space-between" }}>
          <Space wrap>
            <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>
              添加代理
            </Button>
            <Button icon={<DownloadOutlined />} onClick={() => setImportOpen(true)}>
              批量导入
            </Button>
            <Button icon={<DeleteOutlined />} onClick={deleteSelected}>
              删除选中
            </Button>
            <Button type="text" icon={<SyncOutlined />} onClick={() => void load()} loading={loading}>
              刷新
            </Button>
          </Space>
          <Typography.Text type="secondary">共 {items.length} 个代理</Typography.Text>
        </Space>
      </Card>

      {error ? <Alert type="error" showIcon message={`加载代理失败: ${error}`} /> : null}

      <Table<ProxyListItemDto>
        size="small"
        rowKey="index"
        columns={columns}
        dataSource={items}
        loading={loading}
        rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys as number[]) }}
        pagination={{ defaultPageSize: 50, showSizeChanger: true, pageSizeOptions: [20, 50, 100, 200] }}
        locale={{ emptyText: <Empty description="暂无代理" /> }}
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
    </Space>
  );
}
