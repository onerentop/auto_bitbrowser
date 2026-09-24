/**
 * 编辑某个账号所绑窗口的标签（ixBrowser 的标签）
 *
 * 标签的唯一真相在 ixBrowser：这里勾选后整体写回窗口（`abb/accounts/setTags`），
 * 因此 ixBrowser 里看到的与这里永远一致。可以当场新建标签（建完自动勾上）。
 * 账号未绑定窗口时不能编辑（标签挂在窗口上）。
 */
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { App, Alert, Button, Checkbox, Empty, Input, Modal, Space, Tag, Typography } from "antd";
import type { TagRef } from "../../../../shared/channels/accounts.ts";
import { IPC, describeError, invoke } from "../../lib/ipc.ts";
import { useTokens } from "../../theme/tokens.ts";

export interface TagEditTarget {
  email: string;
  windowName: string;
  tagIds: number[];
}

export interface TagEditModalProps {
  /** null = 关闭 */
  target: TagEditTarget | null;
  /** 标签词表（列表接口带回来的） */
  vocabulary: readonly TagRef[];
  onClose: () => void;
  /** 保存成功后回调（页面据此就地更新那一行） */
  onSaved: (email: string, tags: TagRef[]) => void;
  /** 新建过标签时回调（页面重新拉一次列表以刷新词表与使用数） */
  onVocabularyChanged: () => void;
}

export function TagEditModal({ target, vocabulary, onClose, onSaved, onVocabularyChanged }: TagEditModalProps): ReactElement {
  const { message } = App.useApp();
  const t = useTokens();
  const [checked, setChecked] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  /** 本次会话里新建的标签（还没被列表刷新带回来） */
  const [created, setCreated] = useState<TagRef[]>([]);

  useEffect(() => {
    if (!target) return;
    setChecked(target.tagIds);
    setSearch("");
    setNewTitle("");
  }, [target]);

  const all = useMemo(() => {
    const byId = new Map<number, TagRef>();
    for (const t of vocabulary) byId.set(t.id, t);
    for (const t of created) byId.set(t.id, t);
    return [...byId.values()];
  }, [vocabulary, created]);

  const keyword = search.trim().toLowerCase();
  const shown = keyword === "" ? all : all.filter((t) => t.title.toLowerCase().includes(keyword));

  const create = async (): Promise<void> => {
    const title = newTitle.trim();
    if (title === "") {
      void message.warning("请输入标签名");
      return;
    }
    if (all.some((t) => t.title === title)) {
      void message.warning("这个标签已经存在，直接勾选即可");
      return;
    }
    setCreating(true);
    try {
      const tag = await invoke(IPC.invoke.accountsCreateTag, title);
      setCreated((prev) => [...prev, tag]);
      setChecked((prev) => [...prev, tag.id]);
      setNewTitle("");
      onVocabularyChanged();
      void message.success(`标签「${tag.title}」已创建并勾选`);
    } catch (e) {
      void message.error(`新建标签失败: ${describeError(e)}`);
    } finally {
      setCreating(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!target) return;
    setSaving(true);
    try {
      const ok = await invoke(IPC.invoke.accountsSetTags, target.email, checked);
      if (!ok) {
        void message.error("保存失败：ixBrowser 没有接受这次修改");
        return;
      }
      const picked = all.filter((t) => checked.includes(t.id));
      onSaved(target.email, picked);
      void message.success(checked.length > 0 ? `已保存 ${checked.length} 个标签` : "已清空标签");
      onClose();
    } catch (e) {
      void message.error(`保存标签失败: ${describeError(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="编辑标签"
      open={target !== null}
      onCancel={onClose}
      onOk={() => void save()}
      okText="保存"
      cancelText="取消"
      okButtonProps={{ loading: saving }}
      width={560}
      destroyOnHidden
    >
      {target ? (
        <>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            {target.email}
            {target.windowName ? ` · 窗口「${target.windowName}」` : ""}
          </Typography.Paragraph>
          <Input.Search
            placeholder="搜索标签"
            allowClear
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ marginBottom: 8 }}
          />
          <div style={{ maxHeight: 240, overflowY: "auto", border: `1px solid ${t.line}`, borderRadius: 6, padding: 8 }}>
            {shown.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={all.length === 0 ? "还没有任何标签" : "没有匹配的标签"} />
            ) : (
              <Checkbox.Group value={checked} onChange={(v) => setChecked(v.map(Number))} style={{ display: "block" }}>
                <Space direction="vertical" size={4} style={{ width: "100%" }}>
                  {shown.map((t) => (
                    <Checkbox key={t.id} value={t.id}>
                      <Tag color={t.color || undefined} bordered={false}>
                        {t.title}
                      </Tag>
                    </Checkbox>
                  ))}
                </Space>
              </Checkbox.Group>
            )}
          </div>
          <Space.Compact style={{ width: "100%", marginTop: 12 }}>
            <Input
              placeholder="新建标签（输入名字）"
              value={newTitle}
              maxLength={50}
              onChange={(e) => setNewTitle(e.target.value)}
              onPressEnter={() => void create()}
            />
            <Button loading={creating} onClick={() => void create()}>
              新建并勾选
            </Button>
          </Space.Compact>
          <Alert
            style={{ marginTop: 12 }}
            type="info"
            showIcon
            message="标签存在 ixBrowser 里：这里保存后，ixBrowser 里同一个窗口的标签会同步变化。"
          />
        </>
      ) : null}
    </Modal>
  );
}
