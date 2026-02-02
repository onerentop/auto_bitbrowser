# Core 模块
# 提供配置管理、重试框架、数据解析、AI 浏览器代理等核心功能

from .config_manager import ConfigManager
from .retry_helper import RetryHelper, FailedTaskQueue, with_retry, with_retry_async
from .data_parser import parse_account_line, build_account_line
from .totp_helper import (
    generate_totp, get_totp, get_totp_remaining_seconds,
    is_totp_about_to_expire, generate_totp_with_wait, verify_totp,
)

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
        ScreenshotManager,
        ScreenshotResult,
        ElementMarker,
        MarkedElement,
    )
    AI_BROWSER_AGENT_AVAILABLE = True
except ImportError:
    AI_BROWSER_AGENT_AVAILABLE = False

__all__ = [
    'ConfigManager',
    'RetryHelper', 'FailedTaskQueue', 'with_retry', 'with_retry_async',
    'parse_account_line', 'build_account_line',
    # TOTP Helper
    'generate_totp', 'get_totp', 'get_totp_remaining_seconds',
    'is_totp_about_to_expire', 'generate_totp_with_wait', 'verify_totp',
    # AI Browser Agent
    'AIBrowserAgent', 'VisionAnalyzer', 'ActionExecutor',
    'ActionType', 'AgentAction', 'AgentState', 'TaskResult', 'TaskContext',
    'ScreenshotManager', 'ScreenshotResult', 'ElementMarker', 'MarkedElement',
    'AI_BROWSER_AGENT_AVAILABLE',
]
