/**
 * 「配置」标签（一个面板内的分节表单，集中读写后端配置）
 *
 * 布局：顶部固定操作条（刷新 / 恢复默认 / 保存配置）+ 左对齐分节表单；字段、范围、默认值与文案沿用原有定义。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Alert, App, AutoComplete, Button, Form, Input, InputNumber, Select, Space, Tabs, Typography } from "antd";
import { CopyOutlined, ReloadOutlined, SaveOutlined, SendOutlined, SyncOutlined } from "@ant-design/icons";
import {
  SETTINGS_NUMBER_RANGES,
  clampSettingsNumbers,
  type AiProviderName,
  type SettingsNumberField,
  type SettingsSnapshotDto,
} from "../../../../shared/channels/settings.ts";
import { IPC, describeError, invoke } from "../../lib/ipc.ts";
import { useHostStatus } from "../../stores/host-status.ts";
import { normalizeThemeMode, setThemeMode } from "../../stores/theme.ts";
import { Panel, Section } from "../../components/Section.tsx";
import { useTokens } from "../../theme/tokens.ts";

const APP_PASSWORDS_URL = "https://myaccount.google.com/apppasswords";

/** 模型下拉选项 */
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash", "gemini-2.5-flash-lite"];
const ANTHROPIC_MODELS = [
  "claude-sonnet-4-20250514",
  "claude-3-5-sonnet-20241022",
  "claude-3-opus-20240229",
  "claude-3-haiku-20240307",
];

/** 主题选项 */
const THEME_OPTIONS = [
  { value: "auto", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

type FormValues = Omit<SettingsSnapshotDto, SettingsNumberField> & Record<SettingsNumberField, number | null>;

const defaultNumber = (k: SettingsNumberField): number => SETTINGS_NUMBER_RANGES[k][2];

/** 「恢复默认」的表单值（不含 data_dir） */
function defaultFormValues(): Omit<FormValues, "data_dir"> {
  return {
    ai_default_provider: "gemini",
    gemini_api_key: "",
    gemini_base_url: "",
    gemini_model: "gemini-2.5-flash",
    anthropic_api_key: "",
    anthropic_base_url: "",
    anthropic_model: "claude-sonnet-4-20250514",
    ai_max_steps: 25,
    gmail_imap_email: "",
    gmail_imap_password: "",
    timeout_page_load: 30,
    timeout_status_check: 20,
    timeout_iframe_wait: 15,
    delay_after_login: 3,
    delay_after_offer: 8,
    delay_after_save: 18,
    proxy_max_windows_per_ip: 3,
    default_thread_count: 3,
    theme: "auto",
    data_separator: "----",
  };
}

/** 数值输入：范围取自 SETTINGS_NUMBER_RANGES */
function NumberField(props: { name: SettingsNumberField; label: string }): ReactElement {
  const [min, max] = SETTINGS_NUMBER_RANGES[props.name];
  return (
    <Form.Item name={props.name} label={props.label}>
      <InputNumber min={min} max={max} precision={0} style={{ width: 140 }} />
    </Form.Item>
  );
}

function Hint(props: { children: string }): ReactElement {
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {props.children}
    </Typography.Text>
  );
}

export function ConfigTab(): ReactElement {
  const { message, modal, notification } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [providerTab, setProviderTab] = useState<AiProviderName>("gemini");
  const [testing, setTesting] = useState<AiProviderName | null>(null);
  const [copied, setCopied] = useState(false);
  const [dataDirInput, setDataDirInput] = useState("");
  const [applyingDir, setApplyingDir] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hostReady = useHostStatus()?.state === "ready";
  const t = useTokens();

  /** 从后端加载配置 */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await invoke(IPC.invoke.settingsLoad);
      // 默认提供商不在选项里时保持当前选择（findText 失败 → 不改）
      const provider: AiProviderName | undefined =
        s.ai_default_provider === "gemini" || s.ai_default_provider === "anthropic" ? s.ai_default_provider : undefined;
      const current = form.getFieldsValue(true) as Partial<FormValues>;
      form.setFieldsValue({
        // 数值字段按 SETTINGS_NUMBER_RANGES 静默夹紧：
        // 不夹紧的话，config.json 里任一越界值会让后端校验拒绝整份配置，无法保存。
        ...clampSettingsNumbers(s),
        ai_default_provider: provider ?? current.ai_default_provider ?? "gemini",
        // 模型为空时不覆盖下拉当前值
        gemini_model: s.gemini_model || current.gemini_model || "",
        anthropic_model: s.anthropic_model || current.anthropic_model || "",
        theme: normalizeThemeMode(s.theme),
      });
      if (provider) setProviderTab(provider);
      setDataDirInput(s.data_dir);
      setThemeMode(normalizeThemeMode(s.theme));
      setLoaded(true);
      setLoadError(null);
    } catch (e) {
      setLoadError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [form]);

  // 首次在后端就绪后加载；已加载过则不自动覆盖（避免后端重启冲掉未保存的编辑）
  useEffect(() => {
    if (hostReady && !loaded) void load();
  }, [hostReady, loaded, load]);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  /** 保存配置：界面层 strip，gmail 密码原样 */
  const save = async (): Promise<void> => {
    const v = form.getFieldsValue(true) as FormValues;
    const num = (k: SettingsNumberField): number => v[k] ?? defaultNumber(k);
    const snapshot: SettingsSnapshotDto = {
      ai_default_provider: v.ai_default_provider,
      gemini_api_key: (v.gemini_api_key ?? "").trim(),
      gemini_base_url: (v.gemini_base_url ?? "").trim(),
      gemini_model: (v.gemini_model ?? "").trim(),
      anthropic_api_key: (v.anthropic_api_key ?? "").trim(),
      anthropic_base_url: (v.anthropic_base_url ?? "").trim(),
      anthropic_model: (v.anthropic_model ?? "").trim(),
      ai_max_steps: num("ai_max_steps"),
      gmail_imap_email: (v.gmail_imap_email ?? "").trim(),
      gmail_imap_password: v.gmail_imap_password ?? "",
      timeout_page_load: num("timeout_page_load"),
      timeout_status_check: num("timeout_status_check"),
      timeout_iframe_wait: num("timeout_iframe_wait"),
      delay_after_login: num("delay_after_login"),
      delay_after_offer: num("delay_after_offer"),
      delay_after_save: num("delay_after_save"),
      proxy_max_windows_per_ip: num("proxy_max_windows_per_ip"),
      default_thread_count: num("default_thread_count"),
      theme: normalizeThemeMode(v.theme),
      data_dir: dataDirInput.trim(),
      data_separator: (v.data_separator ?? "").trim(),
    };
    setSaving(true);
    try {
      const fresh = await invoke(IPC.invoke.settingsSave, snapshot);
      form.setFieldsValue({ data_separator: fresh.data_separator });
      message.success("配置已保存");
    } catch (e) {
      message.error(`保存失败: ${describeError(e)}`);
    } finally {
      setSaving(false);
    }
  };

  /** 恢复默认：只重置表单，不写盘，不动 data_dir */
  const reset = (): void => {
    modal.confirm({
      title: "确认恢复",
      content: "确定要恢复默认设置吗？",
      okText: "确定",
      cancelText: "取消",
      onOk: () => {
        form.setFieldsValue(defaultFormValues());
        setProviderTab("gemini");
        setThemeMode("auto");
        message.success("设置已恢复为默认值");
      },
    });
  };

  /** 测试 AI 服务商连通性，并提示结果 */
  const testConnection = async (provider: AiProviderName): Promise<void> => {
    const v = form.getFieldsValue(true) as FormValues;
    const input =
      provider === "gemini"
        ? { provider, apiKey: v.gemini_api_key ?? "", baseUrl: v.gemini_base_url ?? "", model: v.gemini_model ?? "" }
        : {
            provider,
            apiKey: v.anthropic_api_key ?? "",
            baseUrl: v.anthropic_base_url ?? "",
            model: v.anthropic_model ?? "",
          };
    setTesting(provider);
    try {
      const r = await invoke(IPC.invoke.settingsTestAi, input);
      if (r.missingKey) {
        message.warning(r.message);
      } else if (r.success) {
        notification.success({
          message: "连接成功",
          description: (
            <div style={{ whiteSpace: "pre-line" }}>
              {`提供商: ${(r.details.provider ?? provider).toUpperCase()}\n模型: ${r.details.model ?? "N/A"}\n响应时间: ${r.details.response_time_ms ?? 0}ms`}
            </div>
          ),
          duration: 5,
        });
      } else {
        notification.error({ message: "连接失败", description: r.message, duration: 5 });
      }
    } catch (e) {
      notification.error({ message: "连接失败", description: describeError(e), duration: 5 });
    } finally {
      setTesting(null);
    }
  };

  /** 复制应用专用密码页面链接 */
  const copyLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(APP_PASSWORDS_URL);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      message.error(`复制失败: ${describeError(e)}`);
    }
  };

  /**
   * 应用数据目录。
   * 有意偏差：原实现弹文件夹对话框、选中即写入；这里没有对话框通道，改成输入框 +「应用」，同样立即写入。
   */
  const applyDataDir = async (): Promise<void> => {
    const dir = dataDirInput.trim();
    if (!dir) {
      message.warning("请输入数据目录");
      return;
    }
    setApplyingDir(true);
    try {
      const saved = await invoke(IPC.invoke.settingsSetDataDir, dir);
      setDataDirInput(saved);
      message.success(`数据目录: ${saved}`);
    } catch (e) {
      message.error(describeError(e));
    } finally {
      setApplyingDir(false);
    }
  };

  const providerForm = (provider: AiProviderName): ReactElement => {
    const isGemini = provider === "gemini";
    return (
      <>
        <Form.Item name={`${provider}_api_key`} label="API Key">
          <Input.Password
            placeholder={
              isGemini
                ? "Gemini API Key（或从环境变量 GEMINI_API_KEY 读取）"
                : "Anthropic API Key（或从环境变量 ANTHROPIC_API_KEY 读取）"
            }
            autoComplete="off"
          />
        </Form.Item>
        <Form.Item name={`${provider}_base_url`} label="Base URL">
          <Input placeholder={isGemini ? "留空使用 Gemini 官方 API" : "留空使用官方 API，或填写第三方兼容服务 URL"} />
        </Form.Item>
        <Form.Item name={`${provider}_model`} label="模型">
          <AutoComplete options={(isGemini ? GEMINI_MODELS : ANTHROPIC_MODELS).map((m) => ({ value: m }))} />
        </Form.Item>
        {!isGemini ? (
          <Form.Item label=" " colon={false}>
            <Hint>支持第三方 Claude API 服务，如 OpenRouter、Together 等</Hint>
          </Form.Item>
        ) : null}
        <Form.Item label=" " colon={false}>
          <Button
            icon={<SendOutlined />}
            loading={testing === provider}
            disabled={testing !== null && testing !== provider}
            onClick={() => void testConnection(provider)}
          >
            {testing === provider ? "测试中..." : isGemini ? "测试 Gemini 连接" : "测试 Anthropic 连接"}
          </Button>
        </Form.Item>
      </>
    );
  };

  return (
    <Panel padding={0}>
      {/* 操作条固定在面板顶部：保存 / 恢复默认 / 刷新始终在同一位置 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          padding: "12px 16px",
          borderBottom: `1px solid ${t.line}`,
        }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {!loaded && !loadError ? "等待后端就绪..." : "修改后点「保存配置」写入；主题切换即时生效"}
        </Typography.Text>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
          {/* 与改版前一致：配置加载完成前不可保存 / 恢复默认（原先由 Form disabled 连带禁用） */}
          <Button icon={<SyncOutlined />} onClick={reset} disabled={!loaded}>
            恢复默认
          </Button>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} disabled={!loaded} onClick={() => void save()}>
            保存配置
          </Button>
        </Space>
      </div>

      <div style={{ padding: 16 }}>
        {loadError ? (
          <Alert type="error" showIcon message="加载配置失败" description={loadError} style={{ marginBottom: 16 }} />
        ) : null}

        <Form<FormValues>
          form={form}
          layout="horizontal"
          labelAlign="left"
          labelCol={{ flex: "130px" }}
          wrapperCol={{ flex: "auto" }}
          initialValues={{ ...defaultFormValues(), data_dir: "" }}
          disabled={!loaded}
          style={{ maxWidth: 760 }}
        >
          <Section
            first
            title="AI Agent 配置（多提供商）"
            description="AI Agent 用于智能浏览器自动化任务（修改2SV手机、替换辅助邮箱等）"
          >
            <Form.Item name="ai_default_provider" label="默认提供商">
              <Select
                style={{ width: 200 }}
                options={[
                  { value: "gemini", label: "gemini" },
                  { value: "anthropic", label: "anthropic" },
                ]}
                onChange={(v: AiProviderName) => setProviderTab(v)}
              />
            </Form.Item>
            <Tabs
              activeKey={providerTab}
              onChange={(k) => setProviderTab(k as AiProviderName)}
              items={[
                { key: "gemini", label: "Gemini", forceRender: true, children: providerForm("gemini") },
                { key: "anthropic", label: "Anthropic / Claude", forceRender: true, children: providerForm("anthropic") },
              ]}
            />
            <NumberField name="ai_max_steps" label="最大步骤" />
          </Section>

          <Section
            title="Gmail 验证码邮箱"
            description="替换辅助邮箱功能用它收验证码；需在 Google 账号设置中生成「应用专用密码」"
          >
            <Form.Item name="gmail_imap_email" label="Gmail 邮箱">
              <Input placeholder="example@gmail.com" />
            </Form.Item>
            <Form.Item name="gmail_imap_password" label="应用密码">
              <Input.Password placeholder="应用专用密码（非登录密码）" autoComplete="off" />
            </Form.Item>
            <Form.Item label=" " colon={false} style={{ marginBottom: 0 }}>
              <Space size={4} wrap>
                <Hint>{`获取应用密码: ${APP_PASSWORDS_URL}`}</Hint>
                <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => void copyLink()} disabled={false}>
                  {copied ? "已复制" : "复制链接"}
                </Button>
              </Space>
            </Form.Item>
          </Section>

          <Section title="超时设置（秒）">
            <NumberField name="timeout_page_load" label="页面加载" />
            <NumberField name="timeout_status_check" label="状态检测" />
            <NumberField name="timeout_iframe_wait" label="Iframe 等待" />
          </Section>

          <Section title="操作延迟（秒）">
            <NumberField name="delay_after_login" label="登录后" />
            <NumberField name="delay_after_offer" label="Offer 后" />
            <NumberField name="delay_after_save" label="保存后" />
          </Section>

          <Section title="代理设置" description="批量创建窗口时，每个代理 IP 最多分配给指定数量的窗口">
            <NumberField name="proxy_max_windows_per_ip" label="每IP最大窗口数" />
          </Section>

          <Section title="其他设置">
            <NumberField name="default_thread_count" label="默认并发数" />
          </Section>

          <Section title="外观">
            <Form.Item name="theme" label="应用主题">
              {/* 切换主题立即生效，点「保存配置」才持久化 */}
              <Select
                style={{ width: 200 }}
                options={THEME_OPTIONS}
                onChange={(v: string) => setThemeMode(normalizeThemeMode(v))}
              />
            </Form.Item>
          </Section>

          <Section title="数据" description="数据目录点「应用」后立即写入，不需要再保存配置">
            <Form.Item label="数据目录">
              <Space.Compact style={{ width: "100%" }}>
                <Input
                  value={dataDirInput}
                  onChange={(e) => setDataDirInput(e.target.value)}
                  placeholder="未设置"
                  onPressEnter={() => void applyDataDir()}
                />
                <Button loading={applyingDir} onClick={() => void applyDataDir()}>
                  应用
                </Button>
              </Space.Compact>
            </Form.Item>
            <Form.Item name="data_separator" label="数据分隔符" style={{ marginBottom: 0 }}>
              <Input placeholder="账号文件字段分隔符" style={{ width: 200 }} />
            </Form.Item>
          </Section>
        </Form>
      </div>
    </Panel>
  );
}
