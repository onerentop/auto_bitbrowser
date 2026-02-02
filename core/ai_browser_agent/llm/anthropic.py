"""
Anthropic (Claude) LLM 实现

使用 Anthropic 原生 API，支持官方和第三方兼容服务
"""

import os
import time
import base64
from typing import Optional
from dataclasses import dataclass, field

try:
    import anthropic
    from anthropic import APIError, APIConnectionError, RateLimitError, AuthenticationError
    ANTHROPIC_AVAILABLE = True
except ImportError:
    anthropic = None
    APIError = None
    APIConnectionError = None
    RateLimitError = None
    AuthenticationError = None
    ANTHROPIC_AVAILABLE = False

from .base import LLMResponse, detect_image_mime


@dataclass
class AnthropicLLM:
    """
    Anthropic (Claude) LLM 实现

    使用 Anthropic 原生 API，支持:
    - 官方 Anthropic API
    - 第三方兼容服务 (通过 base_url 配置)

    常见第三方服务:
    - OpenRouter: https://openrouter.ai/api/v1
    - AWS Bedrock: 需要特殊配置
    - Azure: 需要特殊配置
    """

    DEFAULT_MODEL = "claude-sonnet-4-20250514"

    api_key: str = ""
    base_url: str = ""  # 留空使用官方 API
    model: str = ""
    max_tokens: int = 8192
    timeout: int = 60

    # 内部客户端
    _client: Optional["anthropic.Anthropic"] = field(default=None, repr=False)

    def __post_init__(self):
        """初始化后处理"""
        if not ANTHROPIC_AVAILABLE:
            raise ImportError("请安装 anthropic 库: pip install anthropic")

        # 从环境变量读取 API Key
        if not self.api_key:
            self.api_key = os.environ.get("ANTHROPIC_API_KEY", "")

        if not self.api_key:
            raise ValueError(
                "未提供 API Key，请设置 ANTHROPIC_API_KEY 环境变量或传入 api_key 参数"
            )

        # 设置默认模型
        if not self.model:
            self.model = self.DEFAULT_MODEL

        # 创建客户端
        client_kwargs = {
            "api_key": self.api_key,
            "timeout": self.timeout,
        }

        # 如果指定了 base_url，使用第三方服务
        if self.base_url:
            client_kwargs["base_url"] = self.base_url
            print(f"[AnthropicLLM] 使用第三方 API: {self.base_url}")
        else:
            print(f"[AnthropicLLM] 使用官方 Anthropic API")

        self._client = anthropic.Anthropic(**client_kwargs)
        print(f"[AnthropicLLM] 模型: {self.model}, 超时: {self.timeout}s")

    @property
    def provider(self) -> str:
        """返回提供商名称"""
        return "anthropic"

    def detect_image_mime(self, image_data: bytes) -> str:
        """检测图片 MIME 类型"""
        return detect_image_mime(image_data)

    async def analyze_screenshot(
        self,
        screenshot: bytes,
        prompt: str,
        system_prompt: str,
        max_tokens: int = None,
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
        import asyncio

        # 编码图片
        image_base64 = base64.standard_b64encode(screenshot).decode("utf-8")
        image_mime = self.detect_image_mime(screenshot)

        max_tokens = max_tokens or self.max_tokens

        # 在线程池中执行同步调用
        response = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: self._call_api(image_base64, prompt, system_prompt, image_mime, max_tokens),
        )

        return response

    def _call_api(
        self,
        image_base64: str,
        prompt: str,
        system_prompt: str,
        image_mime: str,
        max_tokens: int,
    ) -> LLMResponse:
        """
        调用 Vision API（同步方法）

        Anthropic Vision API 格式:
        - 图片使用 source.type = "base64"
        - 支持 image/png, image/jpeg, image/gif, image/webp

        Args:
            image_base64: base64 编码的图片
            prompt: 用户提示词
            system_prompt: 系统提示词
            image_mime: 图片 MIME 类型
            max_tokens: 最大输出 token 数

        Returns:
            LLMResponse: 响应数据
        """
        response = self._client.messages.create(
            model=self.model,
            max_tokens=max_tokens,
            system=system_prompt,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": image_mime,
                                "data": image_base64,
                            },
                        },
                        {
                            "type": "text",
                            "text": prompt,
                        },
                    ],
                }
            ],
        )

        # 提取响应
        content = ""
        input_tokens = 0
        output_tokens = 0
        finish_reason = ""

        if response.content:
            # Anthropic 响应是 ContentBlock 列表
            text_blocks = [block.text for block in response.content if hasattr(block, 'text')]
            content = "".join(text_blocks)
            finish_reason = response.stop_reason or ""

            print(f"[AnthropicLLM] API 响应 - stop_reason: {finish_reason}")
            print(f"[AnthropicLLM] API 响应 - content 长度: {len(content)}")

        if hasattr(response, 'usage') and response.usage:
            input_tokens = response.usage.input_tokens or 0
            output_tokens = response.usage.output_tokens or 0
            print(f"[AnthropicLLM] API 响应 - tokens: input={input_tokens}, output={output_tokens}")

        return LLMResponse(
            content=content,
            model=self.model,
            provider=self.provider,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            finish_reason=finish_reason,
        )

    def test_connection(self) -> tuple[bool, str, dict]:
        """
        测试 API 连接是否正常

        Returns:
            (success: bool, message: str, details: dict)
        """
        details = {
            "model": self.model,
            "base_url": self.base_url or "https://api.anthropic.com",
            "provider": self.provider,
            "response_time_ms": 0,
        }

        try:
            start_time = time.time()

            # 发送简单消息测试
            response = self._client.messages.create(
                model=self.model,
                max_tokens=1024,
                messages=[
                    {
                        "role": "user",
                        "content": "Hello, respond in one sentence.",
                    }
                ],
            )

            elapsed_ms = int((time.time() - start_time) * 1000)
            details["response_time_ms"] = elapsed_ms

            if response and response.content:
                text_blocks = [block.text for block in response.content if hasattr(block, 'text')]
                response_text = "".join(text_blocks)
                details["response_preview"] = response_text[:100] if response_text else "(无内容)"

                if hasattr(response, 'usage') and response.usage:
                    details["usage"] = {
                        "input_tokens": response.usage.input_tokens or 0,
                        "output_tokens": response.usage.output_tokens or 0,
                    }

                return True, f"连接成功 ({elapsed_ms}ms)", details
            else:
                return False, "连接成功但响应为空", details

        except AuthenticationError as e:
            details["error_type"] = "authentication"
            details["error_detail"] = str(e)
            return False, "认证失败: API Key 无效", details

        except RateLimitError as e:
            details["error_type"] = "rate_limit"
            details["error_detail"] = str(e)
            return False, "速率限制: 请求过于频繁", details

        except APIConnectionError as e:
            details["error_type"] = "connection"
            details["error_detail"] = str(e)
            return False, "连接失败: 无法连接到 API 服务器", details

        except APIError as e:
            details["error_type"] = "api_error"
            details["error_detail"] = str(e)
            if "model" in str(e).lower():
                return False, f"模型不可用: {self.model}", details
            return False, f"API 错误: {str(e)[:100]}", details

        except Exception as e:
            details["error_type"] = "unknown"
            details["error_detail"] = str(e)
            return False, f"未知错误: {str(e)[:100]}", details


# 常见第三方 Claude API 服务配置参考
THIRD_PARTY_PROVIDERS = {
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "models": [
            "anthropic/claude-sonnet-4",
            "anthropic/claude-3.5-sonnet",
            "anthropic/claude-3-opus",
        ],
        "note": "需要 OpenRouter API Key",
    },
    "together": {
        "base_url": "https://api.together.xyz/v1",
        "models": [
            "anthropic/claude-3-sonnet",
        ],
        "note": "需要 Together API Key",
    },
}
