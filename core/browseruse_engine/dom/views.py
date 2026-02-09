"""
BrowserUse Engine - DOM 视图模型

定义 DOM 元素和树的数据结构。
注意: 主要的 DOMElement 和 DOMTree 定义在 types.py 中，
这里提供额外的辅助类和扩展功能。
"""

from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any

from ..types import DOMElement, DOMTree, Rect


# ==================== 扩展的 DOM 节点 ====================

@dataclass
class EnhancedDOMElement(DOMElement):
    """增强的 DOM 元素，包含额外信息"""
    # 无障碍信息
    aria_label: str = ""
    aria_role: str = ""

    # 样式信息
    computed_style: Dict[str, str] = field(default_factory=dict)
    z_index: int = 0

    # 层级信息
    depth: int = 0
    parent_index: Optional[int] = None
    children_indices: List[int] = field(default_factory=list)

    # 交互状态
    is_focused: bool = False
    is_disabled: bool = False
    is_readonly: bool = False

    def to_simple(self) -> DOMElement:
        """转换为简单的 DOMElement"""
        return DOMElement(
            index=self.index,
            tag_name=self.tag_name,
            text=self.text,
            role=self.role or self.aria_role,
            attributes=self.attributes,
            is_interactive=self.is_interactive,
            is_visible=self.is_visible,
            is_new=self.is_new,
            bounding_box=self.bounding_box,
            selector=self.selector,
        )


# ==================== 选择器映射 ====================

@dataclass
class SelectorMap:
    """
    索引到选择器的映射

    维护元素索引与多种选择器的映射关系，
    用于后续的元素定位和操作。
    """
    # index -> 选择器
    css_selectors: Dict[int, str] = field(default_factory=dict)
    xpath_selectors: Dict[int, str] = field(default_factory=dict)
    # index -> 坐标 (用于点击)
    coordinates: Dict[int, tuple[float, float]] = field(default_factory=dict)

    def get_selector(self, index: int, prefer: str = "css") -> Optional[str]:
        """获取元素选择器"""
        if prefer == "xpath":
            return self.xpath_selectors.get(index) or self.css_selectors.get(index)
        return self.css_selectors.get(index) or self.xpath_selectors.get(index)

    def get_coordinates(self, index: int) -> Optional[tuple[float, float]]:
        """获取元素中心坐标"""
        return self.coordinates.get(index)


# ==================== DOM 快照 ====================

@dataclass
class DOMSnapshot:
    """
    DOM 快照

    包含完整的 DOM 树信息和选择器映射。
    """
    dom_tree: DOMTree
    selector_map: SelectorMap
    viewport: Dict[str, int] = field(default_factory=dict)  # {width, height}
    scroll_position: Dict[str, int] = field(default_factory=dict)  # {x, y}

    def get_element(self, index: int) -> Optional[DOMElement]:
        """根据索引获取元素"""
        return self.dom_tree.get_element(index)

    def get_selector(self, index: int) -> Optional[str]:
        """获取元素选择器"""
        return self.selector_map.get_selector(index)

    def get_coordinates(self, index: int) -> Optional[tuple[float, float]]:
        """获取元素坐标"""
        return self.selector_map.get_coordinates(index)


# ==================== 辅助函数 ====================

def filter_interactive_elements(elements: List[DOMElement]) -> List[DOMElement]:
    """过滤出可交互元素"""
    return [el for el in elements if el.is_interactive and el.is_visible]


def filter_visible_elements(elements: List[DOMElement]) -> List[DOMElement]:
    """过滤出可见元素"""
    return [el for el in elements if el.is_visible]


def find_element_by_text(
    elements: List[DOMElement],
    text: str,
    exact: bool = False
) -> Optional[DOMElement]:
    """根据文本查找元素"""
    text_lower = text.lower()
    for el in elements:
        el_text = el.text.lower()
        if exact:
            if el_text == text_lower:
                return el
        else:
            if text_lower in el_text:
                return el
    return None


def find_elements_by_tag(
    elements: List[DOMElement],
    tag_name: str
) -> List[DOMElement]:
    """根据标签名查找元素"""
    tag_lower = tag_name.lower()
    return [el for el in elements if el.tag_name.lower() == tag_lower]


def find_elements_by_role(
    elements: List[DOMElement],
    role: str
) -> List[DOMElement]:
    """根据角色查找元素"""
    role_lower = role.lower()
    return [el for el in elements if el.role.lower() == role_lower]
