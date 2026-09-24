/**
 * Playwright 兼容层
 *
 * 背景：automation 层有两个文件（auto_replace_email / auto_replace_phone）
 * 不使用 AI 引擎，而是用**确定性选择器**直连 ixBrowser 操作页面。
 * 它们只依赖 Playwright 的一小组能力（goto/fill/locator/wait_for_selector/keyboard）。
 *
 * 这里把 Stagehand 的 V3 Page 适配成等价接口，好处：
 *   - 复用已经建立的 CDP 连接，不用再拉一个 playwright 依赖
 * - 两个脚本的不需要改动逻辑结构
 *
 * 与 Playwright 的差异（已在本层抹平）：
 *   - V3 的 locator.first() 是方法，Playwright 是属性 → 统一成方法
 *   - V3 没有 waitForSelector → 用轮询 count() + isVisible() 实现，
 *     语义对齐 Playwright 的 state='visible' 与超时抛错行为
 */

/** 选择器定位器（只暴露脚本用到的能力） */
export interface CompatLocator {
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  /** 取第一个匹配元素。注意是方法而非 Playwright 的属性 */
  first(): CompatLocator;
}

export interface WaitForSelectorOptions {
  /** 只支持 visible / attached——脚本里只用到这两个 */
  state?: "visible" | "attached";
  timeout?: number;
}

/** Playwright Page 的兼容接口 */
export interface CompatPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  locator(selector: string): CompatLocator;
  /** 超时抛错（与 Playwright 一致），调用方用 try/catch 处理 */
  waitForSelector(
    selector: string,
    options?: WaitForSelectorOptions,
  ): Promise<CompatLocator>;
  keyboard: { press(key: string): Promise<void> };
  /** 页面可见文本（这些脚本用它做关键词判断） */
  content(): Promise<string>;
  waitForTimeout(ms: number): Promise<void>;
}

/** V3 Page 中本层用到的方法 */
export interface V3PageLike {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  url(): string;
  evaluate?<R = unknown>(fn: string | ((arg?: unknown) => R | Promise<R>), arg?: unknown): Promise<R>;
  locator?(selector: string): unknown;
  keyPress?(key: string): Promise<void>;
  keyboard?: { type(text: string): Promise<void> };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 把 V3 的 Locator 包装成 CompatLocator。
 * 对不存在的底层能力做安全降级（返回 0 / false 而非抛错），
 * 因为脚本里大量使用 try/except 形式的选择器探测。
 */
function wrapLocator(raw: unknown): CompatLocator {
  const r = (raw ?? {}) as Record<string, unknown>;
  const call = async (name: string): Promise<unknown> => {
    const fn = r[name];
    if (typeof fn !== "function") return undefined;
    return (fn as () => Promise<unknown>).call(r);
  };

  return {
    async count() {
      const v = await call("count");
      return typeof v === "number" ? v : 0;
    },
    async isVisible() {
      const v = await call("isVisible");
      return v === true;
    },
    async click() {
      const fn = r["click"];
      if (typeof fn !== "function") throw new Error("locator.click 不可用");
      await (fn as () => Promise<void>).call(r);
    },
    async fill(value: string) {
      const fn = r["fill"];
      if (typeof fn !== "function") throw new Error("locator.fill 不可用");
      await (fn as (v: string) => Promise<void>).call(r, value);
    },
    first(): CompatLocator {
      const fn = r["first"];
      if (typeof fn !== "function") return wrapLocator(raw);
      return wrapLocator((fn as () => unknown).call(r));
    },
  };
}

/**
 * 由 V3 Page 构造 Playwright 兼容页。
 * sleep 可注入，便于测试。
 */
export function createCompatPage(
  page: V3PageLike,
  options: { sleepImpl?: (ms: number) => Promise<void> } = {},
): CompatPage {
  const sleep = options.sleepImpl ?? defaultSleep;

  const getPageText = async (): Promise<string> => {
    if (typeof page.evaluate === "function") {
      try {
        const t = await page.evaluate<string>(
          "document.body ? document.body.innerText : ''",
        );
        if (typeof t === "string") return t;
      } catch {
        /* 落到空串 */
      }
    }
    return "";
  };

  const rawLocator = (selector: string): unknown => {
    if (typeof page.locator !== "function") {
      throw new Error("当前页面不支持 locator（V3 Page 能力缺失）");
    }
    return page.locator(selector);
  };

  return {
    async goto(url, opts) {
      await page.goto(url, {
        waitUntil: opts?.waitUntil ?? "domcontentloaded",
        timeout: opts?.timeout,
      });
    },

    async fill(selector, value) {
      const loc = wrapLocator(rawLocator(selector)).first();
      await loc.fill(value);
    },

    locator(selector) {
      return wrapLocator(rawLocator(selector));
    },

    async waitForSelector(selector, opts = {}) {
      const state = opts.state ?? "visible";
      const timeout = opts.timeout ?? 30_000;
      const deadline = Date.now() + timeout;

      for (;;) {
        try {
          const loc = wrapLocator(rawLocator(selector)).first();
          const n = await loc.count();
          if (n > 0) {
            if (state === "attached") return loc;
            if (await loc.isVisible()) return loc;
          }
        } catch {
          /* 单次探测失败不终止，继续等 */
        }

        if (Date.now() >= deadline) {
          throw new Error(
            `waitForSelector 超时: ${selector}（state=${state}, timeout=${timeout}ms）`,
          );
        }
        await sleep(200);
      }
    },

    keyboard: {
      async press(key: string) {
        if (typeof page.keyPress === "function") {
          await page.keyPress(key);
          return;
        }
        // 降级：单个可打印字符走 type
        if (page.keyboard && typeof page.keyboard.type === "function") {
          if (key === "Enter") throw new Error("当前页面不支持 Enter 键，需 keyPress 能力");
          await page.keyboard.type(key);
          return;
        }
        throw new Error("当前页面不支持键盘输入");
      },
    },

    content: getPageText,

    async waitForTimeout(ms) {
      await sleep(ms);
    },
  };
}