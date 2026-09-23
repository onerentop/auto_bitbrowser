/**
 * BrowserUse Engine - CDP 连接器（Node 重写）
 *
 * Python 侧 engine.py 直接 `from playwright.async_api import async_playwright`
 * 然后 `chromium.connect_over_cdp(ws)`。Node 侧把这段抽成可注入的连接器：
 *   - 默认实现用 `playwright-core`，且是**惰性动态 import**
 *     （模块顶层不 import，保证单测与 typecheck 全程离线、不加载浏览器驱动）
 *   - 测试里注入假连接器即可跑通引擎生命周期
 *
 * 与 Python 的对应关系：
 *   connect(ws)   ≈ connect_over_cdp + 取 contexts[0].pages[0]（没有就 new_page）
 *   launchLocal() ≈ chromium.launch(headless=False) + new_context + new_page
 *   close()       ≈ browser.close()
 *   dispose()     ≈ playwright.stop()
 */
import type { BrowserPageLike } from "./page.ts";

/** 一次连接的句柄 */
export interface CdpConnection {
  page: BrowserPageLike;
  /** 断开浏览器连接（CDP 模式下不会关掉 ixBrowser 窗口本身） */
  close(): Promise<void>;
  /** 释放底层 playwright 实例 */
  dispose(): Promise<void>;
  /** 本地模式下额外持有的 context，关闭顺序与 Python 一致 */
  closeContext?(): Promise<void>;
}

export interface CdpConnector {
  connect(wsEndpoint: string): Promise<CdpConnection>;
  launchLocal(): Promise<CdpConnection>;
}

/** playwright-core 的最小结构（避免把它的类型硬编码进编译期依赖） */
interface PwBrowserLike {
  contexts(): PwContextLike[];
  newContext(): Promise<PwContextLike>;
  close(): Promise<void>;
}
interface PwContextLike {
  pages(): BrowserPageLike[];
  newPage(): Promise<BrowserPageLike>;
  close(): Promise<void>;
}
interface PwChromiumLike {
  connectOverCDP(endpoint: string): Promise<PwBrowserLike>;
  launch(options?: { headless?: boolean }): Promise<PwBrowserLike>;
}
interface PwModuleLike {
  chromium: PwChromiumLike;
}

/** 从 browser 里取出第一个页面，取不到就新建（对齐 Python 的分支） */
async function pickPage(browser: PwBrowserLike): Promise<{ page: BrowserPageLike; context: PwContextLike }> {
  const contexts = browser.contexts();
  const first = contexts[0];
  if (first) {
    const pages = first.pages();
    const page = pages[0] ?? (await first.newPage());
    return { page, context: first };
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  return { page, context };
}

/**
 * 默认连接器：惰性加载 playwright-core。
 * 没装 playwright-core 时，只在**真正连接**的那一刻抛错，不影响导入本模块。
 */
export function createPlaywrightConnector(): CdpConnector {
  const loadPlaywright = async (): Promise<PwModuleLike> => {
    try {
      // 动态 import：模块加载期不触碰 playwright
      return (await import("playwright-core")) as unknown as PwModuleLike;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`playwright-core 不可用，无法建立 CDP 连接: ${msg}`);
    }
  };

  const wrap = (browser: PwBrowserLike, page: BrowserPageLike, context: PwContextLike): CdpConnection => ({
    page,
    async close() {
      await browser.close();
    },
    async dispose() {
      // playwright-core 的 Node 版没有独立的 playwright.stop()，
      // 进程内驱动随 browser.close() 释放。这里保留空实现以对齐 Python 的 stop() 结构。
    },
    async closeContext() {
      await context.close();
    },
  });

  return {
    async connect(wsEndpoint: string): Promise<CdpConnection> {
      const pw = await loadPlaywright();
      const browser = await pw.chromium.connectOverCDP(wsEndpoint);
      try {
        const { page, context } = await pickPage(browser);
        return wrap(browser, page, context);
      } catch (e) {
        // 取页面失败时必须把已建立的连接关掉，否则 ixBrowser 窗口一直被占用。
        // Python 侧因为先把 browser 存进 self._browser，异常由 connect_cdp 的
        // except 分支兜底关闭；这里连接句柄还没交出去，只能就地清理。
        try {
          await browser.close();
        } catch {
          /* 清理失败不掩盖原始异常 */
        }
        throw e;
      }
    },

    async launchLocal(): Promise<CdpConnection> {
      const pw = await loadPlaywright();
      const browser = await pw.chromium.launch({ headless: false });
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        return wrap(browser, page, context);
      } catch (e) {
        try {
          await browser.close();
        } catch {
          /* 同上 */
        }
        throw e;
      }
    },
  };
}
