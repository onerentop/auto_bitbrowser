/**
 * 「绑定窗口 / 重新绑定窗口」对话框 —— 对标 _bindBrowser（gui/account_manager_interface.py:1543-1598）
 *
 * 与 Python 的差异（用户已批准）：
 *   Python 用 MessageBox 列出前 10 个可用窗口，确认后**总是绑定第一个**（:1585-1589）。
 *   这里提供真正的下拉选择：Select 列出未被其它账号绑定的窗口，选中哪个就绑定哪个。
 * 其余提示文案照搬 Python。
 */
import { useEffect, useState, type ReactElement } from "react";
import { App, Modal, Select, Spin, Typography } from "antd";
import type { BindWindowOption } from "../../../../shared/channels/accounts.ts";
import { IPC, describeError, invoke } from "../../lib/ipc.ts";
import { logLocal, useTaskState } from "../../stores/task.ts";

export interface BindWindowModalProps {
  /** 要绑定的账号；null 表示对话框关闭 */
  email: string | null;
  onClose: () => void;
  /** 绑定成功后回调（页面据此刷新列表） */
  onBound: () => void;
}

export function BindWindowModal({ email, onClose, onBound }: BindWindowModalProps): ReactElement {
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<BindWindowOption[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 有任务在跑时禁止单条绑定（后端同样会以 TASK_BUSY 拒绝）
  const busy = useTaskState().running !== null;

  useEffect(() => {
    if (!email) return;
    let cancelled = false;
    setLoading(true);
    setOptions([]);
    setSelected(null);
    invoke(IPC.invoke.accountsBindCandidates, email).then(
      (r) => {
        if (cancelled) return;
        setLoading(false);
        if (r.windowCount === 0) {
          message.warning("未找到可用的浏览器窗口，请先在主界面创建窗口");
          onClose();
          return;
        }
        if (r.available.length === 0) {
          message.warning("所有窗口都已被其他账号绑定，请先创建新窗口");
          onClose();
          return;
        }
        setOptions(r.available);
        // 默认选中当前绑定的窗口（重新绑定时），否则第一个（与 Python 的默认行为一致）
        const current = r.available.find((w) => w.profileId === r.currentBrowserId);
        setSelected((current ?? r.available[0])?.profileId ?? null);
      },
      (e: unknown) => {
        if (cancelled) return;
        setLoading(false);
        logLocal(`绑定窗口失败: ${describeError(e)}`);
        message.error(`绑定窗口失败: ${describeError(e)}`);
        onClose();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [email, message, onClose]);

  const submit = async (): Promise<void> => {
    if (!email || !selected) return;
    setSaving(true);
    try {
      const r = await invoke(IPC.invoke.accountsBind, email, selected);
      // 对标 :1590-1593 的两种日志
      if (r.previousBrowserId) logLocal(`已将账号 ${email} 从窗口 ${r.previousBrowserId} 重新绑定到 ${r.browserId}`);
      else logLocal(`已将账号 ${email} 绑定到窗口 ${r.browserId}`);
      onClose();
      onBound();
    } catch (e) {
      logLocal(`绑定窗口失败: ${describeError(e)}`);
      message.error(`绑定窗口失败: ${describeError(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="选择窗口"
      open={email !== null}
      onCancel={onClose}
      onOk={() => void submit()}
      okButtonProps={{ disabled: !selected || busy, loading: saving }}
      okText="绑定"
      destroyOnHidden
    >
      <Typography.Paragraph>为账号 {email} 选择窗口:</Typography.Paragraph>
      {loading ? (
        <Spin />
      ) : (
        <Select
          style={{ width: "100%" }}
          showSearch
          value={selected}
          onChange={(v: string) => setSelected(v)}
          optionFilterProp="label"
          options={options.map((w) => ({ value: w.profileId, label: `${w.profileId} - ${w.name}` }))}
        />
      )}
    </Modal>
  );
}
