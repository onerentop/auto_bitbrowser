/**
 * automation 层共享辅助
 *
 * 对标 Python 各 auto_*.py 里重复出现的那段样板：
 *   provider → 模型名映射、连接 ixBrowser、try/finally 清理。
 * Python 侧是复制粘贴到每个文件的，这里抽成一处，行为保持一致。
 */
import { StagehandGoogleEngine } from "../engine/stagehand-engine.ts";
import { getStagehandConfig } from "../engine/stagehand-config.ts";

/** provider 名称到 Stagehand 模型前缀的映射（Python 各文件里重复定义的那张表） */
export const PROVIDER_MAP: Record<string, string> = {
  gemini: "google",
  anthropic: "anthropic",
};

/**
 * 构建 Stagehand 模型名。
 * 有 provider 时拼成 "provider/model"，否则原样使用 model。
 */
export function buildModelName(
  model?: string | null,
  provider?: string | null,
): string | null {
  if (!model) return null;
  if (provider) {
    const mapped = PROVIDER_MAP[provider] ?? provider;
    return `${mapped}/${model}`;
  }
  return model;
}

/** 所有 auto_* 函数共用的入参尾部 */
export interface CommonOptions {
  closeAfter?: boolean;
  maxSteps?: number;
  apiKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  provider?: string | null;
}

/** 连接参数 */
export interface ConnectOptions extends CommonOptions {
  /** 兜底模型名：调用方未传 model 时使用（Python 侧由 ConfigManager 提供） */
  defaultModel?: string | null;
  /** 兜底 API key */
  defaultApiKey?: string | null;
}

/**
 * 连接 ixBrowser 窗口并返回引擎。
 * 对应 Python 里每个 auto_* 函数开头那段「构建 model_name + connect_to_ixbrowser」。
 *
 * model / key 的回落顺序对标 Python StagehandGoogleEngine.__init__ → get_stagehand_config()：
 *   显式参数 → 调用方给的 default* → ConfigManager（宿主注册的来源）→ 环境变量 → 默认模型。
 * 早期版本在这里直接用空串兜底，调用方不传参数时会以空 model/key 连 Stagehand。
 */
export async function connectEngine(
  browserId: string | number,
  options: ConnectOptions,
): Promise<StagehandGoogleEngine> {
  const resolved = getStagehandConfig({
    modelName: buildModelName(options.model, options.provider) ?? options.defaultModel ?? null,
    apiKey: options.apiKey ?? options.defaultApiKey ?? null,
  });
  if (!resolved.apiKey) {
    // 对标 Python engine.py:163-167 的告警（Python 也只告警不抛错）
    process.stderr.write(
      "[automation] 未配置 API Key。请在设置界面配置 AI Agent，或传入 apiKey 参数，或设置环境变量 MODEL_API_KEY\n",
    );
  }

  return StagehandGoogleEngine.connectToIxBrowser(browserId, {
    modelName: resolved.modelName,
    apiKey: resolved.apiKey ?? "",
    closeBrowserOnExit: options.closeAfter ?? false,
  });
}

/** 打印与 Python 一致的启动横幅 */
export function printBanner(title: string, lines: string[]): void {
  const bar = "=".repeat(50);
  process.stdout.write(`\n${bar}\n`);
  process.stdout.write(`${title}\n`);
  for (const l of lines) process.stdout.write(`${l}\n`);
  process.stdout.write(`${bar}\n`);
}

/**
 * 引擎生命周期包装：确保 finally 里一定调用 stop。
 * 对应 Python 的 try/except/finally 结构——注意异常也要转成返回值而非抛出。
 */
export async function withEngine<T>(
  browserId: string | number,
  options: ConnectOptions,
  body: (engine: StagehandGoogleEngine) => Promise<T>,
  onError: (message: string) => T,
): Promise<T> {
  let engine: StagehandGoogleEngine | null = null;
  try {
    engine = await connectEngine(browserId, options);
    return await body(engine);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return onError(msg);
  } finally {
    if (engine) {
      try {
        await engine.stop(options.closeAfter ?? false);
      } catch {
        /* 关闭失败不覆盖已有结果，与 Python 一致 */
      }
    }
  }
}

/** 元组结果类型，对应 Python 的 Tuple[bool, str] */
export type Result2 = [boolean, string];
/** 对应 Python 的 Tuple[bool, str, Optional[str]] */
export type Result3 = [boolean, string, string | null];