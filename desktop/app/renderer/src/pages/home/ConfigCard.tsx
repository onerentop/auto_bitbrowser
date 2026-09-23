/**
 * 「创建参数配置」卡片 —— 对标 gui/home_interface.py:95-137
 *
 * 模板窗口ID / 窗口前缀来自配置（:468 _loadConfigToUI）。
 * Python 在关窗时 saveConfig（:481-487）写回；这里改为输入框失焦时经 abb/home/saveConfig 写回，
 * 值没变就不发请求。
 * 目标分组下拉 + 「刷新」（:125-135 / :227 refreshGroupList）。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { App, Button, Card, Form, Input, Select } from "antd";
import { SyncOutlined } from "@ant-design/icons";
import type { HomeConfig, HomeGroupOption } from "../../../../shared/channels/home.ts";
import { IPC, describeError, invoke } from "../../lib/ipc.ts";
import { logLocal } from "../../stores/task.ts";
import { useHostStatus } from "../../stores/host-status.ts";

export interface ConfigCardProps {
  groupOptions: HomeGroupOption[];
  groupId: number | null;
  onGroupChange: (id: number) => void;
  onRefreshGroups: () => void;
  groupsLoading: boolean;
}

type ConfigField = keyof HomeConfig;

export function ConfigCard(props: ConfigCardProps): ReactElement {
  const { message } = App.useApp();
  const [values, setValues] = useState<HomeConfig>({ templateId: "", namePrefix: "" });
  // 最近一次与后端一致的值：失焦时对比它决定是否写回
  const saved = useRef<HomeConfig>({ templateId: "", namePrefix: "" });

  // 用户在加载完成前改过的字段：加载结果不覆盖这些字段
  const dirty = useRef<Record<ConfigField, boolean>>({ templateId: false, namePrefix: false });

  // 等后端首次就绪后再读配置（窗口可能早于后端 ready 打开）。
  // 只有请求成功才置 loaded：失败，或后端退出（hostReady 变 false → cleanup）时结果作废，
  // 下次 ready 会再发一次。
  const hostReady = useHostStatus()?.state === "ready";
  const loaded = useRef(false);
  useEffect(() => {
    if (!hostReady || loaded.current) return;
    let alive = true;
    invoke(IPC.invoke.homeGetConfig).then(
      (cfg) => {
        if (!alive) return;
        loaded.current = true;
        saved.current = cfg;
        setValues((v) => ({
          templateId: dirty.current.templateId ? v.templateId : cfg.templateId,
          namePrefix: dirty.current.namePrefix ? v.namePrefix : cfg.namePrefix,
        }));
      },
      // 对标 :478-479：加载失败只记录，不打断界面
      (e) => {
        if (alive) logLocal(`[Config] 加载配置到UI失败: ${describeError(e)}`);
      },
    );
    return () => {
      alive = false;
    };
  }, [hostReady]);

  const persist = useCallback(
    async (field: ConfigField) => {
      const value = values[field].trim();
      if (value === saved.current[field]) return;
      try {
        const cfg = await invoke(IPC.invoke.homeSaveConfig, { [field]: value });
        saved.current = cfg;
        setValues((v) => ({ ...v, [field]: cfg[field] }));
      } catch (e) {
        void message.error(`[Config] 保存配置失败: ${describeError(e)}`);
      }
    },
    [values, message],
  );

  const bind = (field: ConfigField) => ({
    value: values[field],
    onChange: (e: { target: { value: string } }) => {
      dirty.current[field] = true;
      setValues((v) => ({ ...v, [field]: e.target.value }));
    },
    onBlur: () => void persist(field),
  });

  return (
    <Card title="创建参数配置" size="small">
      <Form layout="inline" style={{ rowGap: 12 }}>
        <Form.Item label="模板窗口ID">
          <Input placeholder="请输入模板窗口ID（可选）" style={{ width: 200 }} {...bind("templateId")} />
        </Form.Item>
        <Form.Item label="窗口前缀">
          <Input placeholder="可选，默认按模板名命名" style={{ width: 200 }} {...bind("namePrefix")} />
        </Form.Item>
        <Form.Item label="目标分组">
          <Select
            style={{ width: 220 }}
            value={props.groupId ?? undefined}
            options={props.groupOptions.map((g) => ({ value: g.id, label: g.label }))}
            onChange={(v: number) => props.onGroupChange(v)}
            loading={props.groupsLoading}
          />
        </Form.Item>
        <Form.Item>
          <Button type="text" icon={<SyncOutlined />} onClick={props.onRefreshGroups} loading={props.groupsLoading}>
            刷新
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
}
