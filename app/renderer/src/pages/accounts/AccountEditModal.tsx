/**
 * 添加 / 编辑账号弹窗（从原设置页「账号数据」迁来）
 *
 * 列表不带密码 / 密钥 / 辅助邮箱原文：编辑时打开弹窗才按邮箱向后端取（abb/accounts/get）。
 * 密码不 strip，其余字段 strip（与后端校验一致）。
 */
import { useEffect, useState, type ReactElement } from "react";
import { App, Form, Input, Modal, Spin } from "antd";
import type { AccountDetail, AutoBindSummary } from "../../../../shared/channels/accounts.ts";
import { isValidNewAccountEmail } from "../../../../shared/logic/settings-data.ts";
import { IPC, describeError, invoke } from "../../lib/ipc.ts";

const EMPTY: AccountDetail = { email: "", password: "", recovery_email: "", secret_key: "" };

export interface AccountEditModalProps {
  /** null = 关闭；"" = 添加；邮箱 = 编辑该账号 */
  email: string | null;
  onClose: () => void;
  /** 保存成功后（刷新列表）；添加时带上自动绑定窗口的结果 */
  onSaved: (bind?: AutoBindSummary) => void;
}

export function AccountEditModal(props: AccountEditModalProps): ReactElement {
  const { message } = App.useApp();
  const [form] = Form.useForm<AccountDetail>();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const open = props.email !== null;
  const editing = props.email !== null && props.email !== "";

  // 打开时：添加 → 清空；编辑 → 向后端取原文
  useEffect(() => {
    if (props.email === null) return;
    if (props.email === "") {
      form.setFieldsValue(EMPTY);
      return;
    }
    let cancelled = false;
    setLoading(true);
    form.setFieldsValue({ ...EMPTY, email: props.email });
    invoke(IPC.invoke.accountsGet, props.email).then(
      (d) => {
        if (!cancelled) form.setFieldsValue(d);
      },
      (e: unknown) => {
        if (!cancelled) void message.error(`读取账号失败: ${describeError(e)}`);
      },
    ).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [props.email, form, message]);

  const ok = async (): Promise<void> => {
    const v = form.getFieldsValue(true) as AccountDetail;
    const data: AccountDetail = {
      email: (v.email ?? "").trim(),
      password: v.password ?? "",
      recovery_email: (v.recovery_email ?? "").trim(),
      secret_key: (v.secret_key ?? "").trim(),
    };
    if (!editing && !isValidNewAccountEmail(data.email)) {
      void message.warning("请输入有效的邮箱地址");
      return;
    }
    setSubmitting(true);
    try {
      let bind: AutoBindSummary | undefined;
      if (editing) {
        await invoke(IPC.invoke.accountsUpdate, data);
        void message.success("账号已保存");
      } else {
        bind = await invoke(IPC.invoke.accountsAdd, data);
        void message.success("账号已添加");
      }
      props.onSaved(bind);
      props.onClose();
    } catch (e) {
      void message.error(describeError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={editing ? "编辑账号" : "添加账号"}
      okText="保存"
      cancelText="取消"
      confirmLoading={submitting}
      okButtonProps={{ disabled: loading }}
      onOk={() => void ok()}
      onCancel={props.onClose}
      forceRender
    >
      <Spin spinning={loading}>
        {/* 标签左对齐、固定宽度，与首页「创建参数」一致；上方留 16 与标题拉开 */}
        <Form form={form} layout="horizontal" labelAlign="left" labelCol={{ flex: "80px" }} initialValues={EMPTY} style={{ marginTop: 16 }}>
          <Form.Item name="email" label="邮箱">
            <Input placeholder="example@gmail.com" readOnly={editing} />
          </Form.Item>
          <Form.Item name="password" label="密码">
            <Input.Password placeholder="密码" visibilityToggle />
          </Form.Item>
          <Form.Item name="recovery_email" label="辅助邮箱">
            <Input placeholder="辅助邮箱（可选）" />
          </Form.Item>
          <Form.Item name="secret_key" label="2FA密钥">
            <Input.Password placeholder="2FA密钥（可选）" visibilityToggle />
          </Form.Item>
        </Form>
      </Spin>
    </Modal>
  );
}
