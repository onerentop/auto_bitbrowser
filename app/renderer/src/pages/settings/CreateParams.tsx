/**
 * 设置页「配置」标签里的「创建参数」分节（原首页的配置卡片搬来）
 *
 * 模板窗口 ID / 窗口前缀：输入框失焦时经 abb/home/saveConfig 写回，值没变就不发请求。
 * 目标分组：下拉选择即写回；清空 = 沿用模板窗口的分组。
 * 账号页「窗口」视角的「创建窗口」按钮读的就是这份参数（只问个数）。
 * 本组件渲染在设置页外层表单内部（Form.Item 直接作为它的子项），不再自己起 <form>，避免表单嵌套。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { App, Button, Form, Input, Select } from "antd";
import { SyncOutlined } from "@ant-design/icons";
import type { HomeConfig, HomeGroupOption } from "../../../../shared/channels/home.ts";
import { defaultGroupOptions } from "../../../../shared/logic/home-list.ts";
import { IPC, describeError, invoke } from "../../lib/ipc.ts";
import { logLocal } from "../../stores/task.ts";
import { useHostStatus } from "../../stores/host-status.ts";

const EMPTY: HomeConfig = { templateId: "", namePrefix: "", groupId: null };
type ConfigField = keyof HomeConfig;

export function CreateParams(): ReactElement {
  const { message } = App.useApp();
  const [values, setValues] = useState<HomeConfig>(EMPTY);
  const [groupOptions, setGroupOptions] = useState<HomeGroupOption[]>(defaultGroupOptions);
  const [groupsLoading, setGroupsLoading] = useState(false);

  // 每次渲染同步一份最新输入值：加载回填要用「现在」的值判断哪些字段被用户改过，
  // 直接用 effect 闭包里的 values 会拿到后端就绪那一刻的旧值，把用户刚输入的内容覆盖掉
  const valuesRef = useRef(values);
  valuesRef.current = values;
  // 最近一次与后端一致的值：失焦时对比它决定是否写回
  const saved = useRef<HomeConfig>(EMPTY);
  // 用户在加载完成前改过的字段：加载结果不覆盖这些字段
  const dirty = useRef<Record<ConfigField, boolean>>({ templateId: false, namePrefix: false, groupId: false });

  const hostReady = useHostStatus()?.state === "ready";
  const loaded = useRef(false);

  const refreshGroups = useCallback(async (): Promise<void> => {
    setGroupsLoading(true);
    try {
      const res = await invoke(IPC.invoke.homeListGroups);
      setGroupOptions(res.options);
      if (res.error) logLocal(`[警告] 获取分组列表失败: ${res.error}`);
    } catch (e) {
      logLocal(`[警告] 获取分组列表失败: ${describeError(e)}`);
      setGroupOptions(defaultGroupOptions());
    } finally {
      setGroupsLoading(false);
    }
  }, []);

  // 等后端首次就绪后再读配置。只有请求成功才算 loaded：失败（或后端退出）时下次 ready 会再发一次。
  useEffect(() => {
    if (!hostReady || loaded.current) return;
    let alive = true;
    invoke(IPC.invoke.homeGetConfig).then(
      (cfg) => {
        if (!alive) return;
        loaded.current = true;
        saved.current = cfg;
        const current = valuesRef.current;
        setValues({
          templateId: dirty.current.templateId ? current.templateId : cfg.templateId,
          namePrefix: dirty.current.namePrefix ? current.namePrefix : cfg.namePrefix,
          groupId: dirty.current.groupId ? current.groupId : cfg.groupId,
        });
      },
      (e) => {
        if (alive) logLocal(`[设置] 加载创建参数失败: ${describeError(e)}`);
      },
    );
    return () => {
      alive = false;
    };
  }, [hostReady]);

  useEffect(() => {
    if (hostReady) void refreshGroups();
  }, [hostReady, refreshGroups]);

  /** 写回一个字段（值没变就不发请求）；groupId 传 null 表示沿用模板窗口的分组 */
  const persistField = useCallback(
    async (field: ConfigField, raw: string | number | null): Promise<void> => {
      const value = field === "groupId" ? raw : String(raw ?? "").trim();
      if (value === saved.current[field]) return;
      try {
        const patch = { [field]: value } as Partial<HomeConfig>;
        const cfg = await invoke(IPC.invoke.homeSaveConfig, patch);
        saved.current = cfg;
        setValues((v) => ({ ...v, [field]: cfg[field] }));
      } catch (e) {
        void message.error(`保存创建参数失败：${describeError(e)}`);
      }
    },
    [message],
  );

  const bindText = (field: "templateId" | "namePrefix") => ({
    value: values[field],
    onChange: (e: { target: { value: string } }) => {
      dirty.current[field] = true;
      setValues((v) => ({ ...v, [field]: e.target.value }));
    },
    onBlur: () => void persistField(field, valuesRef.current[field]),
  });

  const groupSelectOptions = useMemo(
    () => groupOptions.map((g) => ({ value: g.id, label: g.label })),
    [groupOptions],
  );

  return (
    <>
      <Form.Item label="模板窗口ID">
        <Input placeholder="请输入模板窗口ID（可选）" style={{ width: 200 }} {...bindText("templateId")} />
      </Form.Item>
      <Form.Item label="窗口前缀">
        <Input placeholder="可选，默认按模板名命名" style={{ width: 200 }} {...bindText("namePrefix")} />
      </Form.Item>
      <Form.Item label="目标分组" tooltip="留空 = 沿用模板窗口的分组">
        <Select
          style={{ width: 220 }}
          allowClear
          placeholder="沿用模板窗口的分组"
          value={values.groupId ?? undefined}
          options={groupSelectOptions}
          loading={groupsLoading}
          onChange={(v: number | undefined) => {
            const next = v ?? null;
            dirty.current.groupId = true;
            setValues((cur) => ({ ...cur, groupId: next }));
            void persistField("groupId", next);
          }}
        />
      </Form.Item>
      <Form.Item label=" " colon={false} style={{ marginBottom: 0 }}>
        <Button type="text" icon={<SyncOutlined />} onClick={() => void refreshGroups()} loading={groupsLoading}>
          刷新分组
        </Button>
      </Form.Item>
    </>
  );
}
