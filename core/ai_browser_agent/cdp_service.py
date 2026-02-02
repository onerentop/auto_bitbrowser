"""
CDP DOM 服务模块

使用 Chrome DevTools Protocol 提供高效的 DOM 操作能力
参考 browser-use 的 CDP 快照设计

Features:
- CDP Session 管理
- 高效的 DOM 快照获取
- 可访问性树 (Accessibility Tree) 支持
- DPR (Device Pixel Ratio) 坐标转换
"""

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, List, Tuple
from contextlib import asynccontextmanager

from playwright.async_api import Page, CDPSession

logger = logging.getLogger("ai_browser_agent.cdp")


@dataclass
class DOMNode:
    """DOM 节点信息"""
    node_id: int
    backend_node_id: int
    node_type: int  # 1=Element, 3=Text, etc.
    node_name: str
    local_name: str = ""
    node_value: str = ""
    attributes: Dict[str, str] = field(default_factory=dict)
    children: List["DOMNode"] = field(default_factory=list)
    bounding_box: Optional[Dict[str, float]] = None
    is_visible: bool = True

    @property
    def is_element(self) -> bool:
        return self.node_type == 1

    @property
    def is_text(self) -> bool:
        return self.node_type == 3


@dataclass
class AccessibilityNode:
    """可访问性节点信息"""
    node_id: str
    role: str
    name: str = ""
    description: str = ""
    value: str = ""
    properties: Dict[str, Any] = field(default_factory=dict)
    children: List["AccessibilityNode"] = field(default_factory=list)
    backend_dom_node_id: Optional[int] = None
    bounding_box: Optional[Dict[str, float]] = None

    @property
    def is_interactive(self) -> bool:
        """是否是可交互元素"""
        interactive_roles = {
            "button", "link", "textbox", "checkbox", "radio",
            "combobox", "listbox", "menu", "menuitem", "tab",
            "switch", "slider", "spinbutton", "searchbox"
        }
        return self.role.lower() in interactive_roles


class CDPDOMService:
    """
    CDP DOM 服务

    提供基于 Chrome DevTools Protocol 的高效 DOM 操作
    """

    def __init__(self, page: Page):
        """
        初始化 CDP DOM 服务

        Args:
            page: Playwright Page 对象
        """
        self.page = page
        self._cdp_session: Optional[CDPSession] = None
        self._dpr: float = 1.0  # Device Pixel Ratio
        self._viewport_size: Tuple[int, int] = (0, 0)

    async def _ensure_cdp_session(self) -> CDPSession:
        """确保 CDP 会话已创建"""
        if self._cdp_session is None:
            context = self.page.context
            self._cdp_session = await context.new_cdp_session(self.page)

            # 获取 DPR
            try:
                result = await self._cdp_session.send("Runtime.evaluate", {
                    "expression": "window.devicePixelRatio",
                    "returnByValue": True
                })
                dpr_value = result.get("result", {}).get("value", 1.0)
                self._dpr = float(dpr_value) if dpr_value else 1.0
            except Exception:
                self._dpr = 1.0

        return self._cdp_session

    async def close(self):
        """关闭 CDP 会话"""
        if self._cdp_session:
            try:
                await self._cdp_session.detach()
            except Exception:
                pass
            self._cdp_session = None

    @asynccontextmanager
    async def session(self):
        """CDP 会话上下文管理器"""
        try:
            cdp = await self._ensure_cdp_session()
            yield cdp
        finally:
            pass  # 保持会话开放以复用

    # ============ 视口和坐标 ============

    async def get_device_pixel_ratio(self) -> float:
        """获取设备像素比"""
        try:
            cdp = await self._ensure_cdp_session()
            result = await cdp.send("Runtime.evaluate", {
                "expression": "window.devicePixelRatio",
                "returnByValue": True
            })
            return result.get("result", {}).get("value", 1.0)
        except Exception as e:
            logger.warning(f"获取 DPR 失败: {e}")
            return 1.0

    async def get_viewport_size(self) -> Tuple[int, int]:
        """获取视口尺寸"""
        try:
            cdp = await self._ensure_cdp_session()
            metrics = await cdp.send("Page.getLayoutMetrics")
            viewport = metrics.get("cssLayoutViewport", {})
            return (
                int(viewport.get("clientWidth", 0)),
                int(viewport.get("clientHeight", 0))
            )
        except Exception as e:
            logger.warning(f"获取视口尺寸失败: {e}")
            return (0, 0)

    def convert_to_css_coords(
        self,
        device_x: float,
        device_y: float,
        dpr: float = None
    ) -> Tuple[float, float]:
        """
        设备坐标转换为 CSS 坐标

        Args:
            device_x: 设备 X 坐标
            device_y: 设备 Y 坐标
            dpr: 设备像素比（默认使用缓存值）

        Returns:
            (css_x, css_y)
        """
        if dpr is None:
            dpr = self._dpr
        return (device_x / dpr, device_y / dpr)

    def convert_to_device_coords(
        self,
        css_x: float,
        css_y: float,
        dpr: float = None
    ) -> Tuple[float, float]:
        """
        CSS 坐标转换为设备坐标

        Args:
            css_x: CSS X 坐标
            css_y: CSS Y 坐标
            dpr: 设备像素比

        Returns:
            (device_x, device_y)
        """
        if dpr is None:
            dpr = self._dpr
        return (css_x * dpr, css_y * dpr)

    # ============ DOM 操作 ============

    async def get_document(self, depth: int = -1) -> Optional[Dict]:
        """
        获取 DOM 文档

        Args:
            depth: 遍历深度（-1 = 完整文档）

        Returns:
            DOM 文档结构
        """
        try:
            cdp = await self._ensure_cdp_session()
            result = await cdp.send("DOM.getDocument", {
                "depth": depth,
                "pierce": True  # 穿透 Shadow DOM
            })
            return result.get("root")
        except Exception as e:
            logger.error(f"获取 DOM 文档失败: {e}")
            return None

    async def query_selector(self, selector: str) -> Optional[int]:
        """
        使用 CSS 选择器查询节点

        Args:
            selector: CSS 选择器

        Returns:
            节点 ID 或 None
        """
        try:
            cdp = await self._ensure_cdp_session()
            doc = await self.get_document(depth=0)
            if not doc:
                return None

            result = await cdp.send("DOM.querySelector", {
                "nodeId": doc["nodeId"],
                "selector": selector
            })
            node_id = result.get("nodeId", 0)
            return node_id if node_id > 0 else None
        except Exception as e:
            logger.warning(f"查询选择器失败: {e}")
            return None

    async def query_selector_all(self, selector: str) -> List[int]:
        """
        使用 CSS 选择器查询所有匹配节点

        Args:
            selector: CSS 选择器

        Returns:
            节点 ID 列表
        """
        try:
            cdp = await self._ensure_cdp_session()
            doc = await self.get_document(depth=0)
            if not doc:
                return []

            result = await cdp.send("DOM.querySelectorAll", {
                "nodeId": doc["nodeId"],
                "selector": selector
            })
            return result.get("nodeIds", [])
        except Exception as e:
            logger.warning(f"查询选择器失败: {e}")
            return []

    async def get_box_model(self, node_id: int) -> Optional[Dict]:
        """
        获取节点的盒模型

        Args:
            node_id: 节点 ID

        Returns:
            盒模型信息（包含 content, padding, border, margin）
        """
        try:
            cdp = await self._ensure_cdp_session()
            result = await cdp.send("DOM.getBoxModel", {
                "nodeId": node_id
            })
            return result.get("model")
        except Exception as e:
            logger.warning(f"获取盒模型失败: {e}")
            return None

    async def get_bounding_box(self, node_id: int) -> Optional[Dict[str, float]]:
        """
        获取节点边界框

        Args:
            node_id: 节点 ID

        Returns:
            {"x", "y", "width", "height"} 或 None
        """
        box_model = await self.get_box_model(node_id)
        if not box_model:
            return None

        # 使用 border 四边形计算边界框
        border = box_model.get("border", [])
        if len(border) < 8:
            return None

        # border 是 [x1, y1, x2, y2, x3, y3, x4, y4]
        x_coords = [border[i] for i in range(0, 8, 2)]
        y_coords = [border[i] for i in range(1, 8, 2)]

        return {
            "x": min(x_coords),
            "y": min(y_coords),
            "width": max(x_coords) - min(x_coords),
            "height": max(y_coords) - min(y_coords)
        }

    async def get_node_center(self, node_id: int) -> Optional[Tuple[float, float]]:
        """
        获取节点中心点坐标

        Args:
            node_id: 节点 ID

        Returns:
            (x, y) 或 None
        """
        bbox = await self.get_bounding_box(node_id)
        if not bbox:
            return None

        return (
            bbox["x"] + bbox["width"] / 2,
            bbox["y"] + bbox["height"] / 2
        )

    # ============ 可访问性树 ============

    async def get_accessibility_tree(
        self,
        depth: int = -1,
        interacting_only: bool = False
    ) -> List[AccessibilityNode]:
        """
        获取可访问性树

        Args:
            depth: 遍历深度
            interacting_only: 是否只返回可交互节点

        Returns:
            AccessibilityNode 列表
        """
        try:
            cdp = await self._ensure_cdp_session()

            # 获取完整的可访问性树
            result = await cdp.send("Accessibility.getFullAXTree", {
                "depth": depth
            })

            nodes = result.get("nodes", [])
            ax_nodes = []

            for node_data in nodes:
                ax_node = self._parse_ax_node(node_data)
                if ax_node:
                    if interacting_only and not ax_node.is_interactive:
                        continue
                    ax_nodes.append(ax_node)

            return ax_nodes

        except Exception as e:
            logger.error(f"获取可访问性树失败: {e}")
            return []

    def _parse_ax_node(self, node_data: Dict) -> Optional[AccessibilityNode]:
        """解析可访问性节点数据"""
        try:
            role_value = node_data.get("role", {})
            role = role_value.get("value", "") if isinstance(role_value, dict) else str(role_value)

            name_value = node_data.get("name", {})
            name = name_value.get("value", "") if isinstance(name_value, dict) else str(name_value)

            description_value = node_data.get("description", {})
            description = description_value.get("value", "") if isinstance(description_value, dict) else ""

            value_prop = node_data.get("value", {})
            value = value_prop.get("value", "") if isinstance(value_prop, dict) else ""

            return AccessibilityNode(
                node_id=node_data.get("nodeId", ""),
                role=role,
                name=name,
                description=description,
                value=value,
                properties={},
                backend_dom_node_id=node_data.get("backendDOMNodeId")
            )
        except Exception as e:
            logger.warning(f"解析可访问性节点失败: {e}")
            return None

    # ============ 快照功能 ============

    async def get_dom_snapshot(self) -> Dict[str, Any]:
        """
        获取完整的 DOM 快照

        高效的方式获取整个页面的 DOM 结构和样式信息

        Returns:
            DOM 快照数据
        """
        try:
            cdp = await self._ensure_cdp_session()

            # 使用 DOMSnapshot.captureSnapshot 获取高效快照
            result = await cdp.send("DOMSnapshot.captureSnapshot", {
                "computedStyles": ["display", "visibility", "opacity"],
                "includePaintOrder": True,
                "includeDOMRects": True
            })

            return result

        except Exception as e:
            logger.error(f"获取 DOM 快照失败: {e}")
            return {}

    async def get_interactive_elements_via_ax(self) -> List[Dict[str, Any]]:
        """
        通过可访问性树获取可交互元素

        这是一种高效的方式，直接从可访问性树获取可交互元素，
        不需要遍历整个 DOM

        Returns:
            可交互元素列表
        """
        try:
            ax_nodes = await self.get_accessibility_tree(interacting_only=True)

            elements = []
            for ax_node in ax_nodes:
                element = {
                    "role": ax_node.role,
                    "name": ax_node.name,
                    "description": ax_node.description,
                    "value": ax_node.value,
                    "backend_node_id": ax_node.backend_dom_node_id,
                }

                # 尝试获取边界框
                if ax_node.backend_dom_node_id:
                    try:
                        cdp = await self._ensure_cdp_session()
                        result = await cdp.send("DOM.getBoxModel", {
                            "backendNodeId": ax_node.backend_dom_node_id
                        })
                        if result and "model" in result:
                            border = result["model"].get("border", [])
                            if len(border) >= 8:
                                x_coords = [border[i] for i in range(0, 8, 2)]
                                y_coords = [border[i] for i in range(1, 8, 2)]
                                element["bounding_box"] = {
                                    "x": min(x_coords),
                                    "y": min(y_coords),
                                    "width": max(x_coords) - min(x_coords),
                                    "height": max(y_coords) - min(y_coords)
                                }
                    except Exception:
                        pass

                elements.append(element)

            return elements

        except Exception as e:
            logger.error(f"获取可交互元素失败: {e}")
            return []

    # ============ 输入操作 ============

    async def focus_node(self, node_id: int) -> bool:
        """聚焦到节点"""
        try:
            cdp = await self._ensure_cdp_session()
            await cdp.send("DOM.focus", {"nodeId": node_id})
            return True
        except Exception as e:
            logger.warning(f"聚焦节点失败: {e}")
            return False

    async def scroll_into_view(self, node_id: int) -> bool:
        """滚动节点到视图"""
        try:
            cdp = await self._ensure_cdp_session()
            await cdp.send("DOM.scrollIntoViewIfNeeded", {"nodeId": node_id})
            return True
        except Exception as e:
            logger.warning(f"滚动到节点失败: {e}")
            return False

    # ============ V2.3: Backend Node ID 操作 (借鉴 browser-use) ============

    async def focus_by_backend_node_id(self, backend_node_id: int) -> bool:
        """
        通过 Backend Node ID 聚焦元素

        Backend Node ID 是跨 CDP 会话稳定的唯一标识符，
        比普通 Node ID 更可靠。

        Args:
            backend_node_id: CDP Backend Node ID

        Returns:
            是否成功
        """
        try:
            cdp = await self._ensure_cdp_session()
            await cdp.send("DOM.focus", {"backendNodeId": backend_node_id})
            logger.debug(f"聚焦元素成功: backendNodeId={backend_node_id}")
            return True
        except Exception as e:
            logger.warning(f"通过 backendNodeId 聚焦失败: {e}")
            return False

    async def scroll_into_view_by_backend_node_id(self, backend_node_id: int) -> bool:
        """
        通过 Backend Node ID 滚动元素到视图

        Args:
            backend_node_id: CDP Backend Node ID

        Returns:
            是否成功
        """
        try:
            cdp = await self._ensure_cdp_session()
            await cdp.send("DOM.scrollIntoViewIfNeeded", {"backendNodeId": backend_node_id})
            logger.debug(f"滚动到元素成功: backendNodeId={backend_node_id}")
            return True
        except Exception as e:
            logger.warning(f"通过 backendNodeId 滚动失败: {e}")
            return False

    async def get_box_model_by_backend_node_id(self, backend_node_id: int) -> Optional[Dict]:
        """
        通过 Backend Node ID 获取元素盒模型

        Args:
            backend_node_id: CDP Backend Node ID

        Returns:
            盒模型信息或 None
        """
        try:
            cdp = await self._ensure_cdp_session()
            result = await cdp.send("DOM.getBoxModel", {"backendNodeId": backend_node_id})
            return result.get("model")
        except Exception as e:
            logger.warning(f"通过 backendNodeId 获取盒模型失败: {e}")
            return None

    async def get_center_by_backend_node_id(self, backend_node_id: int) -> Optional[Tuple[float, float]]:
        """
        通过 Backend Node ID 获取元素中心点坐标

        Args:
            backend_node_id: CDP Backend Node ID

        Returns:
            (x, y) 中心点坐标或 None
        """
        box_model = await self.get_box_model_by_backend_node_id(backend_node_id)
        if not box_model:
            return None

        border = box_model.get("border", [])
        if len(border) < 8:
            return None

        x_coords = [border[i] for i in range(0, 8, 2)]
        y_coords = [border[i] for i in range(1, 8, 2)]

        center_x = (min(x_coords) + max(x_coords)) / 2
        center_y = (min(y_coords) + max(y_coords)) / 2

        return (center_x, center_y)

    async def click_by_backend_node_id(
        self,
        backend_node_id: int,
        button: str = "left",
        click_count: int = 1,
        scroll_into_view: bool = True
    ) -> Tuple[bool, str]:
        """
        通过 Backend Node ID 点击元素

        这是最精确的点击方式，借鉴 browser-use 的实现：
        1. 滚动元素到视图
        2. 获取元素中心坐标
        3. 使用 CDP Input 事件点击

        Args:
            backend_node_id: CDP Backend Node ID
            button: 鼠标按钮 ("left", "right", "middle")
            click_count: 点击次数
            scroll_into_view: 是否先滚动到视图

        Returns:
            (success, message) 元组
        """
        try:
            # 1. 滚动到视图
            if scroll_into_view:
                scroll_ok = await self.scroll_into_view_by_backend_node_id(backend_node_id)
                if not scroll_ok:
                    logger.warning("滚动到视图失败，继续尝试点击")

            # 2. 获取中心坐标
            center = await self.get_center_by_backend_node_id(backend_node_id)
            if not center:
                return False, f"无法获取元素坐标: backendNodeId={backend_node_id}"

            x, y = center

            # 3. 执行点击
            click_ok = await self.click_at_coordinates(x, y, button, click_count)
            if click_ok:
                logger.debug(f"CDP 点击成功: backendNodeId={backend_node_id}, pos=({x:.1f}, {y:.1f})")
                return True, f"点击成功 (CDP): backendNodeId={backend_node_id}"
            else:
                return False, f"CDP 点击失败: backendNodeId={backend_node_id}"

        except Exception as e:
            logger.error(f"通过 backendNodeId 点击失败: {e}")
            return False, f"点击异常: {str(e)}"

    async def resolve_node_id(self, backend_node_id: int) -> Optional[int]:
        """
        将 Backend Node ID 解析为 Node ID

        Node ID 只在当前 CDP 会话内有效，但某些 CDP 命令需要它。

        Args:
            backend_node_id: CDP Backend Node ID

        Returns:
            Node ID 或 None
        """
        try:
            cdp = await self._ensure_cdp_session()
            result = await cdp.send("DOM.describeNode", {"backendNodeId": backend_node_id})
            node = result.get("node", {})
            return node.get("nodeId")
        except Exception as e:
            logger.warning(f"解析 Node ID 失败: {e}")
            return None

    async def set_attribute_by_backend_node_id(
        self,
        backend_node_id: int,
        name: str,
        value: str
    ) -> bool:
        """
        通过 Backend Node ID 设置元素属性

        Args:
            backend_node_id: CDP Backend Node ID
            name: 属性名
            value: 属性值

        Returns:
            是否成功
        """
        try:
            # 需要先解析为 Node ID
            node_id = await self.resolve_node_id(backend_node_id)
            if not node_id:
                logger.warning(f"无法解析 Node ID: backendNodeId={backend_node_id}")
                return False

            cdp = await self._ensure_cdp_session()
            await cdp.send("DOM.setAttributeValue", {
                "nodeId": node_id,
                "name": name,
                "value": value
            })
            return True
        except Exception as e:
            logger.warning(f"设置属性失败: {e}")
            return False

    async def get_outer_html_by_backend_node_id(self, backend_node_id: int) -> Optional[str]:
        """
        通过 Backend Node ID 获取元素外部 HTML

        Args:
            backend_node_id: CDP Backend Node ID

        Returns:
            外部 HTML 字符串或 None
        """
        try:
            cdp = await self._ensure_cdp_session()
            result = await cdp.send("DOM.getOuterHTML", {"backendNodeId": backend_node_id})
            return result.get("outerHTML")
        except Exception as e:
            logger.warning(f"获取 outerHTML 失败: {e}")
            return None

    async def click_at_coordinates(
        self,
        x: float,
        y: float,
        button: str = "left",
        click_count: int = 1
    ) -> bool:
        """
        在指定坐标执行点击

        Args:
            x: X 坐标
            y: Y 坐标
            button: 鼠标按钮 ("left", "right", "middle")
            click_count: 点击次数

        Returns:
            是否成功
        """
        try:
            cdp = await self._ensure_cdp_session()

            # Mouse down
            await cdp.send("Input.dispatchMouseEvent", {
                "type": "mousePressed",
                "x": x,
                "y": y,
                "button": button,
                "clickCount": click_count
            })

            # Mouse up
            await cdp.send("Input.dispatchMouseEvent", {
                "type": "mouseReleased",
                "x": x,
                "y": y,
                "button": button,
                "clickCount": click_count
            })

            return True

        except Exception as e:
            logger.warning(f"CDP 点击失败: {e}")
            return False


# ============ 便捷函数 ============

async def create_cdp_service(page: Page) -> CDPDOMService:
    """创建 CDP DOM 服务实例"""
    service = CDPDOMService(page)
    # 预热：获取 DPR
    await service.get_device_pixel_ratio()
    return service
