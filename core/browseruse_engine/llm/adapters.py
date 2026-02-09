"""
BrowserUse Engine - LLM 适配器

提供 OpenAI、Anthropic、Google 等 LLM 提供商的适配器实现。
"""

import asyncio
import json
import logging
import os
from typing import Optional, List, Dict, Any, Type, TypeVar

from .base import BaseChatModel, BaseMessage, ChatCompletion, SystemMessage, UserMessage

logger = logging.getLogger(__name__)

T = TypeVar('T')


# ==================== OpenAI 适配器 ====================

class OpenAIAdapter:
    """
    OpenAI API 适配器

    支持 OpenAI API 及兼容接口 (如 Azure OpenAI, 第三方代理等)。
    """

    def __init__(
        self,
        model: str = "gpt-4o",
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: int = 4096,
    ):
        self.model = model
        self.api_key = api_key or os.getenv("OPENAI_API_KEY", "")
        self.base_url = base_url
        self.temperature = temperature
        self.max_tokens = max_tokens
        self._client = None

    def _get_client(self):
        """获取或创建 OpenAI 客户端"""
        if self._client is None:
            try:
                from openai import AsyncOpenAI
                kwargs = {"api_key": self.api_key}
                if self.base_url:
                    kwargs["base_url"] = self.base_url
                self._client = AsyncOpenAI(**kwargs)
            except ImportError:
                raise ImportError("请安装 openai: pip install openai")
        return self._client

    async def ainvoke(
        self,
        messages: List[BaseMessage],
        response_format: Optional[Type[T]] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> ChatCompletion:
        """异步调用 OpenAI API"""
        client = self._get_client()

        # 转换消息格式
        api_messages = [msg.to_dict() for msg in messages]

        # 构建请求参数
        kwargs: Dict[str, Any] = {
            "model": self.model,
            "messages": api_messages,
            "temperature": temperature if temperature is not None else self.temperature,
            "max_tokens": max_tokens or self.max_tokens,
        }

        # 如果有 response_format，使用结构化输出
        if response_format is not None:
            try:
                # 使用 parse 方法进行结构化输出
                response = await client.beta.chat.completions.parse(
                    **kwargs,
                    response_format=response_format,
                )
                message = response.choices[0].message

                return ChatCompletion(
                    content=message.content or "",
                    parsed=message.parsed,
                    model=response.model,
                    usage={
                        "prompt_tokens": response.usage.prompt_tokens if response.usage else 0,
                        "completion_tokens": response.usage.completion_tokens if response.usage else 0,
                        "total_tokens": response.usage.total_tokens if response.usage else 0,
                    },
                    finish_reason=response.choices[0].finish_reason or "",
                )
            except Exception as e:
                logger.warning(f"结构化输出失败，尝试普通调用: {e}")
                # 回退到普通调用 + JSON 解析
                kwargs["response_format"] = {"type": "json_object"}

        # 普通调用
        response = await client.chat.completions.create(**kwargs)
        content = response.choices[0].message.content or ""

        # 尝试解析 JSON
        parsed = None
        if response_format is not None and content:
            try:
                data = json.loads(content)
                parsed = response_format(**data)
            except Exception as e:
                logger.warning(f"JSON 解析失败: {e}")

        return ChatCompletion(
            content=content,
            parsed=parsed,
            model=response.model,
            usage={
                "prompt_tokens": response.usage.prompt_tokens if response.usage else 0,
                "completion_tokens": response.usage.completion_tokens if response.usage else 0,
                "total_tokens": response.usage.total_tokens if response.usage else 0,
            },
            finish_reason=response.choices[0].finish_reason or "",
        )

    def invoke(
        self,
        messages: List[BaseMessage],
        response_format: Optional[Type[T]] = None,
    ) -> ChatCompletion:
        """同步调用"""
        return asyncio.run(self.ainvoke(messages, response_format))


# ==================== Anthropic 适配器 ====================

class AnthropicAdapter:
    """
    Anthropic Claude API 适配器
    """

    def __init__(
        self,
        model: str = "claude-sonnet-4-20250514",
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: int = 4096,
    ):
        self.model = model
        self.api_key = api_key or os.getenv("ANTHROPIC_API_KEY", "")
        self.base_url = base_url
        self.temperature = temperature
        self.max_tokens = max_tokens
        self._client = None

    def _get_client(self):
        """获取或创建 Anthropic 客户端"""
        if self._client is None:
            try:
                from anthropic import AsyncAnthropic
                kwargs = {"api_key": self.api_key}
                if self.base_url:
                    kwargs["base_url"] = self.base_url
                self._client = AsyncAnthropic(**kwargs)
            except ImportError:
                raise ImportError("请安装 anthropic: pip install anthropic")
        return self._client

    async def ainvoke(
        self,
        messages: List[BaseMessage],
        response_format: Optional[Type[T]] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> ChatCompletion:
        """异步调用 Anthropic API"""
        client = self._get_client()

        # 分离系统消息和其他消息
        system_content = ""
        api_messages = []
        for msg in messages:
            if isinstance(msg, SystemMessage):
                system_content = msg.content if isinstance(msg.content, str) else str(msg.content)
            else:
                api_messages.append(msg.to_dict())

        # 构建请求参数
        kwargs: Dict[str, Any] = {
            "model": self.model,
            "messages": api_messages,
            "temperature": temperature if temperature is not None else self.temperature,
            "max_tokens": max_tokens or self.max_tokens,
        }
        if system_content:
            kwargs["system"] = system_content

        # 调用 API
        response = await client.messages.create(**kwargs)
        content = response.content[0].text if response.content else ""

        # 尝试解析 JSON
        parsed = None
        if response_format is not None and content:
            try:
                # 尝试从内容中提取 JSON
                json_str = content
                if "```json" in content:
                    json_str = content.split("```json")[1].split("```")[0].strip()
                elif "```" in content:
                    json_str = content.split("```")[1].split("```")[0].strip()

                data = json.loads(json_str)
                parsed = response_format(**data)
            except Exception as e:
                logger.warning(f"JSON 解析失败: {e}")

        return ChatCompletion(
            content=content,
            parsed=parsed,
            model=response.model,
            usage={
                "prompt_tokens": response.usage.input_tokens if response.usage else 0,
                "completion_tokens": response.usage.output_tokens if response.usage else 0,
                "total_tokens": (response.usage.input_tokens + response.usage.output_tokens) if response.usage else 0,
            },
            finish_reason=response.stop_reason or "",
        )

    def invoke(
        self,
        messages: List[BaseMessage],
        response_format: Optional[Type[T]] = None,
    ) -> ChatCompletion:
        """同步调用"""
        return asyncio.run(self.ainvoke(messages, response_format))


# ==================== Google Gemini 适配器 ====================

class GoogleAdapter:
    """
    Google Gemini API 适配器
    """

    def __init__(
        self,
        model: str = "gemini-2.0-flash",
        api_key: Optional[str] = None,
        temperature: float = 0.0,
        max_tokens: int = 4096,
    ):
        self.model = model
        self.api_key = api_key or os.getenv("GOOGLE_API_KEY", "") or os.getenv("GEMINI_API_KEY", "")
        self.temperature = temperature
        self.max_tokens = max_tokens
        self._client = None

    def _get_client(self):
        """获取或创建 Google 客户端"""
        if self._client is None:
            try:
                import google.generativeai as genai
                genai.configure(api_key=self.api_key)
                self._client = genai.GenerativeModel(self.model)
            except ImportError:
                raise ImportError("请安装 google-generativeai: pip install google-generativeai")
        return self._client

    async def ainvoke(
        self,
        messages: List[BaseMessage],
        response_format: Optional[Type[T]] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
    ) -> ChatCompletion:
        """异步调用 Google Gemini API"""
        client = self._get_client()

        # 转换消息格式
        history = []
        system_instruction = ""

        for msg in messages:
            if isinstance(msg, SystemMessage):
                system_instruction = msg.content if isinstance(msg.content, str) else str(msg.content)
            elif msg.role == "user":
                content = msg.content
                if isinstance(content, list):
                    # 处理多模态内容
                    parts = []
                    for item in content:
                        if item.get("type") == "text":
                            parts.append(item["text"])
                        elif item.get("type") == "image_url":
                            # Gemini 需要不同的图片格式处理
                            parts.append(item["image_url"]["url"])
                    content = "\n".join(parts) if parts else ""
                history.append({"role": "user", "parts": [content]})
            elif msg.role == "assistant":
                content = msg.content if isinstance(msg.content, str) else str(msg.content)
                history.append({"role": "model", "parts": [content]})

        # 生成配置
        generation_config = {
            "temperature": temperature if temperature is not None else self.temperature,
            "max_output_tokens": max_tokens or self.max_tokens,
        }
        if response_format is not None:
            generation_config["response_mime_type"] = "application/json"

        # 如果有系统指令，重新创建模型
        if system_instruction:
            import google.generativeai as genai
            client = genai.GenerativeModel(
                self.model,
                system_instruction=system_instruction
            )

        # 异步调用
        response = await asyncio.to_thread(
            lambda: client.generate_content(
                history,
                generation_config=generation_config
            )
        )

        content = response.text if response.text else ""

        # 尝试解析 JSON
        parsed = None
        if response_format is not None and content:
            try:
                data = json.loads(content)
                parsed = response_format(**data)
            except Exception as e:
                logger.warning(f"JSON 解析失败: {e}")

        return ChatCompletion(
            content=content,
            parsed=parsed,
            model=self.model,
            usage={},
            finish_reason="stop",
        )

    def invoke(
        self,
        messages: List[BaseMessage],
        response_format: Optional[Type[T]] = None,
    ) -> ChatCompletion:
        """同步调用"""
        return asyncio.run(self.ainvoke(messages, response_format))


# ==================== 工厂函数 ====================

def create_llm_adapter(
    provider: Optional[str] = None,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
    base_url: Optional[str] = None,
    temperature: float = 0.0,
    max_tokens: int = 4096,
    *,
    model_name: Optional[str] = None,  # 兼容旧参数
) -> BaseChatModel:
    """
    创建 LLM 适配器

    支持两种调用方式:
    1. create_llm_adapter(provider="openai", model="gpt-4o", api_key="...")
    2. create_llm_adapter(model_name="openai/gpt-4o", api_key="...")

    Args:
        provider: LLM 提供商 ("openai", "anthropic", "google")
        api_key: API 密钥
        model: 模型名称 (如 "gpt-4o")
        base_url: API 基础 URL (可选)
        temperature: 温度参数
        max_tokens: 最大 token 数
        model_name: 完整模型名称 (格式: "provider/model")，用于兼容

    Returns:
        BaseChatModel 实现

    Raises:
        ValueError: 如果 provider 无效
    """
    # 兼容 model_name 参数
    if model_name and "/" in model_name:
        parts = model_name.split("/", 1)
        provider = provider or parts[0].lower()
        model = model or parts[1]
    elif model_name:
        model = model or model_name

    # 默认值
    provider = (provider or "openai").lower()

    # 默认模型
    default_models = {
        "openai": "gpt-4o",
        "anthropic": "claude-sonnet-4-20250514",
        "google": "gemini-2.0-flash",
    }
    model = model or default_models.get(provider, "gpt-4o")

    # 根据 provider 创建适配器
    if provider == "anthropic":
        return AnthropicAdapter(
            model=model,
            api_key=api_key,
            base_url=base_url,
            temperature=temperature,
            max_tokens=max_tokens,
        )
    elif provider == "google":
        return GoogleAdapter(
            model=model,
            api_key=api_key,
            temperature=temperature,
            max_tokens=max_tokens,
        )
    elif provider in ("openai", "azure"):
        return OpenAIAdapter(
            model=model,
            api_key=api_key,
            base_url=base_url,
            temperature=temperature,
            max_tokens=max_tokens,
        )
    else:
        raise ValueError(
            f"不支持的 LLM 提供商: {provider}. "
            f"支持的提供商: openai, anthropic, google"
        )


def create_llm_from_config() -> BaseChatModel:
    """
    从 ConfigManager 创建 LLM 适配器

    Returns:
        BaseChatModel 实现
    """
    try:
        from core.config_manager import ConfigManager

        # 获取配置
        provider = ConfigManager.get_ai_default_provider() or "google"
        api_key = ConfigManager.get_ai_provider_api_key(provider)
        model = ConfigManager.get_ai_provider_model(provider)
        base_url = ConfigManager.get(f"ai_agent.providers.{provider}.base_url")

        return create_llm_adapter(
            provider=provider,
            api_key=api_key,
            model=model,
            base_url=base_url,
        )
    except ImportError:
        logger.warning("ConfigManager 不可用，使用环境变量配置")
        model_name = os.getenv("MODEL_NAME", "openai/gpt-4o")
        return create_llm_adapter(
            model_name=model_name,
            api_key=os.getenv("MODEL_API_KEY"),
            base_url=os.getenv("MODEL_BASE_URL"),
        )
