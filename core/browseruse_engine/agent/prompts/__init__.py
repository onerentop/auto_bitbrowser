"""
BrowserUse Engine - 提示词管理器

加载和格式化系统提示词。
"""

import os
import logging
from typing import Optional, List, Dict, Any
from pathlib import Path

logger = logging.getLogger(__name__)

# 提示词目录
PROMPTS_DIR = Path(__file__).parent


class PromptManager:
    """
    提示词管理器

    负责加载提示词模板并格式化为 LLM 可用的消息。
    """

    def __init__(self, language: str = "en"):
        """
        初始化提示词管理器

        Args:
            language: 语言 ("en" 或 "zh")
        """
        self.language = language
        self._system_prompt: Optional[str] = None
        self._load_templates()

    def _load_templates(self) -> None:
        """加载提示词模板"""
        # 根据语言选择模板文件
        if self.language == "zh":
            template_file = PROMPTS_DIR / "system_prompt_zh.md"
        else:
            template_file = PROMPTS_DIR / "system_prompt.md"

        try:
            with open(template_file, "r", encoding="utf-8") as f:
                self._system_prompt = f.read()
            logger.debug(f"加载提示词模板: {template_file}")
        except FileNotFoundError:
            logger.warning(f"提示词模板不存在: {template_file}，使用默认模板")
            self._system_prompt = self._get_default_prompt()

    def _get_default_prompt(self) -> str:
        """获取默认提示词"""
        return """You are an AI browser automation agent. Analyze the page state and execute actions to complete the user's task.

Output JSON format:
{
  "thinking": "your reasoning",
  "evaluation_previous_goal": "assessment of previous action",
  "memory": "important info to remember",
  "next_goal": "next step goal",
  "action": [{"action_name": {"param": "value"}}]
}

Available actions: navigate, click, input, scroll, extract, wait, press_key, go_back, done
"""

    def get_system_prompt(
        self,
        action_descriptions: Optional[str] = None,
        custom_instructions: Optional[str] = None,
    ) -> str:
        """
        获取格式化的系统提示词

        Args:
            action_descriptions: 动作描述 (覆盖默认)
            custom_instructions: 自定义指令 (追加)

        Returns:
            格式化后的系统提示词
        """
        prompt = self._system_prompt or self._get_default_prompt()

        if custom_instructions:
            prompt += f"\n\n## Additional Instructions\n\n{custom_instructions}"

        return prompt

    def get_user_prompt(
        self,
        task: str,
        browser_state: Any,
        agent_history: Optional[Any] = None,
        step_number: int = 0,
        max_steps: int = 50,
    ) -> str:
        """
        构建用户消息

        Args:
            task: 任务描述
            browser_state: 浏览器状态 (BrowserState)
            agent_history: Agent 历史 (AgentHistory)
            step_number: 当前步骤号
            max_steps: 最大步骤数

        Returns:
            格式化的用户消息
        """
        sections = []

        # 历史记录
        if agent_history and hasattr(agent_history, 'get_history_description'):
            history_text = agent_history.get_history_description()
            if history_text and history_text != "No previous actions.":
                sections.append(f"<agent_history>\n{history_text}\n</agent_history>")

        # 浏览器状态
        if browser_state:
            if hasattr(browser_state, 'get_state_description'):
                state_text = browser_state.get_state_description()
            else:
                state_text = str(browser_state)
            sections.append(f"<browser_state>\n{state_text}\n</browser_state>")

        # 任务和步骤信息
        sections.append(f"<task>\n{task}\n</task>")
        sections.append(f"<step_info>\nStep {step_number + 1} of {max_steps}\n</step_info>")

        return "\n\n".join(sections)

    def set_language(self, language: str) -> None:
        """切换语言"""
        if language != self.language:
            self.language = language
            self._load_templates()


# ==================== 便捷函数 ====================

_default_manager: Optional[PromptManager] = None


def get_prompt_manager(language: str = "en") -> PromptManager:
    """获取提示词管理器实例"""
    global _default_manager
    if _default_manager is None or _default_manager.language != language:
        _default_manager = PromptManager(language=language)
    return _default_manager


def get_system_prompt(language: str = "en") -> str:
    """获取系统提示词"""
    return get_prompt_manager(language).get_system_prompt()
