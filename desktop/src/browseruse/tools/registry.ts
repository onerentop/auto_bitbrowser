/**
 * BrowserUse Engine - 动作注册器（Node 重写）
 * 对标 core/browseruse_engine/tools/registry.py
 *
 * 提供动作注册和动作元数据管理。
 *
 * 与 Python 的差异：
 *   1. Python 的 ActionRegistry 是「全类方法 + 类级 _actions 字典」的单例，
 *      TS 侧改成**可实例化的类**，另导出共享实例 defaultRegistry；
 *      Python 侧所有 `ActionRegistry.xxx()` 调用点等价于 `defaultRegistry.xxx()`。
 *      这样测试可以开一个干净 registry，而不必靠 clear() 互相干扰。
 *   2. Python 的 `@ActionRegistry.action(...)` 装饰器在 TS 没有等价物（TS 装饰器
 *      只能修饰类成员），actions.ts 改为在模块底部集中调用 register()，
 *      注册内容（name / description / parameters）与装饰器参数逐字一致。
 *   3. 处理器签名：Python 是 `async def h(page, dom_service=None, llm=None, **kwargs)`，
 *      调用方把上下文与动作参数合并成 kwargs 一把传入；TS 用单个 args 对象模拟
 *      kwargs —— 上下文字段用 camelCase（page / domService / llm / log），
 *      动作参数沿用 Python 的 snake_case（url / wait_until / dom_service 之外的全部）。
 *   4. logger.debug → 注入的 LogFn（可选，默认 noopLog）。
 */

import type { BrowserPageLike, LogFn } from "../page.ts";
import { noopLog } from "../page.ts";
import type { ActionResult } from "../protocol.ts";
import type { DomService } from "../dom/service.ts";
import type { BaseChatModel } from "../llm/base.ts";

/** 动作处理器的上下文字段（对应 Python kwargs 里的 page / dom_service / llm） */
export interface ActionContext {
  page?: BrowserPageLike;
  domService?: DomService | null;
  llm?: BaseChatModel | null;
  /** Python 侧是模块级 logger，这里由执行器注入 */
  log?: LogFn;
}

/** 处理器参数对象 —— 上下文 + 动作参数（模拟 Python 的 **kwargs） */
export interface ActionHandlerArgs extends ActionContext {
  [key: string]: unknown;
}

/** 动作处理器 */
export type ActionHandler = (args: ActionHandlerArgs) => Promise<ActionResult>;

/** 动作元数据 —— 对标 registry.py 的 ActionSchema dataclass */
export interface ActionSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: ActionHandler | null;
}

/** 生成给 LLM 看的动作 JSON Schema 条目 —— 对标 get_json_schema() 的元素结构 */
export interface ActionJsonSchema {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

/**
 * 动作注册表
 *
 * 使用示例：
 *   const registry = new ActionRegistry();
 *   registry.register("my_action", async ({ page }) => createActionResult({ success: true }), "执行自定义动作");
 */
export class ActionRegistry {
  /** Python 侧是类级字典，这里是实例字段；Map 保证插入顺序与 dict 一致 */
  private readonly actions = new Map<string, ActionSchema>();

  private readonly log: LogFn;

  constructor(log: LogFn = noopLog) {
    this.log = log;
  }

  /**
   * 注册动作 —— 对标 register()（同时承担 @action 装饰器的职责）
   *
   * @param name 动作名称
   * @param handler 处理器函数
   * @param description 动作描述
   * @param parameters 参数 JSON Schema
   */
  register(
    name: string,
    handler: ActionHandler,
    description = "",
    parameters?: Record<string, unknown> | null,
  ): void {
    const schema: ActionSchema = {
      name,
      description: description || `执行 ${name} 动作`,
      parameters: parameters ?? {},
      handler,
    };
    this.actions.set(name, schema);
    this.log(`注册动作: ${name}`);
  }

  /** 获取动作元数据 —— 对标 get_action() */
  getAction(name: string): ActionSchema | null {
    return this.actions.get(name) ?? null;
  }

  /** 获取动作处理器 —— 对标 get_handler() */
  getHandler(name: string): ActionHandler | null {
    const schema = this.actions.get(name);
    return schema ? schema.handler : null;
  }

  /** 列出所有已注册的动作名称 —— 对标 list_actions() */
  listActions(): string[] {
    return Array.from(this.actions.keys());
  }

  /** 获取所有动作元数据 —— 对标 get_all_schemas() */
  getAllSchemas(): ActionSchema[] {
    return Array.from(this.actions.values());
  }

  /** 生成动作描述文本 (用于提示词) —— 对标 get_action_descriptions() */
  getActionDescriptions(): string {
    const lines: string[] = [];
    for (const schema of this.actions.values()) {
      lines.push(`- ${schema.name}: ${schema.description}`);
    }
    return lines.join("\n");
  }

  /**
   * 生成动作的 JSON Schema (用于 LLM 结构化输出) —— 对标 get_json_schema()
   *
   * Python 侧 `if schema.parameters:` 对空 dict 为假，因此空参数动作不带 parameters 字段，
   * 这里用 Object.keys().length 做同样判断。
   */
  getJsonSchema(): ActionJsonSchema[] {
    const schemas: ActionJsonSchema[] = [];
    for (const schema of this.actions.values()) {
      const actionSchema: ActionJsonSchema = {
        name: schema.name,
        description: schema.description,
      };
      if (Object.keys(schema.parameters).length > 0) {
        actionSchema.parameters = schema.parameters;
      }
      schemas.push(actionSchema);
    }
    return schemas;
  }

  /** 清空所有注册的动作 (主要用于测试) —— 对标 clear() */
  clear(): void {
    this.actions.clear();
  }
}

/**
 * 全局默认注册表 —— 等价于 Python 的类级 `ActionRegistry._actions`。
 * 内置动作在 actions.ts 被导入时注册到这里。
 */
export const defaultRegistry = new ActionRegistry();
