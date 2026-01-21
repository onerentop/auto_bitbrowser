# Core 模块
# 提供配置管理、重试框架、数据解析、AI 浏览器代理等核心功能

from .config_manager import ConfigManager
from .retry_helper import RetryHelper, FailedTaskQueue, with_retry, with_retry_async
from .data_parser import parse_account_line, build_account_line

# AI Browser Agent (延迟导入，避免依赖问题)
try:
    from .ai_browser_agent import (
        AIBrowserAgent,
        VisionAnalyzer,
        ActionExecutor,
        ActionType,
        AgentAction,
        AgentState,
        TaskResult,
        TaskContext,
    )
    AI_BROWSER_AGENT_AVAILABLE = True
except ImportError:
    AI_BROWSER_AGENT_AVAILABLE = False

__all__ = [
    'ConfigManager',
    'RetryHelper', 'FailedTaskQueue', 'with_retry', 'with_retry_async',
    'parse_account_line', 'build_account_line',
    # AI Browser Agent
    'AIBrowserAgent', 'VisionAnalyzer', 'ActionExecutor',
    'ActionType', 'AgentAction', 'AgentState', 'TaskResult', 'TaskContext',
    'AI_BROWSER_AGENT_AVAILABLE',
]
