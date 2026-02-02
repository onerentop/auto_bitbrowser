"""
AI Browser Agent - 通用 AI 浏览器自动化代理

基于多模态 LLM 的智能浏览器操作代理，支持：
- 视觉分析页面状态
- 智能决策下一步操作
- 自动处理登录、验证等流程
- SoM (Set-of-Mark) 元素标记提升定位准确率
- 多 LLM 提供商（Gemini、Anthropic/Claude）
- 三层架构：run() → _execute_step() → _step()
- 装饰器注册的 Action 处理机制
"""

from .types import (
    ActionType,
    AgentAction,
    AgentState,
    ErrorType,
    TaskResult,
    TaskContext,
)

# 状态管理（V2 新增）
from .state import (
    ExecutionState,
    AgentStateData,
    StepMetadata,
    ActionResult as StateActionResult,
    StepRecord,
    create_state,
)

# 消息管理器（V2 新增）
from .message_manager import MessageManager, Message

# Action 注册机制（V2 新增）
from .action_registry import (
    ActionRegistry,
    ActionMetadata,
    ActionResult as RegistryActionResult,
    action,
    get_registry,
    is_terminal_action,
    is_navigation_action,
    is_input_action,
)

# Action 参数模型（V2 新增）
from .action_models import (
    ActionParams,
    ClickParams,
    FillParams,
    TypeParams,
    PressParams,
    ScrollParams,
    WaitParams,
    NavigateParams,
    ValidationError,
    get_params_class,
    create_params,
)

from .agent import AIBrowserAgent
from .vision_analyzer import VisionAnalyzer
from .action_executor import ActionExecutor
from .element_finder import ElementFinder  # V2 新增：元素查找器
from .element_marker import ElementMarker, MarkedElement
from .screenshot_manager import (
    ScreenshotManager,
    ScreenshotResult,
    ElementCache,   # V2 新增
    SoMStats,       # V2 新增
)

# CDP 服务和增强标记器（V2 新增）
try:
    from .cdp_service import (
        CDPDOMService,
        DOMNode,
        AccessibilityNode,
        create_cdp_service,
    )
    CDP_SERVICE_AVAILABLE = True
except ImportError:
    CDPDOMService = None
    DOMNode = None
    AccessibilityNode = None
    create_cdp_service = None
    CDP_SERVICE_AVAILABLE = False

try:
    from .element_marker_v2 import (
        EnhancedElementMarker,
        ExtractionResult,
        create_enhanced_marker,
        css_to_device_coords,
        device_to_css_coords,
    )
    ENHANCED_MARKER_AVAILABLE = True
except ImportError:
    EnhancedElementMarker = None
    ExtractionResult = None
    create_enhanced_marker = None
    css_to_device_coords = None
    device_to_css_coords = None
    ENHANCED_MARKER_AVAILABLE = False

# V2.3: 可交互元素检测器（借鉴 browser-use）
try:
    from .clickable_detector import (
        ClickableElementDetector,
        InteractivityResult,
        get_clickable_detector,
        create_clickable_detector,
        is_element_clickable,
        detect_interactivity,
    )
    CLICKABLE_DETECTOR_AVAILABLE = True
except ImportError:
    ClickableElementDetector = None
    InteractivityResult = None
    get_clickable_detector = None
    create_clickable_detector = None
    is_element_clickable = None
    detect_interactivity = None
    CLICKABLE_DETECTOR_AVAILABLE = False

# 确保 Action 处理器已注册
from . import actions as _actions

# LLM 抽象层
try:
    from .llm import (
        BaseLLM,
        LLMResponse,
        GeminiLLM,
        AnthropicLLM,
        create_llm,
        create_llm_from_config,
        get_available_providers,
    )
    LLM_ABSTRACTION_AVAILABLE = True
except ImportError:
    BaseLLM = None
    LLMResponse = None
    GeminiLLM = None
    AnthropicLLM = None
    create_llm = None
    create_llm_from_config = None
    get_available_providers = None
    LLM_ABSTRACTION_AVAILABLE = False

# Watchdog 监控（V2 新增）
from .watchdog import (
    WatchdogEvent,
    WatchdogAlert,
    StepWatchdog,
    NetworkWatchdog,
    AgentWatchdog,
    create_agent_watchdog,
)

# 错误分类（V2 新增）
from .errors import (
    ErrorCategory,
    RecoveryAction,
    RecoveryStrategy,
    ClassifiedError,
    ErrorClassifier,
    get_error_classifier,
    classify_error,
    with_error_handling,
    DEFAULT_RECOVERY_STRATEGIES,
)

# 结构化日志（V2 新增）
from .logging_config import (
    StructuredFormatter,
    PrettyFormatter,
    ContextLogger,
    LogEvent,
    AgentLogger,
    get_agent_logger,
    configure_logging,
    create_agent_logger,
    log_performance,
)

# LLM 重试机制（V2 新增）
from .llm_retry import (
    RetryConfig,
    RetryState,
    RetryResult,
    RetryDecision,
    LLMRetryHandler,
    with_llm_retry,
    with_rate_limit_retry,
    get_llm_retry_handler,
    execute_with_retry,
    create_retry_handler,
)

# 性能监控（V2 新增）
from .performance_monitor import (
    TimingMetric,
    PerformanceSnapshot,
    PerformanceMonitor,
    Timer,
    AsyncTimer,
    get_performance_monitor,
    create_performance_monitor,
)

__all__ = [
    # Types
    "ActionType",
    "AgentAction",
    "AgentState",
    "ErrorType",
    "TaskResult",
    "TaskContext",
    # State Management (V2)
    "ExecutionState",
    "AgentStateData",
    "StepMetadata",
    "StateActionResult",
    "StepRecord",
    "create_state",
    # Message Manager (V2)
    "MessageManager",
    "Message",
    # Action Registry (V2)
    "ActionRegistry",
    "ActionMetadata",
    "RegistryActionResult",
    "action",
    "get_registry",
    "is_terminal_action",
    "is_navigation_action",
    "is_input_action",
    # Action Models (V2)
    "ActionParams",
    "ClickParams",
    "FillParams",
    "TypeParams",
    "PressParams",
    "ScrollParams",
    "WaitParams",
    "NavigateParams",
    "ValidationError",
    "get_params_class",
    "create_params",
    # Classes
    "AIBrowserAgent",
    "VisionAnalyzer",
    "ActionExecutor",
    "ElementFinder",  # V2 新增
    # Element Marker (SoM)
    "ElementMarker",
    "MarkedElement",
    # Screenshot Manager
    "ScreenshotManager",
    "ScreenshotResult",
    "ElementCache",   # V2 新增
    "SoMStats",       # V2 新增
    # CDP Service (V2)
    "CDPDOMService",
    "DOMNode",
    "AccessibilityNode",
    "create_cdp_service",
    "CDP_SERVICE_AVAILABLE",
    # Enhanced Marker (V2)
    "EnhancedElementMarker",
    "ExtractionResult",
    "create_enhanced_marker",
    "css_to_device_coords",
    "device_to_css_coords",
    "ENHANCED_MARKER_AVAILABLE",
    # V2.3: Clickable Detector (借鉴 browser-use)
    "ClickableElementDetector",
    "InteractivityResult",
    "get_clickable_detector",
    "create_clickable_detector",
    "is_element_clickable",
    "detect_interactivity",
    "CLICKABLE_DETECTOR_AVAILABLE",
    # LLM Abstraction
    "BaseLLM",
    "LLMResponse",
    "GeminiLLM",
    "AnthropicLLM",
    "create_llm",
    "create_llm_from_config",
    "get_available_providers",
    "LLM_ABSTRACTION_AVAILABLE",
    # Watchdog (V2)
    "WatchdogEvent",
    "WatchdogAlert",
    "StepWatchdog",
    "NetworkWatchdog",
    "AgentWatchdog",
    "create_agent_watchdog",
    # Error Classification (V2)
    "ErrorCategory",
    "RecoveryAction",
    "RecoveryStrategy",
    "ClassifiedError",
    "ErrorClassifier",
    "get_error_classifier",
    "classify_error",
    "with_error_handling",
    "DEFAULT_RECOVERY_STRATEGIES",
    # Logging (V2)
    "StructuredFormatter",
    "PrettyFormatter",
    "ContextLogger",
    "LogEvent",
    "AgentLogger",
    "get_agent_logger",
    "configure_logging",
    "create_agent_logger",
    "log_performance",
    # LLM Retry (V2)
    "RetryConfig",
    "RetryState",
    "RetryResult",
    "RetryDecision",
    "LLMRetryHandler",
    "with_llm_retry",
    "with_rate_limit_retry",
    "get_llm_retry_handler",
    "execute_with_retry",
    "create_retry_handler",
    # Performance Monitor (V2)
    "TimingMetric",
    "PerformanceSnapshot",
    "PerformanceMonitor",
    "Timer",
    "AsyncTimer",
    "get_performance_monitor",
    "create_performance_monitor",
]
