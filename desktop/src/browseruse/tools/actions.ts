/**
 * BrowserUse Engine - 内置动作（Node 重写）
 * 对标 core/browseruse_engine/tools/actions.py
 *
 * 定义所有内置的浏览器动作（10 个）：
 *   navigate / click / input / scroll / extract / screenshot / wait / done / press_key / go_back
 *
 * 与 Python 的差异：
 *   1. `@ActionRegistry.action(...)` 装饰器 → 文件末尾的 registerBuiltinActions()
 *      集中注册；name / description / parameters 与装饰器参数逐字一致。
 *      模块被导入时自动注册到 defaultRegistry（等价 Python import 触发装饰器）。
 *   2. `**kwargs` → 单个 args 对象；动作参数键名保持 Python 的 snake_case
 *      （url / wait_until / timeout / index / text / clear / direction / amount /
 *        query / filename / milliseconds / message / success / key）。
 *   3. Python 缺必填参数时由解释器抛 TypeError，被执行器 catch 成 error 结果；
 *      TS 没有这个机制，改为在函数入口显式抛 `缺少必需参数: xxx`，
 *      同样被执行器 catch —— 行为路径一致，文案不同（Python 文案无法复刻）。
 *   4. `time.time() * 1000` → `Date.now()`（整数毫秒），字段名仍是 duration_ms。
 *   5. `page.viewport_size` 属性 → `page.viewportSize()` 方法；
 *      `page.go_back()` → `page.goBack()`；`full_page` → `fullPage`（Playwright JS API）。
 *   6. `logger.*` → 注入的 LogFn（args.log，默认 noopLog）。
 *   7. extract 里 Python 是函数内延迟 import llm.base，TS 改为顶层 import type + 值导入。
 */

import { writeFile } from "node:fs/promises";

import type { BrowserPageLike } from "../page.ts";
import { noopLog } from "../page.ts";
import type { ActionResult } from "../protocol.ts";
import { createActionResult } from "../protocol.ts";
import type { ActionContext, ActionHandlerArgs, ActionRegistry } from "./registry.ts";
import { defaultRegistry } from "./registry.ts";
import { createSystemMessage, createUserMessage } from "../llm/base.ts";

// ==================== 内部工具 ====================

/** 对标 asyncio.sleep(seconds) */
function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** 对标 Python 的 str(e) */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 必需的 page 上下文（Python 侧缺失会抛 TypeError） */
function requirePage(args: ActionContext): BrowserPageLike {
  if (!args.page) throw new Error("缺少必需参数: page");
  return args.page;
}

/** 必需的字符串参数 */
function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`缺少必需参数: ${name}`);
  return value;
}

/** 必需的数值参数 */
function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number") throw new Error(`缺少必需参数: ${name}`);
  return value;
}

/**
 * 对标 Python 的 f"{x:.0f}"。
 * Python 用「四舍六入五成双」（banker's rounding），JS 的 toFixed(0) 对 .5 一律远离零，
 * 坐标恰好落在 .5（矩形中心）时两者会差 1px，因此这里自己实现。
 */
function formatFixed0(value: number): string {
  const floor = Math.floor(value);
  const diff = value - floor;
  let rounded: number;
  if (diff > 0.5) rounded = floor + 1;
  else if (diff < 0.5) rounded = floor;
  else rounded = floor % 2 === 0 ? floor : floor + 1;
  // Python 对负零输出 "-0"
  if (rounded === 0 && value < 0) return "-0";
  return String(rounded);
}

/** 把执行器传来的松散 kwargs 转成具体动作的参数类型（校验在各动作内部做） */
function castArgs<T>(args: ActionHandlerArgs): T {
  return args as unknown as T;
}

// ==================== 导航动作 ====================

export interface NavigateArgs extends ActionContext {
  url: string;
  wait_until?: string;
  timeout?: number;
}

/** 导航到 URL */
export async function navigate(args: NavigateArgs): Promise<ActionResult> {
  const page = requirePage(args);
  const url = requireString(args.url, "url");
  const waitUntil = args.wait_until ?? "domcontentloaded";
  const timeout = args.timeout ?? 30000;
  const log = args.log ?? noopLog;

  const startTime = Date.now();
  try {
    await page.goto(url, { waitUntil, timeout });
    const durationMs = Date.now() - startTime;
    return createActionResult({
      success: true,
      message: `已导航到 ${url}`,
      duration_ms: durationMs,
    });
  } catch (e) {
    const durationMs = Date.now() - startTime;
    log(`导航失败: ${url} - ${errorText(e)}`);
    return createActionResult({
      success: false,
      error: errorText(e),
      duration_ms: durationMs,
    });
  }
}

// ==================== 点击动作 ====================

export interface ClickArgs extends ActionContext {
  index: number;
}

/** 点击元素 */
export async function click(args: ClickArgs): Promise<ActionResult> {
  const page = requirePage(args);
  const index = requireNumber(args.index, "index");
  const domService = args.domService;
  const log = args.log ?? noopLog;

  const startTime = Date.now();

  if (!domService) {
    return createActionResult({ success: false, error: "DOM 服务不可用" });
  }

  try {
    // 获取选择器或坐标
    const selector = domService.getSelectorByIndex(index);
    const coordinates = domService.getCoordinatesByIndex(index);

    if (selector) {
      // 优先使用选择器
      try {
        await page.click(selector, { timeout: 5000 });
        const durationMs = Date.now() - startTime;
        return createActionResult({
          success: true,
          message: `已点击元素 [${index}]`,
          duration_ms: durationMs,
        });
      } catch (e) {
        log(`选择器点击失败: ${errorText(e)}, 尝试坐标点击`);
      }
    }

    if (coordinates) {
      // 使用坐标点击
      const [x, y] = coordinates;
      await page.mouse.click(x, y);
      const durationMs = Date.now() - startTime;
      return createActionResult({
        success: true,
        message: `已点击元素 [${index}] (坐标: ${formatFixed0(x)}, ${formatFixed0(y)})`,
        duration_ms: durationMs,
      });
    }

    return createActionResult({
      success: false,
      error: `找不到索引为 ${index} 的元素`,
      duration_ms: Date.now() - startTime,
    });
  } catch (e) {
    const durationMs = Date.now() - startTime;
    log(`点击失败: [${index}] - ${errorText(e)}`);
    return createActionResult({
      success: false,
      error: errorText(e),
      duration_ms: durationMs,
    });
  }
}

// ==================== 输入动作 ====================

export interface InputTextArgs extends ActionContext {
  index: number;
  text: string;
  clear?: boolean;
}

/** 输入文本（Python 侧函数名 input_text，注册名 "input"） */
export async function inputText(args: InputTextArgs): Promise<ActionResult> {
  const page = requirePage(args);
  const index = requireNumber(args.index, "index");
  const text = requireString(args.text, "text");
  const clear = args.clear ?? true;
  const domService = args.domService;
  const log = args.log ?? noopLog;

  const startTime = Date.now();

  if (!domService) {
    return createActionResult({ success: false, error: "DOM 服务不可用" });
  }

  try {
    const selector = domService.getSelectorByIndex(index);
    const coordinates = domService.getCoordinatesByIndex(index);

    if (selector) {
      try {
        if (clear) {
          await page.fill(selector, text, { timeout: 5000 });
        } else {
          await page.click(selector, { timeout: 5000 });
          await page.keyboard.type(text);
        }
        const durationMs = Date.now() - startTime;
        return createActionResult({
          success: true,
          message: `已在元素 [${index}] 输入文本`,
          duration_ms: durationMs,
        });
      } catch (e) {
        log(`选择器输入失败: ${errorText(e)}, 尝试坐标输入`);
      }
    }

    if (coordinates) {
      const [x, y] = coordinates;
      await page.mouse.click(x, y);
      await sleep(0.1);
      if (clear) {
        await page.keyboard.press("Control+a");
        await page.keyboard.press("Backspace");
      }
      await page.keyboard.type(text);
      const durationMs = Date.now() - startTime;
      return createActionResult({
        success: true,
        message: `已在元素 [${index}] 输入文本 (坐标)`,
        duration_ms: durationMs,
      });
    }

    return createActionResult({
      success: false,
      error: `找不到索引为 ${index} 的元素`,
      duration_ms: Date.now() - startTime,
    });
  } catch (e) {
    const durationMs = Date.now() - startTime;
    log(`输入失败: [${index}] - ${errorText(e)}`);
    return createActionResult({
      success: false,
      error: errorText(e),
      duration_ms: durationMs,
    });
  }
}

// ==================== 滚动动作 ====================

export interface ScrollArgs extends ActionContext {
  direction?: string;
  amount?: number;
}

/** 滚动页面 */
export async function scroll(args: ScrollArgs): Promise<ActionResult> {
  const page = requirePage(args);
  const direction = args.direction ?? "down";
  const amount = args.amount ?? 0.5;
  const log = args.log ?? noopLog;

  const startTime = Date.now();
  try {
    // 获取视口高度（Python 的 int() 向零截断，用 Math.trunc 对齐）
    const viewport = page.viewportSize();
    let scrollAmount = viewport ? Math.trunc(viewport.height * amount) : 500;

    if (direction === "up") {
      scrollAmount = -scrollAmount;
    }

    await page.evaluate(`window.scrollBy(0, ${scrollAmount})`);
    await sleep(0.3); // 等待滚动完成

    const durationMs = Date.now() - startTime;
    return createActionResult({
      success: true,
      message: `已滚动 ${direction} ${Math.abs(scrollAmount)}px`,
      duration_ms: durationMs,
    });
  } catch (e) {
    const durationMs = Date.now() - startTime;
    log(`滚动失败: ${errorText(e)}`);
    return createActionResult({
      success: false,
      error: errorText(e),
      duration_ms: durationMs,
    });
  }
}

// ==================== 提取动作 ====================

export interface ExtractArgs extends ActionContext {
  query: string;
}

/** 提取页面信息 */
export async function extract(args: ExtractArgs): Promise<ActionResult> {
  const page = requirePage(args);
  const query = requireString(args.query, "query");
  const llm = args.llm;
  const log = args.log ?? noopLog;

  const startTime = Date.now();
  try {
    // 获取页面文本内容
    const content = await page.evaluate<string>("() => document.body.innerText");

    let extracted: string;
    // 如果有 LLM，使用 LLM 提取
    if (llm) {
      const messages = [
        createSystemMessage(
          "你是一个信息提取助手。从给定的页面内容中提取用户需要的信息。只返回提取的信息，不要添加额外说明。",
        ),
        createUserMessage(`页面内容:\n${content.slice(0, 5000)}\n\n请提取: ${query}`),
      ];
      const response = await llm.ainvoke(messages);
      extracted = response.content;
    } else {
      // 没有 LLM，返回原始内容的摘要
      extracted = content.length > 500 ? content.slice(0, 500) + "..." : content;
    }

    const durationMs = Date.now() - startTime;
    return createActionResult({
      success: true,
      message: "信息提取成功",
      extracted_content: extracted,
      duration_ms: durationMs,
    });
  } catch (e) {
    const durationMs = Date.now() - startTime;
    log(`提取失败: ${errorText(e)}`);
    return createActionResult({
      success: false,
      error: errorText(e),
      duration_ms: durationMs,
    });
  }
}

// ==================== 截图动作 ====================

export interface ScreenshotArgs extends ActionContext {
  filename?: string | null;
}

/** 截取页面截图 */
export async function screenshot(args: ScreenshotArgs): Promise<ActionResult> {
  const page = requirePage(args);
  const filename = args.filename ?? null;
  const log = args.log ?? noopLog;

  const startTime = Date.now();
  try {
    const screenshotBytes = await page.screenshot({ type: "png", fullPage: false });
    const screenshotBase64 = Buffer.from(screenshotBytes).toString("base64");

    if (filename) {
      await writeFile(filename, screenshotBytes);
    }

    const durationMs = Date.now() - startTime;
    return createActionResult({
      success: true,
      message: `截图成功` + (filename ? `，已保存到 ${filename}` : ""),
      extracted_content: screenshotBase64,
      duration_ms: durationMs,
    });
  } catch (e) {
    const durationMs = Date.now() - startTime;
    log(`截图失败: ${errorText(e)}`);
    return createActionResult({
      success: false,
      error: errorText(e),
      duration_ms: durationMs,
    });
  }
}

// ==================== 等待动作 ====================

export interface WaitArgs extends ActionContext {
  milliseconds?: number;
}

/** 等待 */
export async function wait(args: WaitArgs = {}): Promise<ActionResult> {
  const milliseconds = args.milliseconds ?? 1000;

  const startTime = Date.now();
  await sleep(milliseconds / 1000);
  const durationMs = Date.now() - startTime;
  return createActionResult({
    success: true,
    message: `已等待 ${milliseconds}ms`,
    duration_ms: durationMs,
  });
}

// ==================== 完成动作 ====================

export interface DoneArgs extends ActionContext {
  message: string;
  success?: boolean;
}

/** 标记任务完成 */
export async function done(args: DoneArgs): Promise<ActionResult> {
  const message = requireString(args.message, "message");
  const success = args.success ?? true;

  return createActionResult({
    success,
    message,
    extracted_content: success ? message : null,
    duration_ms: 0,
  });
}

// ==================== 按键动作 ====================

export interface PressKeyArgs extends ActionContext {
  key: string;
}

/** 按下键盘按键 */
export async function pressKey(args: PressKeyArgs): Promise<ActionResult> {
  const page = requirePage(args);
  const key = requireString(args.key, "key");

  const startTime = Date.now();
  try {
    await page.keyboard.press(key);
    const durationMs = Date.now() - startTime;
    return createActionResult({
      success: true,
      message: `已按下 ${key}`,
      duration_ms: durationMs,
    });
  } catch (e) {
    const durationMs = Date.now() - startTime;
    return createActionResult({
      success: false,
      error: errorText(e),
      duration_ms: durationMs,
    });
  }
}

// ==================== 后退/前进动作 ====================

export type GoBackArgs = ActionContext;

/** 返回上一页 */
export async function goBack(args: GoBackArgs): Promise<ActionResult> {
  const page = requirePage(args);

  const startTime = Date.now();
  try {
    await page.goBack();
    const durationMs = Date.now() - startTime;
    return createActionResult({
      success: true,
      message: "已返回上一页",
      duration_ms: durationMs,
    });
  } catch (e) {
    const durationMs = Date.now() - startTime;
    return createActionResult({
      success: false,
      error: errorText(e),
      duration_ms: durationMs,
    });
  }
}

// ==================== 集中注册 ====================

/**
 * 注册全部内置动作 —— 对标 Python 各函数上的 @ActionRegistry.action(...) 装饰器。
 * 注册顺序与 actions.py 中函数的定义顺序一致（影响 get_action_descriptions 的行顺序）。
 */
export function registerBuiltinActions(registry: ActionRegistry = defaultRegistry): void {
  registry.register("navigate", (args) => navigate(castArgs<NavigateArgs>(args)), "导航到指定 URL", {
    type: "object",
    properties: {
      url: { type: "string", description: "目标 URL" },
    },
    required: ["url"],
  });

  registry.register("click", (args) => click(castArgs<ClickArgs>(args)), "点击指定索引的元素", {
    type: "object",
    properties: {
      index: { type: "integer", description: "元素索引号" },
    },
    required: ["index"],
  });

  registry.register("input", (args) => inputText(castArgs<InputTextArgs>(args)), "在指定元素中输入文本", {
    type: "object",
    properties: {
      index: { type: "integer", description: "元素索引号" },
      text: { type: "string", description: "要输入的文本" },
      clear: { type: "boolean", description: "是否先清空", default: true },
    },
    required: ["index", "text"],
  });

  registry.register("scroll", (args) => scroll(castArgs<ScrollArgs>(args)), "滚动页面", {
    type: "object",
    properties: {
      direction: { type: "string", enum: ["up", "down"], default: "down" },
      amount: { type: "number", description: "滚动量 (页面比例)", default: 0.5 },
    },
  });

  registry.register("extract", (args) => extract(castArgs<ExtractArgs>(args)), "从页面提取信息", {
    type: "object",
    properties: {
      query: { type: "string", description: "要提取的信息描述" },
    },
    required: ["query"],
  });

  registry.register("screenshot", (args) => screenshot(castArgs<ScreenshotArgs>(args)), "截取页面截图", {
    type: "object",
    properties: {
      filename: { type: "string", description: "保存文件名 (可选)" },
    },
  });

  registry.register("wait", (args) => wait(castArgs<WaitArgs>(args)), "等待指定时间", {
    type: "object",
    properties: {
      milliseconds: { type: "integer", description: "等待毫秒数", default: 1000 },
    },
  });

  registry.register("done", (args) => done(castArgs<DoneArgs>(args)), "标记任务完成", {
    type: "object",
    properties: {
      message: { type: "string", description: "完成消息或提取结果" },
      success: { type: "boolean", description: "是否成功完成", default: true },
    },
    required: ["message"],
  });

  registry.register("press_key", (args) => pressKey(castArgs<PressKeyArgs>(args)), "按下键盘按键", {
    type: "object",
    properties: {
      key: { type: "string", description: "按键名称 (如 Enter, Tab, Escape)" },
    },
    required: ["key"],
  });

  // Python 侧 go_back 的装饰器没有传 parameters，对应 parameters={}
  registry.register("go_back", (args) => goBack(castArgs<GoBackArgs>(args)), "返回上一页");
}

// 模块导入即注册 —— 等价于 Python import actions 时装饰器生效
registerBuiltinActions();
