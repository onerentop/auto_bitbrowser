"""
BrowserUse Engine - AI 浏览器操控引擎

基于 browser-use 架构的 AI 浏览器自动化引擎，提供：
- Agent 循环：多步骤迭代执行复杂任务
- DOM 提取：索引化可交互元素
- 动作系统：可扩展的动作注册和执行
- 提示词管理：可配置的中英文提示词
- 多 LLM 支持：OpenAI、Anthropic、Google

与 StagehandGoogleEngine 实现相同的 EngineProtocol 接口，可互换使用。

使用示例:
    ```python
    from core.browseruse_engine import BrowserUseEngine

    # 方式1: 连接到 ixBrowser 窗口
    engine = await BrowserUseEngine.connect_to_ixbrowser("browser_id")
    try:
        result = await engine.run("搜索并订阅 Google One")
        print(f"任务完成: {result.success}")
    finally:
        await engine.stop()

    # 方式2: 作为上下文管理器使用
    async with await BrowserUseEngine.connect_to_ixbrowser("browser_id") as engine:
        result = await engine.run("打开 Google 首页并搜索")
    ```

依赖:
    - playwright: 浏览器自动化
    - openai/anthropic/google-generativeai: LLM API
    - pydantic: 数据验证
"""

__version__ = "1.0.0"

# 协议和结果类型
from .protocol import (
    EngineProtocol,
    NavigationResult,
    ActionResult,
    ExtractResult,
    ObserveResult,
    AgentResult,
    AgentStep,
    OperationStatus,
    is_engine,
)

# 类型定义
from .types import (
    # 动作模型
    ActionModel,
    NavigateAction,
    ClickAction,
    InputAction,
    ScrollAction,
    ExtractAction,
    ScreenshotAction,
    WaitAction,
    DoneAction,
    PressKeyAction,
    GoBackAction,
    ActionType,
    # Agent 模型
    AgentOutput,
    AgentStepRecord,
    AgentHistory,
    AgentConfig,
    # DOM 模型
    DOMElement,
    DOMTree,
    Rect,
    # 浏览器状态
    BrowserState,
    # 配置
    LLMConfig,
    # 操作结果类型
    JoinFamilyResult,
)

# LLM 模块
from .llm import (
    BaseChatModel,
    SystemMessage,
    UserMessage,
    AssistantMessage,
    ChatCompletion,
    create_llm_adapter,
    create_llm_from_config,
)

# 延迟导入主引擎类和便捷函数 (避免循环依赖)
def __getattr__(name: str):
    if name == "BrowserUseEngine":
        from .engine import BrowserUseEngine
        return BrowserUseEngine
    if name == "create_engine":
        from .engine import create_engine
        return create_engine
    if name == "create_engine_from_config":
        from .engine import create_engine_from_config
        return create_engine_from_config
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    # 版本
    "__version__",
    # 主类 (延迟导入)
    "BrowserUseEngine",
    # 便捷函数 (延迟导入)
    "create_engine",
    "create_engine_from_config",
    # 协议
    "EngineProtocol",
    "is_engine",
    # 结果类型
    "NavigationResult",
    "ActionResult",
    "ExtractResult",
    "ObserveResult",
    "AgentResult",
    "AgentStep",
    "OperationStatus",
    # 动作模型
    "ActionModel",
    "NavigateAction",
    "ClickAction",
    "InputAction",
    "ScrollAction",
    "ExtractAction",
    "ScreenshotAction",
    "WaitAction",
    "DoneAction",
    "PressKeyAction",
    "GoBackAction",
    "ActionType",
    # Agent 模型
    "AgentOutput",
    "AgentStepRecord",
    "AgentHistory",
    "AgentConfig",
    # DOM 模型
    "DOMElement",
    "DOMTree",
    "Rect",
    # 浏览器状态
    "BrowserState",
    # 配置
    "LLMConfig",
    # 操作结果类型
    "JoinFamilyResult",
    # LLM
    "BaseChatModel",
    "SystemMessage",
    "UserMessage",
    "AssistantMessage",
    "ChatCompletion",
    "create_llm_adapter",
    "create_llm_from_config",
]
