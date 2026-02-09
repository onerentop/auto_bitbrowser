"""
BrowserUse Engine - Agent 服务核心

实现 Agent 循环调度逻辑。
"""

import asyncio
import json
import logging
import time
from typing import Any, Optional, Callable, Awaitable, List

from .message_manager import MessageManager
from .views import AgentState, AgentStatus, StepResult, AgentRunResult
from .prompts import PromptManager
from ..dom.service import DOMService
from ..tools.executor import ActionExecutor
from ..tools.registry import ActionRegistry
from ..llm.base import BaseChatModel, SystemMessage, UserMessage, AssistantMessage
from ..types import (
    AgentOutput,
    AgentHistory,
    AgentStepRecord,
    BrowserState,
    ActionModel,
)
from ..protocol import ActionResult, AgentResult

logger = logging.getLogger(__name__)


class AgentService:
    """
    Agent 服务

    核心的 Agent 循环调度器，负责：
    1. 获取浏览器状态
    2. 构建 LLM 提示词
    3. 调用 LLM 获取决策
    4. 执行动作序列
    5. 记录历史和状态
    """

    def __init__(
        self,
        llm: BaseChatModel,
        page: Any,
        dom_service: Optional[DOMService] = None,
        action_executor: Optional[ActionExecutor] = None,
        prompt_manager: Optional[PromptManager] = None,
        use_vision: bool = True,
        max_actions_per_step: int = 3,
        language: str = "en",
    ):
        """
        初始化 Agent 服务

        Args:
            llm: LLM 适配器
            page: Playwright Page 对象
            dom_service: DOM 服务 (可选，会自动创建)
            action_executor: 动作执行器 (可选，会自动创建)
            prompt_manager: 提示词管理器 (可选，会自动创建)
            use_vision: 是否使用视觉 (截图)
            max_actions_per_step: 每步最大动作数
            language: 语言
        """
        self.llm = llm
        self.page = page
        self.use_vision = use_vision
        self.max_actions_per_step = max_actions_per_step
        self.language = language

        # 初始化组件
        self.dom_service = dom_service or DOMService(page)
        self.action_executor = action_executor or ActionExecutor(
            page=page,
            dom_service=self.dom_service,
            llm=llm,
        )
        self.prompt_manager = prompt_manager or PromptManager(language=language)
        self.message_manager = MessageManager()

        # 状态
        self._state = AgentState()
        self._stop_requested = False

    async def run(
        self,
        task: str,
        max_steps: int = 50,
        on_step: Optional[Callable[[StepResult], Awaitable[None]]] = None,
        custom_instructions: Optional[str] = None,
    ) -> AgentResult:
        """
        执行 Agent 任务

        Args:
            task: 任务描述
            max_steps: 最大步数
            on_step: 步骤回调函数
            custom_instructions: 自定义指令

        Returns:
            AgentResult
        """
        start_time = time.time()
        self._stop_requested = False

        # 初始化状态
        self._state = AgentState(
            status=AgentStatus.RUNNING,
            task=task,
            max_steps=max_steps,
            history=AgentHistory(task=task, start_time=start_time),
        )

        # 初始化消息
        system_prompt = self.prompt_manager.get_system_prompt(
            custom_instructions=custom_instructions
        )
        self.message_manager.clear()
        self.message_manager.add_system_message(system_prompt)

        steps: List[StepResult] = []
        extracted_content = None

        try:
            for step_num in range(max_steps):
                if self._stop_requested:
                    logger.info("收到停止请求，终止 Agent")
                    self._state.status = AgentStatus.STOPPED
                    break

                self._state.current_step = step_num

                # 执行单步
                step_result = await self._execute_step(step_num, task, max_steps)
                steps.append(step_result)

                # 更新历史
                if self._state.history:
                    record = AgentStepRecord(
                        step_number=step_num,
                        agent_output=step_result.agent_output,
                        action_results=[
                            {"success": r.success, "message": r.message, "error": r.error}
                            for r in step_result.action_results
                        ],
                        browser_state=step_result.browser_state_after,
                        error=step_result.error,
                        timestamp=time.time(),
                    )
                    self._state.history.steps.append(record)

                # 回调
                if on_step:
                    await on_step(step_result)

                # 检查是否完成
                if step_result.is_done:
                    extracted_content = step_result.done_message
                    self._state.status = AgentStatus.COMPLETED
                    logger.info(f"任务完成: {extracted_content}")
                    break

                # 检查错误
                if step_result.error:
                    logger.warning(f"步骤 {step_num} 出错: {step_result.error}")
                    # 继续执行，让 Agent 尝试恢复

                # 动作之间等待
                await asyncio.sleep(0.5)

            else:
                # 达到最大步数
                logger.warning(f"达到最大步数 {max_steps}")
                self._state.status = AgentStatus.FAILED
                self._state.error = "达到最大步数限制"

        except Exception as e:
            logger.error(f"Agent 执行异常: {e}")
            self._state.status = AgentStatus.FAILED
            self._state.error = str(e)

        # 计算统计
        duration_ms = (time.time() - start_time) * 1000
        total_actions = sum(len(s.action_results) for s in steps)

        # 获取最终 URL
        final_url = ""
        try:
            final_url = self.page.url
        except Exception:
            pass

        return AgentResult(
            success=self._state.status == AgentStatus.COMPLETED,
            message=extracted_content or "",
            error=self._state.error,
            extracted_content=extracted_content,
            steps=[
                {
                    "step_number": s.step_number,
                    "thinking": s.agent_output.thinking if s.agent_output else "",
                    "action_name": s.agent_output.action[0].get_action_type() if s.agent_output and s.agent_output.action else "",
                    "action_params": s.agent_output.action[0].get_action_params() if s.agent_output and s.agent_output.action else {},
                    "result": s.action_results[0] if s.action_results else None,
                    "browser_url": s.browser_state_after.url if s.browser_state_after else "",
                    "timestamp": time.time(),
                }
                for s in steps
            ],
            total_steps=len(steps),
            duration_ms=duration_ms,
        )

    async def _execute_step(
        self,
        step_num: int,
        task: str,
        max_steps: int,
    ) -> StepResult:
        """执行单个步骤"""
        step_start = time.time()

        # 1. 获取浏览器状态
        browser_state = await self.dom_service.get_browser_state(
            include_screenshot=self.use_vision
        )
        self._state.browser_state = browser_state

        # 2. 构建用户消息
        user_prompt = self.prompt_manager.get_user_prompt(
            task=task,
            browser_state=browser_state,
            agent_history=self._state.history,
            step_number=step_num,
            max_steps=max_steps,
        )

        # 添加消息
        if self.use_vision and browser_state.screenshot_base64:
            self.message_manager.add_user_message(
                user_prompt,
                image_base64=browser_state.screenshot_base64
            )
        else:
            self.message_manager.add_user_message(user_prompt)

        # 3. 调用 LLM
        try:
            response = await self.llm.ainvoke(
                messages=self.message_manager.get_messages(),
                response_format=AgentOutput,
            )

            agent_output = response.parsed
            if not agent_output:
                # 尝试从内容解析
                try:
                    content = response.content
                    if "```json" in content:
                        content = content.split("```json")[1].split("```")[0]
                    elif "```" in content:
                        content = content.split("```")[1].split("```")[0]
                    data = json.loads(content)
                    agent_output = AgentOutput(**data)
                except Exception as e:
                    logger.error(f"解析 LLM 输出失败: {e}")
                    return StepResult(
                        step_number=step_num,
                        error=f"解析 LLM 输出失败: {e}",
                        browser_state_before=browser_state,
                        duration_ms=(time.time() - step_start) * 1000,
                    )

            # 最终检查 agent_output 是否有效
            if not agent_output:
                logger.error("无法获取有效的 Agent 输出")
                return StepResult(
                    step_number=step_num,
                    error="无法获取有效的 Agent 输出",
                    browser_state_before=browser_state,
                    duration_ms=(time.time() - step_start) * 1000,
                )

            # 添加助手消息
            self.message_manager.add_assistant_message(response.content)

        except Exception as e:
            logger.error(f"LLM 调用失败: {e}")
            return StepResult(
                step_number=step_num,
                error=f"LLM 调用失败: {e}",
                browser_state_before=browser_state,
                duration_ms=(time.time() - step_start) * 1000,
            )

        # 4. 执行动作
        actions = agent_output.action[:self.max_actions_per_step]
        action_results = []

        for action in actions:
            result = await self.action_executor.execute(action)
            action_results.append(result)

            # 如果是 done 动作，停止执行
            if action.done is not None:
                break

        # 5. 获取执行后的状态
        browser_state_after = await self.dom_service.get_browser_state(
            include_screenshot=False
        )

        self._state.last_output = agent_output
        self._state.last_results = action_results

        duration_ms = (time.time() - step_start) * 1000
        logger.info(
            f"Step {step_num}: {agent_output.next_goal} - "
            f"{len(actions)} actions, {duration_ms:.0f}ms"
        )

        return StepResult(
            step_number=step_num,
            agent_output=agent_output,
            action_results=action_results,
            browser_state_before=browser_state,
            browser_state_after=browser_state_after,
            duration_ms=duration_ms,
        )

    def stop(self) -> None:
        """请求停止 Agent"""
        self._stop_requested = True

    @property
    def state(self) -> AgentState:
        """获取当前状态"""
        return self._state

    @property
    def is_running(self) -> bool:
        """是否正在运行"""
        return self._state.is_running
