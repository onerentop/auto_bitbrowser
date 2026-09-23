/**
 * BrowserUse Engine - 浏览器页面抽象（Node 重写）
 *
 * Python 侧直接吃 Playwright 的 async Page 对象。Node 侧不把 playwright 类型
 * 硬编码进来，而是声明**结构化子集**：
 *   - 字段名对齐 Playwright 的 JS API（viewportSize()/goBack()/context()），
 *     真实的 playwright Page 可直接结构化赋值；
 *   - 测试里用假 Page 替身实现同一接口，全程离线。
 *
 * 方法集合由 Python 侧实际调用点决定（dom/service.py、tools/actions.py、engine.py）：
 *   goto / url / title / evaluate / click / fill / screenshot / innerText
 *   go_back / viewport_size / mouse.click / keyboard.press / keyboard.type / context.pages
 */

export interface GotoOptions {
  waitUntil?: string;
  timeout?: number;
}

export interface SelectorOptions {
  timeout?: number;
}

export interface ScreenshotOptions {
  type?: "png" | "jpeg";
  fullPage?: boolean;
  timeout?: number;
}

export interface MouseLike {
  click(x: number, y: number): Promise<void>;
}

export interface KeyboardLike {
  press(key: string): Promise<void>;
  type(text: string): Promise<void>;
}

/** page.context() 返回值中本引擎用到的部分 */
export interface BrowserContextLike {
  pages(): BrowserPageLike[];
}

/** Playwright Page 的结构化子集 */
export interface BrowserPageLike {
  url(): string;
  title(): Promise<string>;
  goto(url: string, options?: GotoOptions): Promise<unknown>;
  evaluate<R = unknown>(pageFunction: string | ((...args: never[]) => unknown), arg?: unknown): Promise<R>;
  click(selector: string, options?: SelectorOptions): Promise<void>;
  fill(selector: string, value: string, options?: SelectorOptions): Promise<void>;
  screenshot(options?: ScreenshotOptions): Promise<Uint8Array>;
  innerText(selector: string): Promise<string>;
  goBack(): Promise<unknown>;
  viewportSize(): { width: number; height: number } | null;
  mouse: MouseLike;
  keyboard: KeyboardLike;
  context(): BrowserContextLike | null;
}

/** 日志钩子：Python 侧是 logging.getLogger(__name__)，这里由调用方注入，默认丢弃 */
export type LogFn = (message: string) => void;

export const noopLog: LogFn = () => {};
