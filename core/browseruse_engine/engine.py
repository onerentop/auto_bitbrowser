"""
BrowserUse Engine - 主引擎类

基于 browser-use 设计的 AI 浏览器控制引擎。
实现 EngineProtocol 接口，与 StagehandGoogleEngine 互换使用。

使用示例:
    ```python
    from core.browseruse_engine import BrowserUseEngine

    # 方式1: 连接到 ixBrowser 窗口（推荐）
    async with await BrowserUseEngine.connect_to_ixbrowser("browser_id") as engine:
        result = await engine.run("打开 Google 并搜索 Python")

    # 方式2: 使用已有的 Playwright Page
    async with BrowserUseEngine(page=page, llm=llm) as engine:
        result = await engine.act("点击登录按钮")
    ```
"""

import asyncio
import logging
import time
from typing import Optional, Any, Type, TypeVar, Callable, Awaitable

from playwright.async_api import Page, Browser, BrowserContext

from .protocol import (
    EngineProtocol,
    NavigationResult,
    ActionResult,
    ExtractResult,
    ObserveResult,
    AgentResult,
    AgentStep,
)
from .types import AgentOutput, BrowserState
from .dom.service import DOMService
from .tools.executor import ActionExecutor
from .tools.registry import ActionRegistry
from .agent.service import AgentService
from .agent.prompts import PromptManager
from .llm.base import BaseChatModel
from .llm.adapters import create_llm_adapter, create_llm_from_config

logger = logging.getLogger(__name__)

T = TypeVar('T')

# 尝试导入 ixBrowser API
try:
    from services.ix_api import openBrowser, closeBrowser
    IXBROWSER_API_AVAILABLE = True
except ImportError:
    IXBROWSER_API_AVAILABLE = False
    openBrowser = None
    closeBrowser = None
    logger.debug("ixBrowser API 不可用")


class BrowserUseEngine:
    """
    BrowserUse AI 浏览器控制引擎

    基于 browser-use 设计，使用 Agent 循环实现智能浏览器自动化。
    实现 EngineProtocol 接口，可与 StagehandGoogleEngine 互换使用。

    核心特点:
    - 多 LLM 支持 (OpenAI, Anthropic, Google)
    - 基于 DOM 的元素提取和交互
    - Agent 循环自动任务完成
    - 支持视觉模式 (截图)

    Attributes:
        page: Playwright Page 对象
        llm: LLM 适配器
        use_vision: 是否使用视觉模式
        language: 提示词语言 ("en" 或 "zh")
    """

    def __init__(
        self,
        page: Optional[Page] = None,
        llm: Optional[BaseChatModel] = None,
        llm_provider: Optional[str] = None,
        llm_model: Optional[str] = None,
        llm_api_key: Optional[str] = None,
        llm_base_url: Optional[str] = None,
        use_vision: bool = True,
        max_actions_per_step: int = 3,
        language: str = "zh",
    ):
        """
        初始化 BrowserUseEngine

        Args:
            page: Playwright Page 对象 (可选，连接 CDP 时会自动获取)
            llm: LLM 适配器实例 (可选，如果不提供则根据参数创建)
            llm_provider: LLM 提供商 ("openai", "anthropic", "google")
            llm_model: LLM 模型名称
            llm_api_key: LLM API 密钥
            llm_base_url: LLM API 基础 URL (可选)
            use_vision: 是否使用视觉模式 (截图)
            max_actions_per_step: 每步最大动作数
            language: 提示词语言 ("en" 或 "zh")
        """
        self._page = page
        self._browser: Optional[Browser] = None
        self._context: Optional[BrowserContext] = None

        # LLM 配置
        if llm:
            self._llm = llm
        elif llm_provider and llm_api_key:
            self._llm = create_llm_adapter(
                provider=llm_provider,
                api_key=llm_api_key,
                model=llm_model,
                base_url=llm_base_url,
            )
        else:
            # 尝试从配置创建
            self._llm = create_llm_from_config()

        self.use_vision = use_vision
        self.max_actions_per_step = max_actions_per_step
        self.language = language

        # 组件 (延迟初始化)
        self._dom_service: Optional[DOMService] = None
        self._action_executor: Optional[ActionExecutor] = None
        self._agent_service: Optional[AgentService] = None
        self._prompt_manager: Optional[PromptManager] = None

        # 状态
        self._initialized = False
        self._cdp_mode = False
        self._cdp_url: Optional[str] = None
        self._browser_id: Optional[str] = None
        self._close_browser_on_exit = False

    async def __aenter__(self) -> "BrowserUseEngine":
        """异步上下文管理器入口"""
        if not self._initialized:
            await self._initialize_components()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        """异步上下文管理器退出"""
        await self.stop()

    # ==================== CDP 连接方法 ====================

    @classmethod
    async def connect_to_ixbrowser(
        cls,
        browser_id: str,
        llm_provider: Optional[str] = None,
        llm_model: Optional[str] = None,
        llm_api_key: Optional[str] = None,
        llm_base_url: Optional[str] = None,
        use_vision: bool = True,
        language: str = "zh",
        close_browser_on_exit: bool = False,
    ) -> "BrowserUseEngine":
        """
        连接到已打开的 ixBrowser 窗口

        这是推荐的使用方式，自动处理 ixBrowser API 调用和 CDP 连接。

        Args:
            browser_id: ixBrowser 窗口 ID (profile_id)
            llm_provider: LLM 提供商 ("openai", "anthropic", "google")
            llm_model: LLM 模型名称
            llm_api_key: LLM API 密钥
            llm_base_url: LLM API 基础 URL (可选)
            use_vision: 是否使用视觉模式
            language: 提示词语言
            close_browser_on_exit: 退出时是否关闭浏览器窗口 (默认 False)

        Returns:
            已连接的 BrowserUseEngine 实例

        Raises:
            ImportError: 如果 ixBrowser API 不可用
            RuntimeError: 如果无法打开或连接到浏览器

        使用示例:
            ```python
            async with await BrowserUseEngine.connect_to_ixbrowser("abc123") as engine:
                result = await engine.run("打开 Google 并搜索 Python")
            ```
        """
        if not IXBROWSER_API_AVAILABLE:
            raise ImportError(
                "ixBrowser API 不可用。请确保 services.ix_api 模块可用"
            )

        # 打开浏览器获取 WebSocket 端点
        logger.info(f"正在打开 ixBrowser 窗口: {browser_id}")
        try:
            result = openBrowser(browser_id)
            if not result.get("success"):
                raise RuntimeError(
                    f"打开 ixBrowser 窗口失败: {result.get('msg', '未知错误')}"
                )

            ws_endpoint = result.get("data", {}).get("ws")
            if not ws_endpoint:
                raise RuntimeError("未获取到 WebSocket 端点")

            logger.info(f"获取到 CDP 端点: {ws_endpoint[:50]}...")

        except Exception as e:
            logger.error(f"打开 ixBrowser 窗口失败: {e}")
            raise RuntimeError(f"打开 ixBrowser 窗口失败: {e}")

        # 创建引擎实例
        engine = cls(
            llm_provider=llm_provider,
            llm_model=llm_model,
            llm_api_key=llm_api_key,
            llm_base_url=llm_base_url,
            use_vision=use_vision,
            language=language,
        )
        engine._browser_id = browser_id
        engine._close_browser_on_exit = close_browser_on_exit

        # 连接到 CDP
        await engine.connect_cdp(ws_endpoint)

        return engine

    async def connect_cdp(self, ws_endpoint: str) -> None:
        """
        连接到现有的 CDP WebSocket 端点

        Args:
            ws_endpoint: CDP WebSocket URL (如 ws://127.0.0.1:xxxxx/devtools/browser/xxx)

        Raises:
            RuntimeError: 如果已初始化或连接失败
        """
        if self._initialized:
            raise RuntimeError("引擎已初始化，无法重复连接")

        logger.info(f"正在通过 CDP 连接: {ws_endpoint[:50]}...")

        try:
            from playwright.async_api import async_playwright

            playwright = await async_playwright().start()
            self._browser = await playwright.chromium.connect_over_cdp(ws_endpoint)

            # 获取默认上下文和页面
            contexts = self._browser.contexts
            if contexts:
                self._context = contexts[0]
                pages = self._context.pages
                if pages:
                    self._page = pages[0]
                else:
                    self._page = await self._context.new_page()
            else:
                self._context = await self._browser.new_context()
                self._page = await self._context.new_page()

            self._cdp_url = ws_endpoint
            self._cdp_mode = True

            # 初始化组件
            await self._initialize_components()

            logger.info("CDP 连接成功")

        except Exception as e:
            logger.error(f"CDP 连接失败: {e}")
            self._cdp_mode = False
            self._cdp_url = None
            raise RuntimeError(f"CDP 连接失败: {e}")

    async def _initialize_components(self) -> None:
        """初始化内部组件"""
        if self._initialized:
            return

        if not self._page:
            raise RuntimeError("Page 对象未设置，无法初始化")

        if not self._llm:
            raise RuntimeError("LLM 未配置，无法初始化")

        # 创建组件
        self._dom_service = DOMService(self._page)
        self._prompt_manager = PromptManager(language=self.language)
        self._action_executor = ActionExecutor(
            page=self._page,
            dom_service=self._dom_service,
            llm=self._llm,
        )
        self._agent_service = AgentService(
            llm=self._llm,
            page=self._page,
            dom_service=self._dom_service,
            action_executor=self._action_executor,
            prompt_manager=self._prompt_manager,
            use_vision=self.use_vision,
            max_actions_per_step=self.max_actions_per_step,
            language=self.language,
        )

        self._initialized = True
        logger.info("BrowserUseEngine 初始化完成")

    async def start(self) -> None:
        """
        启动引擎 (本地模式)

        创建浏览器实例并初始化。
        注意: 如果是 CDP 连接模式，应使用 connect_cdp() 或 connect_to_ixbrowser()。
        """
        if self._initialized:
            logger.warning("引擎已初始化，跳过重复启动")
            return

        if self._cdp_mode:
            logger.warning("CDP 模式下请使用 connect_cdp() 而非 start()")
            return

        logger.info("正在启动 BrowserUseEngine (本地模式)...")

        try:
            from playwright.async_api import async_playwright

            playwright = await async_playwright().start()
            self._browser = await playwright.chromium.launch(headless=False)
            self._context = await self._browser.new_context()
            self._page = await self._context.new_page()

            await self._initialize_components()

            logger.info("BrowserUseEngine 启动成功 (本地模式)")

        except Exception as e:
            logger.error(f"启动 BrowserUseEngine 失败: {e}")
            raise

    async def stop(self, close_browser: Optional[bool] = None) -> None:
        """
        关闭引擎

        释放浏览器资源并清理状态。

        Args:
            close_browser: 是否关闭浏览器窗口 (仅 CDP 模式有效)
                - None: 使用创建时的 close_browser_on_exit 设置
                - True: 强制关闭
                - False: 不关闭
        """
        if not self._initialized:
            return

        logger.info("正在关闭 BrowserUseEngine...")

        try:
            if self._cdp_mode:
                # CDP 模式: 断开连接但不关闭浏览器 (除非指定)
                should_close = close_browser
                if should_close is None:
                    should_close = self._close_browser_on_exit

                if self._browser:
                    try:
                        # 断开 CDP 连接
                        await self._browser.close()
                    except Exception as e:
                        logger.debug(f"关闭浏览器连接时出错: {e}")
                    self._browser = None

                # 是否关闭 ixBrowser 窗口
                if should_close and self._browser_id and IXBROWSER_API_AVAILABLE:
                    try:
                        closeBrowser(self._browser_id)
                        logger.info(f"已关闭 ixBrowser 窗口: {self._browser_id}")
                    except Exception as e:
                        logger.warning(f"关闭 ixBrowser 窗口失败: {e}")

                self._cdp_url = None
                self._browser_id = None
            else:
                # 本地模式: 关闭浏览器
                if self._context:
                    try:
                        await self._context.close()
                    except Exception:
                        pass
                    self._context = None

                if self._browser:
                    try:
                        await self._browser.close()
                    except Exception:
                        pass
                    self._browser = None

            self._page = None
            self._dom_service = None
            self._action_executor = None
            self._agent_service = None
            self._initialized = False
            self._cdp_mode = False

            logger.info("BrowserUseEngine 已关闭")

        except Exception as e:
            logger.error(f"关闭 BrowserUseEngine 失败: {e}")

    def _ensure_initialized(self) -> None:
        """确保引擎已初始化"""
        if not self._initialized:
            raise RuntimeError(
                "引擎未初始化。请先调用 start() 或使用 async with 上下文管理器"
            )

    # ==================== EngineProtocol 实现 ====================

    @property
    def is_initialized(self) -> bool:
        """是否已初始化"""
        return self._initialized

    @property
    def page(self) -> Page:
        """获取 Playwright Page 对象"""
        self._ensure_initialized()
        return self._page

    @property
    def is_cdp_mode(self) -> bool:
        """是否为 CDP 连接模式"""
        return self._cdp_mode

    @property
    def browser_id(self) -> Optional[str]:
        """获取 ixBrowser 窗口 ID (仅 CDP 模式)"""
        return self._browser_id

    async def navigate(
        self,
        url: str,
        wait_until: str = "domcontentloaded",
        timeout: float = 30000,
    ) -> NavigationResult:
        """
        导航到指定 URL

        Args:
            url: 目标 URL
            wait_until: 等待条件 ("load", "domcontentloaded", "networkidle")
            timeout: 超时时间（毫秒）

        Returns:
            NavigationResult
        """
        self._ensure_initialized()
        start_time = time.time()

        try:
            response = await self._page.goto(
                url,
                wait_until=wait_until,
                timeout=timeout,
            )
            duration_ms = (time.time() - start_time) * 1000

            final_url = self._page.url
            logger.debug(f"导航成功: {url} -> {final_url}")

            return NavigationResult(
                success=True,
                url=url,
                final_url=final_url,
                duration_ms=duration_ms,
            )

        except Exception as e:
            duration_ms = (time.time() - start_time) * 1000
            logger.error(f"导航失败: {url} - {e}")

            return NavigationResult(
                success=False,
                url=url,
                error=str(e),
                duration_ms=duration_ms,
            )

    async def act(
        self,
        instruction: str,
        timeout: float = 30000,
    ) -> ActionResult:
        """
        执行自然语言指令 (单步)

        使用 AI 理解指令并在页面上执行相应操作。

        Args:
            instruction: 自然语言指令 (如 "点击登录按钮")
            timeout: 超时时间（毫秒）

        Returns:
            ActionResult
        """
        self._ensure_initialized()
        start_time = time.time()

        try:
            # 使用 Agent 执行单步任务
            result = await self._agent_service.run(
                task=instruction,
                max_steps=1,
            )
            duration_ms = (time.time() - start_time) * 1000

            if result.success:
                return ActionResult(
                    success=True,
                    message=f"执行成功: {instruction}",
                    extracted_content=result.extracted_content,
                    duration_ms=duration_ms,
                )
            else:
                return ActionResult(
                    success=False,
                    error=result.error or "执行失败",
                    duration_ms=duration_ms,
                )

        except Exception as e:
            duration_ms = (time.time() - start_time) * 1000
            logger.error(f"操作失败: {instruction} - {e}")

            return ActionResult(
                success=False,
                error=str(e),
                duration_ms=duration_ms,
            )

    async def extract(
        self,
        instruction: str,
        schema: Optional[Type[T]] = None,
        timeout: float = 30000,
    ) -> ExtractResult:
        """
        提取页面数据

        使用 AI 从页面提取结构化数据。

        Args:
            instruction: 提取描述 (如 "提取所有商品价格")
            schema: Pydantic 模型类，用于结构化输出
            timeout: 超时时间（毫秒）

        Returns:
            ExtractResult
        """
        self._ensure_initialized()
        start_time = time.time()

        try:
            # 构建提取任务
            extract_task = f"Extract the following from the page: {instruction}"
            if schema:
                # 添加 schema 信息到任务
                schema_info = ""
                if hasattr(schema, 'model_json_schema'):
                    schema_dict = schema.model_json_schema()
                    schema_info = f"\n\nExpected output format: {schema_dict}"
                extract_task += schema_info

            # 使用 Agent 执行提取
            result = await self._agent_service.run(
                task=extract_task,
                max_steps=3,
            )
            duration_ms = (time.time() - start_time) * 1000

            if result.success and result.extracted_content:
                # 尝试解析提取的内容
                try:
                    import json
                    data = json.loads(result.extracted_content)
                except (json.JSONDecodeError, TypeError):
                    data = {"content": result.extracted_content}

                return ExtractResult(
                    success=True,
                    data=data,
                    duration_ms=duration_ms,
                )
            else:
                return ExtractResult(
                    success=False,
                    error=result.error or "提取失败",
                    duration_ms=duration_ms,
                )

        except Exception as e:
            duration_ms = (time.time() - start_time) * 1000
            logger.error(f"提取失败: {instruction} - {e}")

            return ExtractResult(
                success=False,
                error=str(e),
                duration_ms=duration_ms,
            )

    async def observe(
        self,
        instruction: str,
        timeout: float = 30000,
    ) -> ObserveResult:
        """
        观察页面元素

        使用 AI 分析页面并找到符合描述的元素。

        Args:
            instruction: 观察描述 (如 "找到所有输入框")
            timeout: 超时时间（毫秒）

        Returns:
            ObserveResult
        """
        self._ensure_initialized()
        start_time = time.time()

        try:
            # 获取 DOM 树
            dom_tree = await self._dom_service.extract_dom()
            duration_ms = (time.time() - start_time) * 1000

            # 收集元素信息
            elements = []
            for element in dom_tree.elements:
                elem_dict = {
                    "index": element.index,
                    "tag": element.tag_name,
                    "text": element.text[:100] if element.text else "",
                    "attributes": element.attributes,
                    "is_visible": element.is_visible,
                    "is_interactive": element.is_interactive,
                }
                elements.append(elem_dict)

            return ObserveResult(
                success=True,
                elements=elements,
                duration_ms=duration_ms,
            )

        except Exception as e:
            duration_ms = (time.time() - start_time) * 1000
            logger.error(f"观察失败: {instruction} - {e}")

            return ObserveResult(
                success=False,
                error=str(e),
                duration_ms=duration_ms,
            )

    async def run(
        self,
        task: str,
        max_steps: int = 50,
        on_step: Optional[Callable[[Any], Awaitable[None]]] = None,
    ) -> AgentResult:
        """
        执行完整 Agent 任务 (多步)

        使用 Agent 循环自动完成复杂任务。

        Args:
            task: 任务描述
            max_steps: 最大步数
            on_step: 步骤回调函数

        Returns:
            AgentResult
        """
        self._ensure_initialized()
        start_time = time.time()

        try:
            # 执行 Agent 任务
            result = await self._agent_service.run(
                task=task,
                max_steps=max_steps,
                on_step=on_step,
            )
            duration_ms = (time.time() - start_time) * 1000

            # 转换步骤格式
            steps = []
            for step_data in result.steps:
                if isinstance(step_data, dict):
                    step = AgentStep(
                        step_number=step_data.get("step_number", 0),
                        thinking=step_data.get("thinking", ""),
                        action_name=step_data.get("action_name", ""),
                        action_params=step_data.get("action_params", {}),
                        browser_url=step_data.get("browser_url", ""),
                        timestamp=step_data.get("timestamp", 0),
                    )
                    steps.append(step)

            return AgentResult(
                success=result.success,
                message=result.message,
                error=result.error,
                extracted_content=result.extracted_content,
                steps=steps,
                total_steps=result.total_steps,
                duration_ms=duration_ms,
            )

        except Exception as e:
            duration_ms = (time.time() - start_time) * 1000
            logger.error(f"Agent 任务失败: {task} - {e}")

            return AgentResult(
                success=False,
                error=str(e),
                duration_ms=duration_ms,
            )

    # ==================== 辅助方法 ====================

    async def screenshot(self, full_page: bool = False) -> Optional[bytes]:
        """
        获取页面截图

        Args:
            full_page: 是否截取整个页面

        Returns:
            截图数据 (PNG 格式) 或 None
        """
        self._ensure_initialized()
        try:
            return await self._page.screenshot(full_page=full_page)
        except Exception as e:
            logger.error(f"截图失败: {e}")
            return None

    async def get_current_url(self) -> str:
        """获取当前 URL"""
        self._ensure_initialized()
        return self._page.url

    async def get_page_title(self) -> str:
        """获取页面标题"""
        self._ensure_initialized()
        return await self._page.title()

    async def get_page_content(self) -> str:
        """获取页面文本内容"""
        self._ensure_initialized()
        try:
            return await self._page.inner_text("body")
        except Exception as e:
            logger.warning(f"获取页面内容失败: {e}")
            return ""

    async def wait(self, milliseconds: float) -> None:
        """等待指定毫秒数"""
        await asyncio.sleep(milliseconds / 1000)

    # ==================== 高级操作方法 ====================

    async def send_family_invite(self, invitee_email: str) -> "JoinFamilyResult":
        """
        发送家庭邀请

        Args:
            invitee_email: 被邀请人邮箱

        Returns:
            JoinFamilyResult
        """
        from .operations.join_family import JoinFamilyOperation
        from .types import JoinFamilyResult

        self._ensure_initialized()
        op = JoinFamilyOperation(self)
        return await op.send_invite(invitee_email)

    async def join_family(self, inviter_email: str) -> "JoinFamilyResult":
        """
        接受家庭邀请并加入家庭组

        Args:
            inviter_email: 邀请人邮箱

        Returns:
            JoinFamilyResult
        """
        from .operations.join_family import JoinFamilyOperation
        from .types import JoinFamilyResult

        self._ensure_initialized()
        op = JoinFamilyOperation(self)
        return await op.accept_invite(inviter_email)


# ==================== 便捷函数 ====================

async def create_engine(
    llm_provider: Optional[str] = None,
    llm_model: Optional[str] = None,
    llm_api_key: Optional[str] = None,
    llm_base_url: Optional[str] = None,
    use_vision: bool = True,
    language: str = "zh",
) -> BrowserUseEngine:
    """
    创建并启动 BrowserUseEngine (便捷函数)

    Args:
        llm_provider: LLM 提供商
        llm_model: LLM 模型名称
        llm_api_key: LLM API 密钥
        llm_base_url: LLM API 基础 URL
        use_vision: 是否使用视觉模式
        language: 提示词语言

    Returns:
        已初始化的 BrowserUseEngine
    """
    engine = BrowserUseEngine(
        llm_provider=llm_provider,
        llm_model=llm_model,
        llm_api_key=llm_api_key,
        llm_base_url=llm_base_url,
        use_vision=use_vision,
        language=language,
    )
    await engine.start()
    return engine


async def create_engine_from_config(
    use_vision: bool = True,
    language: str = "zh",
) -> BrowserUseEngine:
    """
    从项目配置创建并启动引擎

    自动读取设置界面中的 AI Agent 配置。

    Args:
        use_vision: 是否使用视觉模式
        language: 提示词语言

    Returns:
        已初始化的 BrowserUseEngine

    Raises:
        ValueError: 如果配置中没有有效的 API Key
    """
    engine = BrowserUseEngine(
        use_vision=use_vision,
        language=language,
    )

    if not engine._llm:
        raise ValueError(
            "未找到有效的 AI 配置。请在设置界面配置 AI Agent，"
            "或传入 llm_provider 和 llm_api_key 参数"
        )

    await engine.start()
    return engine
