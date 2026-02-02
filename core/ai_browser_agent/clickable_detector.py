"""
多层启发式可交互元素检测器 - AI Browser Agent V2.3

借鉴 browser-use 的 ClickableElementDetector 设计，
提供多层次的可交互性检测，提高元素识别准确率。

检测层级：
1. 标签白名单 (button, a, input, etc.)
2. ARIA 角色 (role="button", role="link", etc.)
3. 事件属性 (onclick, onmousedown, etc.)
4. CSS cursor 样式 (pointer, grab, etc.)
5. contenteditable 属性
6. tabindex 属性
7. 自定义组件检测 (data-* 属性)
"""

import re
import logging
from dataclasses import dataclass, field
from typing import Set, Dict, Any, Optional, List

logger = logging.getLogger("ai_browser_agent.clickable_detector")


@dataclass
class InteractivityResult:
    """可交互性检测结果"""
    is_interactive: bool = False
    is_clickable: bool = False
    is_input: bool = False
    is_focusable: bool = False
    detection_reasons: List[str] = field(default_factory=list)
    confidence: float = 0.0  # 0.0-1.0 置信度

    def add_reason(self, reason: str, confidence_boost: float = 0.2):
        """添加检测原因并提升置信度"""
        self.detection_reasons.append(reason)
        self.confidence = min(1.0, self.confidence + confidence_boost)

    def to_dict(self) -> dict:
        return {
            "is_interactive": self.is_interactive,
            "is_clickable": self.is_clickable,
            "is_input": self.is_input,
            "is_focusable": self.is_focusable,
            "detection_reasons": self.detection_reasons,
            "confidence": self.confidence,
        }


class ClickableElementDetector:
    """
    多层启发式可交互元素检测器

    借鉴 browser-use 的设计，使用多层检测策略判断元素是否可交互。
    """

    # ============ 层级 1: 标签白名单 ============
    INTERACTIVE_TAGS: Set[str] = {
        "button", "a", "input", "select", "textarea", "summary",
        "details", "label", "option", "optgroup"
    }

    INPUT_TAGS: Set[str] = {
        "input", "textarea", "select"
    }

    CLICKABLE_TAGS: Set[str] = {
        "button", "a", "summary", "option"
    }

    # ============ 层级 2: ARIA 角色 ============
    INTERACTIVE_ROLES: Set[str] = {
        "button", "link", "textbox", "checkbox", "radio",
        "combobox", "listbox", "menu", "menuitem", "menuitemcheckbox",
        "menuitemradio", "tab", "tabpanel", "switch", "slider",
        "spinbutton", "searchbox", "option", "treeitem", "gridcell"
    }

    INPUT_ROLES: Set[str] = {
        "textbox", "searchbox", "spinbutton", "combobox"
    }

    CLICKABLE_ROLES: Set[str] = {
        "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio",
        "option", "tab", "treeitem", "checkbox", "radio", "switch"
    }

    # ============ 层级 3: 事件属性 ============
    EVENT_ATTRIBUTES: Set[str] = {
        "onclick", "onmousedown", "onmouseup", "ontouchstart", "ontouchend",
        "onkeydown", "onkeyup", "onkeypress", "onfocus", "onblur",
        "onchange", "oninput", "onsubmit"
    }

    CLICK_EVENTS: Set[str] = {
        "onclick", "onmousedown", "onmouseup", "ontouchstart", "ontouchend"
    }

    # ============ 层级 4: CSS cursor 样式 ============
    CLICKABLE_CURSORS: Set[str] = {
        "pointer", "grab", "grabbing", "move", "copy", "alias",
        "context-menu", "help", "cell", "crosshair"
    }

    # ============ 层级 5: 自定义组件前缀 ============
    COMPONENT_PREFIXES: Set[str] = {
        "data-action", "data-click", "data-toggle", "data-target",
        "data-dismiss", "data-slide", "data-bs-toggle", "data-bs-target",
        "ng-click", "v-on:click", "@click", "(click)"
    }

    def __init__(
        self,
        check_cursor: bool = True,
        check_events: bool = True,
        check_components: bool = True,
        min_confidence: float = 0.3
    ):
        """
        初始化检测器

        Args:
            check_cursor: 是否检查 CSS cursor 样式
            check_events: 是否检查事件属性
            check_components: 是否检查自定义组件属性
            min_confidence: 最小置信度阈值
        """
        self.check_cursor = check_cursor
        self.check_events = check_events
        self.check_components = check_components
        self.min_confidence = min_confidence

    def detect(
        self,
        tag: str,
        attributes: Dict[str, Any],
        computed_style: Optional[Dict[str, str]] = None,
        accessible_role: Optional[str] = None
    ) -> InteractivityResult:
        """
        检测元素是否可交互

        Args:
            tag: 元素标签名（小写）
            attributes: 元素属性字典
            computed_style: 计算后的 CSS 样式（可选）
            accessible_role: 可访问性角色（可选）

        Returns:
            InteractivityResult 检测结果
        """
        result = InteractivityResult()
        tag_lower = tag.lower()

        # 层级 1: 标签检测
        self._check_tag(tag_lower, result)

        # 层级 2: ARIA 角色检测
        role = accessible_role or attributes.get("role", "")
        if role:
            self._check_role(role.lower(), result)

        # 层级 3: 事件属性检测
        if self.check_events:
            self._check_event_attributes(attributes, result)

        # 层级 4: CSS cursor 检测
        if self.check_cursor and computed_style:
            self._check_cursor(computed_style, result)

        # 层级 5: contenteditable 检测
        self._check_contenteditable(attributes, result)

        # 层级 6: tabindex 检测
        self._check_tabindex(attributes, result)

        # 层级 7: 自定义组件检测
        if self.check_components:
            self._check_component_attributes(attributes, result)

        # 综合判断：保留已确认的交互性，只在没有明确判定时使用置信度阈值
        # 修复：避免覆盖在各检测层中已设置的 is_interactive = True
        if not result.is_interactive:
            result.is_interactive = result.confidence >= self.min_confidence

        return result

    def _check_tag(self, tag: str, result: InteractivityResult):
        """层级 1: 标签检测"""
        if tag in self.INTERACTIVE_TAGS:
            result.add_reason(f"tag:{tag}", 0.4)
            result.is_interactive = True

            if tag in self.INPUT_TAGS:
                result.is_input = True
                result.is_focusable = True

            if tag in self.CLICKABLE_TAGS:
                result.is_clickable = True

    def _check_role(self, role: str, result: InteractivityResult):
        """层级 2: ARIA 角色检测"""
        if role in self.INTERACTIVE_ROLES:
            result.add_reason(f"role:{role}", 0.35)
            result.is_interactive = True

            if role in self.INPUT_ROLES:
                result.is_input = True
                result.is_focusable = True

            if role in self.CLICKABLE_ROLES:
                result.is_clickable = True

    def _check_event_attributes(self, attributes: Dict[str, Any], result: InteractivityResult):
        """层级 3: 事件属性检测"""
        for attr in self.EVENT_ATTRIBUTES:
            if attr in attributes and attributes[attr]:
                result.add_reason(f"event:{attr}", 0.25)
                result.is_interactive = True

                if attr in self.CLICK_EVENTS:
                    result.is_clickable = True
                break  # 只记录一个事件

    def _check_cursor(self, computed_style: Dict[str, str], result: InteractivityResult):
        """层级 4: CSS cursor 检测"""
        cursor = computed_style.get("cursor", "").lower()
        if cursor in self.CLICKABLE_CURSORS:
            result.add_reason(f"cursor:{cursor}", 0.2)
            result.is_clickable = True

    def _check_contenteditable(self, attributes: Dict[str, Any], result: InteractivityResult):
        """层级 5: contenteditable 检测"""
        contenteditable = attributes.get("contenteditable", "")
        if contenteditable == "true" or contenteditable is True:
            result.add_reason("contenteditable", 0.3)
            result.is_interactive = True
            result.is_input = True
            result.is_focusable = True

    def _check_tabindex(self, attributes: Dict[str, Any], result: InteractivityResult):
        """层级 6: tabindex 检测"""
        tabindex = attributes.get("tabindex")
        if tabindex is not None:
            try:
                tabindex_val = int(tabindex)
                if tabindex_val >= 0:
                    result.add_reason(f"tabindex:{tabindex_val}", 0.15)
                    result.is_focusable = True
                    # tabindex >= 0 暗示元素可交互
                    if tabindex_val >= 0:
                        result.is_interactive = True
            except (ValueError, TypeError):
                pass

    def _check_component_attributes(self, attributes: Dict[str, Any], result: InteractivityResult):
        """层级 7: 自定义组件属性检测"""
        for attr in attributes:
            attr_lower = attr.lower()
            # 检查常见的组件框架属性
            for prefix in self.COMPONENT_PREFIXES:
                if attr_lower.startswith(prefix) or attr_lower == prefix:
                    result.add_reason(f"component:{attr}", 0.2)
                    result.is_interactive = True
                    result.is_clickable = True
                    return

            # 检查 data-* 中包含 click/action/toggle 等关键词
            if attr_lower.startswith("data-"):
                for keyword in ["click", "action", "toggle", "trigger", "open", "close"]:
                    if keyword in attr_lower:
                        result.add_reason(f"data-attr:{attr}", 0.15)
                        result.is_clickable = True
                        return

    def is_likely_clickable(
        self,
        tag: str,
        attributes: Dict[str, Any],
        computed_style: Optional[Dict[str, str]] = None
    ) -> bool:
        """
        快速判断元素是否可能可点击

        Args:
            tag: 元素标签名
            attributes: 元素属性
            computed_style: 计算样式（可选）

        Returns:
            是否可能可点击
        """
        result = self.detect(tag, attributes, computed_style)
        return result.is_clickable

    def is_likely_input(
        self,
        tag: str,
        attributes: Dict[str, Any]
    ) -> bool:
        """
        快速判断元素是否可能是输入元素

        Args:
            tag: 元素标签名
            attributes: 元素属性

        Returns:
            是否可能是输入元素
        """
        result = self.detect(tag, attributes)
        return result.is_input


# ============ 全局实例 ============

_default_detector: Optional[ClickableElementDetector] = None


def get_clickable_detector() -> ClickableElementDetector:
    """获取全局检测器实例"""
    global _default_detector
    if _default_detector is None:
        _default_detector = ClickableElementDetector()
    return _default_detector


def create_clickable_detector(**kwargs) -> ClickableElementDetector:
    """创建新的检测器实例"""
    return ClickableElementDetector(**kwargs)


def is_element_clickable(
    tag: str,
    attributes: Dict[str, Any],
    computed_style: Optional[Dict[str, str]] = None
) -> bool:
    """
    便捷函数：判断元素是否可点击

    Args:
        tag: 元素标签名
        attributes: 元素属性
        computed_style: 计算样式（可选）

    Returns:
        是否可点击
    """
    detector = get_clickable_detector()
    return detector.is_likely_clickable(tag, attributes, computed_style)


def detect_interactivity(
    tag: str,
    attributes: Dict[str, Any],
    computed_style: Optional[Dict[str, str]] = None,
    accessible_role: Optional[str] = None
) -> InteractivityResult:
    """
    便捷函数：检测元素可交互性

    Args:
        tag: 元素标签名
        attributes: 元素属性
        computed_style: 计算样式（可选）
        accessible_role: 可访问性角色（可选）

    Returns:
        InteractivityResult 检测结果
    """
    detector = get_clickable_detector()
    return detector.detect(tag, attributes, computed_style, accessible_role)
