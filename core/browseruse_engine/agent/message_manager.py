"""
BrowserUse Engine - 消息历史管理器

管理 LLM 对话历史，支持上下文压缩。
"""

import logging
from typing import List, Optional, Any
from dataclasses import dataclass, field

from ..llm.base import BaseMessage, SystemMessage, UserMessage, AssistantMessage

logger = logging.getLogger(__name__)


class MessageManager:
    """
    消息历史管理器

    负责维护 LLM 对话历史，支持：
    - 消息添加和获取
    - 历史截断
    - 上下文压缩
    """

    def __init__(
        self,
        max_messages: int = 50,
        max_tokens_estimate: int = 100000,
    ):
        """
        初始化消息管理器

        Args:
            max_messages: 最大消息数量
            max_tokens_estimate: 估计的最大 token 数
        """
        self.max_messages = max_messages
        self.max_tokens_estimate = max_tokens_estimate
        self._messages: List[BaseMessage] = []
        self._system_message: Optional[SystemMessage] = None

    def add_system_message(self, content: str) -> None:
        """
        设置系统消息

        系统消息始终位于对话开头。
        """
        self._system_message = SystemMessage(content)

    def add_user_message(
        self,
        content: str,
        image_base64: Optional[str] = None
    ) -> None:
        """
        添加用户消息

        Args:
            content: 消息内容
            image_base64: 图片 base64 编码 (可选)
        """
        if image_base64:
            message = UserMessage.with_image(content, image_base64)
        else:
            message = UserMessage(content)
        self._messages.append(message)
        self._trim_if_needed()

    def add_assistant_message(self, content: str) -> None:
        """添加助手消息"""
        self._messages.append(AssistantMessage(content))
        self._trim_if_needed()

    def get_messages(self) -> List[BaseMessage]:
        """
        获取完整消息列表

        Returns:
            消息列表 (系统消息 + 历史消息)
        """
        messages = []
        if self._system_message:
            messages.append(self._system_message)
        messages.extend(self._messages)
        return messages

    def get_last_n_messages(self, n: int) -> List[BaseMessage]:
        """获取最近 n 条消息"""
        messages = []
        if self._system_message:
            messages.append(self._system_message)
        messages.extend(self._messages[-n:])
        return messages

    def _trim_if_needed(self) -> None:
        """如果超过限制，裁剪消息"""
        if len(self._messages) > self.max_messages:
            # 保留最近的消息
            trim_count = len(self._messages) - self.max_messages
            self._messages = self._messages[trim_count:]
            logger.debug(f"裁剪了 {trim_count} 条消息")

    def clear(self) -> None:
        """清空消息历史 (保留系统消息)"""
        self._messages.clear()

    def compress_history(self, keep_recent: int = 10) -> str:
        """
        压缩历史记录

        将旧消息压缩为摘要，保留最近的消息。

        Args:
            keep_recent: 保留最近的消息数量

        Returns:
            压缩后的摘要
        """
        if len(self._messages) <= keep_recent:
            return ""

        # 提取要压缩的消息
        to_compress = self._messages[:-keep_recent]
        kept = self._messages[-keep_recent:]

        # 生成摘要 (简单版本)
        summary_parts = []
        for msg in to_compress:
            if isinstance(msg, UserMessage):
                content = msg.content if isinstance(msg.content, str) else str(msg.content)
                summary_parts.append(f"User: {content[:100]}...")
            elif isinstance(msg, AssistantMessage):
                content = msg.content if isinstance(msg.content, str) else str(msg.content)
                summary_parts.append(f"Assistant: {content[:100]}...")

        summary = "\n".join(summary_parts[-5:])  # 只保留最后 5 条摘要

        # 更新消息列表
        self._messages = kept

        return summary

    @property
    def message_count(self) -> int:
        """消息数量"""
        return len(self._messages)

    @property
    def has_system_message(self) -> bool:
        """是否有系统消息"""
        return self._system_message is not None

    def estimate_tokens(self) -> int:
        """
        估计当前消息的 token 数

        使用简单的字符数估计 (1 token ≈ 4 字符)
        """
        total_chars = 0
        if self._system_message:
            content = self._system_message.content
            if isinstance(content, str):
                total_chars += len(content)

        for msg in self._messages:
            content = msg.content
            if isinstance(content, str):
                total_chars += len(content)
            elif isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and "text" in item:
                        total_chars += len(item["text"])

        return total_chars // 4
