"""
BrowserUse Engine - DOM 模块

提供 DOM 提取和序列化功能。
"""

from .views import (
    EnhancedDOMElement,
    SelectorMap,
    DOMSnapshot,
    filter_interactive_elements,
    filter_visible_elements,
    find_element_by_text,
    find_elements_by_tag,
    find_elements_by_role,
)
from .service import DOMService
from .serializer import DOMSerializer, serialize_dom

__all__ = [
    # 服务
    "DOMService",
    # 序列化
    "DOMSerializer",
    "serialize_dom",
    # 视图模型
    "EnhancedDOMElement",
    "SelectorMap",
    "DOMSnapshot",
    # 辅助函数
    "filter_interactive_elements",
    "filter_visible_elements",
    "find_element_by_text",
    "find_elements_by_tag",
    "find_elements_by_role",
]
