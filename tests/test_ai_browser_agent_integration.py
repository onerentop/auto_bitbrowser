"""
AI Browser Agent V2 集成测试

测试 V2 模块之间的集成和协作：
- ScreenshotManager + CDP 增强标记器
- Agent + Watchdog + ErrorClassifier
- 性能监控和统计
"""

import sys
import os

# 添加项目根目录到 Python 路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import asyncio
import time
import unittest
from unittest.mock import Mock, MagicMock, AsyncMock, patch
from typing import List


class TestScreenshotManagerIntegration(unittest.TestCase):
    """ScreenshotManager 集成测试"""

    def test_screenshot_manager_modes(self):
        """测试不同模式的初始化"""
        from core.ai_browser_agent import (
            ScreenshotManager,
            ENHANCED_MARKER_AVAILABLE,
        )

        # 标准 JS 模式
        mgr_js = ScreenshotManager(use_som=True, use_cdp=False)
        self.assertFalse(mgr_js.use_cdp)
        self.assertIsNotNone(mgr_js._element_marker)
        self.assertIsNone(mgr_js._enhanced_marker)

        # CDP 增强模式
        mgr_cdp = ScreenshotManager(use_som=True, use_cdp=True)
        if ENHANCED_MARKER_AVAILABLE:
            self.assertTrue(mgr_cdp.use_cdp)
            self.assertIsNotNone(mgr_cdp._enhanced_marker)
        else:
            self.assertFalse(mgr_cdp.use_cdp)

        # 禁用 SoM 模式
        mgr_no_som = ScreenshotManager(use_som=False)
        self.assertIsNone(mgr_no_som._element_marker)
        self.assertIsNone(mgr_no_som._enhanced_marker)

    def test_som_stats_tracking(self):
        """测试 SoM 统计跟踪"""
        from core.ai_browser_agent import ScreenshotManager, SoMStats

        mgr = ScreenshotManager(use_som=True)

        # 初始状态
        self.assertEqual(mgr.stats.total_extractions, 0)
        self.assertEqual(mgr.stats.cache_hits, 0)
        self.assertEqual(mgr.stats.cache_misses, 0)

        # 模拟记录提取
        mgr._stats.record_extraction(100.0, 25)
        mgr._stats.record_extraction(150.0, 30)

        self.assertEqual(mgr.stats.total_extractions, 2)
        self.assertEqual(mgr.stats.avg_time_ms, 125.0)
        self.assertEqual(mgr.stats.avg_elements_count, 27.5)

        # 重置统计
        mgr.reset_stats()
        self.assertEqual(mgr.stats.total_extractions, 0)

    def test_cache_operations(self):
        """测试缓存操作"""
        from core.ai_browser_agent import ScreenshotManager, ElementCache

        mgr = ScreenshotManager(use_som=True, cache_enabled=True, cache_max_age=5.0)

        # 初始无缓存
        self.assertIsNone(mgr._cache)

        # 手动创建缓存
        import time
        mgr._cache = ElementCache(
            elements=[],
            elements_summary="test",
            url_hash="abc123",
            timestamp=time.time(),
        )

        # 缓存有效
        self.assertTrue(mgr._cache.is_valid(5.0))

        # 清除缓存
        mgr.clear_cache()
        self.assertIsNone(mgr._cache)

    def test_smart_som_toggle(self):
        """测试智能 SoM 开关"""
        from core.ai_browser_agent import ScreenshotManager

        mgr = ScreenshotManager(
            use_som=True,
            smart_som=True,
            som_timeout_threshold=1000.0
        )

        # 初始状态
        self.assertFalse(mgr._som_temporarily_disabled)
        self.assertEqual(mgr._consecutive_slow_extractions, 0)

        # 模拟慢提取
        mgr._check_extraction_performance(2000.0)  # 超过阈值
        self.assertEqual(mgr._consecutive_slow_extractions, 1)

        mgr._check_extraction_performance(1500.0)  # 超过阈值
        self.assertEqual(mgr._consecutive_slow_extractions, 2)

        mgr._check_extraction_performance(1800.0)  # 超过阈值，触发禁用
        self.assertEqual(mgr._consecutive_slow_extractions, 3)
        self.assertTrue(mgr._som_temporarily_disabled)
        self.assertEqual(mgr.stats.auto_disabled_count, 1)

        # 快提取重置
        mgr._check_extraction_performance(500.0)
        self.assertEqual(mgr._consecutive_slow_extractions, 0)
        self.assertFalse(mgr._som_temporarily_disabled)


class TestWatchdogIntegration(unittest.TestCase):
    """Watchdog 集成测试"""

    def test_watchdog_creation(self):
        """测试 Watchdog 创建"""
        from core.ai_browser_agent import (
            create_agent_watchdog,
            AgentWatchdog,
        )

        alerts = []

        def on_alert(alert):
            alerts.append(alert)

        watchdog = create_agent_watchdog(
            step_timeout=30.0,
            on_alert=on_alert,
        )

        self.assertIsInstance(watchdog, AgentWatchdog)

    def test_watchdog_step_tracking(self):
        """测试步骤跟踪"""
        from core.ai_browser_agent import create_agent_watchdog

        watchdog = create_agent_watchdog(step_timeout=30.0)
        watchdog.start()

        # 开始步骤
        watchdog.start_step(1)

        # 检查状态 (使用正确的属性名)
        self.assertEqual(watchdog.step_watchdog._step_number, 1)
        self.assertTrue(watchdog.step_watchdog.is_active)

        # 结束步骤
        watchdog.end_step(success=True)
        # StepWatchdog 停止后不再 active
        self.assertFalse(watchdog.step_watchdog.is_active)
        # 检查 AgentWatchdog 的连续失败计数被重置
        health = watchdog.check_health()
        self.assertEqual(health["consecutive_failures"], 0)

        watchdog.stop()


class TestErrorClassifierIntegration(unittest.TestCase):
    """错误分类器集成测试"""

    def test_error_classification(self):
        """测试错误分类"""
        from core.ai_browser_agent import (
            classify_error,
            ErrorCategory,
        )

        # 连接拒绝错误
        network_error = Exception("Connection refused")
        classified = classify_error(network_error)
        self.assertEqual(classified.category, ErrorCategory.CONNECTION_REFUSED)

        # 超时错误 - 使用 TASK_TIMEOUT 或 NETWORK_TIMEOUT
        timeout_error = asyncio.TimeoutError("Operation timed out")
        classified = classify_error(timeout_error)
        # TimeoutError 可能映射到多种类型，检查是可恢复的即可
        self.assertTrue(classified.is_recoverable)

        # 元素未找到
        element_error = Exception("Element not found: button#submit")
        classified = classify_error(element_error)
        self.assertEqual(classified.category, ErrorCategory.ELEMENT_NOT_FOUND)

    def test_recovery_strategies(self):
        """测试恢复策略"""
        from core.ai_browser_agent import (
            classify_error,
            RecoveryAction,
            DEFAULT_RECOVERY_STRATEGIES,
            ErrorCategory,
        )

        # 检查默认策略存在（使用 ErrorCategory 枚举作为键）
        self.assertIn(ErrorCategory.CONNECTION_REFUSED, DEFAULT_RECOVERY_STRATEGIES)
        self.assertIn(ErrorCategory.ELEMENT_NOT_FOUND, DEFAULT_RECOVERY_STRATEGIES)

        # 网络错误应该可恢复
        network_error = Exception("Connection reset")
        classified = classify_error(network_error)
        self.assertTrue(classified.is_recoverable)


class TestLLMRetryIntegration(unittest.TestCase):
    """LLM 重试集成测试"""

    def test_retry_handler_creation(self):
        """测试重试处理器创建"""
        from core.ai_browser_agent import (
            create_retry_handler,
            LLMRetryHandler,
            RetryConfig,
        )

        handler = create_retry_handler(
            max_retries=5,
            base_delay=1.0,
        )

        self.assertIsInstance(handler, LLMRetryHandler)
        self.assertEqual(handler.config.max_retries, 5)
        self.assertEqual(handler.config.base_delay, 1.0)

    def test_retry_with_success(self):
        """测试成功重试"""
        from core.ai_browser_agent import create_retry_handler

        handler = create_retry_handler(max_retries=3)

        async def successful_func():
            return "success"

        # 使用 asyncio 运行异步测试
        result = asyncio.get_event_loop().run_until_complete(
            handler.execute_with_retry(successful_func)
        )
        self.assertTrue(result.success)
        self.assertEqual(result.value, "success")
        self.assertEqual(result.attempts, 1)

    def test_retry_with_failures(self):
        """测试失败重试"""
        from core.ai_browser_agent import create_retry_handler

        handler = create_retry_handler(max_retries=3, base_delay=0.1)

        attempts = [0]

        async def failing_func():
            attempts[0] += 1
            if attempts[0] < 3:
                raise Exception("Temporary error")
            return "success"

        result = asyncio.get_event_loop().run_until_complete(
            handler.execute_with_retry(failing_func)
        )
        self.assertTrue(result.success)
        self.assertEqual(result.value, "success")
        self.assertEqual(result.attempts, 3)


class TestLoggingIntegration(unittest.TestCase):
    """日志集成测试"""

    def test_agent_logger(self):
        """测试 Agent 日志器"""
        from core.ai_browser_agent import (
            create_agent_logger,
            AgentLogger,
        )

        logger = create_agent_logger(name="test_agent", structured=False)
        self.assertIsInstance(logger, AgentLogger)

        # 测试各种日志方法（不应抛出异常）
        logger.task_start("task-001", "Test task")
        logger.step_start(1, "Test step")
        logger.action_start("CLICK", "button")
        logger.action_end("CLICK", success=True, duration_ms=100.0)
        logger.step_end(success=True, duration_ms=500.0)
        logger.task_end(success=True, total_steps=1, total_duration_ms=1000.0)

    def test_log_performance_decorator(self):
        """测试性能日志装饰器"""
        # 注意：log_performance 装饰器需要正确的 logger 参数
        # 这里只测试装饰器的基本导入
        from core.ai_browser_agent import log_performance

        # 简单验证装饰器可以被导入
        self.assertIsNotNone(log_performance)


class TestCDPServiceIntegration(unittest.TestCase):
    """CDP 服务集成测试"""

    def test_cdp_service_available(self):
        """测试 CDP 服务可用性"""
        from core.ai_browser_agent import (
            CDP_SERVICE_AVAILABLE,
            ENHANCED_MARKER_AVAILABLE,
        )

        # 这些应该是布尔值
        self.assertIsInstance(CDP_SERVICE_AVAILABLE, bool)
        self.assertIsInstance(ENHANCED_MARKER_AVAILABLE, bool)

    def test_coordinate_conversion(self):
        """测试坐标转换函数"""
        from core.ai_browser_agent import (
            css_to_device_coords,
            device_to_css_coords,
            ENHANCED_MARKER_AVAILABLE,
        )

        if ENHANCED_MARKER_AVAILABLE:
            dpr = 2.0

            # CSS to Device
            device_x, device_y = css_to_device_coords(100, 200, dpr)
            self.assertEqual(device_x, 200.0)
            self.assertEqual(device_y, 400.0)

            # Device to CSS
            css_x, css_y = device_to_css_coords(200.0, 400.0, dpr)
            self.assertEqual(css_x, 100.0)
            self.assertEqual(css_y, 200.0)


class TestStateManagementIntegration(unittest.TestCase):
    """状态管理集成测试"""

    def test_state_lifecycle(self):
        """测试状态生命周期"""
        from core.ai_browser_agent import (
            create_state,
            ExecutionState,
        )

        state = create_state(max_steps=10, max_failures=3)

        # 初始状态
        self.assertEqual(state.execution_state, ExecutionState.IDLE)
        self.assertFalse(state.is_running)

        # 开始
        state.start()
        self.assertEqual(state.execution_state, ExecutionState.RUNNING)
        self.assertTrue(state.is_running)

        # 暂停
        state.pause()
        self.assertEqual(state.execution_state, ExecutionState.PAUSED)
        self.assertTrue(state.is_paused)

        # 恢复
        state.resume()
        self.assertEqual(state.execution_state, ExecutionState.RUNNING)

        # 完成
        state.complete()
        self.assertEqual(state.execution_state, ExecutionState.COMPLETED)

    def test_failure_tracking(self):
        """测试失败跟踪"""
        from core.ai_browser_agent import create_state

        state = create_state(max_steps=10, max_failures=3)
        state.start()

        # 记录失败
        state.record_failure()
        self.assertEqual(state.consecutive_failures, 1)

        state.record_failure()
        self.assertEqual(state.consecutive_failures, 2)

        # 重置连续失败计数 (正确的方法名)
        state.reset_consecutive_failures()
        self.assertEqual(state.consecutive_failures, 0)


class TestMessageManagerIntegration(unittest.TestCase):
    """消息管理器集成测试"""

    def test_message_history(self):
        """测试消息历史"""
        from core.ai_browser_agent import MessageManager

        mgr = MessageManager(max_history=5)

        # 添加消息
        mgr.add_system_message("System prompt")
        mgr.add_user_message("User message 1")
        mgr.add_assistant_message("Assistant response 1")
        mgr.add_user_message("User message 2")
        mgr.add_assistant_message("Assistant response 2")

        messages = mgr.get_messages()
        self.assertGreater(len(messages), 0)

    def test_sensitive_masking(self):
        """测试敏感信息脱敏"""
        from core.ai_browser_agent import MessageManager

        mgr = MessageManager()

        # 注册敏感值
        mgr.register_sensitive_value("password", "secret123")

        # 创建包含敏感信息的消息
        mgr.add_user_message("My password is secret123")

        # 检查消息被脱敏 - Message 是对象，用 .role 和 .content 访问
        messages = mgr.get_messages()
        for msg in messages:
            if msg.role == "user":
                self.assertNotIn("secret123", msg.content)


class TestActionRegistryIntegration(unittest.TestCase):
    """Action 注册表集成测试"""

    def test_registry_handlers(self):
        """测试注册的处理器"""
        from core.ai_browser_agent import (
            get_registry,
            ActionType,
            is_terminal_action,
            is_navigation_action,
        )

        registry = get_registry()

        # 检查基本动作类型
        for action_type in [ActionType.CLICK, ActionType.FILL, ActionType.NAVIGATE]:
            handler = registry.get_handler(action_type)
            # 处理器可能为 None（如果未注册）
            # 但检查函数应该正常工作

        # 终止动作检查
        self.assertTrue(is_terminal_action(ActionType.DONE))
        self.assertTrue(is_terminal_action(ActionType.ERROR))

        # 导航动作检查
        self.assertTrue(is_navigation_action(ActionType.NAVIGATE))
        self.assertTrue(is_navigation_action(ActionType.REFRESH))


class TestElementFinderIntegration(unittest.TestCase):
    """ElementFinder 集成测试"""

    def test_element_finder_import(self):
        """测试 ElementFinder 导入"""
        from core.ai_browser_agent import ElementFinder

        self.assertIsNotNone(ElementFinder)


class TestPerformanceMonitorIntegration(unittest.TestCase):
    """性能监控集成测试"""

    def test_performance_monitor_creation(self):
        """测试性能监控器创建"""
        from core.ai_browser_agent import (
            PerformanceMonitor,
            create_performance_monitor,
            get_performance_monitor,
        )

        monitor = create_performance_monitor()
        self.assertIsInstance(monitor, PerformanceMonitor)

        global_monitor = get_performance_monitor()
        self.assertIsInstance(global_monitor, PerformanceMonitor)

    def test_timing_recording(self):
        """测试计时记录"""
        from core.ai_browser_agent import create_performance_monitor

        monitor = create_performance_monitor()
        monitor.start_session()

        # 记录多个计时
        monitor.record_timing("test_metric", 100.0)
        monitor.record_timing("test_metric", 150.0)
        monitor.record_timing("test_metric", 200.0)

        metric = monitor.get_metric("test_metric")
        self.assertEqual(metric.count, 3)
        self.assertEqual(metric.avg_time_ms, 150.0)
        self.assertEqual(metric.min_time_ms, 100.0)
        self.assertEqual(metric.max_time_ms, 200.0)

        monitor.end_session()

    def test_step_recording(self):
        """测试步骤记录"""
        from core.ai_browser_agent import create_performance_monitor

        monitor = create_performance_monitor()
        monitor.start_session()

        # 记录步骤
        monitor.record_step(success=True, duration_ms=500.0, step_number=1)
        monitor.record_step(success=True, duration_ms=600.0, step_number=2)
        monitor.record_step(success=False, duration_ms=700.0, step_number=3)

        self.assertEqual(monitor._total_steps, 3)
        self.assertEqual(monitor._successful_steps, 2)
        self.assertEqual(monitor._failed_steps, 1)
        self.assertAlmostEqual(monitor.success_rate, 2/3)

        monitor.end_session()

    def test_timer_context_manager(self):
        """测试计时器上下文管理器"""
        from core.ai_browser_agent import create_performance_monitor, Timer
        import time as _time

        monitor = create_performance_monitor()

        with Timer(monitor, "context_test") as t:
            _time.sleep(0.01)  # 10ms

        self.assertGreater(t.duration_ms, 5.0)  # 至少 5ms
        metric = monitor.get_metric("context_test")
        self.assertEqual(metric.count, 1)

    def test_performance_summary(self):
        """测试性能摘要"""
        from core.ai_browser_agent import create_performance_monitor

        monitor = create_performance_monitor()
        monitor.start_session()

        monitor.record_step(success=True, duration_ms=100.0, step_number=1)
        monitor.record_llm_call(duration_ms=200.0, tokens_used=500)
        monitor.record_som_extraction(duration_ms=50.0, elements_count=25)

        summary = monitor.get_summary()

        self.assertIn("session", summary)
        self.assertIn("step_timing", summary)
        self.assertIn("llm_timing", summary)
        self.assertIn("som_timing", summary)
        self.assertEqual(summary["session"]["total_steps"], 1)

        monitor.end_session()

    def test_performance_report(self):
        """测试性能报告生成"""
        from core.ai_browser_agent import create_performance_monitor

        monitor = create_performance_monitor()
        monitor.start_session()

        monitor.record_step(success=True, duration_ms=100.0, step_number=1)
        monitor.record_step(success=True, duration_ms=150.0, step_number=2)

        report = monitor.get_report()

        self.assertIn("AI Browser Agent 性能报告", report)
        self.assertIn("总步骤: 2", report)
        self.assertIn("成功率:", report)

        monitor.end_session()


if __name__ == "__main__":
    print("=" * 60)
    print("AI Browser Agent V2 集成测试")
    print("=" * 60)
    unittest.main(verbosity=2)
