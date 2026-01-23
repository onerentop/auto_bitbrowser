"""
AI Browser Agent - 通用 AI 浏览器自动化代理

基于 Gemini Vision 的智能浏览器操作代理，支持：
- 视觉分析页面状态
- 智能决策下一步操作
- 自动处理登录、验证等流程
"""

from .types import (
    ActionType,
    AgentAction,
    AgentState,
    ErrorType,
    TaskResult,
    TaskContext,
)
from .agent import AIBrowserAgent
from .vision_analyzer import VisionAnalyzer
from .action_executor import ActionExecutor

__all__ = [
    # Types
    "ActionType",
    "AgentAction",
    "AgentState",
    "ErrorType",
    "TaskResult",
    "TaskContext",
    # Classes
    "AIBrowserAgent",
    "VisionAnalyzer",
    "ActionExecutor",
]
