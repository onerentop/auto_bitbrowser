/**
 * 批量编辑（标签 / 备注）小窗：给勾选账号的窗口写同一份标签 / 备注
 *
 * 只改勾了「要修改」的字段（两个都勾就都写）；写的是 ixBrowser **窗口**上的字段，
 * 因此未绑定窗口的账号后端会跳过，结果里给出「写入 / 跳过 / 失败」三个数。
 * 标签按 id 提交，后端用词表转成标签名数组（词表里没有的 id 会被拒绝）。
 *
 * 备注是用户自己的数据：只有在这里点「确定」才会写（自动化任务一律不碰备注）。
 * 留空 = 清空备注，所以两个字段都写明了「不勾 = 不改」。
 */
import { useCallback, useMemo, useState, type ReactElement } from "react";
import { App, Checkbox, Form, Input, Modal, Select, Space, Typography } from "antd";
import type { AccountListRow, AccountsBatchEditPatch, TagRef } from "../../../../shared/channels/accounts.ts";
import { IPC, describeError, invoke } from "../../lib/ipc.ts";
import { Section } from "../../components/Section.tsx";

export interface BatchEditModalProps {
  open: boolean;
  /** 勾选的账号（含被筛选隐藏的），按列表顺序 */
  rows: readonly AccountListRow[];
  /** 标签词表（列表接口一次带回） */
  vocabulary: readonly TagRef[];
  onClose: () => void;
  /** 写完（或有失败）后刷新账号列表 */
  onDone: () => void;
}

/** 未绑定窗口的账号数：这些会被后端跳过（标签与备注都在窗口上） */
function unboundCount(rows: readonly AccountListRow[]): number {
  return rows.filter((r) => !/^\d+$/.test(r.browser_profile_id.trim())).length;
}

export function BatchEditModal(props: BatchEditModalProps): ReactElement {
  const { open, rows, vocabulary, onClose, onDone } = props;
  const { message, modal } = App.useApp();
  const [editTags, setEditTags] = useState(false);
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [editNote, setEditNote] = useState(false);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const skipped = useMemo(() => unboundCount(rows), [rows]);
  const options = useMemo(() => vocabulary.map((t) => ({ value: t.id, label: t.title })), [vocabulary]);
  const canSubmit = rows.length > 0 && (editTags || editNote) && !submitting;

  const reset = useCallback((): void => {
    setEditTags(false);
    setTagIds([]);
    setEditNote(false);
    setNote("");
  }, []);

  /** 改动摘要（确认框与结果提示共用） */
  const summary = useCallback((): string => {
    const parts: string[] = [];
    if (editTags) {
      parts.push(tagIds.length > 0 ? `标签 = ${tagIds.length} 个` : "清空标签");
    }
    if (editNote) parts.push(note === "" ? "清空备注" : `备注 = ${note.length} 字`);
    return parts.join("；");
  }, [editTags, tagIds, editNote, note]);

  const submit = async (): Promise<void> => {
    const patch: AccountsBatchEditPatch = {};
    if (editTags) patch.tagIds = tagIds;
    if (editNote) patch.note = note;
    setSubmitting(true);
    try {
      const r = await invoke(
        IPC.invoke.accountsBatchEdit,
        rows.map((x) => x.email),
        patch,
      );
      const lines = [`${summary()}：已写入 ${r.updated} 个窗口`];
      if (r.skipped > 0) lines.push(`${r.skipped} 个账号未绑定窗口，已跳过`);
      if (r.failed.length > 0) {
        lines.push(`${r.failed.length} 个失败：`);
        for (const f of r.failed.slice(0, 5)) lines.push(`　${f.email}：${f.error}`);
        if (r.failed.length > 5) lines.push(`　…还有 ${r.failed.length - 5} 个`);
      }
      const text = lines.join("\n");
      if (r.failed.length > 0) modal.warning({ title: "批量编辑完成（有失败）", content: <div style={{ whiteSpace: "pre-line" }}>{text}</div> });
      else void message.success(text.replace(/\n/g, "；"));
      reset();
      onClose();
      onDone();
    } catch (e) {
      void message.error(`批量编辑失败：${describeError(e)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="批量编辑"
      width={520}
      okText="确定"
      cancelText="取消"
      okButtonProps={{ disabled: !canSubmit, danger: true }}
      confirmLoading={submitting}
      afterClose={reset}
      onCancel={onClose}
      onOk={() => {
        if (!canSubmit) return;
        modal.confirm({
          title: "确认批量编辑",
          content: (
            <div style={{ whiteSpace: "pre-line" }}>{`将对 ${rows.length} 个账号执行：${summary()}。${
              skipped > 0 ? `\n其中 ${skipped} 个账号未绑定窗口，会被跳过。` : ""
            }\n\n标签与备注都写在 ixBrowser 窗口上，会覆盖原来的内容。`}</div>
          ),
          okText: "确定",
          cancelText: "取消",
          okButtonProps: { danger: true },
          onOk: () => void submit(),
        });
      }}
      destroyOnHidden
    >
      {rows.length === 0 ? (
        <Typography.Text type="secondary">请先在列表里勾选账号</Typography.Text>
      ) : (
        <Form layout="vertical">
          <Section first title="要修改的字段" description="只改勾上的字段；两个都勾就一起写">
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <div>
                <Checkbox checked={editTags} onChange={(e) => setEditTags(e.target.checked)}>
                  标签（覆盖原有标签）
                </Checkbox>
                <div style={{ marginTop: 8 }}>
                  <Select
                    mode="multiple"
                    allowClear
                    style={{ width: "100%" }}
                    placeholder="不选 = 清空该窗口的全部标签"
                    value={tagIds}
                    onChange={(v: number[]) => setTagIds(v)}
                    options={options}
                    disabled={!editTags}
                  />
                </div>
              </div>
              <div>
                <Checkbox checked={editNote} onChange={(e) => setEditNote(e.target.checked)}>
                  备注（覆盖原有备注）
                </Checkbox>
                <div style={{ marginTop: 8 }}>
                  <Input.TextArea
                    rows={3}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="留空 = 清空备注"
                    maxLength={2000}
                    disabled={!editNote}
                  />
                </div>
              </div>
            </Space>
          </Section>
          <Typography.Text type="secondary">
            已勾选 {rows.length} 个账号{skipped > 0 ? `，其中 ${skipped} 个未绑定窗口（会被跳过）` : ""}。
          </Typography.Text>
        </Form>
      )}
    </Modal>
  );
}
