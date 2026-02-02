"""
LLM 工厂模块

提供统一的 LLM 实例创建接口
"""

from typing import Optional, Union
from .base import BaseLLM


# 可用提供商列表
AVAILABLE_PROVIDERS = {
    "gemini": {
        "name": "Google Gemini",
        "description": "Google Gemini API (OpenAI 兼容格式)",
        "default_model": "gemini-2.5-flash",
        "models": [
            "gemini-2.5-flash",
            "gemini-2.5-pro",
            "gemini-2.0-flash",
            "gemini-2.5-flash-lite",
        ],
        "env_key": "GEMINI_API_KEY",
        "supports_vision": True,
    },
    "anthropic": {
        "name": "Anthropic Claude",
        "description": "Anthropic Claude API (支持第三方兼容服务)",
        "default_model": "claude-sonnet-4-20250514",
        "models": [
            "claude-sonnet-4-20250514",
            "claude-3-5-sonnet-20241022",
            "claude-3-opus-20240229",
            "claude-3-haiku-20240307",
        ],
        "env_key": "ANTHROPIC_API_KEY",
        "supports_vision": True,
    },
}


def get_available_providers() -> dict:
    """
    获取可用的 LLM 提供商信息

    Returns:
        dict: 提供商信息字典
    """
    return AVAILABLE_PROVIDERS.copy()


def create_llm(
    provider: str = "gemini",
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    model: Optional[str] = None,
    max_tokens: int = 8192,
    timeout: int = 60,
) -> BaseLLM:
    """
    创建 LLM 实例

    工厂函数，根据提供商类型创建对应的 LLM 实例

    Args:
        provider: 提供商类型 (gemini, anthropic)
        api_key: API 密钥（可从环境变量读取）
        base_url: API 基础 URL（可选，用于第三方服务）
        model: 模型名称（可选，使用默认值）
        max_tokens: 最大输出 token 数
        timeout: API 超时时间（秒）

    Returns:
        BaseLLM: LLM 实例

    Raises:
        ValueError: 不支持的提供商类型
        ImportError: 缺少必要的依赖库
    """
    provider = provider.lower().strip()

    if provider == "gemini":
        from .gemini import GeminiLLM
        return GeminiLLM(
            api_key=api_key or "",
            base_url=base_url or "",
            model=model or "",
            max_tokens=max_tokens,
            timeout=timeout,
        )

    elif provider == "anthropic" or provider == "claude":
        from .anthropic import AnthropicLLM
        return AnthropicLLM(
            api_key=api_key or "",
            base_url=base_url or "",
            model=model or "",
            max_tokens=max_tokens,
            timeout=timeout,
        )

    else:
        supported = ", ".join(AVAILABLE_PROVIDERS.keys())
        raise ValueError(
            f"不支持的提供商: {provider}，支持的提供商: {supported}"
        )


def create_llm_from_config(config: dict) -> BaseLLM:
    """
    从配置字典创建 LLM 实例

    Args:
        config: 配置字典，包含以下字段:
            - provider: 提供商类型
            - api_key: API 密钥
            - base_url: API URL (可选)
            - model: 模型名称 (可选)
            - max_tokens: 最大 token 数 (可选)
            - timeout: 超时时间 (可选)

    Returns:
        BaseLLM: LLM 实例
    """
    return create_llm(
        provider=config.get("provider", "gemini"),
        api_key=config.get("api_key"),
        base_url=config.get("base_url"),
        model=config.get("model"),
        max_tokens=config.get("max_tokens", 8192),
        timeout=config.get("timeout", 60),
    )
