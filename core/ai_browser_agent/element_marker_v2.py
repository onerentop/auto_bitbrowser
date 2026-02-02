"""
增强版 Set-of-Mark 元素标记器模块 (V2)

在原有 JavaScript 提取基础上，增加 CDP 快照支持和 DPR 坐标转换
提供混合模式：优先使用 CDP 快照，回退到 JS 提取
"""

import asyncio
from dataclasses import dataclass, field
from typing import List, Optional, Tuple, Dict, Any, TYPE_CHECKING
from io import BytesIO
import logging

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    Image = None
    ImageDraw = None
    ImageFont = None

from .element_marker import MarkedElement, ElementMarker

# V2.3: 多层可交互检测器
try:
    from .clickable_detector import (
        ClickableElementDetector,
        detect_interactivity,
        InteractivityResult,
    )
    CLICKABLE_DETECTOR_AVAILABLE = True
except ImportError:
    ClickableElementDetector = None
    detect_interactivity = None
    InteractivityResult = None
    CLICKABLE_DETECTOR_AVAILABLE = False

if TYPE_CHECKING:
    from playwright.async_api import Page

logger = logging.getLogger("ai_browser_agent.element_marker_v2")


@dataclass
class ExtractionResult:
    """元素提取结果"""
    elements: List[MarkedElement]
    method: str  # "cdp" | "js" | "hybrid"
    dpr: float = 1.0
    viewport_width: int = 0
    viewport_height: int = 0
    extraction_time_ms: float = 0.0


class EnhancedElementMarker(ElementMarker):
    """
    增强版元素标记器

    在继承原有功能的基础上，增加：
    - CDP 快照支持
    - 设备像素比 (DPR) 坐标转换
    - 可访问性树集成
    - 性能监控
    """

    def __init__(
        self,
        use_cdp: bool = True,
        dpr_aware: bool = True,
        fallback_to_js: bool = True,
    ):
        """
        初始化增强版标记器

        Args:
            use_cdp: 是否使用 CDP 快照（默认 True）
            dpr_aware: 是否进行 DPR 坐标转换（默认 True）
            fallback_to_js: CDP 失败时是否回退到 JS 提取（默认 True）
        """
        super().__init__()
        self.use_cdp = use_cdp
        self.dpr_aware = dpr_aware
        self.fallback_to_js = fallback_to_js
        self._cached_dpr: float = 1.0

    async def extract_elements_v2(
        self,
        page: "Page",
        include_ax_tree: bool = False
    ) -> ExtractionResult:
        """
        提取元素（V2 增强版）

        Args:
            page: Playwright Page 对象
            include_ax_tree: 是否包含可访问性树信息

        Returns:
            ExtractionResult 提取结果
        """
        import time
        start_time = time.time()

        # 获取 DPR
        dpr = await self._get_dpr(page)
        self._cached_dpr = dpr

        # 获取视口尺寸
        viewport = await self._get_viewport(page)

        elements = []
        method = "js"

        if self.use_cdp:
            try:
                # 尝试使用 CDP 提取
                cdp_elements = await self._extract_via_cdp(page, include_ax_tree)
                if cdp_elements:
                    elements = cdp_elements
                    method = "cdp"
                elif self.fallback_to_js:
                    # 回退到 JS
                    elements = await self.extract_elements(page)
                    method = "js_fallback"
            except Exception as e:
                logger.warning(f"CDP 提取失败: {e}")
                if self.fallback_to_js:
                    elements = await self.extract_elements(page)
                    method = "js_fallback"
        else:
            # 直接使用 JS 提取
            elements = await self.extract_elements(page)

        # DPR 坐标转换
        if self.dpr_aware and dpr != 1.0:
            elements = self._apply_dpr_conversion(elements, dpr)

        extraction_time = (time.time() - start_time) * 1000

        return ExtractionResult(
            elements=elements,
            method=method,
            dpr=dpr,
            viewport_width=viewport[0],
            viewport_height=viewport[1],
            extraction_time_ms=extraction_time
        )

    async def _get_dpr(self, page: "Page") -> float:
        """获取设备像素比"""
        try:
            dpr = await page.evaluate("() => window.devicePixelRatio")
            return float(dpr) if dpr else 1.0
        except Exception:
            return 1.0

    async def _get_viewport(self, page: "Page") -> Tuple[int, int]:
        """获取视口尺寸"""
        try:
            result = await page.evaluate("""
                () => ({
                    width: window.innerWidth,
                    height: window.innerHeight
                })
            """)
            return (result.get("width", 0), result.get("height", 0))
        except Exception:
            return (0, 0)

    async def _extract_via_cdp(
        self,
        page: "Page",
        include_ax_tree: bool = False
    ) -> List[MarkedElement]:
        """
        使用 CDP 提取元素 (V2.3 增强版)

        新增功能：
        - 提取 backend_node_id 用于精确点击
        - 使用多层可交互检测器
        - 支持可访问性树集成

        Args:
            page: Playwright Page
            include_ax_tree: 是否使用可访问性树

        Returns:
            MarkedElement 列表（包含 backend_node_id）
        """
        try:
            from .cdp_service import CDPDOMService
        except ImportError:
            logger.warning("cdp_service 模块不可用")
            return []

        elements = []
        element_id = 1

        # 初始化可交互检测器
        detector = None
        if CLICKABLE_DETECTOR_AVAILABLE:
            detector = ClickableElementDetector()

        try:
            cdp_service = CDPDOMService(page)

            if include_ax_tree:
                # 使用可访问性树获取可交互元素
                ax_elements = await cdp_service.get_interactive_elements_via_ax()

                for ax_el in ax_elements:
                    bbox = ax_el.get("bounding_box")
                    if not bbox:
                        continue

                    # 检查元素尺寸
                    if bbox["width"] < self.MIN_ELEMENT_SIZE or bbox["height"] < self.MIN_ELEMENT_SIZE:
                        continue

                    # V2.3: 提取 backend_node_id
                    backend_node_id = ax_el.get("backend_node_id")

                    # 使用多层检测器判断可交互性
                    is_clickable = False
                    if detector:
                        role = ax_el.get("role", "")
                        result = detector.detect(role, {}, accessible_role=role)
                        is_clickable = result.is_clickable

                    element = MarkedElement(
                        id=element_id,
                        tag=ax_el.get("role", "unknown"),
                        text=ax_el.get("name", "")[:self.MAX_TEXT_LENGTH],
                        role=ax_el.get("role"),
                        bbox=(
                            int(bbox["x"]),
                            int(bbox["y"]),
                            int(bbox["width"]),
                            int(bbox["height"])
                        ),
                        center=(
                            int(bbox["x"] + bbox["width"] / 2),
                            int(bbox["y"] + bbox["height"] / 2)
                        ),
                        xpath="",  # CDP 不直接提供 XPath
                        attributes={
                            "_extraction_method": "ax_tree"
                        },
                        is_input=ax_el.get("role") in ("textbox", "combobox", "searchbox"),
                        is_visible=True,
                        # V2.3: 新增字段
                        backend_node_id=backend_node_id,
                        is_clickable=is_clickable,
                    )
                    elements.append(element)
                    element_id += 1

                    if element_id > self.MAX_ELEMENTS:
                        break

            else:
                # 使用 DOM 快照
                snapshot = await cdp_service.get_dom_snapshot()

                # 解析快照中的可交互元素
                # DOM 快照结构比较复杂，需要解析 documents 和 strings
                if snapshot and "documents" in snapshot:
                    elements = self._parse_dom_snapshot_v2(snapshot, element_id, detector)

            await cdp_service.close()

        except Exception as e:
            logger.error(f"CDP 元素提取错误: {e}")

        return elements

    def _parse_dom_snapshot_v2(
        self,
        snapshot: Dict[str, Any],
        start_id: int,
        detector: Optional["ClickableElementDetector"] = None
    ) -> List[MarkedElement]:
        """
        解析 DOM 快照 (V2.3 增强版)

        新增功能：
        - 提取 backendNodeId
        - 使用多层可交互检测器

        Args:
            snapshot: CDP DOM 快照数据
            start_id: 起始元素 ID
            detector: 可交互检测器（可选）

        Returns:
            MarkedElement 列表
        """
        elements = []
        element_id = start_id

        try:
            documents = snapshot.get("documents", [])
            strings = snapshot.get("strings", [])

            if not documents or not strings:
                return elements

            # 获取主文档
            doc = documents[0]
            nodes = doc.get("nodes", {})
            layout = doc.get("layout", {})

            node_names = nodes.get("nodeName", [])
            node_types = nodes.get("nodeType", [])
            attributes = nodes.get("attributes", [])
            layout_node_index = layout.get("nodeIndex", [])
            bounds = layout.get("bounds", [])

            # V2.3: 提取 backendNodeId
            backend_node_ids = nodes.get("backendNodeId", [])

            # 构建 layout 索引映射
            layout_map = {}
            for i, node_idx in enumerate(layout_node_index):
                if i < len(bounds):
                    layout_map[node_idx] = bounds[i]

            # 可交互标签
            interactive_tags = {
                "BUTTON", "A", "INPUT", "TEXTAREA", "SELECT",
                "LABEL", "OPTION", "DETAILS", "SUMMARY"
            }

            for i, name_idx in enumerate(node_names):
                if element_id > self.MAX_ELEMENTS + start_id:
                    break

                if i >= len(node_types):
                    continue

                # 只处理元素节点
                if node_types[i] != 1:
                    continue

                # 获取标签名
                tag_name = strings[name_idx] if name_idx < len(strings) else ""
                tag_lower = tag_name.lower()

                # 解析属性
                attrs = {}
                if i < len(attributes):
                    attr_list = attributes[i]
                    for j in range(0, len(attr_list), 2):
                        if j + 1 < len(attr_list):
                            attr_name = strings[attr_list[j]] if attr_list[j] < len(strings) else ""
                            attr_value = strings[attr_list[j + 1]] if attr_list[j + 1] < len(strings) else ""
                            if attr_name:
                                attrs[attr_name] = attr_value

                # 使用多层检测器判断可交互性
                is_interactive = tag_name.upper() in interactive_tags
                is_clickable = False
                is_input = tag_name.upper() in ("INPUT", "TEXTAREA", "SELECT")

                if detector:
                    result = detector.detect(tag_lower, attrs, accessible_role=attrs.get("role"))
                    is_interactive = is_interactive or result.is_interactive
                    is_clickable = result.is_clickable
                    is_input = is_input or result.is_input
                else:
                    # 检查 role 属性
                    role = attrs.get("role", "")
                    if role in ("button", "link", "textbox", "checkbox", "radio", "menuitem"):
                        is_interactive = True
                        is_clickable = role in ("button", "link", "menuitem")

                if not is_interactive:
                    continue

                # 获取布局信息
                if i not in layout_map:
                    continue

                bound = layout_map[i]
                if len(bound) < 4:
                    continue

                x, y, width, height = bound[:4]

                # 检查尺寸
                if width < self.MIN_ELEMENT_SIZE or height < self.MIN_ELEMENT_SIZE:
                    continue

                # V2.3: 获取 backendNodeId
                backend_node_id = None
                if i < len(backend_node_ids):
                    backend_node_id = backend_node_ids[i]

                # 过滤属性，只保留有用的
                filtered_attrs = {
                    k: v for k, v in attrs.items()
                    if k in ("type", "name", "placeholder", "aria-label", "role", "href", "value")
                }
                filtered_attrs["_extraction_method"] = "dom_snapshot"

                element = MarkedElement(
                    id=element_id,
                    tag=tag_lower,
                    text="",  # 快照中文本内容需要额外提取
                    role=attrs.get("role"),
                    bbox=(int(x), int(y), int(width), int(height)),
                    center=(int(x + width / 2), int(y + height / 2)),
                    xpath="",
                    attributes=filtered_attrs,
                    is_input=is_input,
                    is_visible=True,
                    # V2.3: 新增字段
                    backend_node_id=backend_node_id,
                    is_clickable=is_clickable,
                )
                elements.append(element)
                element_id += 1

        except Exception as e:
            logger.error(f"解析 DOM 快照失败: {e}")

        return elements

    def _parse_dom_snapshot(
        self,
        snapshot: Dict[str, Any],
        start_id: int
    ) -> List[MarkedElement]:
        """
        解析 DOM 快照

        Args:
            snapshot: CDP DOM 快照数据
            start_id: 起始元素 ID

        Returns:
            MarkedElement 列表
        """
        elements = []
        element_id = start_id

        try:
            documents = snapshot.get("documents", [])
            strings = snapshot.get("strings", [])

            if not documents or not strings:
                return elements

            # 获取主文档
            doc = documents[0]
            nodes = doc.get("nodes", {})
            layout = doc.get("layout", {})

            node_names = nodes.get("nodeName", [])
            node_types = nodes.get("nodeType", [])
            attributes = nodes.get("attributes", [])
            layout_node_index = layout.get("nodeIndex", [])
            bounds = layout.get("bounds", [])

            # 构建 layout 索引映射
            layout_map = {}
            for i, node_idx in enumerate(layout_node_index):
                if i < len(bounds):
                    layout_map[node_idx] = bounds[i]

            # 可交互标签
            interactive_tags = {
                "BUTTON", "A", "INPUT", "TEXTAREA", "SELECT",
                "LABEL", "OPTION", "DETAILS", "SUMMARY"
            }

            for i, name_idx in enumerate(node_names):
                if element_id > self.MAX_ELEMENTS + start_id:
                    break

                if i >= len(node_types):
                    continue

                # 只处理元素节点
                if node_types[i] != 1:
                    continue

                # 获取标签名
                tag_name = strings[name_idx] if name_idx < len(strings) else ""

                # 检查是否是可交互元素
                if tag_name.upper() not in interactive_tags:
                    # 检查 role 属性
                    if i < len(attributes):
                        attr_list = attributes[i]
                        has_interactive_role = False
                        for j in range(0, len(attr_list), 2):
                            attr_name = strings[attr_list[j]] if attr_list[j] < len(strings) else ""
                            if attr_name == "role":
                                role_value = strings[attr_list[j + 1]] if attr_list[j + 1] < len(strings) else ""
                                if role_value in ("button", "link", "textbox", "checkbox", "radio", "menuitem"):
                                    has_interactive_role = True
                                    break
                        if not has_interactive_role:
                            continue
                    else:
                        continue

                # 获取布局信息
                if i not in layout_map:
                    continue

                bound = layout_map[i]
                if len(bound) < 4:
                    continue

                x, y, width, height = bound[:4]

                # 检查尺寸
                if width < self.MIN_ELEMENT_SIZE or height < self.MIN_ELEMENT_SIZE:
                    continue

                # 解析属性
                attrs = {}
                if i < len(attributes):
                    attr_list = attributes[i]
                    for j in range(0, len(attr_list), 2):
                        if j + 1 < len(attr_list):
                            attr_name = strings[attr_list[j]] if attr_list[j] < len(strings) else ""
                            attr_value = strings[attr_list[j + 1]] if attr_list[j + 1] < len(strings) else ""
                            if attr_name in ("type", "name", "placeholder", "aria-label", "role"):
                                attrs[attr_name] = attr_value

                element = MarkedElement(
                    id=element_id,
                    tag=tag_name.lower(),
                    text="",  # 快照中文本内容需要额外提取
                    role=attrs.get("role"),
                    bbox=(int(x), int(y), int(width), int(height)),
                    center=(int(x + width / 2), int(y + height / 2)),
                    xpath="",
                    attributes=attrs,
                    is_input=tag_name.upper() in ("INPUT", "TEXTAREA", "SELECT"),
                    is_visible=True
                )
                elements.append(element)
                element_id += 1

        except Exception as e:
            logger.error(f"解析 DOM 快照失败: {e}")

        return elements

    def _apply_dpr_conversion(
        self,
        elements: List[MarkedElement],
        dpr: float
    ) -> List[MarkedElement]:
        """
        应用 DPR 坐标转换

        将设备坐标转换为 CSS 坐标

        Args:
            elements: 元素列表
            dpr: 设备像素比

        Returns:
            转换后的元素列表
        """
        if dpr == 1.0:
            return elements

        converted = []
        for el in elements:
            # 转换边界框
            new_bbox = (
                int(el.bbox[0] / dpr),
                int(el.bbox[1] / dpr),
                int(el.bbox[2] / dpr),
                int(el.bbox[3] / dpr),
            )

            # 转换中心点
            new_center = (
                int(el.center[0] / dpr),
                int(el.center[1] / dpr),
            )

            # 创建新元素（保持所有属性，包括 V2.3 新增字段）
            converted.append(MarkedElement(
                id=el.id,
                tag=el.tag,
                text=el.text,
                role=el.role,
                bbox=new_bbox,
                center=new_center,
                xpath=el.xpath,
                css_selector=el.css_selector,
                attributes=el.attributes,
                is_input=el.is_input,
                is_visible=el.is_visible,
                # V2.3: 保留新增字段
                backend_node_id=el.backend_node_id,
                node_id=el.node_id,
                is_clickable=el.is_clickable,
                cursor_style=el.cursor_style,
                has_event_listener=el.has_event_listener,
            ))

        return converted

    async def extract_and_mark_v2(
        self,
        page: "Page",
        include_ax_tree: bool = False
    ) -> Tuple[bytes, ExtractionResult]:
        """
        提取元素并标注截图（V2 增强版）

        Args:
            page: Playwright Page
            include_ax_tree: 是否使用可访问性树

        Returns:
            (标注截图, ExtractionResult)
        """
        # 提取元素
        result = await self.extract_elements_v2(page, include_ax_tree)

        # 截图
        screenshot = await page.screenshot(type='png')

        # 标注
        if result.elements:
            marked_screenshot = self.mark_screenshot(screenshot, result.elements)
        else:
            marked_screenshot = screenshot

        return marked_screenshot, result

    def get_cached_dpr(self) -> float:
        """获取缓存的 DPR 值"""
        return self._cached_dpr


# ============ 坐标转换工具函数 ============

def css_to_device_coords(
    css_x: float,
    css_y: float,
    dpr: float
) -> Tuple[float, float]:
    """CSS 坐标转设备坐标"""
    return (css_x * dpr, css_y * dpr)


def device_to_css_coords(
    device_x: float,
    device_y: float,
    dpr: float
) -> Tuple[float, float]:
    """设备坐标转 CSS 坐标"""
    return (device_x / dpr, device_y / dpr)


def scale_bounding_box(
    bbox: Tuple[int, int, int, int],
    scale: float
) -> Tuple[int, int, int, int]:
    """缩放边界框"""
    return (
        int(bbox[0] * scale),
        int(bbox[1] * scale),
        int(bbox[2] * scale),
        int(bbox[3] * scale),
    )


# ============ 便捷函数 ============

def create_enhanced_marker(
    use_cdp: bool = True,
    dpr_aware: bool = True
) -> EnhancedElementMarker:
    """创建增强版元素标记器"""
    return EnhancedElementMarker(
        use_cdp=use_cdp,
        dpr_aware=dpr_aware,
        fallback_to_js=True
    )
