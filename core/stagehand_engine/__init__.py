"""
Stagehand Google Engine

基于 Stagehand Python SDK 的 Google 账号操作引擎。
使用 AI 驱动的自然语言指令控制浏览器，实现 Google 账号自动化操作。

主要功能:
- Google 账号登录 (支持 TOTP 2FA)
- Pro 订阅状态检测
- 家庭组状态检测和管理

使用示例:
    ```python
    from core.stagehand_engine import StagehandGoogleEngine

    async with StagehandGoogleEngine(
        model_name="google/gemini-2.0-flash",
        model_api_key="your-api-key",
    ) as engine:
        # 登录
        result = await engine.login(
            email="user@gmail.com",
            password="password",
            totp_secret="BASE32SECRET"
        )

        if result.success:
            # 检测 Pro 状态
            pro_status = await engine.detect_pro_status()
            print(f"Pro 会员: {pro_status.is_pro}")

            # 检测家庭组状态
            family_status = await engine.detect_family_status()
            print(f"有家庭组: {family_status.has_family}")
    ```

依赖:
    - stagehand: AI 浏览器自动化 SDK
    - pyotp: TOTP 验证码生成
    - pydantic: 数据验证

环境变量:
    - MODEL_API_KEY: LLM API 密钥
    - CHROME_PATH: Chrome 可执行文件路径 (可选)
"""

from .engine import StagehandGoogleEngine, create_engine, create_engine_from_config, get_available_providers
from .types import (
    # 状态枚举
    OperationStatus,
    LoginState,
    TwoFactorMethod,
    ProStatus,
    FamilyRole,
    # 结果类型
    LoginResult,
    ProStatusResult,
    FamilyStatusResult,
    FamilyMember,
    NavigationResult,
    ActionResult,
    ExtractResult,
    ObserveResult,
)
from .constants import GoogleURLs, Timeouts

__all__ = [
    # 主类
    "StagehandGoogleEngine",
    "create_engine",
    "create_engine_from_config",
    "get_available_providers",
    # 状态枚举
    "OperationStatus",
    "LoginState",
    "TwoFactorMethod",
    "ProStatus",
    "FamilyRole",
    # 结果类型
    "LoginResult",
    "ProStatusResult",
    "FamilyStatusResult",
    "FamilyMember",
    "NavigationResult",
    "ActionResult",
    "ExtractResult",
    "ObserveResult",
    # 常量
    "GoogleURLs",
    "Timeouts",
]

__version__ = "1.0.0"
