"""
Stagehand Google Engine

基于 Stagehand Python SDK 的 Google 账号操作引擎。
使用 AI 驱动的自然语言指令控制浏览器，实现 Google 账号自动化操作。

主要功能:
- Google 账号登录 (支持 TOTP 2FA)
- Pro 订阅状态检测
- 家庭组状态检测和管理
- 连接到现有的 ixBrowser 窗口 (CDP 模式)

使用示例:
    ```python
    from core.stagehand_engine import StagehandGoogleEngine

    # 方式1: 连接到 ixBrowser 窗口（推荐）
    async with await StagehandGoogleEngine.connect_to_ixbrowser("browser_id") as engine:
        result = await engine.login(
            email="user@gmail.com",
            password="password",
            totp_secret="BASE32SECRET"
        )

    # 方式2: 启动本地浏览器
    async with StagehandGoogleEngine(
        model_name="google/gemini-2.0-flash",
        model_api_key="your-api-key",
    ) as engine:
        result = await engine.login(...)
    ```

依赖:
    - stagehand: AI 浏览器自动化 SDK
    - pyotp: TOTP 验证码生成
    - pydantic: 数据验证

环境变量:
    - MODEL_API_KEY: LLM API 密钥
    - CHROME_PATH: Chrome 可执行文件路径 (可选)
"""

from .engine import (
    StagehandGoogleEngine,
    create_engine,
    create_engine_from_config,
    get_available_providers,
    STAGEHAND_AVAILABLE,
    IXBROWSER_API_AVAILABLE,
)
from .config import (
    StagehandModelConfig,
    get_stagehand_config,
    get_config_from_manager,
    get_config_from_env,
    get_enabled_providers,
    is_config_available,
    CONFIG_MANAGER_AVAILABLE,
)
from .types import (
    # 状态枚举
    OperationStatus,
    LoginState,
    TwoFactorMethod,
    ProStatus,
    FamilyRole,
    # 基础结果类型
    LoginResult,
    ProStatusResult,
    FamilyStatusResult,
    FamilyMember,
    NavigationResult,
    ActionResult,
    ExtractResult,
    ObserveResult,
    # 新增操作结果类型 (v1.1)
    BaseOperationResult,
    BindCardResult,
    SheerlinkResult,
    KickDevicesResult,
    ModifyPhoneResult,
    ModifyAuthenticatorResult,
    ReplaceEmailResult,
    ReplacePhoneResult,  # 别名 for ModifyPhoneResult
    SubscribeResult,
    UnlockResult,
    JoinFamilyResult,
    EnableSharingResult,
    OAuthResult,
)

from .constants import GoogleURLs, Timeouts

__all__ = [
    # 主类
    "StagehandGoogleEngine",
    "create_engine",
    "create_engine_from_config",
    "get_available_providers",
    # 可用性标志
    "STAGEHAND_AVAILABLE",
    "IXBROWSER_API_AVAILABLE",
    # 配置模块
    "StagehandModelConfig",
    "get_stagehand_config",
    "get_config_from_manager",
    "get_config_from_env",
    "get_enabled_providers",
    "is_config_available",
    "CONFIG_MANAGER_AVAILABLE",
    # 状态枚举
    "OperationStatus",
    "LoginState",
    "TwoFactorMethod",
    "ProStatus",
    "FamilyRole",
    # 基础结果类型
    "LoginResult",
    "ProStatusResult",
    "FamilyStatusResult",
    "FamilyMember",
    "NavigationResult",
    "ActionResult",
    "ExtractResult",
    "ObserveResult",
    # 新增操作结果类型 (v1.1)
    "BaseOperationResult",
    "BindCardResult",
    "SheerlinkResult",
    "KickDevicesResult",
    "ModifyPhoneResult",
    "ModifyAuthenticatorResult",
    "ReplaceEmailResult",
    "ReplacePhoneResult",  # 别名 for ModifyPhoneResult
    "SubscribeResult",
    "UnlockResult",
    "JoinFamilyResult",
    "EnableSharingResult",
    "OAuthResult",
    # 常量
    "GoogleURLs",
    "Timeouts",
]

__version__ = "1.1.0"  # 新增 CDP 连接支持
