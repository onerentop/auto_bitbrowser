"""
BrowserUse Engine - LLM 基础协议

定义 BaseChatModel 协议，所有 LLM 适配器都应实现此协议。
"""

from typing import Protocol, Optional, Any, List, Dict, Type, TypeVar, Union, runtime_checkable
from dataclasses import dataclass, field
from abc import abstractmethod

T = TypeVar('T')


# ==================== 消息类型 ====================

@dataclass
class BaseMessage:
    """消息基类"""
    role: str
    content: Union[str, List[Dict[str, Any]]]

    def to_dict(self) -> Dict[str, Any]:
        return {"role": self.role, "content": self.content}


@dataclass
class SystemMessage(BaseMessage):
    """系统消息"""
    role: str = field(default="system", init=False)

    def __init__(self, content: str):
        self.content = content
        self.role = "system"


@dataclass
class UserMessage(BaseMessage):
    """用户消息"""
    role: str = field(default="user", init=False)

    def __init__(self, content: Union[str, List[Dict[str, Any]]]):
        self.content = content
        self.role = "user"

    @classmethod
    def with_image(cls, text: str, image_base64: str) -> "UserMessage":
        """创建包含图片的用户消息"""
        content = [
            {"type": "text", "text": text},
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{image_base64}"}
            }
        ]
        return cls(content=content)


@dataclass
class AssistantMessage(BaseMessage):
    """助手消息"""
    role: str = field(default="assistant", init=False)

    def __init__(self, content: str):
        self.content = content
        self.role = "assistant"


# ==================== 响应类型 ====================

@dataclass
class ChatCompletion:
    """聊天完成响应"""
    content: str
    parsed: Optional[Any] = None  # 解析后的结构化对象
    model: str = ""
    usage: Dict[str, int] = field(default_factory=dict)
    finish_reason: str = ""


# ==================== LLM 协议 ====================

@runtime_checkable
class BaseChatModel(Protocol):
    """
    LLM 聊天模型协议

    所有 LLM 适配器都应实现此协议。
    """

    model: str

    async def ainvoke(
        self,
        messages: List[BaseMessage],
        response_format: Optional[Type[T]] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> ChatCompletion:
        """
        异步调用 LLM

        Args:
            messages: 消息列表
            response_format: 响应格式 (Pydantic 模型)
            temperature: 温度参数
            max_tokens: 最大 token 数

        Returns:
            ChatCompletion
        """
        ...

    def invoke(
        self,
        messages: List[BaseMessage],
        response_format: Optional[Type[T]] = None,
    ) -> ChatCompletion:
        """同步调用 LLM"""
        ...
