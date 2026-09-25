/**
 * 标签管理（词表本身）：新建 / 改名 / 删除
 *
 * 这三个操作直接影响 ixBrowser 里的标签：改名与删除会作用于**所有**挂了该标签的窗口，
 * 所以删除前会显示「有多少个窗口在用」并要求确认。
 * 颜色由 ixBrowser 决定（接口不支持改颜色）。
 */
import { useState, type ReactElement } from "react";
import { App, Button, Empty, Input, Modal, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { TagRef } from "../../../../shared/channels/accounts.ts";
import { IPC, describeError, invoke } from "../../lib/ipc.ts";
import { useTokens } from "../../theme/tokens.ts";
import { usePagination } from "../../components/use-pagination.ts";

export interface TagManagerModalProps {
  open: boolean;
  vocabulary: readonly TagRef[];
  /** 标签 id → 使用它的窗口数（页面按当前列表统计） */
  usage: ReadonlyMap<number, number>;
  onClose: () => void;
  /** 有任何改动后回调（页面重新拉列表以刷新词表与使用数） */
  onChanged: () => void;
}

export function TagManagerModal({ open, vocabulary, usage, onClose, onChanged }: TagManagerModalProps): ReactElement {
  const { message, modal } = App.useApp();
  const t = useTokens();
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  /** 正在改名的标签 id → 草稿名字 */
  const [editing, setEditing] = useState<{ id: number; title: string } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  // 分页：每次打开从第 1 页开始
  const pager = usePagination("tags", vocabulary.length, [open]);

  const create = async (): Promise<void> => {
    const title = newTitle.trim();
    if (title === "") {
      void message.warning("请输入标签名");
      return;
    }
    setCreating(true);
    try {
      const tag = await invoke(IPC.invoke.accountsCreateTag, title);
      setNewTitle("");
      onChanged();
      void message.success(`标签「${tag.title}」已创建`);
    } catch (e) {
      void message.error(`新建标签失败: ${describeError(e)}`);
    } finally {
      setCreating(false);
    }
  };

  const rename = async (id: number, title: string): Promise<void> => {
    const next = title.trim();
    if (next === "") {
      void message.warning("标签名不能为空");
      return;
    }
    setBusyId(id);
    try {
      await invoke(IPC.invoke.accountsUpdateTag, id, next);
      setEditing(null);
      onChanged();
      void message.success("标签已改名");
    } catch (e) {
      void message.error(`改名失败: ${describeError(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const remove = (row: TagRef): void => {
    const used = usage.get(row.id) ?? 0;
    modal.confirm({
      title: "删除标签",
      content: (
        <div style={{ whiteSpace: "pre-line" }}>
          {`确定删除标签「${row.title}」吗？\n\n` +
            (used > 0 ? `⚠️ 当前有 ${used} 个窗口挂着它，删除后这些窗口也会失去这个标签。\n` : "") +
            `此操作会同步到 ixBrowser。`}
        </div>
      ),
      okText: "删除",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        setBusyId(row.id);
        try {
          await invoke(IPC.invoke.accountsDeleteTag, row.id);
          onChanged();
          void message.success("标签已删除");
        } catch (e) {
          void message.error(`删除失败: ${describeError(e)}`);
        } finally {
          setBusyId(null);
        }
      },
    });
  };

  const columns: ColumnsType<TagRef> = [
    {
      title: "标签",
      key: "title",
      render: (_, row) =>
        editing?.id === row.id ? (
          <Input
            autoFocus
            size="small"
            value={editing.title}
            maxLength={50}
            onChange={(e) => setEditing({ id: row.id, title: e.target.value })}
            onPressEnter={() => void rename(row.id, editing.title)}
          />
        ) : (
          <Tag color={row.color || undefined} bordered={false}>
            {row.title}
          </Tag>
        ),
    },
    {
      title: "使用窗口",
      key: "usage",
      width: 100,
      align: "right",
      render: (_, row) => {
        const n = usage.get(row.id) ?? 0;
        return <Typography.Text type={n > 0 ? undefined : "secondary"} className="abb-num">{n}</Typography.Text>;
      },
    },
    {
      title: "操作",
      key: "action",
      width: 150,
      render: (_, row) =>
        editing?.id === row.id ? (
          <Space size={4}>
            <Button type="link" size="small" loading={busyId === row.id} onClick={() => void rename(row.id, editing.title)}>
              保存
            </Button>
            <Button type="link" size="small" onClick={() => setEditing(null)}>
              取消
            </Button>
          </Space>
        ) : (
          <Space size={4}>
            <Button type="link" size="small" onClick={() => setEditing({ id: row.id, title: row.title })}>
              改名
            </Button>
            <Tooltip title="影响所有挂这个标签的窗口">
              <Button type="link" size="small" danger onClick={() => remove(row)}>
                删除
              </Button>
            </Tooltip>
          </Space>
        ),
    },
  ];

  return (
    <Modal title="标签管理" open={open} onCancel={onClose} footer={null} width={640} destroyOnHidden>
      <Space.Compact style={{ width: "100%", marginBottom: 12 }}>
        <Input
          placeholder="新建标签（输入名字）"
          value={newTitle}
          maxLength={50}
          onChange={(e) => setNewTitle(e.target.value)}
          onPressEnter={() => void create()}
        />
        <Button loading={creating} onClick={() => void create()}>
          新建
        </Button>
      </Space.Compact>
      <Table<TagRef>
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={vocabulary as TagRef[]}
        pagination={pager.pagination}
        scroll={{ y: 360 }}
        locale={{
          emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有任何标签" />,
        }}
      />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
        <span style={{ color: t.muted }}>改名与删除会作用于所有挂了该标签的窗口，并同步到 ixBrowser；颜色由 ixBrowser 决定。</span>
      </Typography.Paragraph>
    </Modal>
  );
}
