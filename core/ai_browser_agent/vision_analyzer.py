"""
Vision 分析器 - AI Browser Agent

负责调用 LLM Vision API 分析页面截图并决策下一步操作
支持多 LLM 提供商（Gemini、Anthropic 等）
"""

import os
import json
import base64
import asyncio
from typing import Optional, Union
import traceback

from .types import ActionType, AgentAction, TaskContext
from .prompts import SYSTEM_PROMPT, build_task_prompt

# 导入 LLM 抽象层
try:
    from .llm import BaseLLM, LLMResponse, create_llm, create_llm_from_config
    LLM_ABSTRACTION_AVAILABLE = True
except ImportError:
    LLM_ABSTRACTION_AVAILABLE = False

# 兼容旧版 OpenAI 直接调用
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


class VisionAnalyzer:
    """
    Vision 分析器

    使用 LLM 的多模态能力分析浏览器截图，决策下一步操作
    支持多种 LLM 提供商：
    - Gemini（Google）
    - Anthropic/Claude（官方和第三方兼容服务）
    """

    # 默认值（Gemini）
    DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
    DEFAULT_MODEL = "gemini-2.5-flash"

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        model: str = None,
        max_tokens: int = 8192,
        api_timeout: int = 60,
        provider: Optional[str] = None,
        llm: Optional["BaseLLM"] = None,
    ):
        """
        初始化 Vision 分析器

        Args:
            api_key: API Key（默认从环境变量读取）
            base_url: API Base URL（默认使用 Gemini OpenAI 兼容 API）
            model: 使用的模型（默认 gemini-2.5-flash）
            max_tokens: 最大输出 token 数
            api_timeout: API 调用超时时间（秒），默认 60 秒
            provider: LLM 提供商 (gemini, anthropic)，自动推断或默认 gemini
            llm: 预创建的 LLM 实例（优先使用）

        Environment Variables:
            GEMINI_API_KEY: Gemini API 密钥
            ANTHROPIC_API_KEY: Anthropic API 密钥
        """
        self.max_tokens = max_tokens
        self.api_timeout = api_timeout

        # 如果提供了预创建的 LLM 实例，直接使用
        if llm is not None:
            self._llm = llm
            self.model = llm.model
            self.provider = llm.provider
            self.base_url = getattr(llm, 'base_url', '')
            print(f"[VisionAnalyzer] 使用预创建 LLM: {self.provider}/{self.model}")
            return

        # 使用 LLM 抽象层创建实例
        if LLM_ABSTRACTION_AVAILABLE:
            # 自动推断提供商
            if not provider:
                if api_key and api_key.startswith("sk-ant"):
                    provider = "anthropic"
                elif base_url and "anthropic" in base_url.lower():
                    provider = "anthropic"
                else:
                    provider = "gemini"

            try:
                self._llm = create_llm(
                    provider=provider,
                    api_key=api_key,
                    base_url=base_url,
                    model=model,
                    max_tokens=max_tokens,
                    timeout=api_timeout,
                )
                self.model = self._llm.model
                self.provider = self._llm.provider
                self.base_url = getattr(self._llm, 'base_url', '')
                print(f"[VisionAnalyzer] 使用 LLM 抽象层: {self.provider}/{self.model}")
                return
            except Exception as e:
                print(f"[VisionAnalyzer] LLM 抽象层初始化失败: {e}，回退到直接调用")

        # 回退: 直接使用 OpenAI SDK（兼容旧代码）
        self._llm = None
        self._init_legacy_client(api_key, base_url, model, api_timeout)

    def _init_legacy_client(
        self,
        api_key: Optional[str],
        base_url: Optional[str],
        model: Optional[str],
        api_timeout: int,
    ):
        """初始化旧版 OpenAI 兼容客户端"""
        if not OPENAI_AVAILABLE:
            raise ImportError("请安装 openai 库: pip install openai")

        self.api_key = api_key or os.environ.get("GEMINI_API_KEY")
        if not self.api_key:
            raise ValueError(
                "未提供 API Key，请设置 GEMINI_API_KEY 环境变量或传入 api_key 参数"
            )

        self.base_url = base_url or os.environ.get("GEMINI_BASE_URL") or self.DEFAULT_BASE_URL
        self.model = model or self.DEFAULT_MODEL
        self.provider = "gemini"

        self.client = OpenAI(
            api_key=self.api_key,
            base_url=self.base_url,
            timeout=api_timeout,
        )
        print(f"[VisionAnalyzer] 使用 OpenAI SDK: {self.base_url} (timeout={api_timeout}s)")

    @classmethod
    def from_config(cls, config: dict) -> "VisionAnalyzer":
        """
        从配置字典创建 VisionAnalyzer

        Args:
            config: 配置字典，可直接使用 ConfigManager.get_llm_config()

        Returns:
            VisionAnalyzer 实例
        """
        if LLM_ABSTRACTION_AVAILABLE:
            llm = create_llm_from_config(config)
            return cls(llm=llm)
        else:
            return cls(
                api_key=config.get("api_key"),
                base_url=config.get("base_url"),
                model=config.get("model"),
                max_tokens=config.get("max_tokens", 8192),
                api_timeout=config.get("timeout", 60),
            )

    async def analyze(
        self,
        screenshot: bytes,
        context: TaskContext,
        task_type: Optional[str] = None,
        elements_summary: str = "",
        max_retries: int = 3,
    ) -> AgentAction:
        """
        分析截图并决策下一步操作

        Args:
            screenshot: PNG 格式的截图数据
            context: 任务上下文
            task_type: 任务类型（用于加载特定提示词）
            elements_summary: 页面元素摘要（SoM 提取的可交互元素列表）
            max_retries: 最大重试次数

        Returns:
            AgentAction: AI 决策的动作
        """
        try:
            print(f"[VisionAnalyzer] 截图大小: {len(screenshot) / 1024:.1f} KB")

            # 构建任务提示词
            task_prompt = build_task_prompt(
                goal=context.goal,
                account=context.account,
                params=context.params,
                history=context.get_history_summary(),
                current_step=context.current_step,
                max_steps=context.max_steps,
                task_type=task_type,
                elements_summary=elements_summary,
            )

            # 重试逻辑
            last_error = None
            for attempt in range(max_retries):
                try:
                    # 调用 LLM
                    if self._llm is not None:
                        response = await self._call_llm(screenshot, task_prompt)
                    else:
                        response = await self._call_legacy_api(screenshot, task_prompt)

                    # 检查是否为空响应
                    if response and '"action"' in response:
                        action = self._parse_response(response)
                        return action
                    else:
                        print(f"[VisionAnalyzer] 第 {attempt + 1} 次尝试返回空响应，重试中...")
                        last_error = "API 返回空响应"
                        await asyncio.sleep(1)
                        continue

                except Exception as e:
                    print(f"[VisionAnalyzer] 第 {attempt + 1} 次尝试失败: {e}")
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

    async def _call_llm(self, screenshot: bytes, task_prompt: str) -> str:
        """
        使用 LLM 抽象层调用 API

        Args:
            screenshot: 截图数据
            task_prompt: 任务提示词

        Returns:
            响应文本
        """
        response: LLMResponse = await self._llm.analyze_screenshot(
            screenshot=screenshot,
            prompt=task_prompt,
            system_prompt=SYSTEM_PROMPT,
            max_tokens=self.max_tokens,
        )

        if not response.content:
            return f'{{"action": "error", "error_message": "AI 返回内容为空 (finish_reason={response.finish_reason})", "reasoning": "API 返回了空响应"}}'

        return response.content

    async def _call_legacy_api(self, screenshot: bytes, task_prompt: str) -> str:
        """
        使用旧版 OpenAI SDK 调用 API（兼容）

        Args:
            screenshot: 截图数据
            task_prompt: 任务提示词

        Returns:
            响应文本
        """
        image_base64 = base64.standard_b64encode(screenshot).decode("utf-8")
        image_mime = self._detect_image_mime(screenshot)

        response = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: self._call_api_sync(image_base64, task_prompt, image_mime),
        )

        return response

    def _call_api_sync(self, image_base64: str, task_prompt: str, image_mime: str = "image/png") -> str:
        """
        同步调用 API（旧版兼容）
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
                                "url": f"data:{image_mime};base64,{image_base64}",
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

        # 调试日志
        if response.choices:
            choice = response.choices[0]
            print(f"[VisionAnalyzer] API 响应 - finish_reason: {choice.finish_reason}")
            print(f"[VisionAnalyzer] API 响应 - content 长度: {len(choice.message.content) if choice.message.content else 0}")
            if hasattr(response, 'usage') and response.usage:
                print(f"[VisionAnalyzer] API 响应 - tokens: input={response.usage.prompt_tokens}, output={response.usage.completion_tokens}")

        content = response.choices[0].message.content
        if content is None:
            finish_reason = response.choices[0].finish_reason if response.choices else "unknown"
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
                error_type=data.get("error_type"),  # AI 识别的错误类型
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
        从文本中提取 JSON（增强版）

        支持的修复：
        1. Markdown 代码块提取（```json ... ```）
        2. 尾部逗号移除（trailing commas）
        3. 单引号转双引号
        4. 未加引号的键添加引号
        5. 缺失的小数前导零（.5 -> 0.5）
        6. 括号不匹配修复
        7. 控制字符清理

        Args:
            text: 可能包含 JSON 的文本

        Returns:
            提取并修复的 JSON 字符串
        """
        import re

        # 空值检查
        if not text:
            return '{"action": "error", "error_message": "响应为空"}'

        text = text.strip()

        # Step 1: 从 markdown 代码块中提取
        json_str = self._extract_from_markdown(text)

        # Step 2: 从纯文本中提取 JSON 对象
        if not json_str.startswith("{"):
            json_str = self._extract_json_object(json_str)

        # Step 3: 应用修复
        json_str = self._fix_json_string(json_str)

        return json_str

    def _extract_from_markdown(self, text: str) -> str:
        """从 markdown 代码块中提取 JSON"""
        # 尝试 ```json ... ```
        if "```json" in text:
            start = text.find("```json") + 7
            end = text.find("```", start)
            if end > start:
                return text[start:end].strip()

        # 尝试 ``` ... ```
        if "```" in text:
            start = text.find("```") + 3
            # 跳过可能的语言标识符行
            newline = text.find("\n", start)
            if newline > start and newline - start < 20:
                start = newline + 1
            end = text.find("```", start)
            if end > start:
                content = text[start:end].strip()
                if content.startswith("{"):
                    return content

        return text

    def _extract_json_object(self, text: str) -> str:
        """从文本中提取 JSON 对象（处理括号匹配）"""
        # 找到第一个 {
        start_idx = text.find("{")
        if start_idx == -1:
            return text

        # 括号匹配，考虑字符串内的括号
        depth = 0
        in_string = False
        escape_next = False

        for i, char in enumerate(text[start_idx:], start_idx):
            if escape_next:
                escape_next = False
                continue

            if char == "\\":
                escape_next = True
                continue

            if char == '"' and not escape_next:
                in_string = not in_string
                continue

            if in_string:
                continue

            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    return text[start_idx:i + 1]

        # 如果括号不匹配，返回从 { 开始的部分
        return text[start_idx:]

    def _fix_json_string(self, json_str: str) -> str:
        """
        修复常见的 JSON 格式问题

        Args:
            json_str: 可能有问题的 JSON 字符串

        Returns:
            修复后的 JSON 字符串
        """
        import re

        if not json_str or not json_str.strip():
            return '{"action": "error", "error_message": "响应为空"}'

        # 0. 先处理中文引号（在字符串值内替换为转义的普通引号）
        # 这需要智能处理，只替换字符串值内的中文引号
        json_str = self._escape_chinese_quotes(json_str)

        # 1. 清理控制字符（保留常见的转义字符）
        json_str = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', json_str)

        # 2. 移除尾部逗号（对象和数组）
        # 匹配 }, 或 ], 前的逗号（允许空白）
        json_str = re.sub(r',(\s*[}\]])', r'\1', json_str)

        # 3. 单引号转双引号（仅在非双引号字符串内）
        # 这是一个简化处理，假设 AI 返回的 JSON 结构相对简单
        json_str = self._convert_single_quotes(json_str)

        # 4. 修复未加引号的键（常见模式）
        # 匹配 { key: 或 , key: 格式
        json_str = re.sub(
            r'([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)',
            r'\1"\2"\3',
            json_str
        )

        # 5. 修复缺失的小数前导零
        # .5 -> 0.5（仅在数值上下文中）
        json_str = re.sub(r'([:,\[\s])\.(\d)', r'\g<1>0.\2', json_str)

        # 6. 修复布尔值和 null（大小写问题）
        json_str = re.sub(r'\bTrue\b', 'true', json_str)
        json_str = re.sub(r'\bFalse\b', 'false', json_str)
        json_str = re.sub(r'\bNone\b', 'null', json_str)

        # 7. 尝试补全缺失的右括号
        json_str = self._fix_brackets(json_str)

        return json_str

    def _convert_single_quotes(self, json_str: str) -> str:
        """
        将单引号转换为双引号（智能处理）

        避免替换双引号字符串内的单引号
        """
        result = []
        in_double_quote = False
        escape_next = False

        for char in json_str:
            if escape_next:
                result.append(char)
                escape_next = False
                continue

            if char == "\\":
                result.append(char)
                escape_next = True
                continue

            if char == '"':
                in_double_quote = not in_double_quote
                result.append(char)
            elif char == "'" and not in_double_quote:
                result.append('"')
            else:
                result.append(char)

        return ''.join(result)

    def _escape_chinese_quotes(self, json_str: str) -> str:
        """
        转义 JSON 字符串值内的中文引号

        将中文双引号（""）和单引号（''）替换为普通引号或转义形式，
        避免 JSON 解析错误。

        Args:
            json_str: JSON 字符串

        Returns:
            处理后的 JSON 字符串
        """
        result = []
        in_string = False
        escape_next = False

        # 中文引号映射（替换为普通单引号，避免破坏 JSON 结构）
        chinese_quotes = {
            '"': "'",  # 中文左双引号 -> 普通单引号
            '"': "'",  # 中文右双引号 -> 普通单引号
            ''': "'",  # 中文左单引号 -> 普通单引号
            ''': "'",  # 中文右单引号 -> 普通单引号
            '「': "'",  # 日文引号
            '」': "'",  # 日文引号
            '『': "'",  # 日文双引号
            '』': "'",  # 日文双引号
        }

        for char in json_str:
            if escape_next:
                result.append(char)
                escape_next = False
                continue

            if char == "\\":
                result.append(char)
                escape_next = True
                continue

            if char == '"':
                in_string = not in_string
                result.append(char)
                continue

            # 在字符串内部时，替换中文引号
            if in_string and char in chinese_quotes:
                result.append(chinese_quotes[char])
            else:
                result.append(char)

        return ''.join(result)

    def _fix_brackets(self, json_str: str) -> str:
        """
        修复不匹配的括号

        使用栈追踪括号顺序，按正确顺序补全缺失的右括号
        """
        # 使用栈追踪未闭合的括号
        stack = []
        in_string = False
        escape_next = False

        for char in json_str:
            if escape_next:
                escape_next = False
                continue

            if char == "\\":
                escape_next = True
                continue

            if char == '"' and not escape_next:
                in_string = not in_string
                continue

            if in_string:
                continue

            if char == "{":
                stack.append("}")
            elif char == "[":
                stack.append("]")
            elif char == "}" and stack and stack[-1] == "}":
                stack.pop()
            elif char == "]" and stack and stack[-1] == "]":
                stack.pop()

        # 按逆序补全缺失的右括号
        if stack:
            json_str += "".join(reversed(stack))

        return json_str

    def _detect_image_mime(self, image_data: bytes) -> str:
        """
        检测图片的 MIME 类型

        通过检查文件头魔数确定图片格式

        Args:
            image_data: 图片二进制数据

        Returns:
            MIME 类型字符串（image/png 或 image/jpeg）
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
        # 使用 LLM 抽象层的测试方法
        if self._llm is not None:
            success, message, details = self._llm.test_connection()
            details["provider"] = self.provider
            return success, message, details

        # 回退到旧版测试逻辑
        return self._test_connection_legacy()

    def _test_connection_legacy(self) -> tuple[bool, str, dict]:
        """旧版连接测试（直接使用 OpenAI SDK）"""
        import time

        details = {
            "model": self.model,
            "base_url": self.base_url,
            "provider": self.provider,
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
