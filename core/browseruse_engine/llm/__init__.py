"""
BrowserUse Engine - LLM 模块

提供多 LLM 提供商支持。
"""

from .base import (
    BaseChatModel,
    BaseMessage,
    SystemMessage,
    UserMessage,
    AssistantMessage,
    ChatCompletion,
)
from .adapters import (
    OpenAIAdapter,
    AnthropicAdapter,
    GoogleAdapter,
    create_llm_adapter,
    create_llm_from_config,
)

__all__ = [
    # 协议和消息类型
    "BaseChatModel",
    "BaseMessage",
    "SystemMessage",
    "UserMessage",
    "AssistantMessage",
    "ChatCompletion",
    # 适配器
    "OpenAIAdapter",
    "AnthropicAdapter",
    "GoogleAdapter",
    # 工厂函数
    "create_llm_adapter",
    "create_llm_from_config",
]
