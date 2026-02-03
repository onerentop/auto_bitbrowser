"""
AI Browser Agent - 核心 Agent 类 (V2 三层架构)

整合 Vision Analyzer 和 Action Executor，实现完整的 AI 驱动浏览器自动化

架构设计：
- run(): 顶层 - 会话生命周期管理、信号处理
- _execute_step(): 中层 - 单步超时控制、钩子调用、错误处理
- _step(): 底层 - 四阶段执行（截图→分析→执行→后处理）

V2 集成：
- AgentWatchdog: 步骤超时和健康监控
- ErrorClassifier: 错误分类和恢复策略
- AgentLogger: 结构化日志
- LLMRetryHandler: 智能 LLM 重试
"""

import asyncio
import time
from datetime import datetime
from typing import Optional, Callable, Any
import traceback

from playwright.async_api import async_playwright, Browser, BrowserContext, Page

from .types import (
    ActionType,
    AgentAction,
    AgentState,
    TaskContext,
    TaskResult,
)
from .state import (
    AgentStateData,
    ExecutionState,
    StepMetadata,
    ActionResult,
    create_state,
)
from .message_manager import MessageManager
from .vision_analyzer import VisionAnalyzer
from .action_executor import ActionExecutor

# V2: 集成 Watchdog、错误分类、日志、重试
from .watchdog import AgentWatchdog, WatchdogAlert, create_agent_watchdog
from .errors import classify_error, ErrorCategory, ClassifiedError
from .logging_config import AgentLogger, create_agent_logger, get_agent_logger
from .llm_retry import LLMRetryHandler, create_retry_handler, RetryResult

# 模块级日志器（用于 run_with_ixbrowser 等便捷函数）
import logging
_module_logger = logging.getLogger("ai_browser_agent")

# 邮箱验证码读取器 (可选依赖)
try:
    from services.email_code_reader import GmailCodeReader
    EMAIL_CODE_READER_AVAILABLE = True
except ImportError:
    EMAIL_CODE_READER_AVAILABLE = False


class AIBrowserAgent:
    """
    AI 浏览器代理 (V2 三层架构)

    使用多模态 LLM (Gemini/Anthropic) 分析页面截图，智能执行浏览器自动化任务
    支持多 LLM 提供商切换、暂停/恢复、状态持久化

    V2 增强：
    - AgentWatchdog: 监控步骤超时和代理健康状态
    - ErrorClassifier: 自动分类错误并选择恢复策略
    - AgentLogger: 结构化日志输出
    - LLMRetryHandler: 智能 LLM API 重试
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: str = None,
        provider: Optional[str] = None,
        default_timeout: int = 10000,
        screenshot_delay: float = 2.0,
        use_som: bool = True,
        compress_screenshot: bool = False,
        max_failures: int = 5,
        step_timeout: float = 120.0,
        enable_watchdog: bool = True,
        structured_logging: bool = False,
    ):
        """
        初始化 AI Browser Agent

        Args:
            api_key: API Key（默认从环境变量读取）
            base_url: API Base URL（默认使用提供商的默认 API）
            model: 使用的模型（默认使用提供商的默认模型）
            provider: LLM 提供商 (gemini, anthropic)，默认 gemini
            default_timeout: 默认操作超时时间（毫秒）
            screenshot_delay: 截图前的等待时间（秒），默认 2.0 秒
            use_som: 是否启用 SoM 元素标记（默认 True）
            compress_screenshot: 是否压缩截图以减少 API 成本（默认 False）
            max_failures: 最大连续失败次数（默认 5）
            step_timeout: 单步超时时间（秒，默认 120）
            enable_watchdog: 是否启用 Watchdog 监控（默认 True）
            structured_logging: 是否使用 JSON 格式日志（默认 False）

        Environment Variables:
            GEMINI_API_KEY: Gemini API 密钥
            ANTHROPIC_API_KEY: Anthropic API 密钥
        """
        self.vision_analyzer = VisionAnalyzer(
            api_key=api_key,
            base_url=base_url,
            model=model,
            provider=provider,
        )
        self.default_timeout = default_timeout
        self.screenshot_delay = screenshot_delay
        self.use_som = use_som
        self.compress_screenshot = compress_screenshot
        self.max_failures = max_failures
        self.step_timeout = step_timeout

        # 状态管理（使用新的状态对象）
        self.state_data: Optional[AgentStateData] = None
        self.state = AgentState.IDLE  # 兼容旧接口

        # 消息管理器
        self.message_manager: Optional[MessageManager] = None

        # V2: 结构化日志
        self.logger = create_agent_logger(
            name="ai_browser_agent",
            structured=structured_logging,
        )

        # V2: Watchdog 监控
        self.enable_watchdog = enable_watchdog
        self.watchdog: Optional[AgentWatchdog] = None
        if enable_watchdog:
            self.watchdog = create_agent_watchdog(
                step_timeout=step_timeout,
                on_alert=self._on_watchdog_alert,
            )

        # V2: LLM 重试处理器
        self.retry_handler = create_retry_handler(
            max_retries=3,
            base_delay=2.0,
            on_retry=self._on_llm_retry,
        )

        # 回调函数
        self._on_action: Optional[Callable[[AgentAction], None]] = None
        self._on_step: Optional[Callable[[int, AgentAction], None]] = None
        self._on_screenshot: Optional[Callable[[bytes], None]] = None
        self._on_step_start: Optional[Callable[[int], None]] = None
        self._on_step_end: Optional[Callable[[int, bool], None]] = None

    # ============ V2 回调处理 ============

    def _on_watchdog_alert(self, alert: WatchdogAlert):
        """处理 Watchdog 告警"""
        self.logger.warning(
            f"Watchdog 告警: [{alert.event.value}] {alert.message}",
            severity=alert.severity,
        )

    def _on_llm_retry(self, attempt: int, error: Exception, delay: float):
        """处理 LLM 重试事件"""
        self.logger.warning(
            f"LLM 调用失败，准备重试",
            attempt=attempt,
            error=str(error),
            delay=delay,
        )

    # ============ 回调设置 ============

    def on_action(self, callback: Callable[[AgentAction], None]):
        """设置动作回调"""
        self._on_action = callback

    def on_step(self, callback: Callable[[int, AgentAction], None]):
        """设置步骤回调"""
        self._on_step = callback

    def on_screenshot(self, callback: Callable[[bytes], None]):
        """设置截图回调"""
        self._on_screenshot = callback

    def on_step_start(self, callback: Callable[[int], None]):
        """设置步骤开始回调"""
        self._on_step_start = callback

    def on_step_end(self, callback: Callable[[int, bool], None]):
        """设置步骤结束回调 (step_number, success)"""
        self._on_step_end = callback

    # ============ 控制方法 ============

    def stop(self):
        """请求停止执行"""
        if self.state_data:
            self.state_data.stop()
        self.state = AgentState.STOPPED

    def pause(self):
        """暂停执行"""
        if self.state_data:
            self.state_data.pause()

    def resume(self):
        """恢复执行"""
        if self.state_data:
            self.state_data.resume()

    @property
    def is_running(self) -> bool:
        """是否正在运行"""
        return self.state_data.is_running if self.state_data else False

    @property
    def is_paused(self) -> bool:
        """是否已暂停"""
        return self.state_data.is_paused if self.state_data else False

    # ============ 顶层：run (会话生命周期) ============

    async def run(
        self,
        page: Page,
        goal: str,
        start_url: str,
        account: dict = None,
        params: dict = None,
        task_type: Optional[str] = None,
        max_steps: int = 20,
        navigate_first: bool = True,
    ) -> TaskResult:
        """
        运行自动化任务（顶层入口）

        管理会话生命周期、初始化状态、处理最终结果

        Args:
            page: Playwright Page 对象
            goal: 任务目标描述
            start_url: 起始 URL
            account: 账号信息 {'email', 'password', 'secret'}
            params: 额外参数
            task_type: 任务类型（用于加载特定提示词）
            max_steps: 最大执行步骤数
            navigate_first: 是否先导航到起始 URL

        Returns:
            TaskResult: 执行结果
        """
        task_start_time = time.time()
        task_id = f"task_{int(task_start_time * 1000)}"

        # 1. 初始化状态
        self.state_data = create_state(
            max_steps=max_steps,
            max_failures=self.max_failures,
        )
        self.state_data.start()
        self.state = AgentState.RUNNING

        # V2: 初始化日志上下文
        self.logger.task_start(task_id, goal)

        # V2: 启动 Watchdog
        if self.watchdog:
            self.watchdog.start()

        # 2. 初始化消息管理器
        self.message_manager = MessageManager(max_history=20)
        if account:
            # 注册敏感数据脱敏
            if account.get("password"):
                self.message_manager.register_sensitive_value("password", account["password"])
            if account.get("secret"):
                self.message_manager.register_sensitive_value("secret", account["secret"])

        # 3. 创建任务上下文
        context = TaskContext(
            goal=goal,
            start_url=start_url,
            account=account or {},
            params=params or {},
            max_steps=max_steps,
        )

        # 4. 创建执行器和截图管理器
        executor = ActionExecutor(page, timeout=self.default_timeout)

        from .screenshot_manager import ScreenshotManager
        screenshot_mgr = ScreenshotManager(
            use_som=self.use_som,
            compress=self.compress_screenshot,
        )

        try:
            # 5. 导航到起始页面
            if navigate_first:
                nav_start = time.time()
                await self._navigate_with_retry(page, start_url)
                self.logger.navigation(start_url, (time.time() - nav_start) * 1000)
                await asyncio.sleep(self.screenshot_delay)

            # 6. 主循环
            while not self.state_data.should_stop:
                # V2: Watchdog 心跳
                if self.watchdog:
                    self.watchdog.heartbeat()

                # 检查暂停
                await self._check_pause()

                # 检查停止
                if self.state_data.is_stopped:
                    result = self._create_stopped_result(context)
                    self._finalize_task(task_start_time, result)
                    return result

                # 执行单步（带超时）
                step_result = await self._execute_step(
                    page=page,
                    context=context,
                    executor=executor,
                    screenshot_mgr=screenshot_mgr,
                    task_type=task_type,
                )

                # 处理步骤结果
                if step_result is not None:
                    # 返回非 None 表示任务终止（完成/失败/等待输入）
                    self._finalize_task(task_start_time, step_result)
                    return step_result

            # 7. 达到限制
            if self.state_data.consecutive_failures >= self.max_failures:
                self.state_data.fail()
                self.state = AgentState.FAILED
                result = TaskResult.failure_result(
                    message=f"连续失败次数达到上限 ({self.max_failures})",
                    steps=self.state_data.n_steps,
                )
                self._finalize_task(task_start_time, result)
                return result

            self.state_data.fail()
            self.state = AgentState.FAILED
            result = TaskResult.failure_result(
                message=f"达到最大步骤数限制 ({max_steps})",
                steps=max_steps,
            )
            self._finalize_task(task_start_time, result)
            return result

        except Exception as e:
            # V2: 使用错误分类
            classified = classify_error(e, context={"goal": goal, "step": self.state_data.n_steps if self.state_data else 0})
            self.logger.error(
                f"执行异常: {str(e)}",
                error_type=classified.category.value,
                recoverable=classified.is_recoverable,
            )

            self.state_data.fail()
            self.state = AgentState.FAILED
            result = TaskResult.failure_result(
                message=f"执行异常: {str(e)}",
                error_details=traceback.format_exc(),
                steps=self.state_data.n_steps if self.state_data else 0,
            )
            self._finalize_task(task_start_time, result)
            return result

    def _finalize_task(self, start_time: float, result: TaskResult):
        """任务结束清理"""
        duration_ms = (time.time() - start_time) * 1000

        # V2: 停止 Watchdog
        if self.watchdog:
            self.watchdog.stop()

        # V2: 记录任务结束日志
        self.logger.task_end(
            success=result.success,
            total_steps=result.total_steps,
            total_duration_ms=duration_ms,
            message=result.message,
        )

    # 兼容旧接口
    async def execute_task(self, *args, **kwargs) -> TaskResult:
        """执行自动化任务（兼容旧接口）"""
        return await self.run(*args, **kwargs)

    # ============ 中层：_execute_step (单步控制) ============

    async def _execute_step(
        self,
        page: Page,
        context: TaskContext,
        executor: ActionExecutor,
        screenshot_mgr,
        task_type: Optional[str],
    ) -> Optional[TaskResult]:
        """
        执行单个步骤（中层）

        负责：
        - 单步超时控制
        - V2: Watchdog 步骤监控
        - V2: 错误分类和恢复策略
        - 钩子调用
        - 错误处理和重试决策

        Returns:
            TaskResult 如果任务终止，None 继续执行
        """
        step_number = self.state_data.n_steps
        step_start_time = time.time()
        metadata = StepMetadata(step_number=step_number)

        # V2: Watchdog 开始监控步骤
        if self.watchdog:
            self.watchdog.start_step(step_number)

        # 触发步骤开始回调
        if self._on_step_start:
            self._on_step_start(step_number)

        # V2: 结构化日志
        self.logger.step_start(step_number + 1, f"步骤 {step_number + 1}/{self.state_data.max_steps}")

        try:
            # 带超时执行
            result = await asyncio.wait_for(
                self._step(page, context, executor, screenshot_mgr, task_type, metadata),
                timeout=self.step_timeout,
            )

            # 完成元数据
            metadata.complete()
            step_duration_ms = (time.time() - step_start_time) * 1000

            # V2: Watchdog 结束步骤
            if self.watchdog:
                self.watchdog.end_step(success=result is None or (result and result.success))

            # V2: 步骤结束日志
            self.logger.step_end(
                success=result is None or (result and result.success),
                duration_ms=step_duration_ms,
            )

            # 触发步骤结束回调
            if self._on_step_end:
                self._on_step_end(step_number, result is None or (result and result.success))

            return result

        except asyncio.TimeoutError:
            # 步骤超时
            metadata.complete()
            self.state_data.record_failure()
            step_duration_ms = (time.time() - step_start_time) * 1000

            # V2: Watchdog 记录失败
            if self.watchdog:
                self.watchdog.end_step(success=False)

            # V2: 结构化日志
            self.logger.step_end(
                success=False,
                duration_ms=step_duration_ms,
                message=f"超时 ({self.step_timeout}s)",
            )

            if self._on_step_end:
                self._on_step_end(step_number, False)

            # 检查是否达到失败阈值
            if self.state_data.consecutive_failures >= self.max_failures:
                return self._create_failure_result(
                    context,
                    f"步骤超时，连续失败达到上限 ({self.max_failures})",
                )

            # 继续执行
            return None

        except Exception as e:
            # V2: 使用错误分类
            classified = classify_error(e, context={"step": step_number})
            metadata.complete()
            step_duration_ms = (time.time() - step_start_time) * 1000

            # V2: Watchdog 记录失败
            if self.watchdog:
                self.watchdog.end_step(success=False)

            # V2: 结构化错误日志
            self.logger.error(
                f"步骤执行错误: {str(e)}",
                error_type=classified.category.value,
                recoverable=classified.is_recoverable,
            )

            return await self._handle_step_error(e, context, metadata, classified)

    # ============ 底层：_step (四阶段执行) ============

    async def _step(
        self,
        page: Page,
        context: TaskContext,
        executor: ActionExecutor,
        screenshot_mgr,
        task_type: Optional[str],
        metadata: StepMetadata,
    ) -> Optional[TaskResult]:
        """
        执行单步的四阶段流程（底层）

        1. 准备阶段：截图 + 元素提取
        2. 分析阶段：AI 决策
        3. 执行阶段：动作执行
        4. 后处理：状态更新

        Returns:
            TaskResult 如果任务终止，None 继续执行
        """
        # ========== 阶段 1: 准备 (截图) ==========
        screenshot_start = time.time()
        screenshot_result = await screenshot_mgr.capture(page)
        screenshot_duration = (time.time() - screenshot_start) * 1000

        # V2: 截图日志
        self.logger.screenshot(
            duration_ms=screenshot_duration,
            elements_count=len(screenshot_result.elements) if screenshot_result.elements else 0,
        )

        if self._on_screenshot:
            self._on_screenshot(screenshot_result.screenshot)

        # ========== 阶段 2: AI 分析 ==========
        self.logger.debug("AI 分析中...")
        action = await self._get_action_with_retry(
            screenshot=screenshot_result.screenshot,
            context=context,
            task_type=task_type,
            elements_summary=screenshot_result.elements_summary,
        )

        self.logger.info(f"AI 决策: {action.action_type.value}", action=str(action))

        # 触发动作回调
        if self._on_action:
            self._on_action(action)

        # ========== 阶段 3: 检查终止动作并执行 ==========
        terminal_result = await self._handle_terminal_actions(
            action, context, executor, screenshot_result.elements
        )
        if terminal_result is not None:
            return terminal_result

        # V2: 动作开始日志
        self.logger.action_start(action.action_type.value, action.target_description or "")

        # 执行普通动作
        action_start = time.time()
        success, message = await executor.execute(
            action,
            elements=screenshot_result.elements
        )
        action_duration = (time.time() - action_start) * 1000

        # V2: 动作结束日志
        self.logger.action_end(
            action.action_type.value,
            success=success,
            duration_ms=action_duration,
            error=message if not success else None,
        )

        # ========== 阶段 4: 后处理 ==========
        # 记录动作到上下文
        context.add_action(action)

        # 记录到状态
        action_result = ActionResult(success=success, message=message)
        self.state_data.record_step(
            action=action,
            result=action_result,
            metadata=metadata,
            elements_count=len(screenshot_result.elements) if screenshot_result.elements else 0,
        )

        # 触发步骤回调
        if self._on_step:
            self._on_step(context.current_step, action)

        # 处理执行失败
        if not success:
            self.logger.warning(f"动作执行失败: {message}")
            # 不立即返回失败，让 AI 重新分析（可能恢复）

        # 等待页面稳定
        await self._wait_after_action(action)

        return None  # 继续执行

    # ============ 辅助方法 ============

    async def _navigate_with_retry(self, page: Page, url: str, retries: int = 3):
        """带重试的导航"""
        nav_timeout = 60000
        for attempt in range(retries):
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=nav_timeout)
                self.logger.info(f"导航成功: {url[:60]}...")
                return
            except Exception as e:
                if attempt < retries - 1:
                    self.logger.warning(f"导航超时 (尝试 {attempt + 1}/{retries})，重试中...")
                    await asyncio.sleep(2)
                else:
                    # 最后尝试使用更宽松的策略
                    self.logger.warning("导航仍然超时，尝试 commit 等待策略...")
                    try:
                        await page.goto(url, wait_until="commit", timeout=nav_timeout)
                        return
                    except Exception:
                        raise e

    async def _get_action_with_retry(
        self,
        screenshot: bytes,
        context: TaskContext,
        task_type: Optional[str],
        elements_summary: str,
    ) -> AgentAction:
        """带重试的 AI 分析（V2: 使用 LLMRetryHandler）"""

        async def analyze_wrapper():
            return await self.vision_analyzer.analyze(
                screenshot=screenshot,
                context=context,
                task_type=task_type,
                elements_summary=elements_summary,
            )

        # V2: 使用 LLMRetryHandler
        llm_start = time.time()
        result: RetryResult = await self.retry_handler.execute_with_retry(
            analyze_wrapper,
            context={"task_type": task_type, "step": self.state_data.n_steps if self.state_data else 0},
        )
        llm_duration = (time.time() - llm_start) * 1000

        # V2: 记录 LLM 调用日志
        self.logger.llm_call(
            provider=self.vision_analyzer.provider or "unknown",
            model=self.vision_analyzer.model or "unknown",
            duration_ms=llm_duration,
        )

        if result.success:
            action = result.value
            # 检查空响应
            if action is None:
                return AgentAction(
                    action_type=ActionType.ERROR,
                    error_message="AI 分析无响应",
                    reasoning="AI 返回空动作",
                )
            return action
        else:
            # 重试耗尽，返回错误动作
            self.logger.error(
                f"AI 分析失败: {result.error}",
                error_type=result.classified_error.category.value if result.classified_error else "unknown",
            )
            return AgentAction(
                action_type=ActionType.ERROR,
                error_message=f"AI 分析失败: {result.error}",
                reasoning=f"重试 {result.attempts} 次后仍然失败",
            )

    async def _handle_terminal_actions(
        self,
        action: AgentAction,
        context: TaskContext,
        executor: ActionExecutor,
        elements: list,
    ) -> Optional[TaskResult]:
        """处理终止类动作"""

        if action.action_type == ActionType.DONE:
            self.state_data.complete()
            self.state = AgentState.COMPLETED
            context.add_action(action)

            result_data = {"action_type": "done"}
            if action.result_status:
                result_data["result_status"] = action.result_status
            if action.kicked_count is not None:
                result_data["kicked_count"] = action.kicked_count

            return TaskResult(
                success=True,
                message=action.reasoning,
                state=AgentState.COMPLETED,
                total_steps=self.state_data.n_steps + 1,
                action_history=context.action_history,
                data=result_data,
            )

        if action.action_type == ActionType.ERROR:
            self.state_data.fail()
            self.state = AgentState.FAILED
            context.add_action(action)
            return TaskResult.failure_result(
                message=action.error_message or "AI 报告错误",
                error_details=action.reasoning,
                steps=self.state_data.n_steps + 1,
                error_type=action.error_type,
            )

        if action.action_type == ActionType.NEED_VERIFICATION:
            self.state_data.wait_input()
            self.state = AgentState.WAITING_INPUT
            context.add_action(action)
            return TaskResult(
                success=False,
                message=f"需要 {action.verification_type} 验证码",
                state=AgentState.WAITING_INPUT,
                total_steps=self.state_data.n_steps + 1,
                action_history=context.action_history,
                data={"verification_type": action.verification_type},
            )

        if action.action_type == ActionType.EXTRACT_SECRET:
            self.state_data.wait_input()
            self.state = AgentState.WAITING_INPUT
            context.add_action(action)
            self.logger.info(f"提取到密钥: {action.extracted_secret[:10]}...")
            return TaskResult(
                success=False,
                message="已提取身份验证器密钥",
                state=AgentState.WAITING_INPUT,
                total_steps=self.state_data.n_steps + 1,
                action_history=context.action_history,
                data={
                    "action_type": "extract_secret",
                    "extracted_secret": action.extracted_secret,
                },
            )

        if action.action_type == ActionType.EXTRACT_LINK:
            # 执行链接提取
            success, message = await executor.execute(action, elements=elements)
            self.logger.info(f"链接提取结果: {message}")

            context.add_action(action)
            extracted_link = action.extracted_link
            result_status = action.result_status or "link_ready"

            if not extracted_link:
                self.logger.warning(f"链接提取失败: {message}")
                return None  # 继续循环让 AI 重新分析

            self.logger.info(f"提取到链接: {extracted_link[:50]}..., 状态: {result_status}")
            self.state_data.complete()
            self.state = AgentState.COMPLETED
            return TaskResult(
                success=True,
                message=f"已提取链接 ({result_status})",
                state=AgentState.COMPLETED,
                total_steps=self.state_data.n_steps + 1,
                action_history=context.action_history,
                data={
                    "action_type": "extract_link",
                    "extracted_link": extracted_link,
                    "result_status": result_status,
                },
            )

        return None  # 非终止动作

    async def _handle_step_error(
        self,
        error: Exception,
        context: TaskContext,
        metadata: StepMetadata,
        classified: ClassifiedError = None,
    ) -> Optional[TaskResult]:
        """处理步骤错误（V2: 使用错误分类）"""
        self.state_data.record_failure()

        # V2: 如果没有传入分类，进行分类
        if classified is None:
            classified = classify_error(error, context={"step": metadata.step_number})

        self.logger.error(
            f"步骤执行错误: {error}",
            error_type=classified.category.value,
            recoverable=classified.is_recoverable,
        )

        # V2: 根据恢复策略决定是否继续
        if not classified.is_recoverable:
            return self._create_failure_result(
                context,
                f"不可恢复错误 [{classified.category.value}]: {error}",
                traceback.format_exc(),
            )

        # 检查是否达到失败阈值
        if self.state_data.consecutive_failures >= self.max_failures:
            return self._create_failure_result(
                context,
                f"执行错误，连续失败达到上限: {error}",
                traceback.format_exc(),
            )

        # 继续执行，让 AI 尝试恢复
        return None

    async def _wait_after_action(self, action: AgentAction):
        """动作后等待"""
        if action.action_type in (ActionType.CLICK, ActionType.NAVIGATE, ActionType.REFRESH):
            await asyncio.sleep(self.screenshot_delay * 2.0)
        else:
            await asyncio.sleep(self.screenshot_delay)

    async def _check_pause(self):
        """检查暂停状态"""
        while self.state_data.is_paused and not self.state_data.is_stopped:
            await asyncio.sleep(0.5)

    def _create_stopped_result(self, context: TaskContext) -> TaskResult:
        """创建停止结果"""
        self.state = AgentState.STOPPED
        return TaskResult.stopped_result(
            steps=self.state_data.n_steps,
        )

    def _create_failure_result(
        self,
        context: TaskContext,
        message: str,
        error_details: str = None,
    ) -> TaskResult:
        """创建失败结果"""
        self.state_data.fail()
        self.state = AgentState.FAILED
        return TaskResult.failure_result(
            message=message,
            error_details=error_details,
            steps=self.state_data.n_steps,
        )

    # ============ 状态访问 ============

    def get_statistics(self) -> dict:
        """获取执行统计"""
        if self.state_data:
            return self.state_data.get_statistics()
        return {}

    def get_history_summary(self, last_n: int = 5) -> str:
        """获取历史摘要"""
        if self.state_data:
            return self.state_data.get_history_summary(last_n)
        return ""


# ============ 便捷函数 ============

async def run_with_ixbrowser(
    browser_id: str,
    goal: str,
    start_url: str,
    account: dict = None,
    params: dict = None,
    task_type: Optional[str] = None,
    max_steps: int = 20,
    close_after: bool = True,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    model: Optional[str] = None,
    provider: Optional[str] = None,
    email_imap_config: dict = None,
    use_som: bool = True,
    compress_screenshot: bool = False,
) -> TaskResult:
    """
    使用 ixBrowser 窗口运行 AI Agent

    便捷函数，封装了 ixBrowser 连接和清理逻辑

    Args:
        browser_id: ixBrowser 窗口 ID
        goal: 任务目标
        start_url: 起始 URL
        account: 账号信息
        params: 额外参数
        task_type: 任务类型
        max_steps: 最大步骤数
        close_after: 完成后是否关闭浏览器
        api_key: API Key（默认从配置读取）
        base_url: API Base URL（用于第三方服务）
        model: 使用的模型（默认从配置读取）
        provider: LLM 提供商 (gemini, anthropic)，默认从配置读取
        email_imap_config: 邮箱 IMAP 配置 {'email': str, 'password': str}
                          用于自动读取邮箱验证码
        use_som: 是否启用 SoM 元素标记（默认 True）
        compress_screenshot: 是否压缩截图（默认 False）

    Returns:
        TaskResult: 执行结果
    """
    # 导入 ixBrowser API
    try:
        from services.ix_api import openBrowser, closeBrowser
    except ImportError:
        return TaskResult.failure_result("无法导入 ix_api 模块")

    browser = None
    playwright = None

    try:
        # 1. 打开 ixBrowser 窗口
        _module_logger.info(f"打开浏览器窗口: {browser_id}")
        result = openBrowser(browser_id)

        if not result or "data" not in result:
            return TaskResult.failure_result("无法打开浏览器窗口")

        ws_endpoint = result["data"].get("ws", "")
        if not ws_endpoint:
            return TaskResult.failure_result("获取 WebSocket endpoint 失败")

        # 2. 连接 Playwright
        playwright = await async_playwright().start()
        browser = await playwright.chromium.connect_over_cdp(ws_endpoint)

        # 获取页面
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        page = context.pages[0] if context.pages else await context.new_page()

        # 3. 创建并运行 Agent
        agent = AIBrowserAgent(
            api_key=api_key,
            base_url=base_url,
            model=model,
            provider=provider,
            use_som=use_som,
            compress_screenshot=compress_screenshot,
        )

        # 验证码重试计数
        verification_retries = 0
        max_verification_retries = 3
        remaining_steps = max_steps
        navigate_first = True

        while verification_retries <= max_verification_retries:
            result = await agent.run(
                page=page,
                goal=goal,
                start_url=start_url,
                account=account,
                params=params,
                task_type=task_type,
                max_steps=remaining_steps,
                navigate_first=navigate_first,
            )

            # 如果任务成功或失败（非验证码需求），直接返回
            if result.success or result.state != AgentState.WAITING_INPUT:
                return result

            # 处理验证码需求
            verification_type = result.data.get("verification_type", "")
            _module_logger.info(f"需要 {verification_type} 验证码...")

            # 只处理邮箱验证码
            if verification_type != "email":
                _module_logger.warning(f"不支持自动处理 {verification_type} 验证码")
                return result

            # 检查是否有邮箱配置
            if not email_imap_config or not EMAIL_CODE_READER_AVAILABLE:
                _module_logger.warning("未配置邮箱 IMAP 或 email_code_reader 模块不可用")
                return result

            imap_email = email_imap_config.get("email", "")
            imap_password = email_imap_config.get("password", "")

            if not imap_email or not imap_password:
                _module_logger.warning("邮箱 IMAP 配置不完整")
                return result

            # 读取验证码
            _module_logger.info(f"正在从 {imap_email} 读取验证码...")
            verification_retries += 1

            try:
                reader = GmailCodeReader(imap_email, imap_password)
                success, code_or_error = reader.fetch_verification_code(
                    timeout_seconds=90,
                    poll_interval=5,
                    lookback_minutes=5,
                )
                reader.disconnect()

                if not success:
                    _module_logger.error(f"读取验证码失败: {code_or_error}")
                    return TaskResult.failure_result(
                        message=f"读取验证码失败: {code_or_error}",
                        steps=result.total_steps,
                    )

                verification_code = code_or_error
                _module_logger.info(f"获取到验证码: {verification_code}")

                # 将验证码添加到 params 中供 AI 使用
                if params is None:
                    params = {}
                params["verification_code"] = verification_code

                # 更新剩余步骤数
                remaining_steps = max_steps - result.total_steps
                if remaining_steps <= 0:
                    remaining_steps = 10

                # 下次不需要导航
                navigate_first = False

                _module_logger.info(f"继续执行任务（剩余步骤: {remaining_steps}）...")

            except Exception as e:
                _module_logger.error(f"读取验证码异常: {e}")
                return TaskResult.failure_result(
                    message=f"读取验证码异常: {str(e)}",
                    error_details=traceback.format_exc(),
                    steps=result.total_steps,
                )

        # 超过最大验证码重试次数
        return TaskResult.failure_result(
            message=f"验证码重试次数超限 ({max_verification_retries})",
            steps=result.total_steps if result else 0,
        )

    except Exception as e:
        traceback.print_exc()
        return TaskResult.failure_result(
            message=f"运行失败: {str(e)}",
            error_details=traceback.format_exc(),
        )

    finally:
        # 清理资源
        if close_after:
            try:
                if browser:
                    await browser.close()
            except Exception:
                pass

            try:
                if playwright:
                    await playwright.stop()
            except Exception:
                pass

            try:
                closeBrowser(browser_id)
                _module_logger.info("浏览器已关闭")
            except Exception:
                pass
