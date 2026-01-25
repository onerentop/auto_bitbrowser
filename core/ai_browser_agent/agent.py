"""
AI Browser Agent - 核心 Agent 类

整合 Vision Analyzer 和 Action Executor，实现完整的 AI 驱动浏览器自动化
"""

import asyncio
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
from .vision_analyzer import VisionAnalyzer
from .action_executor import ActionExecutor

# 邮箱验证码读取器 (可选依赖)
try:
    from email_code_reader import GmailCodeReader
    EMAIL_CODE_READER_AVAILABLE = True
except ImportError:
    EMAIL_CODE_READER_AVAILABLE = False


class AIBrowserAgent:
    """
    AI 浏览器代理

    使用 Gemini Vision 分析页面截图，智能执行浏览器自动化任务
    采用 OpenAI 兼容的 API 格式
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: str = "gemini-2.5-flash",
        default_timeout: int = 10000,
        screenshot_delay: float = 2.0,
    ):
        """
        初始化 AI Browser Agent

        Args:
            api_key: API Key（默认从环境变量读取）
            base_url: API Base URL（默认使用 Gemini OpenAI 兼容 API）
            model: 使用的模型
            default_timeout: 默认操作超时时间（毫秒）
            screenshot_delay: 截图前的等待时间（秒），默认 2.0 秒

        Environment Variables:
            GEMINI_API_KEY: Gemini API 密钥
        """
        self.vision_analyzer = VisionAnalyzer(
            api_key=api_key,
            base_url=base_url,
            model=model,
        )
        self.default_timeout = default_timeout
        self.screenshot_delay = screenshot_delay

        self.state = AgentState.IDLE
        self._stop_requested = False

        # 回调函数
        self._on_action: Optional[Callable[[AgentAction], None]] = None
        self._on_step: Optional[Callable[[int, AgentAction], None]] = None
        self._on_screenshot: Optional[Callable[[bytes], None]] = None

    def on_action(self, callback: Callable[[AgentAction], None]):
        """设置动作回调"""
        self._on_action = callback

    def on_step(self, callback: Callable[[int, AgentAction], None]):
        """设置步骤回调"""
        self._on_step = callback

    def on_screenshot(self, callback: Callable[[bytes], None]):
        """设置截图回调"""
        self._on_screenshot = callback

    def stop(self):
        """请求停止执行"""
        self._stop_requested = True

    async def execute_task(
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
        执行自动化任务

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
        self.state = AgentState.RUNNING
        self._stop_requested = False

        # 创建任务上下文
        context = TaskContext(
            goal=goal,
            start_url=start_url,
            account=account or {},
            params=params or {},
            max_steps=max_steps,
        )

        # 创建动作执行器
        executor = ActionExecutor(page, timeout=self.default_timeout)

        try:
            # 导航到起始页面（带重试）
            if navigate_first:
                print(f"导航到: {start_url}")
                nav_retries = 3
                nav_timeout = 60000  # 60 秒超时
                for nav_attempt in range(nav_retries):
                    try:
                        await page.goto(start_url, wait_until="domcontentloaded", timeout=nav_timeout)
                        break  # 成功则跳出循环
                    except Exception as nav_error:
                        if nav_attempt < nav_retries - 1:
                            print(f"导航超时 (尝试 {nav_attempt + 1}/{nav_retries})，重试中...")
                            await asyncio.sleep(2)
                        else:
                            # 最后一次尝试使用更宽松的等待策略
                            print(f"导航仍然超时，尝试 commit 等待策略...")
                            try:
                                await page.goto(start_url, wait_until="commit", timeout=nav_timeout)
                            except Exception:
                                raise nav_error  # 抛出原始错误
                await asyncio.sleep(self.screenshot_delay)

            # 主循环
            while context.current_step < max_steps:
                # 检查是否请求停止
                if self._stop_requested:
                    self.state = AgentState.STOPPED
                    return TaskResult.stopped_result(
                        steps=context.current_step,
                    )

                print(f"\n--- 步骤 {context.current_step + 1}/{max_steps} ---")

                # 1. 截取页面截图
                screenshot = await executor.take_screenshot()
                if self._on_screenshot:
                    self._on_screenshot(screenshot)

                # 2. AI 分析截图并决策
                print("AI 分析中...")
                action = await self.vision_analyzer.analyze(
                    screenshot=screenshot,
                    context=context,
                    task_type=task_type,
                )

                print(f"AI 决策: {action}")

                # 触发回调
                if self._on_action:
                    self._on_action(action)

                # 3. 检查是否是终止动作
                if action.action_type == ActionType.DONE:
                    self.state = AgentState.COMPLETED
                    context.add_action(action)
                    # 传递 result_status（用于 get_sheerlink 等任务）
                    result_data = {"action_type": "done"}
                    if action.result_status:
                        result_data["result_status"] = action.result_status
                    # 传递 kicked_count（用于 kick_devices 任务）
                    if action.kicked_count is not None:
                        result_data["kicked_count"] = action.kicked_count
                    return TaskResult(
                        success=True,
                        message=action.reasoning,
                        state=AgentState.COMPLETED,
                        total_steps=context.current_step + 1,
                        action_history=context.action_history,
                        data=result_data,
                    )

                if action.action_type == ActionType.ERROR:
                    self.state = AgentState.FAILED
                    context.add_action(action)
                    return TaskResult.failure_result(
                        message=action.error_message or "AI 报告错误",
                        error_details=action.reasoning,
                        steps=context.current_step + 1,
                        error_type=action.error_type,  # 传递 AI 识别的错误类型
                    )

                if action.action_type == ActionType.NEED_VERIFICATION:
                    self.state = AgentState.WAITING_INPUT
                    context.add_action(action)
                    return TaskResult(
                        success=False,
                        message=f"需要 {action.verification_type} 验证码",
                        state=AgentState.WAITING_INPUT,
                        total_steps=context.current_step + 1,
                        action_history=context.action_history,
                        data={"verification_type": action.verification_type},
                    )

                if action.action_type == ActionType.EXTRACT_SECRET:
                    # 提取到密钥，返回特殊状态让调用者处理
                    self.state = AgentState.WAITING_INPUT
                    context.add_action(action)
                    extracted_secret = action.extracted_secret
                    print(f"🔑 提取到密钥: {extracted_secret}")
                    return TaskResult(
                        success=False,
                        message="已提取身份验证器密钥",
                        state=AgentState.WAITING_INPUT,
                        total_steps=context.current_step + 1,
                        action_history=context.action_history,
                        data={
                            "action_type": "extract_secret",
                            "extracted_secret": extracted_secret,
                        },
                    )

                if action.action_type == ActionType.EXTRACT_LINK:
                    # 执行链接提取动作（从页面实际提取 href）
                    success, message = await executor.execute(action)
                    print(f"执行结果: {message}")

                    # 使用提取到的链接（executor 会更新 action.extracted_link）
                    context.add_action(action)
                    extracted_link = action.extracted_link
                    result_status = action.result_status or "link_ready"

                    if not extracted_link:
                        # 提取失败
                        print(f"⚠️ 链接提取失败: {message}")
                        # 继续循环，让 AI 重新分析
                        continue

                    print(f"🔗 提取到链接: {extracted_link}")
                    print(f"📋 结果状态: {result_status}")

                    # 如果有 result_status，直接完成任务（不需要进一步处理）
                    self.state = AgentState.COMPLETED
                    return TaskResult(
                        success=True,
                        message=f"已提取链接 ({result_status})",
                        state=AgentState.COMPLETED,
                        total_steps=context.current_step + 1,
                        action_history=context.action_history,
                        data={
                            "action_type": "extract_link",
                            "extracted_link": extracted_link,
                            "result_status": result_status,
                        },
                    )

                # 4. 执行动作
                success, message = await executor.execute(action)
                print(f"执行结果: {message}")

                # 记录动作
                context.add_action(action)

                # 触发步骤回调
                if self._on_step:
                    self._on_step(context.current_step, action)

                # 如果执行失败，继续让 AI 分析新状态（可能恢复）
                if not success:
                    print(f"⚠️ 动作执行失败: {message}")

                # 5. 等待页面稳定
                # 对于点击/导航/刷新操作，action_executor 已处理智能等待
                # 这里额外等待让 iframe 内容有时间渲染
                if action.action_type in (ActionType.CLICK, ActionType.NAVIGATE, ActionType.REFRESH):
                    # 这些操作可能触发 iframe 加载，需要额外等待渲染
                    await asyncio.sleep(self.screenshot_delay * 2.0)
                else:
                    await asyncio.sleep(self.screenshot_delay)

            # 达到最大步骤数
            self.state = AgentState.FAILED
            return TaskResult.failure_result(
                message=f"达到最大步骤数限制 ({max_steps})",
                steps=max_steps,
            )

        except Exception as e:
            traceback.print_exc()
            self.state = AgentState.FAILED
            return TaskResult.failure_result(
                message=f"执行异常: {str(e)}",
                error_details=traceback.format_exc(),
                steps=context.current_step,
            )


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
    model: str = "gemini-2.5-flash",
    email_imap_config: dict = None,
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
        api_key: API Key（默认从环境变量 GEMINI_API_KEY 读取）
        base_url: API Base URL（默认使用 Gemini OpenAI 兼容 API）
        model: 使用的模型
        email_imap_config: 邮箱 IMAP 配置 {'email': str, 'password': str}
                          用于自动读取邮箱验证码

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
        print(f"打开浏览器窗口: {browser_id}")
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

        # 3. 创建并运行 Agent（支持验证码重试）
        agent = AIBrowserAgent(
            api_key=api_key,
            base_url=base_url,
            model=model,
        )

        # 验证码重试计数
        verification_retries = 0
        max_verification_retries = 3
        remaining_steps = max_steps
        navigate_first = True

        while verification_retries <= max_verification_retries:
            result = await agent.execute_task(
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
            print(f"\n📧 需要 {verification_type} 验证码...")

            # 只处理邮箱验证码
            if verification_type != "email":
                print(f"⚠️ 不支持自动处理 {verification_type} 验证码")
                return result

            # 检查是否有邮箱配置
            if not email_imap_config or not EMAIL_CODE_READER_AVAILABLE:
                print("⚠️ 未配置邮箱 IMAP 或 email_code_reader 模块不可用")
                return result

            imap_email = email_imap_config.get("email", "")
            imap_password = email_imap_config.get("password", "")

            if not imap_email or not imap_password:
                print("⚠️ 邮箱 IMAP 配置不完整")
                return result

            # 读取验证码
            print(f"📬 正在从 {imap_email} 读取验证码...")
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
                    print(f"❌ 读取验证码失败: {code_or_error}")
                    return TaskResult.failure_result(
                        message=f"读取验证码失败: {code_or_error}",
                        steps=result.total_steps,
                    )

                verification_code = code_or_error
                print(f"✅ 获取到验证码: {verification_code}")

                # 将验证码添加到 params 中供 AI 使用
                if params is None:
                    params = {}
                params["verification_code"] = verification_code

                # 更新剩余步骤数
                remaining_steps = max_steps - result.total_steps
                if remaining_steps <= 0:
                    remaining_steps = 10  # 保证至少有 10 步继续执行

                # 下次不需要导航（已在页面上）
                navigate_first = False

                print(f"🔄 继续执行任务（剩余步骤: {remaining_steps}）...")

            except Exception as e:
                print(f"❌ 读取验证码异常: {e}")
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
                print("浏览器已关闭")
            except Exception:
                pass
