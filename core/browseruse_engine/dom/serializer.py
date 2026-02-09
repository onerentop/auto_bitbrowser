"""
BrowserUse Engine - DOM 序列化

将 DOM 树序列化为 LLM 可读的文本格式。
"""

from typing import List, Optional
from ..types import DOMElement, DOMTree


class DOMSerializer:
    """
    DOM 序列化器

    将 DOM 树序列化为 LLM 可理解的文本格式。

    输出格式示例:
        [1] button "Submit"
        [2] textbox "Email" placeholder="Enter email"
        *[3] link "Learn more" href="/about"    # * 表示新出现的元素
    """

    def __init__(
        self,
        include_attributes: bool = True,
        max_text_length: int = 50,
        max_elements: int = 100,
    ):
        """
        初始化序列化器

        Args:
            include_attributes: 是否包含元素属性
            max_text_length: 文本最大长度
            max_elements: 最大元素数量
        """
        self.include_attributes = include_attributes
        self.max_text_length = max_text_length
        self.max_elements = max_elements

    def serialize(self, dom_tree: DOMTree) -> str:
        """
        序列化 DOM 树为文本

        Args:
            dom_tree: DOM 树

        Returns:
            序列化后的文本
        """
        lines = []
        elements = dom_tree.elements[:self.max_elements]

        for element in elements:
            line = self.serialize_element(element)
            lines.append(line)

        if len(dom_tree.elements) > self.max_elements:
            lines.append(f"... and {len(dom_tree.elements) - self.max_elements} more elements")

        return "\n".join(lines)

    def serialize_element(self, element: DOMElement) -> str:
        """
        序列化单个元素

        Args:
            element: DOM 元素

        Returns:
            序列化后的字符串
        """
        parts = []

        # 新元素标记
        prefix = "*" if element.is_new else ""

        # 索引和标签
        parts.append(f"{prefix}[{element.index}]")
        parts.append(element.tag_name)

        # 文本内容
        if element.text:
            text = element.text[:self.max_text_length]
            if len(element.text) > self.max_text_length:
                text += "..."
            parts.append(f'"{text}"')

        # 角色
        if element.role and element.role.lower() != element.tag_name.lower():
            parts.append(f"role={element.role}")

        # 属性
        if self.include_attributes:
            attr_parts = self._serialize_attributes(element)
            parts.extend(attr_parts)

        return " ".join(parts)

    def _serialize_attributes(self, element: DOMElement) -> List[str]:
        """序列化元素属性"""
        parts = []
        priority_attrs = ["placeholder", "value", "href", "type", "name", "src"]

        for attr in priority_attrs:
            if attr in element.attributes and element.attributes[attr]:
                value = element.attributes[attr]
                if len(value) > 30:
                    value = value[:30] + "..."
                parts.append(f'{attr}="{value}"')

        return parts

    def serialize_compact(self, dom_tree: DOMTree) -> str:
        """
        紧凑格式序列化 (节省 token)

        Args:
            dom_tree: DOM 树

        Returns:
            紧凑格式的文本
        """
        lines = []
        elements = dom_tree.elements[:self.max_elements]

        for element in elements:
            # 紧凑格式: [index] tag "text"
            prefix = "*" if element.is_new else ""
            text = element.text[:30] if element.text else ""
            if text:
                lines.append(f'{prefix}[{element.index}] {element.tag_name} "{text}"')
            else:
                lines.append(f"{prefix}[{element.index}] {element.tag_name}")

        return "\n".join(lines)


# ==================== 全局序列化器 ====================

_default_serializer = DOMSerializer()


def serialize_dom(dom_tree: DOMTree, compact: bool = False) -> str:
    """
    序列化 DOM 树

    Args:
        dom_tree: DOM 树
        compact: 是否使用紧凑格式

    Returns:
        序列化后的文本
    """
    if compact:
        return _default_serializer.serialize_compact(dom_tree)
    return _default_serializer.serialize(dom_tree)
