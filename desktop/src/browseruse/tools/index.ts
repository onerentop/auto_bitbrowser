/**
 * BrowserUse Engine - 动作系统模块（Node 重写）
 * 对标 core/browseruse_engine/tools/__init__.py
 *
 * 提供动作注册、定义和执行功能。
 *
 * 与 Python 的差异：
 *   - Python 的 `from . import actions` 只为触发装饰器注册，不对外导出动作函数；
 *     TS 这里也保留「先引入 actions 再导出执行器」的顺序，但额外 re-export
 *     各动作函数与参数类型，供下游 agent/engine 直接调用（Python 侧下游是
 *     `from .tools.actions import xxx` 单独导入，效果等价）。
 */

// 导入注册器 (必须先导入)
export { ActionRegistry, defaultRegistry } from "./registry.ts";
export type {
  ActionSchema,
  ActionJsonSchema,
  ActionHandler,
  ActionHandlerArgs,
  ActionContext,
} from "./registry.ts";

// 导入内置动作 (触发注册)
export {
  registerBuiltinActions,
  navigate,
  click,
  inputText,
  scroll,
  extract,
  screenshot,
  wait,
  done,
  pressKey,
  goBack,
} from "./actions.ts";
export type {
  NavigateArgs,
  ClickArgs,
  InputTextArgs,
  ScrollArgs,
  ExtractArgs,
  ScreenshotArgs,
  WaitArgs,
  DoneArgs,
  PressKeyArgs,
  GoBackArgs,
} from "./actions.ts";

// 导入执行器
export { ActionExecutor } from "./executor.ts";
export type { ActionExecutorOptions, ExecuteBatchOptions } from "./executor.ts";
