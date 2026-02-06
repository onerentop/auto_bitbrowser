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
)
from .constants import GoogleURLs, Timeouts

logger = logging.getLogger(__name__)

# 尝试导入配置管理器
try:
    from core.config_manager import ConfigManager
    CONFIG_MANAGER_AVAILABLE = True
except ImportError:
    CONFIG_MANAGER_AVAILABLE = False
    ConfigManager = None
    logger.debug("ConfigManager 不可用，将使用环境变量或手动配置")

# 类型变量用于 extract 方法
T = TypeVar('T', bound=BaseModel)

# 尝试导入 Stagehand
try:
    from stagehand import Stagehand, StagehandConfig
    STAGEHAND_AVAILABLE = True
except ImportError:
    STAGEHAND_AVAILABLE = False
    Stagehand = None
    StagehandConfig = None
    logger.warning("Stagehand 未安装，请运行: pip install stagehand")


def _get_config_model_info() -> tuple:
    """
    从 ConfigManager 获取模型配置

    Returns:
        tuple: (model_name, api_key, base_url) 或 (None, None, None)
    """
    if not CONFIG_MANAGER_AVAILABLE:
        return None, None, None

    try:
        # 获取默认提供商
        provider = ConfigManager.get_ai_default_provider()  # "gemini" 或 "anthropic"

        # 获取提供商配置
        api_key = ConfigManager.get_ai_provider_api_key(provider)
        base_url = ConfigManager.get_ai_provider_base_url(provider)
        model = ConfigManager.get_ai_provider_model(provider)

        if not api_key:
            logger.debug(f"ConfigManager 中 {provider} 提供商未配置 API Key")
            return None, None, None

        # 转换为 Stagehand 格式: "provider/model"
        # gemini -> google, anthropic -> anthropic
        provider_map = {
            "gemini": "google",
            "anthropic": "anthropic",
        }
        stagehand_provider = provider_map.get(provider, provider)

        # 构建 model_name
        if model:
            model_name = f"{stagehand_provider}/{model}"
        else:
            # 默认模型
            default_models = {
                "google": "gemini-2.0-flash",
                "anthropic": "claude-3-5-sonnet",
            }
            model_name = f"{stagehand_provider}/{default_models.get(stagehand_provider, 'gemini-2.0-flash')}"

        logger.info(f"从配置加载 AI 模型: {model_name}")
        return model_name, api_key, base_url

    except Exception as e:
        logger.warning(f"读取 ConfigManager 配置失败: {e}")
        return None, None, None


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

        # 配置优先级: 参数 > ConfigManager > 环境变量
        config_model_name, config_api_key, config_base_url = (None, None, None)
        if use_config:
            config_model_name, config_api_key, config_base_url = _get_config_model_info()

        # 确定最终配置
        self.model_name = model_name or config_model_name or "google/gemini-2.0-flash"
        self.model_api_key = model_api_key or config_api_key or os.getenv("MODEL_API_KEY")
        self.model_base_url = config_base_url  # base_url 仅从配置读取
        self.chrome_path = chrome_path or os.getenv("CHROME_PATH")
        self.headless = headless
        self.verbose = verbose

        # 检查 API Key
        if not self.model_api_key:
            logger.warning(
                "未配置 API Key。请在设置界面配置 AI Agent，"
                "或传入 model_api_key 参数，或设置环境变量 MODEL_API_KEY"
            )

        # Stagehand 实例
        self._stagehand: Optional[Stagehand] = None
        self._page: Optional[Any] = None
        self._initialized = False

        # 会话状态
        self._logged_in_email: Optional[str] = None
        self._login_state = LoginState.UNKNOWN

        # 操作模块 (延迟加载)
        self._login_op = None
        self._pro_status_op = None
        self._family_op = None

    async def __aenter__(self) -> "StagehandGoogleEngine":
        """异步上下文管理器入口"""
        await self.start()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        """异步上下文管理器退出"""
        await self.stop()

    async def start(self) -> None:
        """
        启动 Stagehand 会话

        创建浏览器实例并初始化 Stagehand SDK。
        使用本地模式 (LOCAL)，需要本地安装 Chrome。
        """
        if self._initialized:
            logger.warning("引擎已初始化，跳过重复启动")
            return

        logger.info("正在启动 Stagehand Google Engine...")

        try:
            # 创建配置
            model_client_options = {"apiKey": self.model_api_key}

            # 如果有自定义 base_url，添加到配置
            if self.model_base_url:
                model_client_options["baseURL"] = self.model_base_url

            config = StagehandConfig(
                env="LOCAL",  # 使用本地模式
                model_name=self.model_name,
                model_client_options=model_client_options,
                headless=self.headless,
                verbose=self.verbose,
            )

            # 设置 Chrome 路径（如果提供）
            if self.chrome_path:
                os.environ["CHROME_PATH"] = self.chrome_path

            # 创建 Stagehand 实例
            self._stagehand = Stagehand(config)

            # 初始化
            await self._stagehand.init()

            # 获取页面对象
            self._page = self._stagehand.page

            self._initialized = True
            logger.info("Stagehand Google Engine 启动成功")

        except Exception as e:
            logger.error(f"启动 Stagehand 失败: {e}")
            raise

    async def stop(self) -> None:
        """
        关闭 Stagehand 会话

        释放浏览器资源并清理状态。
        """
        if not self._initialized:
            return

        logger.info("正在关闭 Stagehand Google Engine...")

        try:
            if self._stagehand:
                await self._stagehand.close()
                self._stagehand = None
                self._page = None

            self._initialized = False
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

    @property
    def page(self) -> Any:
        """获取 Playwright Page 对象"""
        self._ensure_initialized()
        return self._page

    @property
    def stagehand(self) -> Stagehand:
        """获取 Stagehand 实例"""
        self._ensure_initialized()
        return self._stagehand

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
            logger.error(f"提取失败: {instruction} - {e}")

            return ExtractResult(
                success=False,
                error=str(e),
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
    if not CONFIG_MANAGER_AVAILABLE:
        return []

    try:
        return ConfigManager.get_enabled_ai_providers()
    except Exception:
        return []
