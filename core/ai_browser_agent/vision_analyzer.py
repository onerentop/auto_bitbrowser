"""
Gemini Vision 分析器 - AI Browser Agent

负责调用 Gemini Vision API 分析页面截图并决策下一步操作
使用 OpenAI 兼容的 API 格式
"""

import os
import json
import base64
import asyncio
from typing import Optional
import traceback

try:
    from openai import OpenAI, APIError, APIConnectionError, RateLimitError, AuthenticationError
except ImportError:
    OpenAI = None
    APIError = None
    APIConnectionError = None
    RateLimitError = None
    AuthenticationError = None

from .types import ActionType, AgentAction, TaskContext
from .prompts import SYSTEM_PROMPT, build_task_prompt


class VisionAnalyzer:
    """
    Gemini Vision 分析器

    使用 Gemini 的多模态能力分析浏览器截图，决策下一步操作
    采用 OpenAI 兼容的 API 格式
    """

    # Gemini OpenAI 兼容 API 地址
    # 注意：必须使用 /openai/ 后缀才能使用 OpenAI 格式
    DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
    DEFAULT_MODEL = "gemini-2.5-flash"

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: str = None,
        max_tokens: int = 8192,
    ):
        """
        初始化 Vision 分析器

        Args:
            api_key: API Key（默认从环境变量读取）
            base_url: API Base URL（默认使用 Gemini OpenAI 兼容 API）
            model: 使用的模型（默认 gemini-2.5-flash）
            max_tokens: 最大输出 token 数

        Environment Variables:
            GEMINI_API_KEY: Gemini API 密钥
        """
        if OpenAI is None:
            raise ImportError(
                "请安装 openai 库: pip install openai"
            )

        self.api_key = api_key or os.environ.get("GEMINI_API_KEY")
        if not self.api_key:
            raise ValueError(
                "未提供 API Key，请设置 GEMINI_API_KEY 环境变量或传入 api_key 参数"
            )

        # 支持自定义 base_url
        self.base_url = base_url or os.environ.get("GEMINI_BASE_URL") or self.DEFAULT_BASE_URL

        # 创建 OpenAI 兼容客户端
        self.client = OpenAI(
            api_key=self.api_key,
            base_url=self.base_url,
        )
        print(f"[AI Agent] 使用 API: {self.base_url}")

        self.model = model or self.DEFAULT_MODEL
        self.max_tokens = max_tokens

    async def analyze(
        self,
        screenshot: bytes,
        context: TaskContext,
        task_type: Optional[str] = None,
        max_retries: int = 3,
    ) -> AgentAction:
        """
        分析截图并决策下一步操作

        Args:
            screenshot: PNG 格式的截图数据
            context: 任务上下文
            task_type: 任务类型（用于加载特定提示词）
            max_retries: 最大重试次数

        Returns:
            AgentAction: AI 决策的动作
        """
        try:
            # 将截图编码为 base64
            image_base64 = base64.standard_b64encode(screenshot).decode("utf-8")
            print(f"[AI Agent] 截图大小: {len(screenshot) / 1024:.1f} KB")

            # 构建任务提示词
            task_prompt = build_task_prompt(
                goal=context.goal,
                account=context.account,
                params=context.params,
                history=context.get_history_summary(),
                current_step=context.current_step,
                max_steps=context.max_steps,
                task_type=task_type,
            )

            # 重试逻辑
            last_error = None
            for attempt in range(max_retries):
                try:
                    # 调用 API（在线程池中执行同步调用）
                    response = await asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: self._call_api(image_base64, task_prompt),
                    )

                    # 检查是否为空响应
                    if response and '"action"' in response:
                        # 解析响应
                        action = self._parse_response(response)
                        return action
                    else:
                        print(f"[AI Agent] 第 {attempt + 1} 次尝试返回空响应，重试中...")
                        last_error = "API 返回空响应"
                        await asyncio.sleep(1)  # 等待 1 秒后重试
                        continue

                except Exception as e:
                    print(f"[AI Agent] 第 {attempt + 1} 次尝试失败: {e}")
                    last_error = str(e)
                    await asyncio.sleep(1)
                    continue

            # 所有重试都失败
            return AgentAction(
                action_type=ActionType.ERROR,
                error_message=f"AI 分析失败（重试 {max_retries} 次）: {last_error}",
                reasoning=f"多次调用 API 均失败: {last_error}",
            )

        except Exception as e:
            traceback.print_exc()
            return AgentAction(
                action_type=ActionType.ERROR,
                error_message=f"AI 分析失败: {str(e)}",
                reasoning=f"调用 Vision API 时发生错误: {str(e)}",
            )

    def _call_api(self, image_base64: str, task_prompt: str) -> str:
        """
        调用 Vision API（同步方法，OpenAI 兼容格式）

        Args:
            image_base64: base64 编码的图片
            task_prompt: 任务提示词

        Returns:
            API 响应文本
        """
        response = self.client.chat.completions.create(
            model=self.model,
            max_tokens=self.max_tokens,
            messages=[
                {
                    "role": "system",
                    "content": SYSTEM_PROMPT,
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{image_base64}",
                            },
                        },
                        {
                            "type": "text",
                            "text": task_prompt,
                        },
                    ],
                }
            ],
        )

        # 调试日志：输出完整响应信息
        if response.choices:
            choice = response.choices[0]
            print(f"[AI Agent] API 响应 - finish_reason: {choice.finish_reason}")
            print(f"[AI Agent] API 响应 - content 长度: {len(choice.message.content) if choice.message.content else 0}")
            if hasattr(response, 'usage') and response.usage:
                print(f"[AI Agent] API 响应 - tokens: input={response.usage.prompt_tokens}, output={response.usage.completion_tokens}")

        # 提取响应文本
        content = response.choices[0].message.content
        if content is None:
            # 检查是否因为 finish_reason 导致的空响应
            finish_reason = response.choices[0].finish_reason if response.choices else "unknown"
            print(f"[AI Agent] 警告: content 为 None, finish_reason={finish_reason}")
            return f'{{"action": "error", "error_message": "AI 返回内容为空 (finish_reason={finish_reason})", "reasoning": "API 返回了空响应"}}'
        return content

    def _parse_response(self, response: str) -> AgentAction:
        """
        解析 AI 的 JSON 响应

        Args:
            response: AI 返回的文本

        Returns:
            AgentAction: 解析后的动作
        """
        try:
            # 尝试提取 JSON
            json_str = self._extract_json(response)
            data = json.loads(json_str)

            # 调试日志：输出解析后的数据
            print(f"[AI Agent] 解析后的动作数据: action={data.get('action')}, target={data.get('target')}, x={data.get('x')}, y={data.get('y')}")

            # 解析动作类型
            action_str = data.get("action", "error").lower()
            action_type = self._parse_action_type(action_str)

            return AgentAction(
                action_type=action_type,
                target_description=data.get("target"),
                x=data.get("x"),
                y=data.get("y"),
                value=data.get("value"),
                wait_seconds=data.get("wait_seconds"),
                key=data.get("value") if action_type == ActionType.PRESS else None,
                url=data.get("url"),
                reasoning=data.get("reasoning", ""),
                confidence=data.get("confidence", 1.0),
                error_message=data.get("error_message"),
                verification_type=data.get("verification_type"),
                extracted_secret=data.get("extracted_secret"),
                extracted_link=data.get("extracted_link"),
                result_status=data.get("result_status"),
                kicked_count=data.get("kicked_count"),
            )

        except json.JSONDecodeError as e:
            return AgentAction(
                action_type=ActionType.ERROR,
                error_message=f"JSON 解析失败: {str(e)}",
                reasoning=f"AI 返回的内容无法解析为 JSON: {response[:200]}...",
            )
        except Exception as e:
            return AgentAction(
                action_type=ActionType.ERROR,
                error_message=f"响应解析失败: {str(e)}",
                reasoning=f"解析响应时发生错误: {str(e)}",
            )

    def _extract_json(self, text: str) -> str:
        """
        从文本中提取 JSON

        Args:
            text: 可能包含 JSON 的文本

        Returns:
            提取的 JSON 字符串
        """
        # 空值检查
        if not text:
            return '{"action": "error", "error_message": "响应为空"}'

        # 尝试直接解析
        text = text.strip()
        if text.startswith("{"):
            # 找到匹配的结束括号
            depth = 0
            for i, char in enumerate(text):
                if char == "{":
                    depth += 1
                elif char == "}":
                    depth -= 1
                    if depth == 0:
                        return text[: i + 1]
            return text

        # 尝试从 markdown 代码块中提取
        if "```json" in text:
            start = text.find("```json") + 7
            end = text.find("```", start)
            if end > start:
                return text[start:end].strip()

        if "```" in text:
            start = text.find("```") + 3
            end = text.find("```", start)
            if end > start:
                content = text[start:end].strip()
                if content.startswith("{"):
                    return content

        # 返回原文本，让 JSON 解析器处理
        return text

    def test_connection(self) -> tuple[bool, str, dict]:
        """
        测试 API 连接是否正常

        发送简单消息测试 API 配置是否有效

        Returns:
            (success: bool, message: str, details: dict)
            - success: 连接是否成功
            - message: 用户友好的消息
            - details: 详细信息 (model, response_time, error_type 等)
        """
        import time

        details = {
            "model": self.model,
            "base_url": self.base_url,
            "response_time_ms": 0,
        }

        try:
            start_time = time.time()

            # 发送简单消息测试
            response = self.client.chat.completions.create(
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

                # 提取 usage
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
            # 检查是否是模型不支持
            if "model" in str(e).lower():
                return False, f"模型不可用: {self.model}", details
            return False, f"API 错误: {str(e)[:100]}", details

        except Exception as e:
            details["error_type"] = "unknown"
            details["error_detail"] = str(e)
            return False, f"未知错误: {str(e)[:100]}", details

    async def test_connection_async(self) -> tuple[bool, str, dict]:
        """
        异步版本的连接测试

        Returns:
            (success: bool, message: str, details: dict)
        """
        return await asyncio.get_event_loop().run_in_executor(
            None, self.test_connection
        )

    def _parse_action_type(self, action_str: str) -> ActionType:
        """
        解析动作类型字符串

        Args:
            action_str: 动作类型字符串

        Returns:
            ActionType 枚举值
        """
        action_map = {
            "click": ActionType.CLICK,
            "fill": ActionType.FILL,
            "type": ActionType.TYPE,
            "press": ActionType.PRESS,
            "scroll": ActionType.SCROLL,
            "wait": ActionType.WAIT,
            "wait_for": ActionType.WAIT_FOR,
            "navigate": ActionType.NAVIGATE,
            "refresh": ActionType.REFRESH,
            "extract_secret": ActionType.EXTRACT_SECRET,
            "extract_link": ActionType.EXTRACT_LINK,
            "done": ActionType.DONE,
            "error": ActionType.ERROR,
            "need_verification": ActionType.NEED_VERIFICATION,
        }

        return action_map.get(action_str, ActionType.ERROR)
