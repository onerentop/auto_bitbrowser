/**
 * 首页（ixBrowser 窗口管理）的后端 handler（分组 / 窗口列表、创建 / 打开 / 删除、配置读写）
 *
 * 取列表（listGroups / listBrowsers）是只读操作，做成普通请求：
 * ixBrowser 是本机服务，正常情况下每页 <1s；单次请求最坏 20s 超时（abort 不属于可重试错误，
 * 不会叠加重试），超出 30s 主进程超时的只有「服务挂死」这种异常场景，此时返回 TIMEOUT 也合理。
 * 打开 / 删除逐个调 ixBrowser，数量不定，必须走后台任务。
 */
import type { HostContext } from "../context.ts";
import type { HostHandlerTable } from "../dispatch.ts";
import { CodedError, ERROR_CODES } from "../../shared/envelope.ts";
import {
  HOME_TASK_TYPES,
  MAX_CREATE_COUNT,
  type HomeBrowserTree,
  type HomeConfig,
  type HomeConfigPatch,
  type HomeCreateResult,
  type HomeCreateSpec,
  type HomeGroupListResult,
} from "../../shared/channels/home.ts";
import type { TaskInfo } from "../../shared/ipc.ts";
import { deleteBrowserById, getBrowserList, getNextWindowName, openBrowserById } from "../../../src/ixbrowser/window.ts";
import { getGroupList } from "../../../src/ixbrowser/groups.ts";
import {
  createWindowsFromTemplate,
  resolveNamePrefix,
  type CreateWindowsDeps,
} from "../../../src/application/create-windows.ts";
import { runBrowserBatch } from "../../../src/application/browser-batch.ts";
import { buildBrowserTree, buildGroupOptions, defaultGroupOptions } from "../../shared/logic/home-tree.ts";

/** 配置键 */
export const HOME_CONFIG_KEYS = {
  templateId: "last_used_template_id",
  namePrefix: "window_name_prefix",
} as const;

/** 单次批量上限：防止误传超大数组 */
const MAX_BATCH = 10_000;

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalid(message: string): CodedError {
  return new CodedError(ERROR_CODES.INVALID_ARGUMENT, message);
}

function expectNoArgs(args: unknown[]): void {
  if (args.length > 0) throw invalid("该通道不接受参数");
}

/** 校验 saveConfig 的参数：普通对象，只允许 templateId / namePrefix 两个字符串字段 */
export function parseConfigPatch(args: unknown[]): HomeConfigPatch {
  if (args.length !== 1) throw invalid("需要 1 个参数：配置补丁对象");
  const raw = args[0];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw invalid("配置补丁必须是对象");
  const patch: HomeConfigPatch = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key !== "templateId" && key !== "namePrefix") throw invalid(`不支持的配置字段: ${key}`);
    if (typeof value !== "string") throw invalid(`配置字段 ${key} 必须是字符串`);
    if (value.length > 1000) throw invalid(`配置字段 ${key} 过长`);
    patch[key] = value;
  }
  if (Object.keys(patch).length === 0) throw invalid("配置补丁不能为空");
  return patch;
}

/** 校验窗口 ID 列表：非空数组、正整数；去重保序 */
export function parseProfileIds(args: unknown[]): number[] {
  if (args.length !== 1) throw invalid("需要 1 个参数：窗口 ID 数组");
  const raw = args[0];
  if (!Array.isArray(raw)) throw invalid("窗口 ID 列表必须是数组");
  if (raw.length === 0) throw invalid("窗口 ID 列表不能为空");
  if (raw.length > MAX_BATCH) throw invalid(`一次最多处理 ${MAX_BATCH} 个窗口`);
  const ids: number[] = [];
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
      throw invalid(`非法的窗口 ID: ${String(v)}`);
    }
    if (!ids.includes(v)) ids.push(v);
  }
  return ids;
}

/** 校验「根据模板创建窗口」的入参（界面上模板 ID 是文本框，必须是正整数） */
export function parseCreateSpec(args: unknown[]): HomeCreateSpec {
  if (args.length !== 1) throw invalid("需要 1 个参数：创建参数对象");
  const raw = args[0];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw invalid("创建参数必须是对象");
  const o = raw as Record<string, unknown>;

  const templateId = o["templateId"];
  if (typeof templateId !== "number" || !Number.isSafeInteger(templateId) || templateId <= 0) {
    throw invalid(`模板窗口 ID 必须是正整数: ${String(templateId)}`);
  }

  const count = o["count"];
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_CREATE_COUNT) {
    throw invalid(`创建个数必须是 1-${MAX_CREATE_COUNT} 的整数`);
  }

  const prefixRaw = o["namePrefix"] ?? "";
  if (typeof prefixRaw !== "string") throw invalid("窗口前缀必须是字符串");
  if (prefixRaw.length > 100) throw invalid("窗口前缀过长");

  const groupRaw = o["groupId"];
  let groupId: number | null = null;
  if (groupRaw !== undefined && groupRaw !== null) {
    if (typeof groupRaw !== "number" || !Number.isSafeInteger(groupRaw) || groupRaw < 0) {
      throw invalid(`分组 ID 必须是非负整数: ${String(groupRaw)}`);
    }
    groupId = groupRaw;
  }

  return { templateId, count, namePrefix: prefixRaw, groupId };
}

function configString(value: unknown): string {
  // 空值统一转成空字符串
  return value === null || value === undefined || value === "" ? "" : String(value);
}

function readConfig(ctx: HostContext): HomeConfig {
  const cfg = ctx.config();
  return {
    templateId: configString(cfg.get(HOME_CONFIG_KEYS.templateId, "")),
    namePrefix: configString(cfg.get(HOME_CONFIG_KEYS.namePrefix, "")),
  };
}

export function createHomeHandlers(ctx: HostContext): HostHandlerTable {
  const deps = () => ({ client: ctx.ix(), log: ctx.log });

  return {
    "abb/home/getConfig": (...args: unknown[]): HomeConfig => {
      expectNoArgs(args);
      return readConfig(ctx);
    },

    /**
     * 改为输入框失焦时写回，而不是等关窗时一次性写回两个输入框；
     * 桌面端改为输入框失焦时写回（窗口关闭时渲染层来不及可靠地发请求）。
     * 只写这两个键，值先 strip()。
     */
    "abb/home/saveConfig": (...args: unknown[]): HomeConfig => {
      const patch = parseConfigPatch(args);
      const cfg = ctx.config();
      if (patch.templateId !== undefined) cfg.set(HOME_CONFIG_KEYS.templateId, patch.templateId.trim());
      if (patch.namePrefix !== undefined) cfg.set(HOME_CONFIG_KEYS.namePrefix, patch.namePrefix.trim());
      return readConfig(ctx);
    },

    /** 刷新分组列表：出错时只保留「默认分组」 */
    "abb/home/listGroups": async (...args: unknown[]): Promise<HomeGroupListResult> => {
      expectNoArgs(args);
      try {
        const groups = await getGroupList(deps());
        return { options: buildGroupOptions(groups), error: null };
      } catch (error) {
        return { options: defaultGroupOptions(), error: errText(error) };
      }
    },

    /** 加载窗口列表并组装树 */
    "abb/home/listBrowsers": async (...args: unknown[]): Promise<HomeBrowserTree> => {
      expectNoArgs(args);
      let groups: unknown[] = [];
      let browsers: unknown[] = [];
      let error: string | null = null;
      try {
        groups = await getGroupList(deps());
        browsers = await getBrowserList(deps(), { fetchAll: true });
      } catch (e) {
        error = errText(e);
      }
      const tree = buildBrowserTree(groups, browsers);
      return { ...tree, error };
    },

    // 任务内把 window.ts 的重试日志也转到任务日志（底部任务坞可见）
    "abb/home/openBrowsers": (...args: unknown[]): TaskInfo => {
      const ids = parseProfileIds(args);
      return ctx.tasks.start(HOME_TASK_TYPES.open, `打开 ${ids.length} 个窗口`, (api) =>
        runBrowserBatch(api, ids, "打开", (id, log) => openBrowserById({ client: ctx.ix(), log }, id)),
      );
    },

    "abb/home/deleteBrowsers": (...args: unknown[]): TaskInfo => {
      const ids = parseProfileIds(args);
      return ctx.tasks.start(HOME_TASK_TYPES.delete, `删除 ${ids.length} 个窗口`, (api) =>
        runBrowserBatch(api, ids, "删除", (id, log) => deleteBrowserById({ client: ctx.ix(), log }, id)),
      );
    },

    /**
     * 按模板窗口批量创建窗口。
     *
     * 模板不存在时**直接拒绝**（不启动任务）——避免任务跑起来才一个个失败。
     * 名字由 getNextWindowName 按当前窗口列表算，前缀为空时用模板窗口名。
     */
    "abb/home/createBrowsers": async (...args: unknown[]): Promise<TaskInfo> => {
      const spec = parseCreateSpec(args);
      const template = await ctx.ix().getProfileInfo(spec.templateId);
      if (!template) throw invalid(`模板窗口不存在: ${spec.templateId}`);
      const namePrefix = resolveNamePrefix(spec.namePrefix, template.name ?? "");

      return ctx.tasks.start(
        HOME_TASK_TYPES.create,
        `按模板创建 ${spec.count} 个窗口`,
        (api): Promise<HomeCreateResult> =>
          createWindowsFromTemplate({
            templateId: spec.templateId,
            count: spec.count,
            namePrefix,
            groupId: spec.groupId,
            deps: {
              copy: (templateId, fields) => ctx.ix().copyProfile(templateId, fields),
              nextName: (prefix) => getNextWindowName({ client: ctx.ix(), log: api.log }, prefix),
              shouldStop: api.shouldStop,
              log: api.log,
              progress: (current) => api.progress(current, spec.count),
              item: api.item,
            } satisfies CreateWindowsDeps,
          }),
      );
    },
  };
}
