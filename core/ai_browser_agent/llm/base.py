"""
LLM 基础协议定义

使用 Protocol 实现鸭子类型，无需继承即可支持类型检查
"""

from typing import Protocol, runtime_checkable, Optional
from dataclasses import dataclass


@dataclass
class LLMResponse:
    """LLM 响应数据类"""
    content: str  # 响应文本内容
    model: str  # 使用的模型
    provider: str  # 提供商名称
    input_tokens: int = 0  # 输入 token 数
    output_tokens: int = 0  # 输出 token 数
    finish_reason: str = ""  # 完成原因


@runtime_checkable
class BaseLLM(Protocol):
    """
    LLM 统一接口协议

    所有 LLM 实现必须遵循此协议，提供统一的调用方式
    """

    model: str

    @property
    def provider(self) -> str:
        """
        返回提供商名称

        Returns:
            str: 提供商标识符 (gemini, anthropic, openai)
        """
        ...

    async def analyze_screenshot(
        self,
        screenshot: bytes,
        prompt: str,
        system_prompt: str,
        max_tokens: int = 8192,
    ) -> LLMResponse:
        """
        分析截图并返回响应

        Args:
            screenshot: PNG/JPEG 格式的截图数据
            prompt: 用户提示词
            system_prompt: 系统提示词
            max_tokens: 最大输出 token 数

        Returns:
            LLMResponse: 包含响应内容和元数据
        """
        ...

    def test_connection(self) -> tuple[bool, str, dict]:
        """
        测试 API 连接

        Returns:
            (success: bool, message: str, details: dict)
            - success: 连接是否成功
            - message: 用户友好的消息
            - details: 详细信息 (model, response_time, error_type 等)
        """
        ...

    def detect_image_mime(self, image_data: bytes) -> str:
        """
        检测图片的 MIME 类型

        Args:
            image_data: 图片二进制数据

        Returns:
            MIME 类型字符串 (image/png 或 image/jpeg)
        """
        ...


def detect_image_mime(image_data: bytes) -> str:
    """
    检测图片的 MIME 类型（通用实现）

    通过检查文件头魔数确定图片格式

    Args:
        image_data: 图片二进制数据

    Returns:
        MIME 类型字符串 (image/png 或 image/jpeg)
    """
    if len(image_data) < 8:
        return "image/png"  # 默认

    # PNG: 89 50 4E 47 0D 0A 1A 0A
    if image_data[:8] == b'\x89PNG\r\n\x1a\n':
        return "image/png"

    # JPEG: FF D8 FF
    if image_data[:3] == b'\xff\xd8\xff':
        return "image/jpeg"

    # 默认返回 PNG
    return "image/png"
