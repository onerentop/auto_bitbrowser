"""
Gemini LLM 实现

使用 OpenAI 兼容格式调用 Google Gemini API
"""

import os
import time
import base64
from typing import Optional
from dataclasses import dataclass, field

try:
    from openai import OpenAI, APIError, APIConnectionError, RateLimitError, AuthenticationError
    OPENAI_AVAILABLE = True
except ImportError:
    OpenAI = None
    APIError = None
    APIConnectionError = None
    RateLimitError = None
    AuthenticationError = None
    OPENAI_AVAILABLE = False

from .base import LLMResponse, detect_image_mime


@dataclass
class GeminiLLM:
    """
    Gemini LLM 实现

    使用 OpenAI 兼容的 API 格式调用 Google Gemini API
    """

    # Gemini OpenAI 兼容 API 地址
    DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
    DEFAULT_MODEL = "gemini-2.5-flash"

    api_key: str = ""
    base_url: str = ""
    model: str = ""
    max_tokens: int = 8192
    timeout: int = 60

    # 内部客户端
    _client: Optional[OpenAI] = field(default=None, repr=False)

    def __post_init__(self):
        """初始化后处理"""
        if not OPENAI_AVAILABLE:
            raise ImportError("请安装 openai 库: pip install openai")

        # 从环境变量读取 API Key
        if not self.api_key:
            self.api_key = os.environ.get("GEMINI_API_KEY", "")

        if not self.api_key:
            raise ValueError(
                "未提供 API Key，请设置 GEMINI_API_KEY 环境变量或传入 api_key 参数"
            )

        # 设置默认值
        if not self.base_url:
            self.base_url = os.environ.get("GEMINI_BASE_URL", "") or self.DEFAULT_BASE_URL

        if not self.model:
            self.model = self.DEFAULT_MODEL

        # 创建客户端
        self._client = OpenAI(
            api_key=self.api_key,
            base_url=self.base_url,
            timeout=self.timeout,
        )
        print(f"[GeminiLLM] 使用 API: {self.base_url} (timeout={self.timeout}s)")

    @property
    def provider(self) -> str:
        """返回提供商名称"""
        return "gemini"

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

        Args:
            image_base64: base64 编码的图片
            prompt: 用户提示词
            system_prompt: 系统提示词
            image_mime: 图片 MIME 类型
            max_tokens: 最大输出 token 数

        Returns:
            LLMResponse: 响应数据
        """
        response = self._client.chat.completions.create(
            model=self.model,
            max_tokens=max_tokens,
            messages=[
                {
                    "role": "system",
                    "content": system_prompt,
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{image_mime};base64,{image_base64}",
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

        if response.choices:
            choice = response.choices[0]
            content = choice.message.content or ""
            finish_reason = choice.finish_reason or ""

            print(f"[GeminiLLM] API 响应 - finish_reason: {finish_reason}")
            print(f"[GeminiLLM] API 响应 - content 长度: {len(content)}")

        if hasattr(response, 'usage') and response.usage:
            input_tokens = response.usage.prompt_tokens or 0
            output_tokens = response.usage.completion_tokens or 0
            print(f"[GeminiLLM] API 响应 - tokens: input={input_tokens}, output={output_tokens}")

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
            "base_url": self.base_url,
            "provider": self.provider,
            "response_time_ms": 0,
        }

        try:
            start_time = time.time()

            # 发送简单消息测试
            response = self._client.chat.completions.create(
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

            if response and response.choices:
                response_text = response.choices[0].message.content or ""
                details["response_preview"] = response_text[:100] if response_text else "(无内容)"

                if hasattr(response, 'usage') and response.usage:
                    details["usage"] = {
                        "input_tokens": getattr(response.usage, 'prompt_tokens', 0),
                        "output_tokens": getattr(response.usage, 'completion_tokens', 0),
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
