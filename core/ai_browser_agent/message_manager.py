"""
消息管理器模块

管理 LLM 对话历史、状态消息生成、敏感数据脱敏
参考 browser-use 的 MessageManager 设计
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, List, Dict, Any
import json
import re
import base64


@dataclass
class Message:
    """对话消息"""
    role: str  # "system", "user", "assistant"
    content: str
    images: List[bytes] = field(default_factory=list)
    timestamp: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict:
        """转换为字典（不含图片）"""
        return {
            "role": self.role,
            "content": self.content,
            "timestamp": self.timestamp.isoformat(),
            "has_images": len(self.images) > 0,
        }

    def to_api_format(self) -> dict:
        """转换为 API 格式（含图片）"""
        if not self.images:
            return {
                "role": self.role,
                "content": self.content,
            }

        # 带图片的消息格式
        content_parts = []
        for img in self.images:
            content_parts.append({
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/png;base64,{base64.b64encode(img).decode()}"
                }
            })
        content_parts.append({
            "type": "text",
            "text": self.content,
        })

        return {
            "role": self.role,
            "content": content_parts,
        }


class MessageManager:
    """
    对话历史管理器

    功能：
    - 管理系统/用户/助手消息
    - 支持图片消息
    - 状态消息生成
    - 敏感数据脱敏
    - 对话导出
    """

    def __init__(
        self,
        max_history: int = 20,
        system_prompt: str = "",
        mask_sensitive: bool = True,
    ):
        """
        初始化消息管理器

        Args:
            max_history: 保留的最大历史消息数
            system_prompt: 系统提示词
            mask_sensitive: 是否脱敏敏感信息
        """
        self.max_history = max_history
        self.system_prompt = system_prompt
        self.mask_sensitive = mask_sensitive

        self._messages: List[Message] = []
        self._sensitive_patterns: List[re.Pattern] = []
        self._sensitive_values: Dict[str, str] = {}

        # 初始化系统消息
        if system_prompt:
            self.add_system_message(system_prompt)

    # ============ 消息管理 ============

    def add_system_message(self, content: str):
        """添加系统消息"""
        self._messages.append(Message(role="system", content=content))
        self._trim_history()

    def add_user_message(self, content: str, images: List[bytes] = None):
        """添加用户消息（可含截图）"""
        masked_content = self._mask_sensitive(content) if self.mask_sensitive else content
        self._messages.append(Message(
            role="user",
            content=masked_content,
            images=images or [],
        ))
        self._trim_history()

    def add_assistant_message(self, content: str):
        """添加助手消息"""
        self._messages.append(Message(role="assistant", content=content))
        self._trim_history()

    def add_state_message(
        self,
        current_url: str,
        elements_summary: str,
        step_info: str = "",
        extra_context: str = "",
    ):
        """
        添加状态消息

        生成格式化的当前状态描述供 AI 分析
        """
        parts = []

        if step_info:
            parts.append(f"【步骤信息】\n{step_info}")

        parts.append(f"【当前页面】\n{current_url}")

        if elements_summary:
            parts.append(f"【页面元素】\n{elements_summary}")

        if extra_context:
            parts.append(f"【额外上下文】\n{extra_context}")

        content = "\n\n".join(parts)
        self.add_user_message(content)

    def _trim_history(self):
        """裁剪历史消息，保留系统消息和最近的消息"""
        if len(self._messages) <= self.max_history:
            return

        # 保留系统消息
        system_messages = [m for m in self._messages if m.role == "system"]
        other_messages = [m for m in self._messages if m.role != "system"]

        # 保留最近的消息
        keep_count = self.max_history - len(system_messages)
        recent_messages = other_messages[-keep_count:] if keep_count > 0 else []

        self._messages = system_messages + recent_messages

    # ============ 敏感数据处理 ============

    def register_sensitive_value(self, key: str, value: str):
        """注册敏感值（用于脱敏）"""
        if value:
            self._sensitive_values[value] = f"<{key}>"

    def register_sensitive_pattern(self, pattern: str):
        """注册敏感模式（正则表达式）"""
        self._sensitive_patterns.append(re.compile(pattern))

    def _mask_sensitive(self, content: str) -> str:
        """脱敏敏感信息"""
        masked = content

        # 替换注册的敏感值
        for value, placeholder in self._sensitive_values.items():
            masked = masked.replace(value, placeholder)

        # 替换匹配的模式
        for pattern in self._sensitive_patterns:
            masked = pattern.sub("<MASKED>", masked)

        return masked

    # ============ 获取消息 ============

    def get_messages(self) -> List[Message]:
        """获取所有消息"""
        return self._messages.copy()

    def get_api_messages(self) -> List[dict]:
        """获取 API 格式的消息列表"""
        return [m.to_api_format() for m in self._messages]

    def get_last_n_messages(self, n: int) -> List[Message]:
        """获取最近 N 条消息"""
        return self._messages[-n:] if n > 0 else []

    def get_context_window(self, max_tokens: int = 4000) -> List[Message]:
        """
        获取适合上下文窗口的消息

        简单估算：每个字符约 0.5 token
        """
        messages = []
        total_chars = 0
        max_chars = max_tokens * 2

        # 始终包含系统消息
        for m in self._messages:
            if m.role == "system":
                messages.append(m)
                total_chars += len(m.content)

        # 从最近开始添加其他消息
        for m in reversed(self._messages):
            if m.role == "system":
                continue
            msg_chars = len(m.content)
            if total_chars + msg_chars > max_chars:
                break
            messages.insert(-1 if messages else 0, m)
            total_chars += msg_chars

        return messages

    # ============ 清理和导出 ============

    def clear(self):
        """清空所有消息"""
        self._messages = []
        if self.system_prompt:
            self.add_system_message(self.system_prompt)

    def clear_except_system(self):
        """清空非系统消息"""
        self._messages = [m for m in self._messages if m.role == "system"]

    def save_conversation(self, filepath: str, include_images: bool = False):
        """
        保存对话到文件

        Args:
            filepath: 保存路径
            include_images: 是否包含图片（Base64 编码）
        """
        data = {
            "saved_at": datetime.now().isoformat(),
            "message_count": len(self._messages),
            "messages": [],
        }

        for m in self._messages:
            msg_data = m.to_dict()
            if include_images and m.images:
                msg_data["images"] = [
                    base64.b64encode(img).decode() for img in m.images
                ]
            data["messages"].append(msg_data)

        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def load_conversation(self, filepath: str):
        """从文件加载对话"""
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)

        self._messages = []
        for msg_data in data.get("messages", []):
            images = []
            if "images" in msg_data:
                images = [base64.b64decode(img) for img in msg_data["images"]]

            self._messages.append(Message(
                role=msg_data["role"],
                content=msg_data["content"],
                images=images,
                timestamp=datetime.fromisoformat(msg_data["timestamp"]),
            ))

    # ============ 状态消息生成 ============

    def create_state_message(
        self,
        goal: str,
        current_url: str,
        step_number: int,
        max_steps: int,
        elements_summary: str = "",
        history_summary: str = "",
        account_info: dict = None,
        params: dict = None,
    ) -> str:
        """
        创建状态消息

        用于每个步骤开始时向 AI 传递当前状态
        """
        parts = []

        # 任务目标
        parts.append(f"【任务目标】\n{goal}")

        # 步骤信息
        parts.append(f"【当前进度】\n步骤 {step_number + 1}/{max_steps}")

        # 当前页面
        parts.append(f"【当前页面】\n{current_url}")

        # 账号信息（脱敏）
        if account_info:
            account_display = []
            if account_info.get("email"):
                account_display.append(f"邮箱: {account_info['email']}")
            if account_info.get("password"):
                account_display.append("密码: <已提供>")
            if account_info.get("secret"):
                account_display.append("2FA密钥: <已提供>")
            if account_display:
                parts.append(f"【账号信息】\n" + "\n".join(account_display))

        # 额外参数
        if params:
            params_display = [f"{k}: {v}" for k, v in params.items()]
            parts.append(f"【任务参数】\n" + "\n".join(params_display))

        # 页面元素
        if elements_summary:
            parts.append(f"【可交互元素】\n{elements_summary}")

        # 历史操作
        if history_summary:
            parts.append(f"【最近操作】\n{history_summary}")

        return "\n\n".join(parts)

    # ============ 统计信息 ============

    @property
    def message_count(self) -> int:
        """消息总数"""
        return len(self._messages)

    @property
    def user_message_count(self) -> int:
        """用户消息数"""
        return sum(1 for m in self._messages if m.role == "user")

    @property
    def assistant_message_count(self) -> int:
        """助手消息数"""
        return sum(1 for m in self._messages if m.role == "assistant")

    def get_statistics(self) -> dict:
        """获取统计信息"""
        total_chars = sum(len(m.content) for m in self._messages)
        total_images = sum(len(m.images) for m in self._messages)

        return {
            "total_messages": self.message_count,
            "user_messages": self.user_message_count,
            "assistant_messages": self.assistant_message_count,
            "system_messages": sum(1 for m in self._messages if m.role == "system"),
            "total_characters": total_chars,
            "total_images": total_images,
            "estimated_tokens": total_chars // 2,  # 粗略估算
        }
