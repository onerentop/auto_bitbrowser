/**
 * 「账号数据」标签（列表 / 增删改 / 批量导入 / 导出 / 删除）
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Alert, App, Button, Card, Checkbox, Form, Input, Modal, Space, Table, Tooltip, Typography } from "antd";
import {
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  PlusOutlined,
  SearchOutlined,
  SyncOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import {
  SETTINGS_TASK_TYPES,
  type DeleteAccountsResultDto,
  type SettingsAccountDto,
  type SettingsAccountInputDto,
} from "../../../../shared/channels/settings.ts";
import {
  ACCOUNT_IMPORT_FORMAT_HINT,
  ACCOUNT_PREVIEW_COLUMNS,
  buildAccountExportText,
  formatAccountPreviewRow,
  isValidNewAccountEmail,
  parseAccountImportLine,
} from "../../../../../src/application/settings-data.ts";
import { IPC, describeError, invoke } from "../../lib/ipc.ts";
import { useHostStatus } from "../../stores/host-status.ts";
import { markTaskStarted, onTaskFinished } from "../../stores/task.ts";
import { BatchImportModal } from "./BatchImportModal.tsx";

const EXPORT_FILE_NAME = "accounts_export.txt";

/** 状态颜色 */
const STATUS_COLORS: Record<string, string> = {
  subscribed: "#4caf50",
  verified: "#2196f3",
  error: "#f44336",
};

const EMPTY_ACCOUNT: SettingsAccountInputDto = { email: "", password: "", recovery_email: "", secret_key: "" };

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

function isDeleteResult(v: unknown): v is DeleteAccountsResultDto {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Record<string, unknown>)["deleted_accounts"] === "number" &&
    typeof (v as Record<string, unknown>)["deleted_windows"] === "number"
  );
}

/** 新增 / 编辑账号的表单弹窗 */
function AccountEditModal(props: {
  editing: SettingsAccountDto | null;
  open: boolean;
  onCancel: () => void;
  onSubmit: (data: SettingsAccountInputDto) => Promise<void>;
}): ReactElement {
  const [form] = Form.useForm<SettingsAccountInputDto>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    const e = props.editing;
    form.setFieldsValue(
      e ? { email: e.email, password: e.password, recovery_email: e.recovery_email, secret_key: e.secret_key } : EMPTY_ACCOUNT,
    );
  }, [props.open, props.editing, form]);

  const ok = async (): Promise<void> => {
    const v = form.getFieldsValue(true) as SettingsAccountInputDto;
    // 密码不 strip
    const data: SettingsAccountInputDto = {
      email: (v.email ?? "").trim(),
      password: v.password ?? "",
      recovery_email: (v.recovery_email ?? "").trim(),
      secret_key: (v.secret_key ?? "").trim(),
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
      title={props.editing ? "编辑账号" : "添加账号"}
      okText="确定"
      cancelText="取消"
      confirmLoading={submitting}
      onOk={() => void ok()}
      onCancel={props.onCancel}
      forceRender
    >
      <Form form={form} layout="horizontal" labelCol={{ flex: "80px" }} initialValues={EMPTY_ACCOUNT}>
        <Form.Item name="email" label="邮箱">
          <Input placeholder="example@gmail.com" readOnly={!!props.editing} />
        </Form.Item>
        <Form.Item name="password" label="密码">
          <Input placeholder="密码" />
        </Form.Item>
        <Form.Item name="recovery_email" label="辅助邮箱">
          <Input placeholder="辅助邮箱（可选）" />
        </Form.Item>
        <Form.Item name="secret_key" label="2FA密钥">
          <Input placeholder="2FA密钥（可选）" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export function AccountsTab(): ReactElement {
  const { message, modal } = App.useApp();
  const [accounts, setAccounts] = useState<SettingsAccountDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<SettingsAccountDto | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const hostReady = useHostStatus()?.state === "ready";

  /** 按邮箱子串过滤（不区分大小写） */
  const keyword = search.trim().toLowerCase();
  const visible = useMemo(
    () => (keyword ? accounts.filter((a) => a.email.toLowerCase().includes(keyword)) : accounts),
    [accounts, keyword],
  );

  // 隐藏行取消勾选
  useEffect(() => {
    const visibleSet = new Set(visible.map((a) => a.email));
    setSelected((prev) => {
      const next = prev.filter((e) => visibleSet.has(e));
      return next.length === prev.length ? prev : next;
    });
  }, [visible]);

  /** 加载列表数据 */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await invoke(IPC.invoke.settingsAccountsList);
      setAccounts(list);
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

  // 删除任务结束后刷新列表，并给出完成提示
  useEffect(
    () =>
      onTaskFinished((e) => {
        if (e.type !== SETTINGS_TASK_TYPES.deleteAccounts) return;
        void load();
        if (isDeleteResult(e.result)) {
          const r = e.result;
          message.success(`已删除 ${r.deleted_accounts} 个账号` + (r.deleted_windows > 0 ? `，${r.deleted_windows} 个窗口` : ""));
        }
      }),
    [load, message],
  );

  const selectedRows = useMemo(() => {
    const set = new Set(selected);
    return visible.filter((a) => set.has(a.email));
  }, [visible, selected]);

  const allVisibleChecked = visible.length > 0 && selectedRows.length === visible.length;

  /** 全选 / 取消全选：只作用于可见行 */
  const toggleAll = (checked: boolean): void => {
    setSelected(checked ? visible.map((a) => a.email) : []);
  };

  const openAdd = (): void => {
    setEditing(null);
    setEditOpen(true);
  };

  const openEdit = (a: SettingsAccountDto): void => {
    setEditing(a);
    setEditOpen(true);
  };

  /** 提交新增 / 编辑（新增 status=pending，编辑不改状态） */
  const submitEdit = async (data: SettingsAccountInputDto): Promise<void> => {
    try {
      if (editing) {
        await invoke(IPC.invoke.settingsAccountsUpdate, data);
      } else {
        if (!isValidNewAccountEmail(data.email)) {
          message.warning("请输入有效的邮箱地址");
          setEditOpen(false);
          return;
        }
        await invoke(IPC.invoke.settingsAccountsAdd, data);
        message.success("账号已添加");
      }
      setEditOpen(false);
      await load();
    } catch (e) {
      message.error(describeError(e));
    }
  };

  /** 批量删除：走后台任务 */
  const deleteSelected = (): void => {
    const rows = selectedRows;
    if (rows.length === 0) {
      message.info("请先勾选要删除的账号");
      return;
    }
    modal.confirm({
      title: "确认删除",
      content: (
        <div style={{ whiteSpace: "pre-line" }}>{`确定要删除选中的 ${rows.length} 个账号吗？\n将同时删除对应的 ixBrowser 窗口。`}</div>
      ),
      okText: "确定",
      cancelText: "取消",
      onOk: async () => {
        try {
          const info = await invoke(
            IPC.invoke.settingsAccountsDelete,
            rows.map((a) => a.email),
          );
          markTaskStarted(info);
        } catch (e) {
          message.error(describeError(e));
        }
      },
    });
  };

  /** 导出选中账号 */
  const exportSelected = (): void => {
    const rows = selectedRows;
    if (rows.length === 0) {
      message.info("请先勾选要导出的账号");
      return;
    }
    try {
      downloadText(EXPORT_FILE_NAME, buildAccountExportText(rows));
      message.success(`已导出 ${rows.length} 个账号到: ${EXPORT_FILE_NAME}`);
    } catch (e) {
      message.error(`导出失败: ${describeError(e)}`);
    }
  };

  const columns: ColumnsType<SettingsAccountDto> = [
    { title: "邮箱", dataIndex: "email", ellipsis: true },
    { title: "密码", dataIndex: "password", ellipsis: true },
    { title: "辅助邮箱", dataIndex: "recovery_email", ellipsis: true },
    { title: "2FA密钥", dataIndex: "secret_key", ellipsis: true },
    {
      title: "状态",
      dataIndex: "status",
      width: 110,
      render: (s: string) => <span style={STATUS_COLORS[s] ? { color: STATUS_COLORS[s] } : undefined}>{s}</span>,
    },
    {
      title: "操作",
      key: "actions",
      width: 90,
      render: (_, a) => (
        <Button type="text" icon={<EditOutlined />} onClick={() => openEdit(a)}>
          编辑
        </Button>
      ),
    },
  ];

  const countText = keyword ? `显示 ${visible.length}/${accounts.length} 个账号` : `共 ${accounts.length} 个账号`;

  return (
    <Space direction="vertical" size={12} style={{ width: "100%" }}>
      <Card size="small">
        <Space wrap style={{ width: "100%", justifyContent: "space-between" }}>
          <Space wrap>
            <Tooltip title="全选/取消全选可见账号">
              <Checkbox
                checked={allVisibleChecked}
                indeterminate={selectedRows.length > 0 && !allVisibleChecked}
                onChange={(e) => toggleAll(e.target.checked)}
              />
            </Tooltip>
            <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>
              添加账号
            </Button>
            <Button icon={<DownloadOutlined />} onClick={() => setImportOpen(true)}>
              批量导入
            </Button>
            <Button icon={<DeleteOutlined />} onClick={deleteSelected}>
              删除选中
            </Button>
            <Button icon={<UploadOutlined />} onClick={exportSelected}>
              导出选中
            </Button>
            <Button type="text" icon={<SyncOutlined />} onClick={() => void load()} loading={loading}>
              刷新
            </Button>
          </Space>
          <Space>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索邮箱..."
              style={{ width: 200 }}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Typography.Text type="secondary">{countText}</Typography.Text>
          </Space>
        </Space>
      </Card>

      {error ? <Alert type="error" showIcon message={`加载账号失败: ${error}`} /> : null}

      <Table<SettingsAccountDto>
        size="small"
        rowKey="email"
        columns={columns}
        dataSource={visible}
        loading={loading}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: (keys) => setSelected(keys as string[]),
          hideSelectAll: true,
          columnWidth: 40,
        }}
        pagination={{ defaultPageSize: 50, showSizeChanger: true, pageSizeOptions: [20, 50, 100, 200] }}
      />

      <AccountEditModal editing={editing} open={editOpen} onCancel={() => setEditOpen(false)} onSubmit={submitEdit} />

      <BatchImportModal
        open={importOpen}
        title="批量导入账号"
        formatHint={ACCOUNT_IMPORT_FORMAT_HINT}
        columns={ACCOUNT_PREVIEW_COLUMNS}
        parseLine={parseAccountImportLine}
        formatPreviewRow={formatAccountPreviewRow}
        onImport={(text) => invoke(IPC.invoke.settingsAccountsImport, text)}
        onClose={() => setImportOpen(false)}
        onDone={() => void load()}
      />
    </Space>
  );
}
