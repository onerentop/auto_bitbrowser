/**
 * 「绑定窗口 / 重新绑定窗口」对话框
 *
 * 下拉列出未被其它账号绑定的窗口，选中哪个就绑定哪个；
 * 与邮箱同名的窗口排最前并标【同名】（同名窗口可能有多个，自动绑定不猜，由这里人工确认）。
 */
import { useEffect, useState, type ReactElement } from "react";
import { App, Modal, Select, Spin, Typography } from "antd";
import type { BindWindowOption } from "../../../../shared/channels/accounts.ts";
import { defaultBindSelection } from "../../../../shared/logic/account-list.ts";
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
        // 默认选中：当前绑定 → 唯一的同名窗口 → 不选（让用户自己挑）
        setSelected(defaultBindSelection(r.available, r.currentBrowserId));
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
      // 两种日志
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
      <Typography.Paragraph style={{ marginTop: 16, marginBottom: 8 }}>
        为账号 <Typography.Text strong>{email}</Typography.Text> 选择窗口：
      </Typography.Paragraph>
      {loading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
          <Spin />
        </div>
      ) : (
        <Select
          style={{ width: "100%" }}
          showSearch
          value={selected}
          onChange={(v: string) => setSelected(v)}
          optionFilterProp="label"
          placeholder="请选择窗口（【同名】= 窗口名与邮箱相同）"
          options={options.map((w) => ({
            value: w.profileId,
            label: `${w.sameName ? "【同名】" : ""}${w.profileId} - ${w.name}`,
          }))}
        />
      )}
    </Modal>
  );
}
