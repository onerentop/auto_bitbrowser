"""
Stagehand Google Engine - 配置管理模块

集中管理 StagehandGoogleEngine 的配置获取逻辑
支持从 ConfigManager、环境变量等多种来源读取配置
"""

import logging
import os
from dataclasses import dataclass
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)

# 尝试导入配置管理器
try:
    from core.config_manager import ConfigManager
    CONFIG_MANAGER_AVAILABLE = True
except ImportError:
    CONFIG_MANAGER_AVAILABLE = False
    ConfigManager = None
    logger.debug("ConfigManager 不可用，将使用环境变量或手动配置")


@dataclass
class StagehandModelConfig:
    """Stagehand 模型配置"""
    model_name: str
    api_key: Optional[str]
    base_url: Optional[str] = None

    @property
    def is_valid(self) -> bool:
        """检查配置是否有效（有 API Key）"""
        return bool(self.api_key)

    @property
    def provider(self) -> str:
        """获取提供商名称 (从 model_name 解析)"""
        if "/" in self.model_name:
            return self.model_name.split("/")[0]
        return "unknown"

    @property
    def model(self) -> str:
        """获取模型名称 (从 model_name 解析)"""
        if "/" in self.model_name:
            return self.model_name.split("/", 1)[1]
        return self.model_name

    def to_stagehand_options(self) -> Dict[str, Any]:
        """
        转换为 Stagehand model_client_options 格式

        Returns:
            dict: 可直接传入 AsyncStagehand 的配置选项
        """
        options = {"apiKey": self.api_key}
        if self.base_url:
            options["baseURL"] = self.base_url
        return options


# 默认配置
DEFAULT_MODEL_NAME = "google/gemini-2.0-flash"
DEFAULT_MODELS = {
    "google": "gemini-2.0-flash",
    "anthropic": "claude-3-5-sonnet",
    "openai": "gpt-4o",
}

# 提供商名称映射 (ConfigManager 格式 -> Stagehand 格式)
PROVIDER_MAP = {
    "gemini": "google",
    "anthropic": "anthropic",
    "openai": "openai",
}


def get_config_from_manager() -> Optional[StagehandModelConfig]:
    """
    从 ConfigManager 获取模型配置

    Returns:
        StagehandModelConfig 或 None (如果 ConfigManager 不可用或未配置)
    """
    if not CONFIG_MANAGER_AVAILABLE:
        return None

    try:
        # 获取默认提供商
        provider = ConfigManager.get_ai_default_provider()  # "gemini" 或 "anthropic"
        if not provider:
            logger.debug("ConfigManager 中未设置默认 AI 提供商")
            return None

        # 获取提供商配置
        api_key = ConfigManager.get_ai_provider_api_key(provider)
        if not api_key:
            logger.debug(f"ConfigManager 中 {provider} 提供商未配置 API Key")
            return None

        base_url = ConfigManager.get_ai_provider_base_url(provider)
        model = ConfigManager.get_ai_provider_model(provider)

        # 转换为 Stagehand 格式: "provider/model"
        stagehand_provider = PROVIDER_MAP.get(provider, provider)

        # 构建 model_name
        if model:
            model_name = f"{stagehand_provider}/{model}"
        else:
            # 使用默认模型
            default_model = DEFAULT_MODELS.get(stagehand_provider, "gemini-2.0-flash")
            model_name = f"{stagehand_provider}/{default_model}"

        logger.info(f"从 ConfigManager 加载 AI 配置: {model_name}")

        return StagehandModelConfig(
            model_name=model_name,
            api_key=api_key,
            base_url=base_url,
        )

    except Exception as e:
        logger.warning(f"读取 ConfigManager 配置失败: {e}")
        return None


def get_config_from_env() -> Optional[StagehandModelConfig]:
    """
    从环境变量获取模型配置

    支持的环境变量:
        - MODEL_API_KEY: API 密钥
        - MODEL_NAME: 模型名称 (如 "google/gemini-2.0-flash")
        - MODEL_BASE_URL: 自定义 API 基础 URL

    Returns:
        StagehandModelConfig 或 None (如果环境变量未设置)
    """
    api_key = os.getenv("MODEL_API_KEY")
    if not api_key:
        return None

    model_name = os.getenv("MODEL_NAME", DEFAULT_MODEL_NAME)
    base_url = os.getenv("MODEL_BASE_URL")

    logger.info(f"从环境变量加载 AI 配置: {model_name}")

    return StagehandModelConfig(
        model_name=model_name,
        api_key=api_key,
        base_url=base_url,
    )


def get_stagehand_config(
    model_name: Optional[str] = None,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    use_config_manager: bool = True,
    use_env: bool = True,
) -> StagehandModelConfig:
    """
    获取 Stagehand 模型配置 (统一入口)

    配置优先级:
        1. 显式传入的参数 (最高优先级)
        2. ConfigManager 配置 (项目设置界面)
        3. 环境变量
        4. 默认值

    Args:
        model_name: 模型名称 (如 "google/gemini-2.0-flash")
        api_key: API 密钥
        base_url: 自定义 API 基础 URL
        use_config_manager: 是否使用 ConfigManager 配置
        use_env: 是否使用环境变量

    Returns:
        StagehandModelConfig 配置对象

    Usage:
        ```python
        # 自动从配置/环境变量读取
        config = get_stagehand_config()

        # 指定特定配置
        config = get_stagehand_config(
            model_name="anthropic/claude-3-5-sonnet",
            api_key="your-api-key",
        )

        # 仅使用环境变量
        config = get_stagehand_config(use_config_manager=False)
        ```
    """
    # 从各个来源收集配置
    config_mgr_config = None
    env_config = None

    if use_config_manager:
        config_mgr_config = get_config_from_manager()

    if use_env:
        env_config = get_config_from_env()

    # 按优先级合并配置
    final_model_name = model_name
    final_api_key = api_key
    final_base_url = base_url

    # ConfigManager 配置作为第二优先级
    if config_mgr_config:
        if not final_model_name:
            final_model_name = config_mgr_config.model_name
        if not final_api_key:
            final_api_key = config_mgr_config.api_key
        if not final_base_url:
            final_base_url = config_mgr_config.base_url

    # 环境变量作为第三优先级
    if env_config:
        if not final_model_name:
            final_model_name = env_config.model_name
        if not final_api_key:
            final_api_key = env_config.api_key
        if not final_base_url:
            final_base_url = env_config.base_url

    # 默认值
    if not final_model_name:
        final_model_name = DEFAULT_MODEL_NAME

    return StagehandModelConfig(
        model_name=final_model_name,
        api_key=final_api_key,
        base_url=final_base_url,
    )


def get_enabled_providers() -> list:
    """
    获取已启用的 AI 提供商列表

    Returns:
        list: 已配置 API Key 的提供商名称列表 (ConfigManager 格式)
    """
    if not CONFIG_MANAGER_AVAILABLE:
        # 检查环境变量
        if os.getenv("MODEL_API_KEY"):
            return ["env"]
        return []

    try:
        return ConfigManager.get_enabled_ai_providers()
    except Exception:
        return []


def is_config_available() -> bool:
    """
    检查是否有可用的配置

    Returns:
        bool: True 如果有可用的 API Key 配置
    """
    config = get_stagehand_config()
    return config.is_valid


# 便捷导出
__all__ = [
    "StagehandModelConfig",
    "get_stagehand_config",
    "get_config_from_manager",
    "get_config_from_env",
    "get_enabled_providers",
    "is_config_available",
    "CONFIG_MANAGER_AVAILABLE",
    "DEFAULT_MODEL_NAME",
    "DEFAULT_MODELS",
    "PROVIDER_MAP",
]
