"""
BrowserUse Engine - DOM 提取服务

从 Playwright Page 提取可交互元素，生成索引化的 DOM 树。
"""

import asyncio
import logging
import time
from typing import Optional, List, Dict, Any, Set

from ..types import DOMElement, DOMTree, Rect, BrowserState
from .views import SelectorMap, DOMSnapshot

logger = logging.getLogger(__name__)


# ==================== JavaScript 提取脚本 ====================

# 提取可交互元素的 JavaScript 代码
EXTRACT_ELEMENTS_JS = """
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
            return `#${CSS.escape(el.id)}`;
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
                selector += `[${attr}="${CSS.escape(value)}"]`;
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
"""


# ==================== DOM 服务类 ====================

class DOMService:
    """
    DOM 提取服务

    从 Playwright Page 提取可交互元素，生成索引化的 DOM 树。
    """

    def __init__(self, page: Any):
        """
        初始化 DOM 服务

        Args:
            page: Playwright Page 对象
        """
        self.page = page
        self._last_snapshot: Optional[DOMSnapshot] = None
        self._previous_indices: Set[int] = set()

    async def extract_dom(self, mark_new: bool = True) -> DOMTree:
        """
        提取页面 DOM 树

        Args:
            mark_new: 是否标记新出现的元素

        Returns:
            DOMTree
        """
        start_time = time.time()

        try:
            # 执行 JavaScript 提取
            result = await self.page.evaluate(EXTRACT_ELEMENTS_JS)

            # 转换为 DOMElement 列表
            elements = []
            current_indices = set()

            for item in result.get("elements", []):
                bbox = item.get("bounding_box", {})
                rect = Rect(
                    x=bbox.get("x", 0),
                    y=bbox.get("y", 0),
                    width=bbox.get("width", 0),
                    height=bbox.get("height", 0),
                ) if bbox else None

                element = DOMElement(
                    index=item["index"],
                    tag_name=item["tag_name"],
                    text=item.get("text", ""),
                    role=item.get("role", ""),
                    attributes=item.get("attributes", {}),
                    is_interactive=item.get("is_interactive", True),
                    is_visible=item.get("is_visible", True),
                    is_new=mark_new and item["index"] not in self._previous_indices,
                    bounding_box=rect,
                    selector=item.get("selector", ""),
                )
                elements.append(element)
                current_indices.add(item["index"])

            # 更新历史索引
            self._previous_indices = current_indices

            # 创建 DOM 树
            dom_tree = DOMTree(
                elements=elements,
                page_url=result.get("page_url", ""),
                page_title=result.get("page_title", ""),
                timestamp=time.time(),
            )

            # 创建选择器映射
            selector_map = SelectorMap()
            for item in result.get("elements", []):
                idx = item["index"]
                selector_map.css_selectors[idx] = item.get("selector", "")
                selector_map.coordinates[idx] = (
                    item.get("center_x", 0),
                    item.get("center_y", 0)
                )

            # 保存快照
            self._last_snapshot = DOMSnapshot(
                dom_tree=dom_tree,
                selector_map=selector_map,
                viewport=result.get("viewport", {}),
                scroll_position=result.get("scroll_position", {}),
            )

            duration = (time.time() - start_time) * 1000
            logger.debug(f"DOM 提取完成: {len(elements)} 个元素, {duration:.1f}ms")

            return dom_tree

        except Exception as e:
            logger.error(f"DOM 提取失败: {e}")
            return DOMTree()

    async def get_browser_state(self, include_screenshot: bool = False) -> BrowserState:
        """
        获取完整的浏览器状态

        Args:
            include_screenshot: 是否包含截图

        Returns:
            BrowserState
        """
        # 提取 DOM
        dom_tree = await self.extract_dom()

        # 获取页面信息
        url = self.page.url
        title = await self.page.title()

        # 获取标签页信息
        tabs = []
        try:
            context = self.page.context
            for i, page in enumerate(context.pages):
                tabs.append({
                    "index": i,
                    "url": page.url,
                    "title": await page.title() if page == self.page else "",
                })
        except Exception:
            tabs = [{"index": 0, "url": url, "title": title}]

        # 截图
        screenshot_base64 = None
        if include_screenshot:
            try:
                screenshot_bytes = await self.page.screenshot(type="png")
                import base64
                screenshot_base64 = base64.b64encode(screenshot_bytes).decode()
            except Exception as e:
                logger.warning(f"截图失败: {e}")

        return BrowserState(
            url=url,
            title=title,
            dom_tree=dom_tree,
            screenshot_base64=screenshot_base64,
            tabs=tabs,
            active_tab_index=0,
        )

    def get_element_by_index(self, index: int) -> Optional[DOMElement]:
        """根据索引获取元素"""
        if self._last_snapshot:
            return self._last_snapshot.get_element(index)
        return None

    def get_selector_by_index(self, index: int) -> Optional[str]:
        """根据索引获取选择器"""
        if self._last_snapshot:
            return self._last_snapshot.get_selector(index)
        return None

    def get_coordinates_by_index(self, index: int) -> Optional[tuple[float, float]]:
        """根据索引获取坐标"""
        if self._last_snapshot:
            return self._last_snapshot.get_coordinates(index)
        return None

    async def highlight_element(self, index: int, color: str = "red") -> bool:
        """
        高亮显示指定元素 (调试用)

        Args:
            index: 元素索引
            color: 高亮颜色

        Returns:
            是否成功
        """
        selector = self.get_selector_by_index(index)
        if not selector:
            return False

        try:
            await self.page.evaluate(f"""
                (selector) => {{
                    const el = document.querySelector(selector);
                    if (el) {{
                        el.style.outline = '3px solid {color}';
                        el.style.outlineOffset = '2px';
                        setTimeout(() => {{
                            el.style.outline = '';
                            el.style.outlineOffset = '';
                        }}, 2000);
                    }}
                }}
            """, selector)
            return True
        except Exception as e:
            logger.warning(f"高亮元素失败: {e}")
            return False
