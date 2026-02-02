"""
AI Browser Agent V2 模块单元测试

测试所有 V2 新增模块的功能：
- state.py: 状态管理
- message_manager.py: 消息管理
- action_registry.py: Action 注册机制
- action_models.py: 参数模型
- errors.py: 错误分类
- watchdog.py: Watchdog 监控
- logging_config.py: 结构化日志
- llm_retry.py: LLM 重试机制

运行方法:
    python -m pytest tests/test_ai_browser_agent_v2.py -v
    python tests/test_ai_browser_agent_v2.py  # 直接运行
"""

import os
import sys
import asyncio
import unittest
import tempfile
from pathlib import Path
from datetime import datetime

# 添加项目根目录到路径
sys.path.insert(0, str(Path(__file__).parent.parent))


class TestStateModule(unittest.TestCase):
    """测试状态管理模块"""

    def test_execution_state_enum(self):
        """测试 ExecutionState 枚举"""
        from core.ai_browser_agent import ExecutionState

        self.assertEqual(ExecutionState.IDLE.value, "idle")
        self.assertEqual(ExecutionState.RUNNING.value, "running")
        self.assertEqual(ExecutionState.PAUSED.value, "paused")
        self.assertEqual(ExecutionState.COMPLETED.value, "completed")
        self.assertEqual(ExecutionState.FAILED.value, "failed")

    def test_create_state(self):
        """测试创建状态对象"""
        from core.ai_browser_agent import create_state, ExecutionState

        state = create_state(max_steps=30, max_failures=3)
        self.assertEqual(state.max_steps, 30)
        self.assertEqual(state.max_failures, 3)
        self.assertEqual(state.execution_state, ExecutionState.IDLE)
        self.assertEqual(state.n_steps, 0)

    def test_state_control_methods(self):
        """测试状态控制方法"""
        from core.ai_browser_agent import create_state, ExecutionState

        state = create_state()

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
        self.assertFalse(state.is_paused)

        # 停止
        state.stop()
        self.assertEqual(state.execution_state, ExecutionState.STOPPED)
        self.assertTrue(state.is_stopped)

    def test_state_serialization(self):
        """测试状态序列化"""
        from core.ai_browser_agent import create_state

        state = create_state(max_steps=15)
        state.start()
        state.increment_step()
        state.increment_step()

        # 序列化
        state_dict = state.to_dict()
        self.assertEqual(state_dict["n_steps"], 2)
        self.assertEqual(state_dict["max_steps"], 15)
        self.assertEqual(state_dict["execution_state"], "running")

        # JSON 序列化
        json_str = state.to_json()
        self.assertIn("n_steps", json_str)

    def test_state_file_persistence(self):
        """测试状态文件持久化"""
        from core.ai_browser_agent import create_state, AgentStateData

        state = create_state(max_steps=10)
        state.start()
        state.increment_step()

        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            filepath = f.name

        try:
            # 保存
            state.save(filepath)

            # 加载
            loaded_state = AgentStateData.load(filepath)
            self.assertEqual(loaded_state.n_steps, 1)
            self.assertEqual(loaded_state.max_steps, 10)
        finally:
            os.unlink(filepath)


class TestMessageManager(unittest.TestCase):
    """测试消息管理模块"""

    def test_message_creation(self):
        """测试消息创建"""
        from core.ai_browser_agent import Message

        msg = Message(role="user", content="Hello")
        self.assertEqual(msg.role, "user")
        self.assertEqual(msg.content, "Hello")
        self.assertIsInstance(msg.timestamp, datetime)

    def test_message_manager_basics(self):
        """测试消息管理器基础功能"""
        from core.ai_browser_agent import MessageManager

        manager = MessageManager(max_history=10)

        manager.add_system_message("You are a browser agent.")
        manager.add_user_message("Click the button.")
        manager.add_assistant_message("I will click the button.")

        messages = manager.get_messages()
        self.assertEqual(len(messages), 3)
        self.assertEqual(messages[0].role, "system")
        self.assertEqual(messages[1].role, "user")
        self.assertEqual(messages[2].role, "assistant")

    def test_message_manager_with_images(self):
        """测试带图片的消息"""
        from core.ai_browser_agent import MessageManager

        manager = MessageManager()

        # 模拟截图数据
        fake_screenshot = b'\x89PNG\r\n\x1a\n' + b'\x00' * 100
        manager.add_user_message("Analyze this page", images=[fake_screenshot])

        messages = manager.get_messages()
        self.assertEqual(len(messages), 1)
        self.assertEqual(len(messages[0].images), 1)

    def test_message_sensitive_masking(self):
        """测试敏感信息脱敏"""
        from core.ai_browser_agent import MessageManager

        manager = MessageManager(mask_sensitive=True)
        manager.register_sensitive_value("password", "secret123")

        manager.add_user_message("The password is secret123")

        messages = manager.get_messages()
        self.assertIn("<password>", messages[0].content)
        self.assertNotIn("secret123", messages[0].content)

    def test_message_history_trimming(self):
        """测试历史消息裁剪"""
        from core.ai_browser_agent import MessageManager

        manager = MessageManager(max_history=5)
        manager.add_system_message("System prompt")

        # 添加超过限制的消息
        for i in range(10):
            manager.add_user_message(f"Message {i}")

        messages = manager.get_messages()
        # 系统消息 + 最近的消息
        self.assertLessEqual(len(messages), 5)
        # 系统消息应该保留
        self.assertEqual(messages[0].role, "system")


class TestActionRegistry(unittest.TestCase):
    """测试 Action 注册机制"""

    def test_registry_singleton(self):
        """测试注册表单例"""
        from core.ai_browser_agent import ActionRegistry

        registry1 = ActionRegistry()
        registry2 = ActionRegistry()
        self.assertIs(registry1, registry2)

    def test_get_registry(self):
        """测试获取全局注册表"""
        from core.ai_browser_agent import get_registry, ActionType

        registry = get_registry()
        self.assertIsNotNone(registry)

        # 确认已注册的 Action
        self.assertTrue(registry.has_handler(ActionType.CLICK))
        self.assertTrue(registry.has_handler(ActionType.FILL))
        self.assertTrue(registry.has_handler(ActionType.DONE))

    def test_list_actions(self):
        """测试列出所有注册的 Action"""
        from core.ai_browser_agent import get_registry

        registry = get_registry()
        actions = registry.list_actions()

        # 至少应该有 14 个 Action
        self.assertGreaterEqual(len(actions), 14)

    def test_terminal_action_check(self):
        """测试终止类动作检查"""
        from core.ai_browser_agent import is_terminal_action, ActionType

        self.assertTrue(is_terminal_action(ActionType.DONE))
        self.assertTrue(is_terminal_action(ActionType.ERROR))
        self.assertTrue(is_terminal_action(ActionType.NEED_VERIFICATION))
        self.assertFalse(is_terminal_action(ActionType.CLICK))
        self.assertFalse(is_terminal_action(ActionType.FILL))

    def test_navigation_action_check(self):
        """测试导航类动作检查"""
        from core.ai_browser_agent import is_navigation_action, ActionType

        self.assertTrue(is_navigation_action(ActionType.NAVIGATE))
        self.assertTrue(is_navigation_action(ActionType.REFRESH))
        self.assertTrue(is_navigation_action(ActionType.CLICK))  # 点击可能触发导航
        self.assertFalse(is_navigation_action(ActionType.FILL))


class TestActionModels(unittest.TestCase):
    """测试 Action 参数模型"""

    def test_click_params(self):
        """测试点击参数模型"""
        from core.ai_browser_agent import ClickParams

        # 有效参数
        params = ClickParams(target="Login button")
        errors = params.validate()
        self.assertEqual(len(errors), 0)

        # 坐标参数
        params2 = ClickParams(x=100, y=200)
        errors2 = params2.validate()
        self.assertEqual(len(errors2), 0)

        # 无效参数（没有目标也没有坐标）
        params3 = ClickParams()
        errors3 = params3.validate()
        self.assertGreater(len(errors3), 0)

    def test_fill_params(self):
        """测试填写参数模型"""
        from core.ai_browser_agent import FillParams

        # 有效参数
        params = FillParams(target="Email input", value="test@example.com")
        errors = params.validate()
        self.assertEqual(len(errors), 0)

        # 无效参数（没有值）
        params2 = FillParams(target="Email input", value="")
        errors2 = params2.validate()
        self.assertGreater(len(errors2), 0)

    def test_navigate_params(self):
        """测试导航参数模型"""
        from core.ai_browser_agent import NavigateParams

        # 有效 URL
        params = NavigateParams(url="https://example.com")
        errors = params.validate()
        self.assertEqual(len(errors), 0)

        # 无效 URL
        params2 = NavigateParams(url="not-a-url")
        errors2 = params2.validate()
        self.assertGreater(len(errors2), 0)

    def test_create_params_factory(self):
        """测试参数创建工厂函数"""
        from core.ai_browser_agent import create_params, ActionType

        params = create_params(ActionType.CLICK, target="Button", x=50, y=100)
        self.assertIsNotNone(params)
        self.assertEqual(params.target, "Button")
        self.assertEqual(params.x, 50)


class TestErrorClassification(unittest.TestCase):
    """测试错误分类模块"""

    def test_error_category_enum(self):
        """测试错误类别枚举"""
        from core.ai_browser_agent import ErrorCategory

        self.assertEqual(ErrorCategory.NETWORK.value, "network")
        self.assertEqual(ErrorCategory.ELEMENT_NOT_FOUND.value, "element_not_found")
        self.assertEqual(ErrorCategory.LLM_RATE_LIMIT.value, "llm_rate_limit")

    def test_classify_timeout_error(self):
        """测试超时错误分类"""
        from core.ai_browser_agent import classify_error, ErrorCategory

        error = TimeoutError("Connection timed out")
        classified = classify_error(error)

        self.assertEqual(classified.category, ErrorCategory.NETWORK_TIMEOUT)
        self.assertTrue(classified.is_recoverable)

    def test_classify_element_not_found(self):
        """测试元素未找到错误分类"""
        from core.ai_browser_agent import classify_error, ErrorCategory

        error = Exception("Element not found: button#submit")
        classified = classify_error(error)

        self.assertEqual(classified.category, ErrorCategory.ELEMENT_NOT_FOUND)

    def test_classify_rate_limit(self):
        """测试速率限制错误分类"""
        from core.ai_browser_agent import classify_error, ErrorCategory

        error = Exception("429 Too Many Requests")
        classified = classify_error(error)

        self.assertEqual(classified.category, ErrorCategory.LLM_RATE_LIMIT)

    def test_recovery_strategy(self):
        """测试恢复策略"""
        from core.ai_browser_agent import classify_error, RecoveryAction

        error = Exception("Rate limit exceeded 429")
        classified = classify_error(error)

        self.assertIsNotNone(classified.recovery_strategy)
        self.assertEqual(classified.recovery_strategy.action, RecoveryAction.WAIT)

    def test_error_to_dict(self):
        """测试错误序列化"""
        from core.ai_browser_agent import classify_error

        error = Exception("Network timeout")
        classified = classify_error(error)

        error_dict = classified.to_dict()
        self.assertIn("category", error_dict)
        self.assertIn("message", error_dict)
        self.assertIn("is_recoverable", error_dict)


class TestWatchdog(unittest.TestCase):
    """测试 Watchdog 监控模块"""

    def test_step_watchdog(self):
        """测试步骤级 Watchdog"""
        from core.ai_browser_agent import StepWatchdog

        watchdog = StepWatchdog(timeout_seconds=10.0, warning_threshold=5.0)

        self.assertFalse(watchdog.is_active)

        watchdog.start(step_number=1)
        self.assertTrue(watchdog.is_active)

        # 检查无超时
        alert = watchdog.check()
        self.assertIsNone(alert)

        watchdog.stop()
        self.assertFalse(watchdog.is_active)

    def test_agent_watchdog(self):
        """测试 Agent Watchdog"""
        from core.ai_browser_agent import create_agent_watchdog

        watchdog = create_agent_watchdog(step_timeout=60.0)

        watchdog.start()
        watchdog.start_step(1)
        watchdog.heartbeat()

        health = watchdog.check_health()
        self.assertTrue(health["is_running"])
        self.assertTrue(health["is_responsive"])
        self.assertEqual(health["consecutive_failures"], 0)

        watchdog.end_step(success=True)
        watchdog.stop()

    def test_watchdog_alerts(self):
        """测试 Watchdog 告警"""
        from core.ai_browser_agent import WatchdogEvent, WatchdogAlert

        alert = WatchdogAlert(
            event=WatchdogEvent.TIMEOUT,
            message="Step timeout",
            severity="error"
        )

        self.assertEqual(alert.event, WatchdogEvent.TIMEOUT)
        self.assertEqual(alert.severity, "error")

        alert_dict = alert.to_dict()
        self.assertEqual(alert_dict["event"], "timeout")


class TestLoggingConfig(unittest.TestCase):
    """测试结构化日志模块"""

    def test_agent_logger(self):
        """测试 Agent 日志器"""
        from core.ai_browser_agent import AgentLogger
        import logging

        logger = AgentLogger(name="test_agent", level=logging.DEBUG)

        # 不抛异常即可
        logger.task_start("task-001", "Test task")
        logger.step_start(1, "First step")
        logger.action_start("CLICK", "Button")
        logger.action_end("CLICK", success=True, duration_ms=100.0)
        logger.step_end(success=True, duration_ms=500.0)
        logger.task_end(success=True, total_steps=1, total_duration_ms=1000.0)

    def test_log_events(self):
        """测试日志事件"""
        from core.ai_browser_agent import LogEvent

        event = LogEvent(
            event_type="ACTION_START",
            message="Click button",
            action_type="CLICK"
        )

        self.assertEqual(event.event_type, "ACTION_START")
        self.assertIn("CLICK", str(event))

        event_dict = event.to_dict()
        self.assertIn("event_type", event_dict)
        self.assertIn("timestamp", event_dict)

    def test_configure_logging(self):
        """测试日志配置"""
        from core.ai_browser_agent import configure_logging
        import logging

        logger = configure_logging(
            level=logging.INFO,
            structured=False,
            use_colors=True
        )

        self.assertIsNotNone(logger)


class TestLLMRetry(unittest.TestCase):
    """测试 LLM 重试机制"""

    def test_retry_config(self):
        """测试重试配置"""
        from core.ai_browser_agent import RetryConfig

        config = RetryConfig(
            max_retries=5,
            base_delay=2.0,
            max_delay=30.0,
            backoff_factor=2.0
        )

        self.assertEqual(config.max_retries, 5)
        self.assertEqual(config.base_delay, 2.0)
        self.assertTrue(config.jitter)

    def test_create_retry_handler(self):
        """测试创建重试处理器"""
        from core.ai_browser_agent import create_retry_handler

        handler = create_retry_handler(
            max_retries=3,
            base_delay=1.0
        )

        self.assertIsNotNone(handler)
        self.assertEqual(handler.config.max_retries, 3)

    def test_retry_result(self):
        """测试重试结果"""
        from core.ai_browser_agent import RetryResult

        result = RetryResult(
            success=True,
            value="test_value",
            attempts=2,
            total_delay=1.5
        )

        self.assertTrue(result.success)
        self.assertEqual(result.value, "test_value")
        self.assertEqual(result.attempts, 2)

    def test_sync_retry_success(self):
        """测试同步重试成功"""
        from core.ai_browser_agent import create_retry_handler

        handler = create_retry_handler(max_retries=3)

        call_count = 0

        def success_func():
            nonlocal call_count
            call_count += 1
            return "success"

        result = handler.sync_execute_with_retry(success_func)

        self.assertTrue(result.success)
        self.assertEqual(result.value, "success")
        self.assertEqual(call_count, 1)

    def test_sync_retry_with_failures(self):
        """测试同步重试带失败"""
        from core.ai_browser_agent import create_retry_handler

        handler = create_retry_handler(max_retries=3, base_delay=0.1)

        call_count = 0

        def fail_twice():
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise Exception("Temporary error")
            return "success"

        result = handler.sync_execute_with_retry(fail_twice)

        self.assertTrue(result.success)
        self.assertEqual(result.value, "success")
        self.assertEqual(call_count, 3)


class TestAsyncFeatures(unittest.TestCase):
    """测试异步功能"""

    def test_async_retry(self):
        """测试异步重试"""
        from core.ai_browser_agent import create_retry_handler

        async def run_test():
            handler = create_retry_handler(max_retries=3, base_delay=0.1)

            call_count = 0

            async def async_success():
                nonlocal call_count
                call_count += 1
                return "async_success"

            result = await handler.execute_with_retry(async_success)
            return result, call_count

        result, count = asyncio.run(run_test())

        self.assertTrue(result.success)
        self.assertEqual(result.value, "async_success")
        self.assertEqual(count, 1)


class TestIntegration(unittest.TestCase):
    """集成测试"""

    def test_all_v2_modules_import(self):
        """测试所有 V2 模块导入"""
        from core.ai_browser_agent import (
            # State Management
            ExecutionState,
            AgentStateData,
            StepMetadata,
            StepRecord,
            create_state,
            # Message Manager
            MessageManager,
            Message,
            # Action Registry
            ActionRegistry,
            ActionMetadata,
            action,
            get_registry,
            is_terminal_action,
            # Action Models
            ClickParams,
            FillParams,
            NavigateParams,
            create_params,
            # Error Classification
            ErrorCategory,
            RecoveryAction,
            ClassifiedError,
            classify_error,
            # Watchdog
            AgentWatchdog,
            create_agent_watchdog,
            # Logging
            AgentLogger,
            configure_logging,
            # LLM Retry
            LLMRetryHandler,
            create_retry_handler,
        )

        # 所有导入成功
        self.assertTrue(True)

    def test_action_registry_handlers_count(self):
        """测试 Action 处理器数量"""
        from core.ai_browser_agent import get_registry, ActionType

        registry = get_registry()

        # 验证所有 ActionType 都有处理器
        missing = []
        for action_type in ActionType:
            if not registry.has_handler(action_type):
                missing.append(action_type)

        self.assertEqual(
            len(missing), 0,
            f"Missing handlers for: {[a.value for a in missing]}"
        )


def run_tests():
    """运行所有测试"""
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()

    # 添加所有测试类
    suite.addTests(loader.loadTestsFromTestCase(TestStateModule))
    suite.addTests(loader.loadTestsFromTestCase(TestMessageManager))
    suite.addTests(loader.loadTestsFromTestCase(TestActionRegistry))
    suite.addTests(loader.loadTestsFromTestCase(TestActionModels))
    suite.addTests(loader.loadTestsFromTestCase(TestErrorClassification))
    suite.addTests(loader.loadTestsFromTestCase(TestWatchdog))
    suite.addTests(loader.loadTestsFromTestCase(TestLoggingConfig))
    suite.addTests(loader.loadTestsFromTestCase(TestLLMRetry))
    suite.addTests(loader.loadTestsFromTestCase(TestAsyncFeatures))
    suite.addTests(loader.loadTestsFromTestCase(TestIntegration))

    # 运行测试
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    # 返回退出码
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(run_tests())
