/**
 * Stagehand 模型配置解析 —— 对标 core/stagehand_engine/config.py
 *
 * 为什么需要：Python 的 StagehandGoogleEngine 在 model_name / api_key 未显式传入时，
 * 会经 get_stagehand_config() 依次回落到 ConfigManager → 环境变量 → 默认模型。
 * 早期 Node 移植的 connectEngine 缺了这一层，调用方不传参数时会以空 model/key 连 Stagehand
 * （Python 的 auto_google_login / auto_enable_family_sharing 明确「AI 配置从 ConfigManager 读取」）。
 *
 * Node 没有 ConfigManager 全局单例（打开哪份 config.json 由宿主决定），
 * 所以「ConfigManager 来源」改为可注册的 provider：后端进程启动时用 ctx.config() 注册一次。
 * 未注册时等价 Python 的 CONFIG_MANAGER_AVAILABLE=False（只看环境变量）。
 */

/** 对标 DEFAULT_MODEL_NAME */
export const DEFAULT_MODEL_NAME = "google/gemini-2.0-flash";

/** 对标 DEFAULT_MODELS */
export const DEFAULT_MODELS: Readonly<Record<string, string>> = {
  google: "gemini-2.0-flash",
  anthropic: "claude-3-5-sonnet",
  openai: "gpt-4o",
};

/** 对标 PROVIDER_MAP（ConfigManager 格式 → Stagehand 格式） */
export const STAGEHAND_PROVIDER_MAP: Readonly<Record<string, string>> = {
  gemini: "google",
  anthropic: "anthropic",
  openai: "openai",
};

/** 对标 StagehandModelConfig */
export interface StagehandModelConfig {
  modelName: string;
  apiKey: string | null;
  baseUrl: string | null;
}

/** ConfigManager 需要提供的四个读取方法（ConfigManager 本身即满足） */
export interface StagehandConfigSource {
  getAiDefaultProvider(): string | null | undefined;
  getAiProviderApiKey(provider: string): string | null | undefined;
  getAiProviderBaseUrl(provider: string): string | null | undefined;
  getAiProviderModel(provider: string): string | null | undefined;
}

let registeredSource: (() => StagehandConfigSource | null) | null = null;

/**
 * 注册「ConfigManager 来源」。传 null 取消注册。
 * 用工厂而不是实例：宿主的 ConfigManager 是惰性创建的，注册时不必立刻打开配置文件。
 */
export function registerStagehandConfigSource(source: (() => StagehandConfigSource | null) | null): void {
  registeredSource = source;
}

type Log = (message: string) => void;

/** 对标 get_config_from_manager()：未注册、未设默认提供商、无 key 或读取异常时返回 null */
export function getConfigFromManager(
  source: StagehandConfigSource | null = registeredSource?.() ?? null,
  log: Log = () => {},
): StagehandModelConfig | null {
  if (!source) return null;
  try {
    const provider = source.getAiDefaultProvider();
    if (!provider) {
      log("ConfigManager 中未设置默认 AI 提供商");
      return null;
    }
    const apiKey = source.getAiProviderApiKey(provider);
    if (!apiKey) {
      log(`ConfigManager 中 ${provider} 提供商未配置 API Key`);
      return null;
    }
    const baseUrl = source.getAiProviderBaseUrl(provider) || null;
    const model = source.getAiProviderModel(provider);
    const stagehandProvider = STAGEHAND_PROVIDER_MAP[provider] ?? provider;
    const modelName = model
      ? `${stagehandProvider}/${model}`
      : `${stagehandProvider}/${DEFAULT_MODELS[stagehandProvider] ?? "gemini-2.0-flash"}`;
    log(`从 ConfigManager 加载 AI 配置: ${modelName}`);
    return { modelName, apiKey, baseUrl };
  } catch (error) {
    log(`读取 ConfigManager 配置失败: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** 对标 get_config_from_env()：MODEL_API_KEY / MODEL_NAME / MODEL_BASE_URL */
export function getConfigFromEnv(env: Record<string, string | undefined> = process.env): StagehandModelConfig | null {
  const apiKey = env["MODEL_API_KEY"];
  if (!apiKey) return null;
  return {
    modelName: env["MODEL_NAME"] ?? DEFAULT_MODEL_NAME,
    apiKey,
    baseUrl: env["MODEL_BASE_URL"] ?? null,
  };
}

export interface GetStagehandConfigOptions {
  modelName?: string | null;
  apiKey?: string | null;
  baseUrl?: string | null;
  useConfigManager?: boolean;
  useEnv?: boolean;
  /** 测试注入：覆盖已注册的来源 */
  source?: StagehandConfigSource | null;
  env?: Record<string, string | undefined>;
  log?: Log;
}

/**
 * 对标 get_stagehand_config()：优先级 显式参数 > ConfigManager > 环境变量 > 默认模型。
 * 各字段独立回落（Python 用 `if not final_x`，空串也视为缺失）。
 */
export function getStagehandConfig(options: GetStagehandConfigOptions = {}): StagehandModelConfig {
  const useConfigManager = options.useConfigManager ?? true;
  const useEnv = options.useEnv ?? true;

  const mgr = useConfigManager
    ? getConfigFromManager(options.source !== undefined ? options.source : (registeredSource?.() ?? null), options.log)
    : null;
  const envCfg = useEnv ? getConfigFromEnv(options.env) : null;

  let modelName = options.modelName || null;
  let apiKey = options.apiKey || null;
  let baseUrl = options.baseUrl || null;

  if (mgr) {
    modelName ||= mgr.modelName;
    apiKey ||= mgr.apiKey;
    baseUrl ||= mgr.baseUrl;
  }
  if (envCfg) {
    modelName ||= envCfg.modelName;
    apiKey ||= envCfg.apiKey;
    baseUrl ||= envCfg.baseUrl;
  }
  return { modelName: modelName || DEFAULT_MODEL_NAME, apiKey, baseUrl };
}
