/**
 * 首页（ixBrowser 窗口管理） 的后端 handler —— 对标 gui/home_interface.py
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
  type HomeBatchResult,
  type HomeBrowserTree,
  type HomeConfig,
  type HomeConfigPatch,
  type HomeGroupListResult,
} from "../../shared/channels/home.ts";
import type { TaskApi } from "../task-runner.ts";
import type { TaskInfo } from "../../shared/ipc.ts";
import { deleteBrowserById, getBrowserList, openBrowserById } from "../../../src/ixbrowser/window.ts";
import { getGroupList } from "../../../src/ixbrowser/groups.ts";
import { buildBrowserTree, buildGroupOptions, defaultGroupOptions } from "../../../src/application/home-tree.ts";

/** 配置键（对标 home_interface.py:471 / :475） */
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

function configString(value: unknown): string {
  // Python: str(template_id) if template_id else ""
  return value === null || value === undefined || value === "" ? "" : String(value);
}

function readConfig(ctx: HostContext): HomeConfig {
  const cfg = ctx.config();
  return {
    templateId: configString(cfg.get(HOME_CONFIG_KEYS.templateId, "")),
    namePrefix: configString(cfg.get(HOME_CONFIG_KEYS.namePrefix, "")),
  };
}

type BrowserOp = (id: number, log: (message: string) => void) => Promise<boolean>;

/**
 * 批量打开 / 删除的任务体：逐个执行，每个窗口一行日志 + 一条逐条目结果（任务历史用），
 * 更新进度，支持中途停止。
 * 原版 _onOpenClicked / _onDeleteClicked（:446-466）只有 TODO，这里是新实现。
 */
export async function runBrowserBatch(
  api: Pick<TaskApi, "log" | "progress" | "item" | "shouldStop">,
  ids: readonly number[],
  verb: string,
  op: BrowserOp,
): Promise<HomeBatchResult> {
  const total = ids.length;
  const failed: number[] = [];
  let success = 0;
  let done = 0;
  api.log(`准备${verb} ${total} 个窗口...`);
  api.progress(0, total);
  for (const id of ids) {
    if (api.shouldStop()) {
      api.log(`[用户操作] 任务已停止，剩余 ${total - done} 个窗口未处理`);
      break;
    }
    let ok = false;
    let failure = "";
    // 本条目内最后一条底层日志：失败时的原因（「窗口不存在」这类）只在底层日志里，
    // 逐条目消息带上它，任务历史才能回答「为什么失败」
    const log = (message: string): void => {
      failure = message;
      api.log(message);
    };
    try {
      ok = await op(id, log);
    } catch (error) {
      failure = errText(error);
      api.log(`[错误] 窗口 ${id} ${verb}异常: ${failure}`);
    }
    done += 1;
    if (ok) {
      success += 1;
      api.log(`[${done}/${total}] ✓ 窗口 ${id} ${verb}成功`);
      api.item(String(id), "成功", "");
    } else {
      failed.push(id);
      api.log(`[${done}/${total}] ✗ 窗口 ${id} ${verb}失败`);
      // 逐条目结果：任务历史（总数 / 成功 / 失败）靠它统计。只打日志的话，
      // 真机上任务虽然成功，历史里却全是 0（2026-09-24 复现）。
      api.item(String(id), "失败", failure || `窗口 ${id} ${verb}失败`);
    }
    api.progress(done, total);
  }
  api.log(`${verb}完成: 成功 ${success}，失败 ${failed.length}`);
  return { total, success_count: success, failed_count: failed.length, failed_ids: failed };
}

export function createHomeHandlers(ctx: HostContext): HostHandlerTable {
  const deps = () => ({ client: ctx.ix(), log: ctx.log });

  return {
    "abb/home/getConfig": (...args: unknown[]): HomeConfig => {
      expectNoArgs(args);
      return readConfig(ctx);
    },

    /**
     * Python 在关窗时 saveConfig（:481-487）一次写回两个输入框；
     * 桌面端改为输入框失焦时写回（窗口关闭时渲染层来不及可靠地发请求）。
     * 只写这两个键，且与 Python 一样 strip()。
     */
    "abb/home/saveConfig": (...args: unknown[]): HomeConfig => {
      const patch = parseConfigPatch(args);
      const cfg = ctx.config();
      if (patch.templateId !== undefined) cfg.set(HOME_CONFIG_KEYS.templateId, patch.templateId.trim());
      if (patch.namePrefix !== undefined) cfg.set(HOME_CONFIG_KEYS.namePrefix, patch.namePrefix.trim());
      return readConfig(ctx);
    },

    /** 对标 refreshGroupList（:227-245）：出错时只保留「默认分组」 */
    "abb/home/listGroups": async (...args: unknown[]): Promise<HomeGroupListResult> => {
      expectNoArgs(args);
      try {
        const groups = await getGroupList(deps());
        return { options: buildGroupOptions(groups), error: null };
      } catch (error) {
        return { options: defaultGroupOptions(), error: errText(error) };
      }
    },

    /** 对标 BrowserLoadWorker.run（:47-74）+ _populateBrowserTree（:295-361） */
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
  };
}
