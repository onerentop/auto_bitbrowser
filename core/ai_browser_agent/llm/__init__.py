"""
LLM 抽象层模块

提供统一的 LLM 接口，支持多个 AI 服务商:
- Gemini (Google) - 使用 OpenAI 兼容格式
- Anthropic (Claude) - 原生 API，支持第三方兼容服务
"""

from .base import BaseLLM, LLMResponse
from .gemini import GeminiLLM
from .anthropic import AnthropicLLM
from .factory import create_llm, create_llm_from_config, get_available_providers

__all__ = [
    # Protocol
    "BaseLLM",
    "LLMResponse",
    # Implementations
    "GeminiLLM",
    "AnthropicLLM",
    # Factory
    "create_llm",
    "create_llm_from_config",
    "get_available_providers",
]
