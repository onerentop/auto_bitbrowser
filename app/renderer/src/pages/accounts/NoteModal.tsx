/**
 * 窗口备注编辑小窗（账号管理页）
 *
 * 备注是 ixBrowser 窗口上的那一份，与首页看到的是同一个；保存只写 note 一个字段。
 * 只在用户点击保存时写入 —— 自动化任务从不读写备注（历史事故：自动化覆盖过用户手写的笔记）。
 */
import { useEffect, useState, type ReactElement } from "react";
import { App, Alert, Input, Modal, Typography } from "antd";
import { IPC, describeError, invoke } from "../../lib/ipc.ts";

/** 与后端 MAX_NOTE_LENGTH 一致 */
export const MAX_NOTE_LENGTH = 2000;

export interface NoteTarget {
  email: string;
  windowName: string;
  note: string;
}

export interface NoteModalProps {
  /** null = 关闭 */
  target: NoteTarget | null;
  onClose: () => void;
  /** 保存成功后回调（页面据此就地更新那一行） */
  onSaved: (email: string, note: string) => void;
}

export function NoteModal({ target, onClose, onSaved }: NoteModalProps): ReactElement {
  const { message } = App.useApp();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (target) setDraft(target.note);
  }, [target]);

  const save = async (): Promise<void> => {
    if (!target) return;
    setSaving(true);
    try {
      const ok = await invoke(IPC.invoke.accountsUpdateNote, target.email, draft);
      if (!ok) {
        void message.error("保存失败：ixBrowser 没有接受这次修改");
        return;
      }
      onSaved(target.email, draft);
      void message.success("备注已保存");
      onClose();
    } catch (e) {
      void message.error(`保存备注失败: ${describeError(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="编辑窗口备注"
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
          <Input.TextArea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoSize={{ minRows: 6, maxRows: 14 }}
            maxLength={MAX_NOTE_LENGTH}
            showCount
            placeholder="这个窗口的备注（只写 ixBrowser 的窗口备注，不影响账号数据）"
          />
          <Alert
            style={{ marginTop: 12 }}
            type="info"
            showIcon
            message="备注只写窗口上的 note 字段，自动化任务不会读写它。"
          />
        </>
      ) : null}
    </Modal>
  );
}
