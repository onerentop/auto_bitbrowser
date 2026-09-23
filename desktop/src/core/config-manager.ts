/**
 * 配置管理器（Node 重写）
 * 对标 core/config_manager.py（832 行），逐字移植：DEFAULT_CONFIG、敏感字段清单、
 * _merge_config 合并规则、点号路径 get/set、load() 的明文迁移、全部 get_ai_* / set_ai_* 取值优先级。
 *
 * 与 Python 的刻意差异（其余一律照抄）：
 *   1. 单例形态：Python 是「类方法单例」（ConfigManager.get(...)，状态挂在类属性 _config 上）；
 *      TS 侧改为可实例化的 class + 默认单例 configManager + 模块级便捷函数委托单例。
 *      理由：可测试性（测试可注入独立的 configFile，互不污染）。
 *   2. 线程锁：Python 用 threading.RLock 保护 _config / 文件写入；Node 单线程事件循环下
 *      这里的所有操作都是同步的，不存在交叉执行点，故去掉锁，不引入任何等价物。
 *   3. 配置文件路径：Python 是 BASE_PATH/config.json（BASE_PATH = 仓库根，PyInstaller 打包时取 exe 目录）；
 *      TS 侧默认同样解析到仓库根的 config.json（本文件位于 desktop/src/core/ → 上溯三级），
 *      但构造参数 configFile 允许注入（测试用）。没有 sys.frozen 分支的等价物。
 *   4. 打印：Python 用 print()，这里用可注入的 log（默认 console.log），文案逐字保留。
 *   5. b64/UTF-8 解码的**异常语义**：Python 的 b64decode/decode('utf-8') 会抛异常从而
 *      走 `except: return value`；Node 的 Buffer 解码是静默容错的，为保持一致这里显式
 *      校验 base64 长度并用 TextDecoder({fatal:true}) 解码，让非法输入照样落到 catch。
 *
 * 加解密必须与 Python **字节级互通**（config.json 是两侧共用的同一个文件）：
 *   - XOR 作用在 **Unicode 码点** 上（Python 的 ord/chr），不是 UTF-8 字节。
 *     因此这里用 Array.from(value) 按码点切分（emoji 等星平面字符算 1 个字符，
 *     绝不能用 JS 的 UTF-16 code unit 逐个处理，否则密钥偏移量会与 Python 错位）。
 *   - **先 XOR 再 UTF-8 编码**，最后 base64：Buffer.from(obfuscated, "utf8").toString("base64")。
 *   - 解密是完全对称的逆过程；不以 "ENC:" 开头的值原样返回；任何异常都返回原值。
 *
 * 照搬的可疑行为（详见各处 ⚠ 注释）：见 mergeConfig 的浅拷贝别名、get() 返回内部对象引用、
 * getAiProviderApiKey 的二次解密。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 配置树里的任意值（Python 侧是 JSON 可序列化的任意对象） */
export type ConfigValue = unknown;

/** 配置字典 */
export type ConfigDict = Record<string, ConfigValue>;

export type LogFn = (message: string) => void;

/** 对标 get_base_path()：Python 取 core/ 的上一级 = 仓库根；本文件在 desktop/src/core/ 故上溯三级 */
export function getBasePath(): string {
  return path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
}

/** 对标 BASE_PATH */
export const BASE_PATH: string = getBasePath();

/** 对标 ConfigManager.CONFIG_FILE 的默认值 */
export function resolveDefaultConfigFile(): string {
  return path.join(BASE_PATH, "config.json");
}

/** 对标 _OBFUSCATION_KEY（混淆密钥，简单混淆，非高安全性加密） */
export const OBFUSCATION_KEY = "ixBrowser_AutoManager_2024";

/** 对标 _SENSITIVE_CONFIG_PATHS：需要加密保存的敏感字段路径 */
export const SENSITIVE_CONFIG_PATHS: readonly string[] = [
  "gmail_imap_password",
  "sub2api.password",
  "sub2api.admin_token",
  "sms_bus.token",
  "ai_agent.api_key",
];

/**
 * 对标 DEFAULT_CONFIG（默认配置模板），键与默认值逐条对齐。
 * ⚠ 与 Python 一样是**可变的共享对象**：mergeConfig 用浅拷贝，
 *   未被用户配置覆盖的嵌套子树仍然是这里的引用（见 mergeConfig 注释）。
 */
export const DEFAULT_CONFIG: ConfigDict = {
  default_thread_count: 3,
  timeouts: {
    page_load: 30,
    status_check: 20,
    iframe_wait: 15,
  },
  delays: {
    after_login: 3,
    after_offer: 8,
    after_save: 18,
  },
  card_rotation_index: 0,
  last_used_template_id: "",
  window_name_prefix: "",
  // 代理设置
  proxy: {
    max_windows_per_ip: 3, // 每个IP最大窗口数
  },
  // Sub2API 集成配置
  sub2api: {
    enabled: true,
    base_url: "https://sub2api.topren.top",
    username: "", // 用户名
    password: "", // 加密存储
    admin_token: "", // 登录后获取的 Token (加密存储)
    default_group: "claude_share",
  },
  // 账号管理配置
  account_manager: {
    login_concurrency: 3, // 并发登录数
    login_timeout: 120, // 登录超时（秒）
    login_max_retries: 2, // 登录最大重试次数（首次 + 重试）
    login_retry_delay: 3, // 重试间隔（秒）
    oauth_timeout: 180, // OAuth 超时（秒）
  },
  // SMS-Bus 接码平台配置
  sms_bus: {
    token: "", // API Token
    default_country_id: null, // 默认国家 ID (None = 自动选最便宜)
    default_project_id: null, // 默认服务 ID (None = Google)
    sms_timeout: 120, // 等待验证码超时（秒）
    sms_poll_interval: 5, // 轮询间隔（秒）
    max_retries: 2, // 总尝试次数（不是额外重试次数）
  },
  // AI Agent 配置 (多提供商支持)
  ai_agent: {
    // 默认提供商
    default_provider: "gemini",
    // 提供商配置
    providers: {
      gemini: {
        enabled: true,
        api_key: "",
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai/",
        model: "gemini-2.5-flash",
        timeout: 60,
      },
      anthropic: {
        enabled: true,
        api_key: "",
        base_url: "", // 留空使用官方 API，或填第三方兼容服务 URL
        model: "claude-sonnet-4-20250514",
        timeout: 60,
      },
    },
    // 通用配置
    max_steps: 25,
    max_tokens: 8192,
    // SoM (Set-of-Mark) 配置
    use_som: true, // 启用 SoM 元素标记
    compress_screenshot: false, // 压缩截图以减少 API 成本
    max_elements: 30, // 元素摘要最大元素数
    // 超时配置（毫秒）
    timeouts: {
      operation: 10000, // 单次操作超时
      navigation: 60000, // 页面导航超时
      network_idle: 5000, // 网络空闲等待
      api_call: 30000, // API 调用超时
    },
    // 延迟配置（秒）
    delays: {
      screenshot: 2.0, // 截图前等待
      after_click: 1.5, // 点击后等待
      after_navigate: 3.0, // 导航后等待
      min_page_stable: 0.3, // 最小页面稳定等待
    },
    // 重试配置
    retry: {
      max_retries: 3, // 最大重试次数
      base_delay: 1.0, // 基础重试延迟
      backoff_factor: 1.5, // 退避系数
    },
    // 验证码等待（秒）
    verification_timeout: 90,
    // 兼容性字段 (向后兼容)
    api_key: "",
    base_url: "",
    model: "",
  },
};

/** 对标 copy.deepcopy(DEFAULT_CONFIG) */
export function createDefaultConfig(): ConfigDict {
  return structuredClone(DEFAULT_CONFIG);
}

function isRecord(value: unknown): value is ConfigDict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ==================== 加解密（与 Python 字节级互通） ====================

/**
 * 模拟 Python base64.b64decode 的严格性：
 * 非法字符被丢弃，剩余长度不是 4 的倍数则抛异常（Python 抛 binascii.Error）。
 * Node 的 Buffer.from(s, "base64") 本身完全静默容错，不做这一步就会与 Python 的
 * `except: return value` 分支行为分叉。
 */
function pythonB64Decode(encoded: string): Buffer {
  const cleaned = encoded.replace(/[^A-Za-z0-9+/=]/g, "");
  if (cleaned.length % 4 !== 0) {
    throw new Error("Invalid base64-encoded string");
  }
  return Buffer.from(cleaned, "base64");
}

/** 与 Python 的 bytes.decode('utf-8') 一致：非法 UTF-8 抛异常而不是替换成 U+FFFD */
function strictUtf8Decode(buf: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(buf);
}

/** 按 Unicode 码点做 XOR 混淆（Python: chr(ord(c) ^ ord(KEY[i % len(KEY)]))） */
function xorByCodePoint(text: string): string {
  // Array.from 按码点切分，星平面字符（emoji）算 1 个字符，与 Python 的 enumerate 对齐
  const chars = Array.from(text);
  let out = "";
  for (let i = 0; i < chars.length; i += 1) {
    const cp = (chars[i] as string).codePointAt(0) as number;
    const keyChar = OBFUSCATION_KEY[i % OBFUSCATION_KEY.length] as string;
    out += String.fromCodePoint(cp ^ (keyChar.codePointAt(0) as number));
  }
  return out;
}

/** 对标 encrypt_sensitive()：简单加密敏感信息（base64 + 混淆） */
export function encryptSensitive(value: string): string {
  if (!value) {
    return "";
  }
  try {
    // 混淆
    const obfuscated = xorByCodePoint(value);
    // Base64 编码（注意：XOR 之后才做 UTF-8 编码）
    const encoded = Buffer.from(obfuscated, "utf8").toString("base64");
    return `ENC:${encoded}`;
  } catch {
    return value;
  }
}

/** 对标 decrypt_sensitive()：解密敏感信息 */
export function decryptSensitive(value: string): string {
  if (!value || !value.startsWith("ENC:")) {
    return value;
  }
  try {
    // 去掉前缀
    const encoded = value.slice(4);
    // Base64 解码
    const obfuscated = strictUtf8Decode(pythonB64Decode(encoded));
    // 反混淆
    return xorByCodePoint(obfuscated);
  } catch {
    return value;
  }
}

// ==================== ConfigManager ====================

export interface ConfigManagerOptions {
  /** 配置文件路径，默认 BASE_PATH/config.json（测试可注入） */
  configFile?: string;
  /** 日志输出，默认 console.log（对标 Python 的 print） */
  log?: LogFn;
}

export interface LlmConfigResult {
  provider: string;
  api_key: string;
  base_url: string;
  model: string;
  max_tokens: number;
  timeout: number;
}

/**
 * 配置管理器 —— 对标 Python 的 ConfigManager 类。
 * Python 是类方法单例；这里是普通类，模块底部导出默认单例 configManager。
 */
export class ConfigManager {
  /** 对标 CONFIG_FILE */
  readonly configFile: string;

  private readonly log: LogFn;

  /** 对标 _config（None 表示尚未加载） */
  private config: ConfigDict | null = null;

  constructor(options: ConfigManagerOptions = {}) {
    this.configFile = options.configFile ?? resolveDefaultConfigFile();
    this.log = options.log ?? ((msg: string) => console.log(msg));
  }

  // ---------- 敏感字段 ----------

  /** 对标 _is_sensitive_key_path()：判断是否为敏感配置路径 */
  static isSensitiveKeyPath(keyPath: string): boolean {
    if (SENSITIVE_CONFIG_PATHS.includes(keyPath)) {
      return true;
    }
    return keyPath.startsWith("ai_agent.providers.") && keyPath.endsWith(".api_key");
  }

  /** 实例转发，便于子类/测试覆盖 */
  isSensitiveKeyPath(keyPath: string): boolean {
    return ConfigManager.isSensitiveKeyPath(keyPath);
  }

  // ---------- 加载 / 保存 ----------

  /** 对标 load()：加载配置，不存在则创建默认配置 */
  load(): ConfigDict {
    if (this.config !== null) {
      // Python 是 dict.copy()（浅拷贝），嵌套子树仍与内部状态共享
      return { ...this.config };
    }

    let needSave = false;

    if (fs.existsSync(this.configFile)) {
      try {
        const raw = fs.readFileSync(this.configFile, "utf-8");
        const parsed: unknown = JSON.parse(raw);
        this.config = parsed as ConfigDict;
        // 合并默认配置（处理新增字段）
        this.config = ConfigManager.mergeConfig(DEFAULT_CONFIG, this.config);
      } catch (e) {
        this.log(`[ConfigManager] 加载配置失败: ${errText(e)}，使用默认配置`);
        this.config = createDefaultConfig();
        needSave = true;
      }
    } else {
      this.config = createDefaultConfig();
      needSave = true;
    }

    // 兼容历史明文配置：自动迁移为加密存储
    if (this.migrateLegacySensitiveFields()) {
      needSave = true;
    }

    if (needSave) {
      this.saveInternal();
    }

    return { ...this.config };
  }

  /**
   * 对标 _merge_config()：递归合并配置，保留现有值，添加新字段。
   * ⚠ 照搬 Python 的浅拷贝语义：`result = default.copy()` 之后，凡是 current 里
   *   没有出现的嵌套 dict，result 持有的是 DEFAULT_CONFIG 里那棵子树的**引用**，
   *   后续 set() 写入会顺带改到 DEFAULT_CONFIG。Python 侧存在同样的别名问题，
   *   这里不做修正以保证行为一致。
   */
  static mergeConfig(defaults: ConfigDict, current: ConfigDict): ConfigDict {
    const result: ConfigDict = { ...defaults };
    for (const [key, value] of Object.entries(current)) {
      if (key in result) {
        const existing = result[key];
        if (isRecord(existing) && isRecord(value)) {
          result[key] = ConfigManager.mergeConfig(existing, value);
        } else {
          result[key] = value;
        }
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /** 对标 save()：保存配置到文件 */
  save(config?: ConfigDict | null): void {
    if (config !== undefined && config !== null) {
      this.config = config;
    }
    // 保存前再次兜底迁移，避免外部通过 set() 直接写入明文
    this.migrateLegacySensitiveFields();
    this.saveInternal();
  }

  /** 对标 _save_internal()（Python 需在锁内调用，Node 无锁） */
  private saveInternal(): void {
    try {
      // 对标 json.dump(..., ensure_ascii=False, indent=2)
      fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2), "utf-8");
    } catch (e) {
      this.log(`[ConfigManager] 保存配置失败: ${errText(e)}`);
    }
  }

  /** 对标 reload()：强制重新加载配置 */
  reload(): ConfigDict {
    this.config = null;
    return this.load();
  }

  // ---------- 点号路径读写 ----------

  /**
   * 对标 get()：获取配置项，支持嵌套 key
   * 例如: configManager.get("timeouts.page_load", 30)
   *
   * 差异：Python 的 default 形参默认 None，这里默认 null（JSON 语义一致）。
   * ⚠ 与 Python 一样返回**内部对象的引用**（不深拷贝），调用方修改会直接改到配置树。
   */
  get(key: string, defaultValue: ConfigValue = null): ConfigValue {
    const config = this.load();
    const keys = key.split(".");
    let value: ConfigValue = config;

    for (const k of keys) {
      // Python: dict 缺键抛 KeyError、非 dict 下标抛 TypeError，两者都落到 default
      if (!isRecord(value) || !(k in value)) {
        return defaultValue;
      }
      value = value[k];
    }

    if (typeof value === "string" && this.isSensitiveKeyPath(key)) {
      return decryptSensitive(value);
    }
    return value;
  }

  /**
   * 对标 set()：设置配置项，支持嵌套 key
   * 例如: configManager.set("timeouts.page_load", 30)
   *
   * 差异：Python 在中间层是标量时（`k not in 5`）抛 TypeError；这里显式抛 Error 对齐。
   */
  set(key: string, value: ConfigValue): void {
    if (this.config === null) {
      this.load();
    }

    const keys = key.split(".");
    let config = this.config as ConfigDict;

    // 遍历到倒数第二层
    for (const k of keys.slice(0, -1)) {
      if (!(k in config)) {
        config[k] = {};
      }
      const next = config[k];
      if (!isRecord(next)) {
        throw new TypeError(`[ConfigManager] 配置路径 ${key} 的中间节点 ${k} 不是对象`);
      }
      config = next;
    }

    // 设置最后一层的值
    config[keys[keys.length - 1] as string] = value;
    // 若设置的是敏感字段，立即转为加密存储
    this.migrateLegacySensitiveFields();
    this.saveInternal();
  }

  /** 对标 _get_nested_value()：获取嵌套配置值（内部方法） */
  private getNestedValue(keyPath: string): ConfigValue {
    if (this.config === null) {
      return null;
    }
    let current: ConfigValue = this.config;
    for (const key of keyPath.split(".")) {
      if (!isRecord(current) || !(key in current)) {
        return null;
      }
      current = current[key];
    }
    return current;
  }

  /** 对标 _set_nested_value()：设置嵌套配置值（内部方法，中间层非 dict 直接覆盖为 {}） */
  private setNestedValue(keyPath: string, value: ConfigValue): void {
    if (this.config === null) {
      this.config = createDefaultConfig();
    }

    const keys = keyPath.split(".");
    let current = this.config;
    for (const key of keys.slice(0, -1)) {
      const next = current[key];
      if (!(key in current) || !isRecord(next)) {
        current[key] = {};
      }
      current = current[key] as ConfigDict;
    }
    current[keys[keys.length - 1] as string] = value;
  }

  /** 对标 _collect_sensitive_paths()：收集需要加密的敏感字段路径 */
  private collectSensitivePaths(): string[] {
    const paths = new Set<string>(SENSITIVE_CONFIG_PATHS);

    const providers = this.getNestedValue("ai_agent.providers");
    if (isRecord(providers)) {
      for (const providerName of Object.keys(providers)) {
        paths.add(`ai_agent.providers.${providerName}.api_key`);
      }
    }

    return [...paths].sort();
  }

  /** 对标 _migrate_legacy_sensitive_fields()：将历史明文敏感字段迁移为加密存储，返回是否发生迁移 */
  private migrateLegacySensitiveFields(): boolean {
    if (this.config === null) {
      return false;
    }

    const migratedFields: string[] = [];
    for (const keyPath of this.collectSensitivePaths()) {
      const value = this.getNestedValue(keyPath);
      if (typeof value !== "string" || !value) {
        continue;
      }
      if (value.startsWith("ENC:")) {
        continue;
      }

      const encrypted = encryptSensitive(value);
      if (encrypted && encrypted !== value) {
        this.setNestedValue(keyPath, encrypted);
        migratedFields.push(keyPath);
      }
    }

    if (migratedFields.length > 0) {
      // 只打印字段路径，不打印值
      this.log(`[ConfigManager] 已迁移明文敏感字段: ${migratedFields.join(", ")}`);
      return true;
    }
    return false;
  }

  /** 对标 encrypt_sensitive()（类方法转发） */
  encryptSensitive(value: string): string {
    return encryptSensitive(value);
  }

  /** 对标 decrypt_sensitive()（类方法转发） */
  decryptSensitive(value: string): string {
    return decryptSensitive(value);
  }

  // ============ AI Agent 配置方法 ============

  /** 对标 get_ai_default_provider() */
  getAiDefaultProvider(): string {
    return this.get("ai_agent.default_provider", "gemini") as string;
  }

  /** 对标 set_ai_default_provider() */
  setAiDefaultProvider(provider: string): void {
    this.set("ai_agent.default_provider", provider);
  }

  /**
   * 对标 get_ai_provider_config()：获取指定提供商的配置（provider 为空则用默认提供商）
   * ⚠ 无 api_key 时返回的是内部对象引用（与 Python 的 cls.get 一致）；
   *   有 api_key 时才浅拷贝一份并解密。
   * 差异：路径上的值不是 dict 时 Python 会 AttributeError，这里返回 {}。
   */
  getAiProviderConfig(provider?: string | null): ConfigDict {
    const name = provider ? provider : this.getAiDefaultProvider();

    const raw = this.get(`ai_agent.providers.${name}`, {});
    let config: ConfigDict = isRecord(raw) ? raw : {};

    // 解密 API Key
    if (config["api_key"]) {
      config = { ...config };
      config["api_key"] = decryptSensitive(String(config["api_key"]));
    }

    return config;
  }

  /** 对标 set_ai_provider_config()：设置指定提供商的配置（api_key 加密存储） */
  setAiProviderConfig(provider: string, config: ConfigDict): void {
    let next = config;
    // 加密 API Key
    if (next["api_key"]) {
      next = { ...next };
      next["api_key"] = encryptSensitive(String(next["api_key"]));
    }

    this.set(`ai_agent.providers.${provider}`, next);
  }

  /**
   * 对标 get_ai_provider_api_key()：获取指定提供商的解密后 API Key
   * ⚠ 照搬 Python 的二次解密：该路径已被 get() 判定为敏感并解密过一次，
   *   这里再 decrypt 一次对非 ENC: 值是幂等的（无害），保留以对齐。
   */
  getAiProviderApiKey(provider?: string | null): string {
    const name = provider ? provider : this.getAiDefaultProvider();

    const encrypted = this.get(`ai_agent.providers.${name}.api_key`, "") as string;
    return decryptSensitive(encrypted);
  }

  /** 对标 set_ai_provider_api_key()：设置指定提供商的 API Key（加密存储） */
  setAiProviderApiKey(provider: string, apiKey: string): void {
    const encrypted = encryptSensitive(apiKey);
    this.set(`ai_agent.providers.${provider}.api_key`, encrypted);
  }

  /** 对标 get_ai_provider_base_url() */
  getAiProviderBaseUrl(provider?: string | null): string {
    const name = provider ? provider : this.getAiDefaultProvider();

    return this.get(`ai_agent.providers.${name}.base_url`, "") as string;
  }

  /** 对标 set_ai_provider_base_url() */
  setAiProviderBaseUrl(provider: string, baseUrl: string): void {
    this.set(`ai_agent.providers.${provider}.base_url`, baseUrl);
  }

  /** 对标 get_ai_provider_model() */
  getAiProviderModel(provider?: string | null): string {
    const name = provider ? provider : this.getAiDefaultProvider();

    return this.get(`ai_agent.providers.${name}.model`, "") as string;
  }

  /** 对标 set_ai_provider_model() */
  setAiProviderModel(provider: string, model: string): void {
    this.set(`ai_agent.providers.${provider}.model`, model);
  }

  /** 对标 is_ai_provider_enabled() */
  isAiProviderEnabled(provider: string): boolean {
    return this.get(`ai_agent.providers.${provider}.enabled`, false) as boolean;
  }

  /** 对标 set_ai_provider_enabled() */
  setAiProviderEnabled(provider: string, enabled: boolean): void {
    this.set(`ai_agent.providers.${provider}.enabled`, enabled);
  }

  /** 对标 get_enabled_ai_providers()：获取所有启用的提供商列表 */
  getEnabledAiProviders(): string[] {
    const providers = this.get("ai_agent.providers", {});
    if (!isRecord(providers)) {
      return [];
    }
    return Object.entries(providers)
      .filter(([, config]) => (isRecord(config) ? Boolean(config["enabled"]) : false))
      .map(([name]) => name);
  }

  /**
   * 对标 get_ai_api_key()：获取解密后的 AI Agent API Key（向后兼容）
   * 优先使用默认提供商的 API Key，兼容旧的单一配置
   */
  getAiApiKey(): string {
    // 先尝试新的多提供商配置
    const provider = this.getAiDefaultProvider();
    const key = this.getAiProviderApiKey(provider);
    if (key) {
      return key;
    }

    // 兼容旧配置
    const encrypted = this.get("ai_agent.api_key", "") as string;
    return decryptSensitive(encrypted);
  }

  /**
   * 对标 set_ai_api_key()：加密保存 AI Agent API Key（向后兼容）
   * 同时更新默认提供商和兼容字段
   */
  setAiApiKey(apiKey: string): void {
    const encrypted = encryptSensitive(apiKey);
    // 更新默认提供商
    const provider = this.getAiDefaultProvider();
    this.set(`ai_agent.providers.${provider}.api_key`, encrypted);
    // 兼容字段
    this.set("ai_agent.api_key", encrypted);
  }

  /** 对标 get_ai_base_url()：获取 AI Agent Base URL（向后兼容） */
  getAiBaseUrl(): string {
    // 先尝试新的多提供商配置
    const provider = this.getAiDefaultProvider();
    const url = this.getAiProviderBaseUrl(provider);
    if (url) {
      return url;
    }

    // 兼容旧配置
    return this.get("ai_agent.base_url", "") as string;
  }

  /** 对标 set_ai_base_url()：设置 AI Agent Base URL（向后兼容） */
  setAiBaseUrl(baseUrl: string): void {
    // 更新默认提供商
    const provider = this.getAiDefaultProvider();
    this.set(`ai_agent.providers.${provider}.base_url`, baseUrl);
    // 兼容字段
    this.set("ai_agent.base_url", baseUrl);
  }

  /** 对标 get_ai_model()：获取 AI Agent 模型名称（向后兼容） */
  getAiModel(): string {
    // 先尝试新的多提供商配置
    const provider = this.getAiDefaultProvider();
    const model = this.getAiProviderModel(provider);
    if (model) {
      return model;
    }

    // 兼容旧配置
    return this.get("ai_agent.model", "gemini-2.5-flash") as string;
  }

  /** 对标 set_ai_model()：设置 AI Agent 模型名称（向后兼容） */
  setAiModel(model: string): void {
    // 更新默认提供商
    const provider = this.getAiDefaultProvider();
    this.set(`ai_agent.providers.${provider}.model`, model);
    // 兼容字段
    this.set("ai_agent.model", model);
  }

  /** 对标 get_ai_max_steps() */
  getAiMaxSteps(): number {
    return this.get("ai_agent.max_steps", 25) as number;
  }

  /** 对标 set_ai_max_steps() */
  setAiMaxSteps(maxSteps: number): void {
    this.set("ai_agent.max_steps", maxSteps);
  }

  /** 对标 get_ai_max_tokens() */
  getAiMaxTokens(): number {
    return this.get("ai_agent.max_tokens", 8192) as number;
  }

  /** 对标 set_ai_max_tokens() */
  setAiMaxTokens(maxTokens: number): void {
    this.set("ai_agent.max_tokens", maxTokens);
  }

  /** 对标 get_llm_config()：获取用于创建 LLM 实例的配置 */
  getLlmConfig(provider?: string | null): LlmConfigResult {
    const name = provider ? provider : this.getAiDefaultProvider();

    const providerConfig = this.getAiProviderConfig(name);

    return {
      provider: name,
      api_key: (providerConfig["api_key"] ?? "") as string,
      base_url: (providerConfig["base_url"] ?? "") as string,
      model: (providerConfig["model"] ?? "") as string,
      max_tokens: this.getAiMaxTokens(),
      timeout: (providerConfig["timeout"] ?? 60) as number,
    };
  }

  // ============ Gmail IMAP 配置方法 ============

  /** 对标 get_gmail_imap_email()：获取 Gmail IMAP 邮箱（用于接收验证码） */
  getGmailImapEmail(): string {
    return this.get("gmail_imap_email", "") as string;
  }

  /** 对标 set_gmail_imap_email() */
  setGmailImapEmail(email: string): void {
    this.set("gmail_imap_email", email);
  }

  /** 对标 get_gmail_imap_password()：获取 Gmail IMAP 应用密码 */
  getGmailImapPassword(): string {
    const encrypted = this.get("gmail_imap_password", "") as string;
    return decryptSensitive(encrypted);
  }

  /** 对标 set_gmail_imap_password()：设置 Gmail IMAP 应用密码 */
  setGmailImapPassword(password: string): void {
    const encrypted = encryptSensitive(password);
    this.set("gmail_imap_password", encrypted);
  }

  // ============ 账号管理配置方法 ============

  /** 对标 get_login_concurrency()：获取并发登录数 */
  getLoginConcurrency(): number {
    return this.get("account_manager.login_concurrency", 3) as number;
  }

  /** 对标 set_login_concurrency() */
  setLoginConcurrency(concurrency: number): void {
    this.set("account_manager.login_concurrency", concurrency);
  }

  /** 对标 get_login_timeout()：获取登录超时时间（秒） */
  getLoginTimeout(): number {
    return this.get("account_manager.login_timeout", 120) as number;
  }

  /** 对标 set_login_timeout() */
  setLoginTimeout(timeout: number): void {
    this.set("account_manager.login_timeout", timeout);
  }

  /** 对标 get_login_max_retries()：获取登录最大重试次数 */
  getLoginMaxRetries(): number {
    return this.get("account_manager.login_max_retries", 2) as number;
  }

  /** 对标 set_login_max_retries() */
  setLoginMaxRetries(retries: number): void {
    this.set("account_manager.login_max_retries", retries);
  }

  /** 对标 get_login_retry_delay()：获取登录重试间隔（秒） */
  getLoginRetryDelay(): number {
    return this.get("account_manager.login_retry_delay", 3) as number;
  }

  /** 对标 set_login_retry_delay() */
  setLoginRetryDelay(delay: number): void {
    this.set("account_manager.login_retry_delay", delay);
  }

}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ==================== 默认单例 + 模块级便捷函数 ====================

/** 默认单例，等价于 Python 的「类方法单例」用法 */
export const configManager = new ConfigManager();

/** 对标 ConfigManager.load() */
export function load(): ConfigDict {
  return configManager.load();
}

/** 对标 ConfigManager.save() */
export function save(config?: ConfigDict | null): void {
  configManager.save(config);
}

/** 对标 ConfigManager.get() */
export function get(key: string, defaultValue: ConfigValue = null): ConfigValue {
  return configManager.get(key, defaultValue);
}

/** 对标 ConfigManager.set() */
export function set(key: string, value: ConfigValue): void {
  configManager.set(key, value);
}

/** 对标 ConfigManager.reload() */
export function reload(): ConfigDict {
  return configManager.reload();
}

/** 对标模块级便捷函数 get_config() */
export function getConfig(key: string, defaultValue: ConfigValue = null): ConfigValue {
  return configManager.get(key, defaultValue);
}

/** 对标模块级便捷函数 set_config() */
export function setConfig(key: string, value: ConfigValue): void {
  configManager.set(key, value);
}
