"""
AI Browser Agent V2.3 模块单元测试

测试 V2.3 新增功能（借鉴 browser-use 的 Backend Node ID 系统）：
- clickable_detector.py: 多层启发式可交互检测器
- MarkedElement: backend_node_id 字段扩展
- cdp_service.py: Backend Node ID 操作方法
- element_finder.py: CDP 点击支持
- element_marker_v2.py: backend_node_id 提取

运行方法:
    python -m pytest tests/test_ai_browser_agent_v2_3.py -v
    python tests/test_ai_browser_agent_v2_3.py  # 直接运行
"""

import os
import sys
import unittest
from pathlib import Path

# 添加项目根目录到路径
sys.path.insert(0, str(Path(__file__).parent.parent))


class TestClickableDetector(unittest.TestCase):
    """测试多层启发式可交互检测器"""

    def test_import_module(self):
        """测试模块导入"""
        from core.ai_browser_agent import (
            ClickableElementDetector,
            InteractivityResult,
            CLICKABLE_DETECTOR_AVAILABLE,
        )

        self.assertTrue(CLICKABLE_DETECTOR_AVAILABLE)
        self.assertIsNotNone(ClickableElementDetector)
        self.assertIsNotNone(InteractivityResult)

    def test_create_detector(self):
        """测试创建检测器实例"""
        from core.ai_browser_agent import (
            create_clickable_detector,
            get_clickable_detector,
        )

        # 创建新实例
        detector = create_clickable_detector()
        self.assertIsNotNone(detector)

        # 获取全局实例
        global_detector = get_clickable_detector()
        self.assertIsNotNone(global_detector)

    def test_interactivity_result_dataclass(self):
        """测试 InteractivityResult 数据类"""
        from core.ai_browser_agent.clickable_detector import InteractivityResult

        result = InteractivityResult()
        self.assertFalse(result.is_interactive)
        self.assertFalse(result.is_clickable)
        self.assertFalse(result.is_input)
        self.assertFalse(result.is_focusable)
        self.assertEqual(len(result.detection_reasons), 0)
        self.assertEqual(result.confidence, 0.0)

    def test_interactivity_result_add_reason(self):
        """测试添加检测原因"""
        from core.ai_browser_agent.clickable_detector import InteractivityResult

        result = InteractivityResult()
        result.add_reason("tag:button", 0.4)

        self.assertEqual(len(result.detection_reasons), 1)
        self.assertIn("tag:button", result.detection_reasons)
        self.assertEqual(result.confidence, 0.4)

        # 添加更多原因
        result.add_reason("role:button", 0.35)
        self.assertEqual(len(result.detection_reasons), 2)
        self.assertEqual(result.confidence, 0.75)

    def test_interactivity_result_to_dict(self):
        """测试结果序列化"""
        from core.ai_browser_agent.clickable_detector import InteractivityResult

        result = InteractivityResult(
            is_interactive=True,
            is_clickable=True,
            is_input=False,
            is_focusable=True,
            detection_reasons=["tag:button"],
            confidence=0.8,
        )

        result_dict = result.to_dict()
        self.assertTrue(result_dict["is_interactive"])
        self.assertTrue(result_dict["is_clickable"])
        self.assertFalse(result_dict["is_input"])
        self.assertEqual(result_dict["confidence"], 0.8)

    def test_detect_button_tag(self):
        """测试按钮标签检测（层级 1）"""
        from core.ai_browser_agent import create_clickable_detector

        detector = create_clickable_detector()

        # <button> 标签
        result = detector.detect("button", {})
        self.assertTrue(result.is_interactive)
        self.assertTrue(result.is_clickable)
        self.assertFalse(result.is_input)
        self.assertIn("tag:button", result.detection_reasons)

    def test_detect_link_tag(self):
        """测试链接标签检测（层级 1）"""
        from core.ai_browser_agent import create_clickable_detector

        detector = create_clickable_detector()

        # <a> 标签
        result = detector.detect("a", {"href": "/page"})
        self.assertTrue(result.is_interactive)
        self.assertTrue(result.is_clickable)

    def test_detect_input_tag(self):
        """测试输入标签检测（层级 1）"""
        from core.ai_browser_agent import create_clickable_detector

        detector = create_clickable_detector()

        # <input> 标签
        result = detector.detect("input", {"type": "text"})
        self.assertTrue(result.is_interactive)
        self.assertTrue(result.is_input)
        self.assertTrue(result.is_focusable)

    def test_detect_aria_role_button(self):
        """测试 ARIA 角色检测（层级 2）"""
        from core.ai_browser_agent import create_clickable_detector

        detector = create_clickable_detector()

        # <div role="button">
        result = detector.detect("div", {"role": "button"})
        self.assertTrue(result.is_interactive)
        self.assertTrue(result.is_clickable)
        self.assertIn("role:button", result.detection_reasons)

    def test_detect_aria_role_textbox(self):
        """测试 ARIA 角色输入框检测（层级 2）"""
        from core.ai_browser_agent import create_clickable_detector

        detector = create_clickable_detector()

        # <div role="textbox">
        result = detector.detect("div", {"role": "textbox"})
        self.assertTrue(result.is_interactive)
        self.assertTrue(result.is_input)

    def test_detect_accessible_role_parameter(self):
        """测试可访问性角色参数"""
        from core.ai_browser_agent import create_clickable_detector

        detector = create_clickable_detector()

        # 使用 accessible_role 参数（优先于 attributes）
        result = detector.detect("div", {}, accessible_role="link")
        self.assertTrue(result.is_interactive)
        self.assertTrue(result.is_clickable)

    def test_detect_event_attributes(self):
        """测试事件属性检测（层级 3）"""
        from core.ai_browser_agent import create_clickable_detector

        # 修复后不再需要降低 min_confidence，因为 is_interactive 不会被覆盖
        detector = create_clickable_detector(check_events=True)

        # onclick 属性
        result = detector.detect("div", {"onclick": "handleClick()"})
        self.assertTrue(result.is_interactive)
        self.assertTrue(result.is_clickable)

        # 检查检测原因
        has_event_reason = any("event:" in r for r in result.detection_reasons)
        self.assertTrue(has_event_reason)

    def test_detect_cursor_style(self):
        """测试 CSS cursor 检测（层级 4）"""
        from core.ai_browser_agent import create_clickable_detector

        detector = create_clickable_detector(check_cursor=True)

        # cursor: pointer
        result = detector.detect("div", {}, computed_style={"cursor": "pointer"})
        self.assertTrue(result.is_clickable)
        self.assertIn("cursor:pointer", result.detection_reasons)

    def test_detect_contenteditable(self):
        """测试 contenteditable 检测（层级 5）"""
        from core.ai_browser_agent import create_clickable_detector

        detector = create_clickable_detector()

        # contenteditable="true"
        result = detector.detect("div", {"contenteditable": "true"})
        self.assertTrue(result.is_interactive)
        self.assertTrue(result.is_input)
        self.assertTrue(result.is_focusable)

    def test_detect_tabindex(self):
        """测试 tabindex 检测（层级 6）"""
        from core.ai_browser_agent import create_clickable_detector

        # 修复后不再需要降低 min_confidence
        detector = create_clickable_detector()

        # tabindex="0"
        result = detector.detect("div", {"tabindex": "0"})
        self.assertTrue(result.is_focusable)
        self.assertTrue(result.is_interactive)

        # tabindex="-1"（可聚焦但不在 Tab 序列中）
        result2 = detector.detect("div", {"tabindex": "-1"})
        # tabindex=-1 不应该增加交互性
        self.assertNotIn("tabindex:-1", result2.detection_reasons)

    def test_detect_component_attributes(self):
        """测试自定义组件属性检测（层级 7）"""
        from core.ai_browser_agent import create_clickable_detector

        # 修复后不再需要降低 min_confidence
        detector = create_clickable_detector(check_components=True)

        # ng-click (Angular)
        result = detector.detect("div", {"ng-click": "doSomething()"})
        self.assertTrue(result.is_interactive)
        self.assertTrue(result.is_clickable)

    def test_detect_data_action_attribute(self):
        """测试 data-action 属性检测"""
        from core.ai_browser_agent import create_clickable_detector

        # 修复后不再需要降低 min_confidence
        detector = create_clickable_detector(check_components=True)

        # data-action
        result = detector.detect("div", {"data-action": "toggle"})
        self.assertTrue(result.is_interactive)
        self.assertTrue(result.is_clickable)

    def test_detect_non_interactive_element(self):
        """测试非交互元素"""
        from core.ai_browser_agent import create_clickable_detector

        detector = create_clickable_detector()

        # 普通 <div> 没有任何交互属性
        result = detector.detect("div", {})
        self.assertFalse(result.is_interactive)
        self.assertFalse(result.is_clickable)
        self.assertFalse(result.is_input)
        self.assertEqual(result.confidence, 0.0)

    def test_convenience_functions(self):
        """测试便捷函数"""
        from core.ai_browser_agent import is_element_clickable, detect_interactivity

        # is_element_clickable
        self.assertTrue(is_element_clickable("button", {}))
        self.assertFalse(is_element_clickable("div", {}))

        # detect_interactivity
        result = detect_interactivity("a", {"href": "/"})
        self.assertTrue(result.is_clickable)

    def test_multi_layer_confidence_accumulation(self):
        """测试多层检测置信度累积"""
        from core.ai_browser_agent import create_clickable_detector

        detector = create_clickable_detector()

        # 多重指标：button 标签 + role="button" + onclick
        result = detector.detect("button", {
            "role": "button",
            "onclick": "submit()",
        })

        # 置信度应该更高（多个原因）
        self.assertGreater(len(result.detection_reasons), 1)
        self.assertGreater(result.confidence, 0.5)


class TestMarkedElementBackendNodeId(unittest.TestCase):
    """测试 MarkedElement 的 Backend Node ID 扩展"""

    def test_marked_element_new_fields(self):
        """测试 MarkedElement 新增字段"""
        from core.ai_browser_agent import MarkedElement

        element = MarkedElement(
            id=1,
            tag="button",
            text="Click me",
            bbox=(10, 20, 100, 40),
            center=(60, 40),
            xpath="/html/body/button",
        )

        # 验证 V2.3 新增字段存在
        self.assertIsNone(element.backend_node_id)
        self.assertIsNone(element.node_id)
        self.assertFalse(element.is_clickable)
        self.assertIsNone(element.cursor_style)
        self.assertFalse(element.has_event_listener)

    def test_marked_element_with_backend_node_id(self):
        """测试带 Backend Node ID 的 MarkedElement"""
        from core.ai_browser_agent import MarkedElement

        element = MarkedElement(
            id=1,
            tag="button",
            text="Submit",
            bbox=(0, 0, 100, 50),
            center=(50, 25),
            xpath="/html/body/form/button",
            backend_node_id=12345,
            node_id=67890,
            is_clickable=True,
            cursor_style="pointer",
            has_event_listener=True,
        )

        self.assertEqual(element.backend_node_id, 12345)
        self.assertEqual(element.node_id, 67890)
        self.assertTrue(element.is_clickable)
        self.assertEqual(element.cursor_style, "pointer")
        self.assertTrue(element.has_event_listener)


class TestCDPServiceBackendNodeId(unittest.TestCase):
    """测试 CDP 服务的 Backend Node ID 功能"""

    def test_cdp_service_available(self):
        """测试 CDP 服务可用性"""
        from core.ai_browser_agent import CDP_SERVICE_AVAILABLE

        self.assertTrue(CDP_SERVICE_AVAILABLE)

    def test_cdp_service_import(self):
        """测试 CDP 服务导入"""
        from core.ai_browser_agent import CDPDOMService

        self.assertIsNotNone(CDPDOMService)

    def test_cdp_service_methods_exist(self):
        """测试 CDP 服务方法存在"""
        from core.ai_browser_agent.cdp_service import CDPDOMService

        # 验证 V2.3 新增方法存在
        methods = [
            'focus_by_backend_node_id',
            'scroll_into_view_by_backend_node_id',
            'get_box_model_by_backend_node_id',
            'get_center_by_backend_node_id',
            'click_by_backend_node_id',
            'resolve_node_id',
            'set_attribute_by_backend_node_id',
            'get_outer_html_by_backend_node_id',
            'click_at_coordinates',
        ]

        for method_name in methods:
            self.assertTrue(
                hasattr(CDPDOMService, method_name),
                f"CDPDOMService missing method: {method_name}"
            )


class TestElementFinderCDP(unittest.TestCase):
    """测试 ElementFinder 的 CDP 点击功能"""

    def test_element_finder_cdp_methods_exist(self):
        """测试 ElementFinder CDP 方法存在"""
        from core.ai_browser_agent import ElementFinder

        methods = [
            '_get_cdp_service',
            'close_cdp_service',
            'get_element_backend_node_id',
            'click_by_backend_node_id',
            'click_by_element_id_cdp',
            'has_backend_node_id',
        ]

        for method_name in methods:
            self.assertTrue(
                hasattr(ElementFinder, method_name),
                f"ElementFinder missing method: {method_name}"
            )


class TestActionExecutorCDPClick(unittest.TestCase):
    """测试 ActionExecutor 的 CDP 点击优先级"""

    def test_action_executor_prefer_cdp_click_parameter(self):
        """测试 ActionExecutor prefer_cdp_click 参数"""
        from core.ai_browser_agent import ActionExecutor
        import inspect

        # 检查构造函数参数
        sig = inspect.signature(ActionExecutor.__init__)
        params = list(sig.parameters.keys())

        self.assertIn('prefer_cdp_click', params)


class TestEnhancedMarkerBackendNodeId(unittest.TestCase):
    """测试增强标记器的 Backend Node ID 提取"""

    def test_enhanced_marker_available(self):
        """测试增强标记器可用性"""
        from core.ai_browser_agent import ENHANCED_MARKER_AVAILABLE

        self.assertTrue(ENHANCED_MARKER_AVAILABLE)

    def test_enhanced_marker_import(self):
        """测试增强标记器导入"""
        from core.ai_browser_agent import (
            EnhancedElementMarker,
            create_enhanced_marker,
        )

        self.assertIsNotNone(EnhancedElementMarker)
        self.assertIsNotNone(create_enhanced_marker)

    def test_create_enhanced_marker(self):
        """测试创建增强标记器"""
        from core.ai_browser_agent import create_enhanced_marker

        marker = create_enhanced_marker(use_cdp=True, dpr_aware=True)

        self.assertIsNotNone(marker)
        self.assertTrue(marker.use_cdp)
        self.assertTrue(marker.dpr_aware)


class TestIntegrationV23(unittest.TestCase):
    """V2.3 集成测试"""

    def test_all_v23_exports(self):
        """测试所有 V2.3 导出"""
        from core.ai_browser_agent import (
            # Clickable Detector
            ClickableElementDetector,
            InteractivityResult,
            get_clickable_detector,
            create_clickable_detector,
            is_element_clickable,
            detect_interactivity,
            CLICKABLE_DETECTOR_AVAILABLE,
            # MarkedElement (already exported)
            MarkedElement,
            # CDP Service (already exported)
            CDPDOMService,
            CDP_SERVICE_AVAILABLE,
            # Enhanced Marker (already exported)
            EnhancedElementMarker,
            ENHANCED_MARKER_AVAILABLE,
            # Element Finder (already exported)
            ElementFinder,
            # Action Executor (already exported)
            ActionExecutor,
        )

        # 所有导入成功
        self.assertTrue(True)

    def test_clickable_detector_integration_with_detector(self):
        """测试检测器与元素标记器的集成"""
        from core.ai_browser_agent import (
            create_clickable_detector,
            MarkedElement,
        )

        detector = create_clickable_detector()

        # 模拟从标记器获取的元素
        element = MarkedElement(
            id=1,
            tag="button",
            text="Submit",
            bbox=(100, 200, 80, 40),
            center=(140, 220),
            xpath="/html/body/button",
            attributes={"type": "submit", "role": "button"},
            is_input=False,
            is_visible=True,
        )

        # 使用检测器分析
        result = detector.detect(
            element.tag,
            element.attributes or {},
            accessible_role=element.role,
        )

        # 验证结果
        self.assertTrue(result.is_interactive)
        self.assertTrue(result.is_clickable)


def run_tests():
    """运行所有测试"""
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()

    # 添加所有测试类
    suite.addTests(loader.loadTestsFromTestCase(TestClickableDetector))
    suite.addTests(loader.loadTestsFromTestCase(TestMarkedElementBackendNodeId))
    suite.addTests(loader.loadTestsFromTestCase(TestCDPServiceBackendNodeId))
    suite.addTests(loader.loadTestsFromTestCase(TestElementFinderCDP))
    suite.addTests(loader.loadTestsFromTestCase(TestActionExecutorCDPClick))
    suite.addTests(loader.loadTestsFromTestCase(TestEnhancedMarkerBackendNodeId))
    suite.addTests(loader.loadTestsFromTestCase(TestIntegrationV23))

    # 运行测试
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    # 返回退出码
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(run_tests())
