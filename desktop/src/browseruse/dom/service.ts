/**
 * BrowserUse Engine - DOM 提取服务（Node 重写）
 * 对标 core/browseruse_engine/dom/service.py
 *
 * 移植差异：
 *   - 类名 DOMService → DomService（下游 tools/agent 约定的命名），行为完全一致
 *   - page 参数类型由 Playwright 的 Page 改成 ../page.ts 的 BrowserPageLike 结构化子集，
 *     本文件不 import playwright
 *   - Playwright JS API 与 Python API 的差异：page.url（属性）→ page.url()，
 *     page.context（属性）→ page.context()，context.pages（属性）→ context.pages()
 *   - 截图：Python 的 page.screenshot(type="png", timeout=10000) 返回 bytes 再 base64；
 *     Node 侧 screenshot() 返回 Uint8Array，用 Buffer.from(bytes).toString("base64") 转换，
 *     产物字符串等价
 *   - logging.getLogger() 的 debug/warning/error → 构造时注入的 LogFn（默认 noopLog）；
 *     LogFn 只有一个 message 参数，**日志级别信息被丢弃**，文案与 Python 逐字一致
 *   - Python 的 Dict[int, ...] → Map；tuple[float, float] → [number, number]
 *   - EXTRACT_ELEMENTS_JS 逐字复制自 service.py:21-224，只对模板字面量里的反引号与
 *     `${` 做了 TS 层面的转义（运行时字符串内容完全相同），选择器列表、可见性阈值、
 *     属性白名单、索引起始值 1、100/200 截断长度一个字符都没改
 */

import {
  createBrowserState,
  createDomElement,
  createDomTree,
  type BrowserState,
  type DOMElement,
  type DOMTree,
  type Rect,
} from "../types.ts";
import { noopLog, type BrowserPageLike, type LogFn } from "../page.ts";
import {
  createDomSnapshot,
  createSelectorMap,
  getSnapshotCoordinates,
  getSnapshotElement,
  getSnapshotSelector,
  type DOMSnapshot,
} from "./views.ts";

// ==================== JavaScript 提取脚本 ====================

// 提取可交互元素的 JavaScript 代码
export const EXTRACT_ELEMENTS_JS = `
() => {
    const INTERACTIVE_TAGS = new Set([
        'a', 'button', 'input', 'select', 'textarea', 'option',
        'label', 'details', 'summary', 'dialog', 'menu', 'menuitem'
    ]);

    const INTERACTIVE_ROLES = new Set([
        'button', 'link', 'menuitem', 'option', 'radio', 'switch',
        'tab', 'checkbox', 'combobox', 'listbox', 'menu', 'menubar',
        'searchbox', 'slider', 'spinbutton', 'textbox', 'treeitem'
    ]);

    const CLICKABLE_ATTRIBUTES = ['onclick', 'ng-click', '@click', 'v-on:click'];

    function isElementVisible(el) {
        if (!el) return false;

        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
        }

        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return false;
        }

        // 检查是否在视口范围内 (允许部分可见)
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        if (rect.right < 0 || rect.bottom < 0 || rect.left > viewportWidth || rect.top > viewportHeight) {
            return false;
        }

        return true;
    }

    function isInteractive(el) {
        const tagName = el.tagName.toLowerCase();

        // 检查标签名
        if (INTERACTIVE_TAGS.has(tagName)) {
            return true;
        }

        // 检查 role 属性
        const role = el.getAttribute('role');
        if (role && INTERACTIVE_ROLES.has(role.toLowerCase())) {
            return true;
        }

        // 检查 tabindex
        if (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') {
            return true;
        }

        // 检查点击事件属性
        for (const attr of CLICKABLE_ATTRIBUTES) {
            if (el.hasAttribute(attr)) {
                return true;
            }
        }

        // 检查 contenteditable
        if (el.isContentEditable) {
            return true;
        }

        return false;
    }

    function getElementText(el) {
        // 优先使用特定属性
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return ariaLabel.trim();

        const title = el.getAttribute('title');
        if (title) return title.trim();

        const placeholder = el.getAttribute('placeholder');
        if (placeholder) return placeholder.trim();

        const altText = el.getAttribute('alt');
        if (altText) return altText.trim();

        // 获取直接文本内容
        let text = '';
        for (const node of el.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
                text += node.textContent;
            }
        }
        text = text.trim();
        if (text) return text;

        // 获取内部文本
        const innerText = el.innerText || el.textContent || '';
        return innerText.trim().substring(0, 100);  // 限制长度
    }

    function getUniqueSelector(el) {
        // 尝试生成唯一 CSS 选择器
        if (el.id) {
            return \`#\${CSS.escape(el.id)}\`;
        }

        // 使用属性组合
        const tagName = el.tagName.toLowerCase();
        let selector = tagName;

        // 添加类名
        if (el.className && typeof el.className === 'string') {
            const classes = el.className.split(' ').filter(c => c.trim());
            if (classes.length > 0) {
                selector += '.' + classes.slice(0, 2).map(c => CSS.escape(c)).join('.');
            }
        }

        // 添加特定属性
        for (const attr of ['name', 'type', 'placeholder', 'aria-label']) {
            const value = el.getAttribute(attr);
            if (value) {
                selector += \`[\${attr}="\${CSS.escape(value)}"]\`;
                break;
            }
        }

        return selector;
    }

    function extractElements() {
        const elements = [];
        let index = 1;

        // 获取所有元素
        const allElements = document.querySelectorAll('*');

        for (const el of allElements) {
            // 跳过脚本和样式
            const tagName = el.tagName.toLowerCase();
            if (['script', 'style', 'noscript', 'svg', 'path'].includes(tagName)) {
                continue;
            }

            // 检查可见性和交互性
            if (!isElementVisible(el) || !isInteractive(el)) {
                continue;
            }

            const rect = el.getBoundingClientRect();
            const text = getElementText(el);
            const selector = getUniqueSelector(el);

            // 收集属性
            const attributes = {};
            for (const attr of ['href', 'type', 'name', 'value', 'placeholder', 'src', 'alt']) {
                const value = el.getAttribute(attr);
                if (value) {
                    attributes[attr] = value.substring(0, 100);
                }
            }

            elements.push({
                index: index,
                tag_name: tagName,
                text: text.substring(0, 200),
                role: el.getAttribute('role') || '',
                attributes: attributes,
                is_interactive: true,
                is_visible: true,
                bounding_box: {
                    x: rect.left + window.scrollX,
                    y: rect.top + window.scrollY,
                    width: rect.width,
                    height: rect.height
                },
                selector: selector,
                center_x: rect.left + rect.width / 2,
                center_y: rect.top + rect.height / 2
            });

            index++;
        }

        return {
            elements: elements,
            page_url: window.location.href,
            page_title: document.title,
            viewport: {
                width: window.innerWidth,
                height: window.innerHeight
            },
            scroll_position: {
                x: window.scrollX,
                y: window.scrollY
            }
        };
    }

    return extractElements();
}
`;

// ==================== 注入脚本的返回结构 ====================

/** EXTRACT_ELEMENTS_JS 返回的单个元素（字段名与脚本 push 的对象逐字一致） */
export interface RawExtractedElement {
  index: number;
  tag_name: string;
  text?: string;
  role?: string;
  attributes?: Record<string, string>;
  is_interactive?: boolean;
  is_visible?: boolean;
  bounding_box?: { x?: number; y?: number; width?: number; height?: number } | null;
  selector?: string;
  center_x?: number;
  center_y?: number;
}

/** EXTRACT_ELEMENTS_JS 的整体返回值 */
export interface RawExtractResult {
  elements?: RawExtractedElement[];
  page_url?: string;
  page_title?: string;
  viewport?: Record<string, number>;
  scroll_position?: Record<string, number>;
}

/** DomService 构造选项 —— Python 的 __init__ 只有 page，log 是 Node 侧新增的日志出口 */
export interface DomServiceOptions {
  log?: LogFn;
}

// ==================== DOM 服务类 ====================

/**
 * DOM 提取服务 —— 对标 DOMService
 *
 * 从 Playwright Page 提取可交互元素，生成索引化的 DOM 树。
 */
export class DomService {
  private readonly page: BrowserPageLike;
  private readonly log: LogFn;
  private lastSnapshot: DOMSnapshot | null = null;
  private previousIndices: Set<number> = new Set<number>();

  constructor(page: BrowserPageLike, options: DomServiceOptions = {}) {
    this.page = page;
    this.log = options.log ?? noopLog;
  }

  /**
   * 提取页面 DOM 树 —— 对标 extract_dom(mark_new=True)
   *
   * @param markNew 是否标记新出现的元素
   */
  async extractDom(markNew = true): Promise<DOMTree> {
    // Python 用 time.time() 计时，这里用 performance.now()（同为浮点毫秒，精度对齐）
    const startTime = performance.now();

    try {
      // 执行 JavaScript 提取
      const result = (await this.page.evaluate<RawExtractResult>(EXTRACT_ELEMENTS_JS)) ?? {};

      // 转换为 DOMElement 列表
      const elements: DOMElement[] = [];
      const currentIndices = new Set<number>();

      for (const item of result.elements ?? []) {
        const bbox = item.bounding_box;
        // Python: `Rect(...) if bbox else None`，空 dict 为假值，这里对齐成"空对象也算无"
        const rect: Rect | null =
          bbox && Object.keys(bbox).length > 0
            ? {
                x: bbox.x ?? 0,
                y: bbox.y ?? 0,
                width: bbox.width ?? 0,
                height: bbox.height ?? 0,
              }
            : null;

        const element = createDomElement({
          index: item.index,
          tag_name: item.tag_name,
          text: item.text ?? "",
          role: item.role ?? "",
          attributes: item.attributes ?? {},
          is_interactive: item.is_interactive ?? true,
          is_visible: item.is_visible ?? true,
          is_new: markNew && !this.previousIndices.has(item.index),
          bounding_box: rect,
          selector: item.selector ?? "",
        });
        elements.push(element);
        currentIndices.add(item.index);
      }

      // 更新历史索引
      this.previousIndices = currentIndices;

      // 创建 DOM 树
      // Python 的 time.time() 是"秒"（浮点），这里保持同一量纲：Date.now() / 1000
      const domTree = createDomTree({
        elements,
        page_url: result.page_url ?? "",
        page_title: result.page_title ?? "",
        timestamp: Date.now() / 1000,
      });

      // 创建选择器映射
      const selectorMap = createSelectorMap();
      for (const item of result.elements ?? []) {
        const idx = item.index;
        selectorMap.css_selectors.set(idx, item.selector ?? "");
        selectorMap.coordinates.set(idx, [item.center_x ?? 0, item.center_y ?? 0]);
      }

      // 保存快照
      this.lastSnapshot = createDomSnapshot({
        dom_tree: domTree,
        selector_map: selectorMap,
        viewport: result.viewport ?? {},
        scroll_position: result.scroll_position ?? {},
      });

      const duration = performance.now() - startTime;
      this.log(`DOM 提取完成: ${elements.length} 个元素, ${duration.toFixed(1)}ms`);

      return domTree;
    } catch (e) {
      this.log(`DOM 提取失败: ${errorText(e)}`);
      return createDomTree();
    }
  }

  /**
   * 获取完整的浏览器状态 —— 对标 get_browser_state(include_screenshot=False)
   */
  async getBrowserState(options: { includeScreenshot?: boolean } = {}): Promise<BrowserState> {
    const includeScreenshot = options.includeScreenshot ?? false;

    // 提取 DOM
    const domTree = await this.extractDom();

    // 获取页面信息
    const url = this.page.url();
    const title = await this.page.title();

    // 获取标签页信息
    // BrowserState.tabs 的类型是 Record<string, string>[]，但 Python 里 index 存的是 int，
    // 为保持对拍值一致这里照存数字，仅在类型层面做一次断言。
    let tabs: Record<string, string>[] = [];
    try {
      const context = this.page.context();
      if (!context) {
        throw new Error("context is null");
      }
      const pages = context.pages();
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        if (!page) continue;
        tabs.push({
          index: i,
          url: page.url(),
          title: page === this.page ? await page.title() : "",
        } as unknown as Record<string, string>);
      }
    } catch {
      tabs = [{ index: 0, url, title } as unknown as Record<string, string>];
    }

    // 截图
    let screenshotBase64: string | null = null;
    if (includeScreenshot) {
      try {
        const screenshotBytes = await this.page.screenshot({ type: "png", timeout: 10000 });
        // Python: base64.b64encode(bytes).decode()
        screenshotBase64 = Buffer.from(screenshotBytes).toString("base64");
      } catch (e) {
        this.log(`截图失败: ${errorText(e)}`);
      }
    }

    return createBrowserState({
      url,
      title,
      dom_tree: domTree,
      screenshot_base64: screenshotBase64,
      tabs,
      active_tab_index: 0,
    });
  }

  /** 根据索引获取元素 —— 对标 get_element_by_index() */
  getElementByIndex(index: number): DOMElement | null {
    if (this.lastSnapshot) {
      return getSnapshotElement(this.lastSnapshot, index);
    }
    return null;
  }

  /** 根据索引获取选择器 —— 对标 get_selector_by_index() */
  getSelectorByIndex(index: number): string | null {
    if (this.lastSnapshot) {
      return getSnapshotSelector(this.lastSnapshot, index);
    }
    return null;
  }

  /** 根据索引获取坐标 —— 对标 get_coordinates_by_index()（Python 返回 tuple） */
  getCoordinatesByIndex(index: number): [number, number] | null {
    if (this.lastSnapshot) {
      return getSnapshotCoordinates(this.lastSnapshot, index);
    }
    return null;
  }

  /**
   * 高亮显示指定元素 (调试用) —— 对标 highlight_element(index, color="red")
   *
   * 注入脚本逐字复制自 service.py:412-424（Python 用 f-string 插 color，
   * 这里用模板字面量插同一个变量）。
   */
  async highlightElement(index: number, color = "red"): Promise<boolean> {
    const selector = this.getSelectorByIndex(index);
    if (!selector) {
      return false;
    }

    try {
      await this.page.evaluate(
        `
                (selector) => {
                    const el = document.querySelector(selector);
                    if (el) {
                        el.style.outline = '3px solid ${color}';
                        el.style.outlineOffset = '2px';
                        setTimeout(() => {
                            el.style.outline = '';
                            el.style.outlineOffset = '';
                        }, 2000);
                    }
                }
            `,
        selector,
      );
      return true;
    } catch (e) {
      this.log(`高亮元素失败: ${errorText(e)}`);
      return false;
    }
  }
}

/** 异常 → 文本（对齐 Python f"{e}" 的效果：只取消息体） */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
