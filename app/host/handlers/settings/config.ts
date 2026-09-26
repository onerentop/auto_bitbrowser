/**
 * 设置页「配置」标签的 handler（读取 / 保存 / 测试连接 / 数据目录）
 */
import { statSync } from "node:fs";
import { SettingsService } from "../../../../src/application/settings-service.ts";
import { testAiConnection, type FetchLike } from "../../../../src/application/test-ai-connection.ts";
import {
  AI_PROVIDERS,
  SETTINGS_INVOKE,
  SETTINGS_NUMBER_RANGES,
  SETTINGS_THEMES,
  type SettingsNumberField,
  type SettingsSnapshotDto,
  type TestAiResultDto,
} from "../../../shared/channels/settings.ts";
import type { HostContext } from "../../context.ts";
import type { HostHandlerTable } from "../../dispatch.ts";
import { asBool, asOneOf, asRecord, asInt, asString, field, invalid } from "./validate.ts";

export interface ConfigHandlerDeps {
  /** 测试注入：替换真实 HTTP */
  fetchImpl?: FetchLike;
}

const STRING_FIELDS = [
  "gemini_api_key",
  "gemini_base_url",
  "gemini_model",
  "anthropic_api_key",
  "anthropic_base_url",
  "anthropic_model",
  "gmail_imap_email",
  "gmail_imap_password",
  "data_dir",
  "data_separator",
  "captcha_api_key",
] as const;

/** 布尔字段（界面上的 Switch）：必须是真正的布尔值 */
const BOOL_FIELDS = ["captcha_enabled"] as const;

/** 校验保存参数：字符串字段类型 / 长度，数值字段整数且在 SETTINGS_NUMBER_RANGES 范围内，枚举字段取值合法 */
export function parseSnapshotArg(value: unknown): SettingsSnapshotDto {
  const o = asRecord(value, "snapshot");
  const strings = {} as Record<(typeof STRING_FIELDS)[number], string>;
  for (const key of STRING_FIELDS) strings[key] = field(o, key);

  const numbers = {} as Record<SettingsNumberField, number>;
  for (const [key, [min, max]] of Object.entries(SETTINGS_NUMBER_RANGES) as [
    SettingsNumberField,
    readonly [number, number, number],
  ][]) {
    numbers[key] = asInt(o[key], key, min, max);
  }

  const bools = {} as Record<(typeof BOOL_FIELDS)[number], boolean>;
  for (const key of BOOL_FIELDS) bools[key] = asBool(o[key], key);

  return {
    ...strings,
    ...numbers,
    ...bools,
    ai_default_provider: asOneOf(o["ai_default_provider"], "ai_default_provider", AI_PROVIDERS),
    theme: asOneOf(o["theme"], "theme", SETTINGS_THEMES),
  };
}

export function createConfigHandlers(ctx: HostContext, deps: ConfigHandlerDeps = {}): HostHandlerTable {
  const service = (): SettingsService => new SettingsService(ctx.config());

  return {
    [SETTINGS_INVOKE.settingsLoad]: (): SettingsSnapshotDto => service().loadSettingsSnapshot(),

    /** 启动时读主题：只返回 theme，避免像 settingsLoad 那样把解密后的密钥发到渲染层；不接受参数 */
    [SETTINGS_INVOKE.settingsGetTheme]: (...args: unknown[]): { theme: string } => {
      if (args.length > 0) invalid("该通道不接受参数");
      return { theme: service().getTheme() };
    },

    [SETTINGS_INVOKE.settingsSave]: (snapshot: unknown): SettingsSnapshotDto => {
      const s = parseSnapshotArg(snapshot);
      const svc = service();
      svc.saveSettingsSnapshot(s);
      return svc.loadSettingsSnapshot();
    },

    /**
     * 有意偏差：原实现用文件夹对话框选择、选中即写入。
     * 主进程是薄壳、暂无对话框通道，界面改为「输入框 + 应用」，这里仍然立即写入；
     * 因为不再由对话框保证目录存在，这里补一道「必须是已存在的目录」校验。
     */
    [SETTINGS_INVOKE.settingsSetDataDir]: (path: unknown): string => {
      const dir = asString(path, "path").trim();
      if (!dir) invalid("数据目录不能为空");
      let isDir = false;
      try {
        isDir = statSync(dir).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) invalid(`目录不存在: ${dir}`);
      service().setDataDir(dir);
      return dir;
    },

    /** 测试 AI 连通性：空 key 时只提示、不发请求 */
    [SETTINGS_INVOKE.settingsTestAi]: async (input: unknown): Promise<TestAiResultDto> => {
      const o = asRecord(input, "input");
      const provider = asOneOf(o["provider"], "provider", AI_PROVIDERS);
      const [apiKey, baseUrl, model] = service().resolveProviderRuntimeConfig(
        provider,
        field(o, "apiKey"),
        field(o, "baseUrl"),
        field(o, "model"),
      );
      if (!apiKey) {
        // 没有 key 时只提示，不发请求
        return {
          success: false,
          missingKey: true,
          message: `请先输入 ${provider.toUpperCase()} API Key`,
          details: {},
        };
      }
      const result = await testAiConnection(
        { apiKey, baseUrl, model, provider },
        deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {},
      );
      return { ...result, missingKey: false };
    },
  };
}
