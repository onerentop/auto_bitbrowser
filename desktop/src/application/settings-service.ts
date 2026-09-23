/**
 * 设置页应用服务（Node 重写）
 * 对标 application/settings_service.py
 *
 * 与 Python 的差异：
 *   - Python 是静态方法 + 全局 ConfigManager；这里注入 ConfigManager 实例。
 *   - save：Python 每个 ConfigManager.set() 都会写一次盘（core/config_manager.py:234-256），
 *     共写 20 余次；这里在配置树的深拷贝上一次性改完，再 save() 只落盘一次。
 *     写入的键、值、加密方式与 Python 逐条一致。
 *   - load：Python 调 ConfigManager.load()（有缓存）；这里用 reload() 重读磁盘，
 *     让「刷新」能看到外部（例如同时运行的 Python 版）对 config.json 的修改。
 *     ConfigManager 的每次写入都已立即落盘，重读不会丢数据。
 */
import { encryptSensitive, type ConfigDict, type ConfigManager } from "../core/config-manager.ts";

/** 设置快照 —— 对标 SettingsSnapshot（application/settings_service.py:16） */
export interface SettingsSnapshot {
  ai_default_provider: string;
  gemini_api_key: string;
  gemini_base_url: string;
  gemini_model: string;
  anthropic_api_key: string;
  anthropic_base_url: string;
  anthropic_model: string;
  ai_max_steps: number;
  gmail_imap_email: string;
  gmail_imap_password: string;
  timeout_page_load: number;
  timeout_status_check: number;
  timeout_iframe_wait: number;
  delay_after_login: number;
  delay_after_offer: number;
  delay_after_save: number;
  proxy_max_windows_per_ip: number;
  default_thread_count: number;
  theme: string;
  data_dir: string;
  data_separator: string;
}

/** 配置文件里的值可能被手工改坏：非字符串按空串处理 */
function str(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

/** 非有限数字回退到默认值（Python 直接把原值塞进 SpinBox） */
function num(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function isRecord(value: unknown): value is ConfigDict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 在配置树上按点号路径写值（中间层不是对象时覆盖为 {}） */
function setPath(root: ConfigDict, keyPath: string, value: unknown): void {
  const keys = keyPath.split(".");
  let cur = root;
  for (const k of keys.slice(0, -1)) {
    const next = cur[k];
    if (!isRecord(next)) cur[k] = {};
    cur = cur[k] as ConfigDict;
  }
  cur[keys[keys.length - 1] as string] = value;
}

export class SettingsService {
  private readonly config: ConfigManager;

  constructor(config: ConfigManager) {
    this.config = config;
  }

  /**
   * 对标 resolve_provider_runtime_config（settings_service.py:53-64）：
   * 界面输入 strip 后非空就用输入，否则回退到已保存配置。
   */
  resolveProviderRuntimeConfig(
    provider: string,
    apiKeyInput: string,
    baseUrlInput: string,
    modelInput: string,
  ): [apiKey: string, baseUrl: string, model: string] {
    const name = provider.trim().toLowerCase();
    const apiKey = apiKeyInput.trim() || str(this.config.getAiProviderApiKey(name));
    const baseUrl = baseUrlInput.trim() || str(this.config.getAiProviderBaseUrl(name));
    const model = modelInput.trim() || str(this.config.getAiProviderModel(name));
    return [apiKey, baseUrl, model];
  }

  /** 对标 load_settings_snapshot（settings_service.py:67-93） */
  loadSettingsSnapshot(): SettingsSnapshot {
    const c = this.config;
    c.reload();
    return {
      ai_default_provider: str(c.getAiDefaultProvider(), "gemini"),
      gemini_api_key: str(c.getAiProviderApiKey("gemini")),
      gemini_base_url: str(c.getAiProviderBaseUrl("gemini")),
      gemini_model: str(c.getAiProviderModel("gemini")),
      anthropic_api_key: str(c.getAiProviderApiKey("anthropic")),
      anthropic_base_url: str(c.getAiProviderBaseUrl("anthropic")),
      anthropic_model: str(c.getAiProviderModel("anthropic")),
      ai_max_steps: num(c.getAiMaxSteps(), 25),
      gmail_imap_email: str(c.get("gmail_imap_email", "")),
      gmail_imap_password: str(c.getGmailImapPassword()),
      timeout_page_load: num(c.get("timeouts.page_load", 30), 30),
      timeout_status_check: num(c.get("timeouts.status_check", 20), 20),
      timeout_iframe_wait: num(c.get("timeouts.iframe_wait", 15), 15),
      delay_after_login: num(c.get("delays.after_login", 3), 3),
      delay_after_offer: num(c.get("delays.after_offer", 8), 8),
      delay_after_save: num(c.get("delays.after_save", 18), 18),
      proxy_max_windows_per_ip: num(c.get("proxy.max_windows_per_ip", 3), 3),
      default_thread_count: num(c.get("default_thread_count", 3), 3),
      theme: str(c.get("theme", "auto"), "auto"),
      data_dir: str(c.get("data_dir", "")),
      data_separator: str(c.get("data_separator", "----"), "----"),
    };
  }

  /**
   * 对标 save_settings_snapshot（settings_service.py:96-128），只落盘一次。
   *
   * 注意 data_dir 不在这里写（Python 同样不写，它由 set_data_dir 单独立即写入）。
   * 字段的 strip 由界面层负责（照搬 setting_interface.py:619-641），
   * 但 data_separator 在这里再 strip 一次，保证任何调用方都不会存进首尾空白。
   */
  saveSettingsSnapshot(s: SettingsSnapshot): void {
    // 先 reload() 重读磁盘再改：否则缓存比磁盘旧时，整树回写会把外部（例如同时运行的
    // Python 版）写入的表单外键（sub2api.admin_token 等）覆盖成旧值。
    const tree = structuredClone(this.config.reload());

    setPath(tree, "ai_agent.default_provider", s.ai_default_provider);

    // 保持兼容行为：输入为空时不覆盖已保存 API Key（settings_service.py:100-102）
    if (s.gemini_api_key) {
      setPath(tree, "ai_agent.providers.gemini.api_key", encryptSensitive(s.gemini_api_key));
    }
    setPath(tree, "ai_agent.providers.gemini.base_url", s.gemini_base_url);
    setPath(tree, "ai_agent.providers.gemini.model", s.gemini_model);

    if (s.anthropic_api_key) {
      setPath(tree, "ai_agent.providers.anthropic.api_key", encryptSensitive(s.anthropic_api_key));
    }
    setPath(tree, "ai_agent.providers.anthropic.base_url", s.anthropic_base_url);
    setPath(tree, "ai_agent.providers.anthropic.model", s.anthropic_model);

    setPath(tree, "ai_agent.max_steps", s.ai_max_steps);

    setPath(tree, "gmail_imap_email", s.gmail_imap_email);
    // 照搬 settings_service.py:114：应用密码**无条件**写入 —— 输入框为空会清空已保存的密码。
    // 这与上面 API Key「为空不覆盖」不一致，但属于 Python 原有行为，保持一致。
    setPath(tree, "gmail_imap_password", encryptSensitive(s.gmail_imap_password));

    setPath(tree, "timeouts.page_load", s.timeout_page_load);
    setPath(tree, "timeouts.status_check", s.timeout_status_check);
    setPath(tree, "timeouts.iframe_wait", s.timeout_iframe_wait);

    setPath(tree, "delays.after_login", s.delay_after_login);
    setPath(tree, "delays.after_offer", s.delay_after_offer);
    setPath(tree, "delays.after_save", s.delay_after_save);

    setPath(tree, "proxy.max_windows_per_ip", s.proxy_max_windows_per_ip);
    setPath(tree, "default_thread_count", s.default_thread_count);
    setPath(tree, "theme", s.theme);
    setPath(tree, "data_separator", s.data_separator.trim());

    this.config.save(tree);
  }

  /** 只读主题（与 loadSettingsSnapshot 的 theme 取值一致），供启动时 theme-init 使用 */
  getTheme(): string {
    this.config.reload();
    return str(this.config.get("theme", "auto"), "auto");
  }

  /** 对标 set_data_dir（settings_service.py:131-133）：立即写入 */
  setDataDir(path: string): void {
    this.config.set("data_dir", path);
  }
}
