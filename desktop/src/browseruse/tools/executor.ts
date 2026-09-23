/**
 * BrowserUse Engine - 动作执行器（Node 重写）
 * 对标 core/browseruse_engine/tools/executor.py
 *
 * 负责解析 ActionModel 并调用对应的处理器执行动作。
 *
 * 与 Python 的差异：
 *   1. 构造参数由位置参数改成对象：new ActionExecutor({ page, domService, llm, registry, log })。
 *      Python 侧只有 page/dom_service/llm 三个；registry/log 是 TS 新增的注入点
 *      （Python 用类级单例 ActionRegistry 和模块级 logger，TS 默认值 defaultRegistry / noopLog
 *       与之等价）。
 *   2. `action.get_action_type()` / `get_action_params()` 是 pydantic 模型方法，
 *      TS 侧是 types.ts 的自由函数 getActionType / getActionParams。
 *   3. `**params` 展开成 kwargs → 合并到一个 args 对象（上下文在前、动作参数在后，
 *      与 Python 的 dict 字面量顺序一致）。
 *   4. logger.error/info/warning → 注入的 LogFn。
 *
 * 注意：内置动作在 actions.ts 被导入时才注册进 defaultRegistry。
 * 请从 tools/index.ts 导入本类（index.ts 会先引入 actions.ts），
 * 或自行 `import "./actions.ts"`，否则默认注册表为空、所有动作都会返回「未知动作」。
 */

import type { BrowserPageLike, LogFn } from "../page.ts";
import { noopLog } from "../page.ts";
import type { ActionResult } from "../protocol.ts";
import { createActionResult } from "../protocol.ts";
import type { ActionModel } from "../types.ts";
import { getActionParams, getActionType } from "../types.ts";
import type { ActionHandlerArgs, ActionRegistry } from "./registry.ts";
import { defaultRegistry } from "./registry.ts";
import type { DomService } from "../dom/service.ts";
import type { BaseChatModel } from "../llm/base.ts";

/** 对标 asyncio.sleep(seconds) */
function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** 对标 Python 的 str(e) */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 执行器构造参数 */
export interface ActionExecutorOptions {
  /** 浏览器页面 */
  page: BrowserPageLike;
  /** DOM 服务实例 */
  domService?: DomService | null;
  /** LLM 适配器实例 */
  llm?: BaseChatModel | null;
  /** 动作注册表，默认使用全局 defaultRegistry（等价 Python 的类级单例） */
  registry?: ActionRegistry;
  /** 日志钩子，默认丢弃 */
  log?: LogFn;
}

/** 批量执行参数 —— 对标 execute_batch 的 stop_on_done / stop_on_error */
export interface ExecuteBatchOptions {
  stopOnDone?: boolean;
  stopOnError?: boolean;
}

/**
 * 动作执行器
 *
 * 负责解析 ActionModel 并调用对应的处理器执行动作。
 */
export class ActionExecutor {
  readonly page: BrowserPageLike;

  readonly domService: DomService | null;

  readonly llm: BaseChatModel | null;

  private readonly registry: ActionRegistry;

  private readonly log: LogFn;

  constructor(options: ActionExecutorOptions) {
    this.page = options.page;
    this.domService = options.domService ?? null;
    this.llm = options.llm ?? null;
    this.registry = options.registry ?? defaultRegistry;
    this.log = options.log ?? noopLog;
  }

  /** 执行单个动作 —— 对标 execute() */
  async execute(action: ActionModel): Promise<ActionResult> {
    const actionType = getActionType(action);
    if (!actionType) {
      return createActionResult({ success: false, error: "无效的动作" });
    }

    // 获取动作参数
    const params = getActionParams(action);

    // 获取处理器
    const handler = this.registry.getHandler(actionType);
    if (!handler) {
      return createActionResult({
        success: false,
        error: `未知动作: ${actionType}`,
      });
    }

    // 构建调用参数
    const callArgs: ActionHandlerArgs = {
      page: this.page,
      domService: this.domService,
      llm: this.llm,
      log: this.log,
      ...params,
    };

    try {
      // 执行动作
      const result = await handler(callArgs);
      return result;
    } catch (e) {
      this.log(`执行动作 ${actionType} 失败: ${errorText(e)}`);
      return createActionResult({
        success: false,
        error: errorText(e),
      });
    }
  }

  /**
   * 批量执行动作序列 —— 对标 execute_batch()
   *
   * @param actions 动作列表
   * @param options stopOnDone（默认 true）遇到 done 动作时停止；
   *                stopOnError（默认 false）遇到错误时停止
   */
  async executeBatch(actions: ActionModel[], options: ExecuteBatchOptions = {}): Promise<ActionResult[]> {
    const stopOnDone = options.stopOnDone ?? true;
    const stopOnError = options.stopOnError ?? false;

    const results: ActionResult[] = [];

    for (const action of actions) {
      const result = await this.execute(action);
      results.push(result);

      // 检查是否需要停止
      if (stopOnDone && action.done !== undefined && action.done !== null) {
        this.log("遇到 done 动作，停止执行");
        break;
      }

      if (stopOnError && !result.success) {
        this.log(`动作执行失败，停止执行: ${result.error}`);
        break;
      }

      // 动作之间短暂等待，让页面响应
      await sleep(0.2);
    }

    return results;
  }

  /**
   * 直接执行动作 (不经过 ActionModel) —— 对标 execute_raw()
   *
   * @param actionType 动作类型名称
   * @param params 动作参数（Python 是 **params）
   */
  async executeRaw(actionType: string, params: Record<string, unknown> = {}): Promise<ActionResult> {
    const handler = this.registry.getHandler(actionType);
    if (!handler) {
      return createActionResult({
        success: false,
        error: `未知动作: ${actionType}`,
      });
    }

    const callArgs: ActionHandlerArgs = {
      page: this.page,
      domService: this.domService,
      llm: this.llm,
      log: this.log,
      ...params,
    };

    try {
      return await handler(callArgs);
    } catch (e) {
      this.log(`执行动作 ${actionType} 失败: ${errorText(e)}`);
      return createActionResult({
        success: false,
        error: errorText(e),
      });
    }
  }

  /** 检查是否是完成动作 —— 对标 is_done_action() */
  static isDoneAction(action: ActionModel): boolean {
    return action.done !== undefined && action.done !== null;
  }

  /** 获取完成动作的结果消息 —— 对标 get_done_result() */
  static getDoneResult(action: ActionModel): string | null {
    if (action.done !== undefined && action.done !== null) {
      return action.done.message;
    }
    return null;
  }
}
