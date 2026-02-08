"""
Stagehand Google Engine - 主引擎类

基于 Stagehand Python SDK 的 Google 账号操作引擎
使用自然语言 AI 驱动浏览器自动化

使用示例:
    ```python
    from core.stagehand_engine import StagehandGoogleEngine

    # 方式1: 使用项目配置（推荐）
    async with StagehandGoogleEngine() as engine:
        result = await engine.login(
            email="user@gmail.com",
            password="password",
            totp_secret="BASE32SECRET"
        )

    # 方式2: 手动指定配置
    async with StagehandGoogleEngine(
        model_name="google/gemini-2.0-flash",
        model_api_key="your-api-key",
    ) as engine:
        result = await engine.login(...)

    # 方式3: 使用便捷函数（自动读取配置）
    engine = await create_engine_from_config()
    ```
"""

import asyncio
import logging
import os
import time
from typing import Optional, Any, Dict, Type, TypeVar

from pydantic import BaseModel

from .types import (
    OperationStatus,
    LoginState,
    LoginResult,
    ProStatus,
    ProStatusResult,
    FamilyStatusResult,
    FamilyRole,
    NavigationResult,
    ActionResult,
    ExtractResult,
    ObserveResult,
    # 新增操作结果类型
    BindCardResult,
    SheerlinkResult,
    KickDevicesResult,
    ModifyPhoneResult,
    ModifyAuthenticatorResult,
    ReplaceEmailResult,
    SubscribeResult,
    UnlockResult,
    JoinFamilyResult,
    EnableSharingResult,
    OAuthResult,
)
from .constants import GoogleURLs, Timeouts
from .config import (
    get_stagehand_config,
    get_enabled_providers,
    StagehandModelConfig,
    CONFIG_MANAGER_AVAILABLE,
)

logger = logging.getLogger(__name__)

# 类型变量用于 extract 方法
T = TypeVar('T', bound=BaseModel)

# 尝试导入 Stagehand (需要 stagehand>=3.5.0)
try:
    from stagehand import Stagehand, AsyncStagehand
    STAGEHAND_AVAILABLE = True
except ImportError:
    STAGEHAND_AVAILABLE = False
    Stagehand = None
    AsyncStagehand = None
    logger.warning("Stagehand 未安装，请运行: pip install 'stagehand>=3.5.0'")

# 尝试导入 ixBrowser API
try:
    from services.ix_api import openBrowser, closeBrowser
    IXBROWSER_API_AVAILABLE = True
except ImportError:
    IXBROWSER_API_AVAILABLE = False
    openBrowser = None
    closeBrowser = None
    logger.debug("ixBrowser API 不可用")


class StagehandGoogleEngine:
    """
    基于 Stagehand 的 Google 账号操作引擎

    使用 AI 驱动的自然语言指令控制浏览器，
    实现 Google 账号的登录、状态检测、家庭组管理等操作。

    配置优先级:
        1. 构造函数参数 (最高优先级)
        2. ConfigManager 配置 (项目设置界面)
        3. 环境变量 MODEL_API_KEY

    Attributes:
        model_name: LLM 模型名称 (如 "google/gemini-2.0-flash")
        model_api_key: LLM API 密钥
        chrome_path: Chrome 可执行文件路径 (可选)
        headless: 是否无头模式运行
        verbose: 日志详细程度 (0-2)
    """

    def __init__(
        self,
        model_name: Optional[str] = None,
        model_api_key: Optional[str] = None,
        chrome_path: Optional[str] = None,
        headless: bool = False,
        verbose: int = 1,
        use_config: bool = True,
    ):
        """
        初始化 Stagehand Google Engine

        Args:
            model_name: LLM 模型名称，格式为 "provider/model"
                支持: google/gemini-2.0-flash, openai/gpt-4o, anthropic/claude-3-5-sonnet 等
                如不提供，将从 ConfigManager 或环境变量读取
            model_api_key: LLM API 密钥
                如不提供，将从 ConfigManager 或环境变量 MODEL_API_KEY 读取
            chrome_path: Chrome 可执行文件路径，如不提供则自动检测
            headless: 是否无头模式运行浏览器
            verbose: 日志详细程度 (0=静默, 1=正常, 2=详细)
            use_config: 是否使用 ConfigManager 配置 (默认 True)
        """
        if not STAGEHAND_AVAILABLE:
            raise ImportError(
                "Stagehand 未安装。请运行: pip install stagehand"
            )

        # 使用统一配置模块获取配置
        config = get_stagehand_config(
            model_name=model_name,
            api_key=model_api_key,
            use_config_manager=use_config,
            use_env=True,
        )

        # 设置实例属性
        self.model_name = config.model_name
        self.model_api_key = config.api_key
        self.model_base_url = config.base_url
        self.chrome_path = chrome_path or os.getenv("CHROME_PATH")
        self.headless = headless
        self.verbose = verbose

        # 检查 API Key
        if not self.model_api_key:
            logger.warning(
                "未配置 API Key。请在设置界面配置 AI Agent，"
                "或传入 model_api_key 参数，或设置环境变量 MODEL_API_KEY"
            )

        # Stagehand 实例 (stagehand 3.x 统一使用 AsyncStagehand)
        self._async_stagehand: Optional[AsyncStagehand] = None
        self._session = None  # Stagehand 会话
        self._session_id: Optional[str] = None  # 会话 ID
        self._page: Optional[Any] = None
        self._initialized = False
        self._cdp_mode = False  # 是否为 CDP 连接模式
        self._cdp_url: Optional[str] = None  # CDP WebSocket URL
        self._browser_id: Optional[str] = None  # ixBrowser 窗口 ID

        # 会话状态
        self._logged_in_email: Optional[str] = None
        self._login_state = LoginState.UNKNOWN

        # 操作模块 (延迟加载)
        self._login_op = None
        self._pro_status_op = None
        self._family_op = None

    async def __aenter__(self) -> "StagehandGoogleEngine":
        """异步上下文管理器入口"""
        if not self._initialized and not self._cdp_mode:
            await self.start()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        """异步上下文管理器退出"""
        await self.stop()

    # ==================== CDP 连接方法 ====================

    @classmethod
    async def connect_to_ixbrowser(
        cls,
        browser_id: str,
        model_name: Optional[str] = None,
        model_api_key: Optional[str] = None,
        use_config: bool = True,
        close_browser_on_exit: bool = False,
    ) -> "StagehandGoogleEngine":
        """
        连接到已打开的 ixBrowser 窗口

        这是推荐的使用方式，自动处理 ixBrowser API 调用和 CDP 连接。

        Args:
            browser_id: ixBrowser 窗口 ID (profile_id)
            model_name: LLM 模型名称，如不提供则从配置读取
            model_api_key: LLM API 密钥，如不提供则从配置读取
            use_config: 是否使用 ConfigManager 配置 (默认 True)
            close_browser_on_exit: 退出时是否关闭浏览器窗口 (默认 False)

        Returns:
            已连接的 StagehandGoogleEngine 实例

        Raises:
            ImportError: 如果 ixBrowser API 不可用
            RuntimeError: 如果无法打开或连接到浏览器

        使用示例:
            ```python
            from core.stagehand_engine.constants import GoogleURLs
            async with await StagehandGoogleEngine.connect_to_ixbrowser("abc123") as engine:
                await engine.navigate(GoogleURLs.ACCOUNT)
                await engine.act("点击登录按钮")
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
            model_name=model_name,
            model_api_key=model_api_key,
            use_config=use_config,
        )
        engine._browser_id = browser_id
        engine._close_browser_on_exit = close_browser_on_exit

        # 连接到 CDP
        await engine.connect_cdp(ws_endpoint)

        return engine

    async def connect_cdp(self, ws_endpoint: str) -> None:
        """
        连接到现有的 CDP WebSocket 端点

        使用 Stagehand sessions API 连接到已打开的浏览器。

        Args:
            ws_endpoint: CDP WebSocket URL (如 ws://127.0.0.1:xxxxx/devtools/browser/xxx)

        Raises:
            RuntimeError: 如果已初始化或连接失败
        """
        if self._initialized:
            raise RuntimeError("引擎已初始化，无法重复连接")

        if not STAGEHAND_AVAILABLE:
            raise ImportError("Stagehand 未安装。请运行: pip install stagehand")

        logger.info(f"正在通过 CDP 连接: {ws_endpoint[:50]}...")

        try:
            self._cdp_url = ws_endpoint
            self._cdp_mode = True

            # 创建 AsyncStagehand 客户端
            self._async_stagehand = AsyncStagehand(
                server="local",
                model_api_key=self.model_api_key,
                local_ready_timeout_s=30.0,
            )

            # 进入上下文
            await self._async_stagehand.__aenter__()

            # 使用 sessions API 连接到现有浏览器
            self._session = await self._async_stagehand.sessions.start(
                model_name=self.model_name,
                browser={
                    "type": "local",
                    "cdp_url": ws_endpoint,
                },
            )

            self._session_id = self._session.session_id
            self._page = self._session.page

            self._initialized = True
            logger.info(f"CDP 连接成功, session_id: {self._session_id}")

        except Exception as e:
            logger.error(f"CDP 连接失败: {e}")
            # 清理
            self._cdp_mode = False
            self._cdp_url = None
            if self._async_stagehand:
                try:
                    await self._async_stagehand.__aexit__(None, None, None)
                except Exception:
                    pass
                self._async_stagehand = None
            raise RuntimeError(f"CDP 连接失败: {e}")

    async def start(self) -> None:
        """
        启动 Stagehand 会话

        创建浏览器实例并初始化 Stagehand SDK。
        使用本地模式 (LOCAL)，需要本地安装 Chrome。

        注意: 如果是 CDP 连接模式，应使用 connect_cdp() 或 connect_to_ixbrowser() 而非此方法。
        """
        if self._initialized:
            logger.warning("引擎已初始化，跳过重复启动")
            return

        if self._cdp_mode:
            logger.warning("CDP 模式下请使用 connect_cdp() 而非 start()")
            return

        logger.info("正在启动 Stagehand Google Engine (本地模式)...")

        try:
            # 设置 Chrome 路径（如果提供）
            if self.chrome_path:
                os.environ["CHROME_PATH"] = self.chrome_path

            # 创建 AsyncStagehand 实例 (stagehand 3.x API)
            self._async_stagehand = AsyncStagehand(
                server="local",  # 使用本地模式
                model_api_key=self.model_api_key,
                local_headless=self.headless,
                local_chrome_path=self.chrome_path,
                local_ready_timeout_s=30.0,
            )

            # 进入上下文
            await self._async_stagehand.__aenter__()

            # 使用 sessions API 启动会话
            self._session = await self._async_stagehand.sessions.start(
                model_name=self.model_name,
            )

            self._session_id = self._session.session_id
            self._page = self._session.page

            self._initialized = True
            self._cdp_mode = False  # 明确标记为非 CDP 模式
            logger.info("Stagehand Google Engine 启动成功 (本地模式)")

        except Exception as e:
            logger.error(f"启动 Stagehand 失败: {e}")
            # 清理已创建的资源
            if self._async_stagehand:
                try:
                    await self._async_stagehand.__aexit__(None, None, None)
                except Exception:
                    pass
                self._async_stagehand = None
            self._session = None
            self._session_id = None
            raise

    async def stop(self, close_browser: Optional[bool] = None) -> None:
        """
        关闭 Stagehand 会话

        释放浏览器资源并清理状态。

        Args:
            close_browser: 是否关闭浏览器窗口 (仅 CDP 模式有效)
                - None: 使用创建时的 close_browser_on_exit 设置
                - True: 强制关闭
                - False: 不关闭
        """
        if not self._initialized:
            return

        logger.info("正在关闭 Stagehand Google Engine...")

        try:
            if self._cdp_mode:
                # CDP 模式清理
                if self._session:
                    try:
                        await self._session.close()
                    except Exception as e:
                        logger.debug(f"关闭 session 时出错: {e}")
                    self._session = None
                    self._session_id = None

                if self._async_stagehand:
                    try:
                        await self._async_stagehand.__aexit__(None, None, None)
                    except Exception as e:
                        logger.debug(f"关闭 AsyncStagehand 时出错: {e}")
                    self._async_stagehand = None

                # 是否关闭浏览器窗口
                should_close = close_browser
                if should_close is None:
                    should_close = getattr(self, '_close_browser_on_exit', False)

                if should_close and self._browser_id and IXBROWSER_API_AVAILABLE:
                    try:
                        closeBrowser(self._browser_id)
                        logger.info(f"已关闭 ixBrowser 窗口: {self._browser_id}")
                    except Exception as e:
                        logger.warning(f"关闭 ixBrowser 窗口失败: {e}")

                self._cdp_url = None
                self._browser_id = None
            else:
                # 本地模式清理 (stagehand 3.x 也使用 _async_stagehand)
                if self._session:
                    try:
                        await self._session.close()
                    except Exception as e:
                        logger.debug(f"关闭 session 时出错: {e}")
                    self._session = None
                    self._session_id = None

                if self._async_stagehand:
                    try:
                        await self._async_stagehand.__aexit__(None, None, None)
                    except Exception as e:
                        logger.debug(f"关闭 AsyncStagehand 时出错: {e}")
                    self._async_stagehand = None

            self._page = None
            self._initialized = False
            self._cdp_mode = False
            self._logged_in_email = None
            self._login_state = LoginState.UNKNOWN

            logger.info("Stagehand Google Engine 已关闭")

        except Exception as e:
            logger.error(f"关闭 Stagehand 失败: {e}")

    def _ensure_initialized(self) -> None:
        """确保引擎已初始化"""
        if not self._initialized:
            raise RuntimeError(
                "引擎未初始化。请先调用 start() 或使用 async with 上下文管理器"
            )

    # 无效页面 URL 模式
    INVALID_PAGE_PATTERNS = [
        "about:blank",
        "about:srcdoc",
        "chrome://",
        "chrome-error://",
        "data:",
    ]

    def _is_page_valid(self, url: Optional[str] = None) -> bool:
        """
        检查页面 URL 是否有效（可以执行 AI 操作）

        Args:
            url: 要检查的 URL，如果不提供则使用当前页面 URL

        Returns:
            bool: True 如果页面有效
        """
        if url is None:
            if not self._page:
                return False
            try:
                url = self._page.url
            except Exception:
                return False

        if not url:
            return False

        # 检查是否为无效页面模式
        for pattern in self.INVALID_PAGE_PATTERNS:
            if url.startswith(pattern):
                return False

        return True

    def _get_page_invalid_reason(self, url: Optional[str] = None) -> str:
        """
        获取页面无效的原因

        Args:
            url: 要检查的 URL

        Returns:
            str: 无效原因描述
        """
        if url is None:
            if not self._page:
                return "页面对象不存在"
            try:
                url = self._page.url
            except Exception as e:
                return f"无法获取页面 URL: {e}"

        if not url:
            return "页面 URL 为空"

        for pattern in self.INVALID_PAGE_PATTERNS:
            if url.startswith(pattern):
                return f"页面 URL 无效: {url} (匹配模式: {pattern})"

        return "未知原因"

    async def _ensure_valid_page(self, operation: str = "操作") -> None:
        """
        确保页面状态有效，可以执行 AI 操作

        Args:
            operation: 操作名称，用于错误消息

        Raises:
            RuntimeError: 如果页面状态无效
        """
        self._ensure_initialized()

        if not self._is_page_valid():
            reason = self._get_page_invalid_reason()
            raise RuntimeError(
                f"无法执行 {operation}: {reason}。"
                f"请确保页面已正确加载后再执行操作。"
            )

    @property
    def page(self) -> Any:
        """获取 Playwright Page 对象"""
        self._ensure_initialized()
        return self._page

    @property
    def stagehand(self) -> Any:
        """获取 AsyncStagehand 实例 (stagehand 3.x 统一使用 AsyncStagehand)"""
        self._ensure_initialized()
        return self._async_stagehand

    @property
    def session(self) -> Any:
        """获取 Stagehand Session 对象"""
        return self._session

    @property
    def session_id(self) -> Optional[str]:
        """获取 Session ID"""
        return self._session_id

    @property
    def is_cdp_mode(self) -> bool:
        """是否为 CDP 连接模式"""
        return self._cdp_mode

    @property
    def browser_id(self) -> Optional[str]:
        """获取 ixBrowser 窗口 ID (仅 CDP 模式)"""
        return self._browser_id

    @property
    def is_initialized(self) -> bool:
        """是否已初始化"""
        return self._initialized

    @property
    def logged_in_email(self) -> Optional[str]:
        """当前登录的邮箱"""
        return self._logged_in_email

    @property
    def login_state(self) -> LoginState:
        """当前登录状态"""
        return self._login_state

    # ==================== 基础操作 ====================

    async def navigate(
        self,
        url: str,
        wait_until: str = "domcontentloaded",
        timeout: float = Timeouts.NAVIGATION,
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
            await self._page.goto(url, wait_until=wait_until, timeout=timeout)
            final_url = self._page.url
            duration_ms = (time.time() - start_time) * 1000

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
                error_message=str(e),
                duration_ms=duration_ms,
            )

    async def act(
        self,
        instruction: str,
        timeout: float = Timeouts.ACTION,
    ) -> ActionResult:
        """
        执行自然语言指令

        使用 AI 理解指令并在页面上执行相应操作。

        Args:
            instruction: 自然语言指令 (如 "点击登录按钮")
            timeout: 超时时间（毫秒）

        Returns:
            ActionResult
        """
        self._ensure_initialized()
        start_time = time.time()

        # 检查页面有效性
        if not self._is_page_valid():
            reason = self._get_page_invalid_reason()
            logger.warning(f"act 跳过: 页面无效 - {reason}")
            return ActionResult(
                success=False,
                error=f"页面状态无效，无法执行 act: {reason}",
                duration_ms=(time.time() - start_time) * 1000,
            )

        try:
            # 使用 Stagehand act API
            result = await self._page.act(instruction)
            duration_ms = (time.time() - start_time) * 1000

            logger.debug(f"操作成功: {instruction}")

            return ActionResult(
                success=True,
                message=f"执行成功: {instruction}",
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

    async def observe(
        self,
        instruction: str,
        timeout: float = Timeouts.OBSERVE,
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

        # 检查页面有效性
        if not self._is_page_valid():
            reason = self._get_page_invalid_reason()
            logger.warning(f"observe 跳过: 页面无效 - {reason}")
            return ObserveResult(
                success=False,
                error=f"页面状态无效，无法执行 observe: {reason}",
                duration_ms=(time.time() - start_time) * 1000,
            )

        try:
            # 使用 Stagehand observe API
            actions = await self._page.observe(instruction)
            duration_ms = (time.time() - start_time) * 1000

            # 转换为字典列表
            action_list = []
            if actions:
                for action in actions:
                    if hasattr(action, '__dict__'):
                        action_list.append(vars(action))
                    elif isinstance(action, dict):
                        action_list.append(action)

            logger.debug(f"观察成功: {instruction}, 找到 {len(action_list)} 个元素")

            return ObserveResult(
                success=True,
                actions=action_list,
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

    async def extract(
        self,
        instruction: str,
        schema: Optional[Type[T]] = None,
        timeout: float = Timeouts.EXTRACT,
    ) -> ExtractResult:
        """
        提取页面数据

        使用 AI 从页面提取结构化数据。

        Args:
            instruction: 提取描述 (如 "提取所有商品价格")
            schema: Pydantic 模型类，用于验证提取结果
            timeout: 超时时间（毫秒）

        Returns:
            ExtractResult
        """
        self._ensure_initialized()
        start_time = time.time()

        # 检查页面有效性
        if not self._is_page_valid():
            reason = self._get_page_invalid_reason()
            logger.warning(f"extract 跳过: 页面无效 - {reason}")
            return ExtractResult(
                success=False,
                error=f"页面状态无效，无法执行 extract: {reason}",
                duration_ms=(time.time() - start_time) * 1000,
            )

        try:
            # 使用 Stagehand extract API
            if schema:
                result = await self._page.extract(instruction, schema=schema)
            else:
                result = await self._page.extract(instruction)

            duration_ms = (time.time() - start_time) * 1000

            # 转换结果为字典
            if hasattr(result, 'model_dump'):
                data = result.model_dump()
            elif hasattr(result, '__dict__'):
                data = vars(result)
            elif isinstance(result, dict):
                data = result
            else:
                data = {"result": result}

            logger.debug(f"提取成功: {instruction}")

            return ExtractResult(
                success=True,
                data=data,
                duration_ms=duration_ms,
            )

        except Exception as e:
            duration_ms = (time.time() - start_time) * 1000
            error_msg = str(e)

            # 增强错误信息：检测 500 错误
            if "500" in error_msg or "extract failed" in error_msg.lower():
                current_url = "unknown"
                try:
                    current_url = self._page.url
                except Exception:
                    pass
                logger.error(f"extract API 调用失败 (500): {instruction}, 当前 URL: {current_url}")
                error_msg = f"extract API 调用失败: {error_msg}. 当前页面: {current_url}"
            else:
                logger.error(f"提取失败: {instruction} - {e}")

            return ExtractResult(
                success=False,
                error=error_msg,
                duration_ms=duration_ms,
            )

    async def wait(self, milliseconds: float) -> None:
        """等待指定毫秒数"""
        await asyncio.sleep(milliseconds / 1000)

    async def get_page_content(self) -> str:
        """获取页面文本内容"""
        self._ensure_initialized()
        try:
            return await self._page.inner_text("body", timeout=5000)
        except Exception:
            return ""

    async def get_current_url(self) -> str:
        """获取当前 URL"""
        self._ensure_initialized()
        return self._page.url

    # ==================== 高级操作 ====================

    async def login(
        self,
        email: str,
        password: str,
        totp_secret: Optional[str] = None,
        recovery_email: Optional[str] = None,
        timeout: float = Timeouts.LOGIN_TOTAL,
    ) -> LoginResult:
        """
        Google 账号登录

        支持邮箱密码登录，自动处理 TOTP 两步验证。

        Args:
            email: Google 邮箱地址
            password: 密码
            totp_secret: TOTP 密钥 (Base32 编码)，用于两步验证
            recovery_email: 辅助邮箱，用于某些验证场景
            timeout: 总超时时间（毫秒）

        Returns:
            LoginResult
        """
        self._ensure_initialized()

        # 延迟导入操作模块
        if self._login_op is None:
            from .operations.login import LoginOperation
            self._login_op = LoginOperation(self)

        result = await self._login_op.execute(
            email=email,
            password=password,
            totp_secret=totp_secret,
            recovery_email=recovery_email,
            timeout=timeout,
        )

        # 更新状态
        if result.success:
            self._logged_in_email = email
            self._login_state = LoginState.LOGGED_IN
        else:
            self._login_state = result.login_state

        return result

    async def detect_pro_status(
        self,
        navigate_if_needed: bool = True,
        timeout: float = Timeouts.EXTRACT,
    ) -> ProStatusResult:
        """
        检测 Google One Pro 订阅状态

        Args:
            navigate_if_needed: 是否自动导航到 Google One 页面
            timeout: 超时时间（毫秒）

        Returns:
            ProStatusResult
        """
        self._ensure_initialized()

        # 延迟导入操作模块
        if self._pro_status_op is None:
            from .operations.pro_status import ProStatusOperation
            self._pro_status_op = ProStatusOperation(self)

        return await self._pro_status_op.execute(
            navigate_if_needed=navigate_if_needed,
            timeout=timeout,
        )

    async def detect_family_status(
        self,
        navigate_if_needed: bool = True,
        timeout: float = Timeouts.EXTRACT,
    ) -> FamilyStatusResult:
        """
        检测家庭组状态

        Args:
            navigate_if_needed: 是否自动导航到家庭组页面
            timeout: 超时时间（毫秒）

        Returns:
            FamilyStatusResult
        """
        self._ensure_initialized()

        # 延迟导入操作模块
        if self._family_op is None:
            from .operations.family import FamilyOperation
            self._family_op = FamilyOperation(self)

        return await self._family_op.execute(
            navigate_if_needed=navigate_if_needed,
            timeout=timeout,
        )

    # ==================== 新增操作 (待实现) ====================
    # 以下方法将在 Phase 2 中实现具体逻辑

    async def bind_card(
        self,
        card_number: str,
        card_exp: str,
        card_cvv: str,
        card_name: str,
        zip_code: Optional[str] = None,
        timeout: float = Timeouts.OPERATION,
    ) -> BindCardResult:
        """
        绑定支付卡并订阅

        Args:
            card_number: 卡号
            card_exp: 有效期 (MM/YY 格式)
            card_cvv: CVV 安全码
            card_name: 持卡人姓名
            zip_code: 邮编 (某些地区需要)
            timeout: 超时时间（毫秒）

        Returns:
            BindCardResult
        """
        self._ensure_initialized()

        # 延迟导入操作模块
        from .operations.bind_card import BindCardOperation
        bind_op = BindCardOperation(self)

        return await bind_op.execute(
            card_number=card_number,
            card_exp=card_exp,
            card_cvv=card_cvv,
            card_name=card_name,
            zip_code=zip_code,
            timeout=timeout,
        )

    async def get_sheerlink(
        self,
        navigate_if_needed: bool = True,
        timeout: float = Timeouts.OPERATION,
    ) -> SheerlinkResult:
        """
        获取 SheerID 学生验证链接

        Args:
            navigate_if_needed: 是否自动导航
            timeout: 超时时间（毫秒）

        Returns:
            SheerlinkResult
        """
        self._ensure_initialized()

        # 延迟导入操作模块
        from .operations.sheerlink import SheerlinkOperation
        sheerlink_op = SheerlinkOperation(self)

        return await sheerlink_op.execute(
            navigate_if_needed=navigate_if_needed,
            timeout=timeout,
        )

    async def kick_devices(
        self,
        keep_current: bool = True,
        timeout: float = Timeouts.OPERATION,
    ) -> KickDevicesResult:
        """
        踢出其他登录设备

        Args:
            keep_current: 是否保留当前设备
            timeout: 超时时间（毫秒）

        Returns:
            KickDevicesResult
        """
        self._ensure_initialized()

        # 延迟导入操作模块
        from .operations.kick_devices import KickDevicesOperation
        kick_op = KickDevicesOperation(self)

        return await kick_op.execute(
            keep_current=keep_current,
            timeout=timeout,
        )

    async def modify_2sv_phone(
        self,
        new_phone: str,
        sms_service: Optional[Any] = None,
        timeout: float = Timeouts.OPERATION,
    ) -> ModifyPhoneResult:
        """
        修改两步验证手机号

        Args:
            new_phone: 新手机号
            sms_service: 短信验证服务 (用于接收验证码)
            timeout: 超时时间（毫秒）

        Returns:
            ModifyPhoneResult
        """
        self._ensure_initialized()

        # 延迟导入操作模块
        from .operations.modify_2sv import Modify2SVOperation
        modify_op = Modify2SVOperation(self)

        return await modify_op.execute(
            new_phone=new_phone,
            sms_service=sms_service,
            timeout=timeout,
        )

    async def modify_authenticator(
        self,
        timeout: float = Timeouts.OPERATION,
    ) -> ModifyAuthenticatorResult:
        """
        添加或修改 Google Authenticator

        Args:
            timeout: 超时时间（毫秒）

        Returns:
            ModifyAuthenticatorResult (包含新的 TOTP 密钥)
        """
        self._ensure_initialized()

        # 延迟导入操作模块
        from .operations.modify_auth import ModifyAuthenticatorOperation
        modify_op = ModifyAuthenticatorOperation(self)

        return await modify_op.execute(
            timeout=timeout,
        )

    async def replace_recovery_email(
        self,
        new_email: str,
        email_service: Optional[Any] = None,
        timeout: float = Timeouts.OPERATION,
    ) -> ReplaceEmailResult:
        """
        替换辅助邮箱

        Args:
            new_email: 新的辅助邮箱
            email_service: 邮件服务 (用于接收验证码)
            timeout: 超时时间（毫秒）

        Returns:
            ReplaceEmailResult
        """
        self._ensure_initialized()

        # 延迟导入操作模块
        from .operations.replace_email import ReplaceEmailOperation
        replace_op = ReplaceEmailOperation(self)

        return await replace_op.execute(
            new_email=new_email,
            email_service=email_service,
            timeout=timeout,
        )

    async def replace_recovery_phone(
        self,
        new_phone: str,
        sms_service: Optional[Any] = None,
        timeout: float = Timeouts.OPERATION,
    ) -> ModifyPhoneResult:
        """
        替换恢复手机号

        Args:
            new_phone: 新手机号
            sms_service: 短信验证服务 (用于接收验证码)
            timeout: 超时时间（毫秒）

        Returns:
            ModifyPhoneResult
        """
        self._ensure_initialized()

        # 延迟导入操作模块
        from .operations.replace_phone import ReplacePhoneOperation
        replace_op = ReplacePhoneOperation(self)

        return await replace_op.execute(
            new_phone=new_phone,
            sms_service=sms_service,
            timeout=timeout,
        )

    async def subscribe(
        self,
        plan: str = "student",
        timeout: float = Timeouts.OPERATION,
    ) -> SubscribeResult:
        """
        订阅 Google One

        Args:
            plan: 订阅计划 ("student", "regular", "trial")
            timeout: 超时时间（毫秒）

        Returns:
            SubscribeResult
        """
        self._ensure_initialized()

        # 延迟导入操作模块
        from .operations.subscribe import SubscribeOperation
        subscribe_op = SubscribeOperation(self)

        return await subscribe_op.execute(
            plan=plan,
            timeout=timeout,
        )

    async def unlock_403(
        self,
        validation_url: Optional[str] = None,
        phone_number: Optional[str] = None,
        country_name: str = "United States",
        sms_client: Optional[Any] = None,
        request_id: Optional[str] = None,
        sms_timeout: int = 120,
        sms_interval: int = 5,
        timeout: float = Timeouts.OPERATION,
    ) -> UnlockResult:
        """
        解锁 403 账号

        Args:
            validation_url: 验证 URL (如果已知)
            phone_number: 用于验证的手机号
            country_name: 国家名称
            sms_client: 短信验证服务客户端
            request_id: SMS 请求 ID
            sms_timeout: 等待验证码超时时间（秒）
            sms_interval: 轮询验证码间隔（秒）
            timeout: 操作超时时间（毫秒）

        Returns:
            UnlockResult
        """
        self._ensure_initialized()

        # 延迟导入操作模块
        from .operations.unlock_403 import Unlock403Operation
        unlock_op = Unlock403Operation(self)

        return await unlock_op.execute(
            validation_url=validation_url,
            phone_number=phone_number,
            country_name=country_name,
            sms_client=sms_client,
            request_id=request_id,
            sms_timeout=sms_timeout,
            sms_interval=sms_interval,
            timeout=timeout,
        )

    async def join_family(
        self,
        inviter_email: str,
        timeout: float = Timeouts.OPERATION,
    ) -> JoinFamilyResult:
        """
        加入家庭组

        注意: 此操作需要邀请人先发送邀请

        Args:
            inviter_email: 邀请人邮箱
            timeout: 超时时间（毫秒）

        Returns:
            JoinFamilyResult
        """
        self._ensure_initialized()

        # 延迟导入操作模块
        from .operations.join_family import JoinFamilyOperation
        join_op = JoinFamilyOperation(self)

        return await join_op.execute(
            inviter_email=inviter_email,
            timeout=timeout,
        )

    async def enable_family_sharing(
        self,
        timeout: float = Timeouts.OPERATION,
    ) -> EnableSharingResult:
        """
        开启家庭共享

        Args:
            timeout: 超时时间（毫秒）

        Returns:
            EnableSharingResult
        """
        self._ensure_initialized()

        # 延迟导入操作模块
        from .operations.enable_sharing import EnableSharingOperation
        enable_op = EnableSharingOperation(self)

        return await enable_op.execute(
            timeout=timeout,
        )

    async def oauth_authorize(
        self,
        service: str,
        oauth_url: Optional[str] = None,
        timeout: float = Timeouts.OPERATION,
    ) -> OAuthResult:
        """
        OAuth 授权

        Args:
            service: 服务名称 (如 "antigravity", "sub2api")
            oauth_url: OAuth 授权 URL (如果已知)
            timeout: 超时时间（毫秒）

        Returns:
            OAuthResult
        """
        self._ensure_initialized()

        # 延迟导入操作模块
        from .operations.oauth import OAuthOperation
        oauth_op = OAuthOperation(self)

        return await oauth_op.execute(
            service=service,
            oauth_url=oauth_url,
            timeout=timeout,
        )


# ==================== 便捷函数 ====================

async def create_engine(
    model_name: Optional[str] = None,
    model_api_key: Optional[str] = None,
    chrome_path: Optional[str] = None,
    headless: bool = False,
    use_config: bool = True,
) -> StagehandGoogleEngine:
    """
    创建并启动 Stagehand Google Engine (便捷函数)

    Args:
        model_name: LLM 模型名称，如不提供则从配置读取
        model_api_key: LLM API 密钥，如不提供则从配置读取
        chrome_path: Chrome 路径
        headless: 是否无头模式
        use_config: 是否使用 ConfigManager 配置 (默认 True)

    Returns:
        已初始化的 StagehandGoogleEngine
    """
    engine = StagehandGoogleEngine(
        model_name=model_name,
        model_api_key=model_api_key,
        chrome_path=chrome_path,
        headless=headless,
        use_config=use_config,
    )
    await engine.start()
    return engine


async def create_engine_from_config(
    headless: bool = False,
    chrome_path: Optional[str] = None,
) -> StagehandGoogleEngine:
    """
    从项目配置创建并启动引擎

    自动读取设置界面中的 AI Agent 配置。

    Args:
        headless: 是否无头模式
        chrome_path: Chrome 路径 (可选)

    Returns:
        已初始化的 StagehandGoogleEngine

    Raises:
        ValueError: 如果配置中没有有效的 API Key
    """
    engine = StagehandGoogleEngine(
        headless=headless,
        chrome_path=chrome_path,
        use_config=True,
    )

    if not engine.model_api_key:
        raise ValueError(
            "未找到有效的 AI 配置。请在设置界面配置 AI Agent，"
            "或设置环境变量 MODEL_API_KEY"
        )

    await engine.start()
    return engine


def get_available_providers() -> list:
    """
    获取可用的 AI 提供商列表

    Returns:
        list: 已配置 API Key 的提供商名称列表
    """
    return get_enabled_providers()
