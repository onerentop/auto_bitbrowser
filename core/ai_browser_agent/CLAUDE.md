# AI Browser Agent

> [Root](../../CLAUDE.md) > [core](../CLAUDE.md) > **ai_browser_agent**

## Overview

Multi-LLM Vision-based universal AI browser automation agent. Analyzes page screenshots intelligently, makes decisions, and executes browser operations without maintaining fragile CSS selectors.

**Supported LLM Providers**:
- **Gemini** (Google) - via OpenAI-compatible API
- **Anthropic/Claude** (Official and Third-party services like OpenRouter, Together)

## Architecture

```
+-------------------------------------------------------------+
|              AI Browser Agent                               |
+-------------------------------------------------------------+
|                                                             |
|   +-----------------------------------------------------+   |
|   |          LLM Abstraction Layer (llm/)               |   |
|   |  - BaseLLM Protocol                                 |   |
|   |  - GeminiLLM: OpenAI SDK compatible                 |   |
|   |  - AnthropicLLM: Native + Third-party API support   |   |
|   |  - Factory: create_llm(provider, ...)               |   |
|   +-------------------------+---------------------------+   |
|                             |                               |
|   +-----------------------------------------------------+   |
|   |          ScreenshotManager                           |   |
|   |  - Unified screenshot capture entry point            |   |
|   |  - Optional SoM (Set-of-Mark) element marking        |   |
|   |  - Screenshot compression support                    |   |
|   +-------------------------+---------------------------+   |
|                             |                               |
|                             v                               |
|   +-----------------------------------------------------+   |
|   |              VisionAnalyzer                          |   |
|   |  - Uses LLM abstraction layer                        |   |
|   |  - Analyzes page screenshots + element summaries     |   |
|   |  - Enhanced JSON parsing with auto-repair            |   |
|   +-------------------------+---------------------------+   |
|                             |                               |
|                             v                               |
|   +-----------------------------------------------------+   |
|   |              ActionExecutor                          |   |
|   |  - Executes Playwright operations                    |   |
|   |  - Supports element ID [N] targeting from SoM        |   |
|   |  - Optimized page stability detection                |   |
|   +-----------------------------------------------------+   |
|                                                             |
+-------------------------------------------------------------+
```

## Module Structure

```
core/ai_browser_agent/
├── __init__.py           # Module exports
├── types.py              # Type definitions (ActionType, AgentAction, TaskResult, etc.)
├── prompts.py            # AI prompt templates with SoM support
├── vision_analyzer.py    # Multi-LLM Vision integration (enhanced JSON parsing)
├── action_executor.py    # Playwright action executor (element ID support)
├── element_marker.py     # SoM element marker for visual grounding
├── screenshot_manager.py # Unified screenshot + SoM manager
├── retry_strategy.py     # Unified retry strategy with error classification
├── agent.py              # AIBrowserAgent core class (three-layer architecture)
├── state.py              # V2: Agent state management
├── message_manager.py    # V2: Conversation history management
├── action_registry.py    # V2: Action decorator registration
├── action_models.py      # V2: Parameter validation models
├── actions.py            # V2: Registered action handlers
├── errors.py             # V2: Error classification and recovery
├── watchdog.py           # V2: Watchdog monitoring system
├── logging_config.py     # V2: Structured logging
├── llm_retry.py          # V2: LLM retry mechanism
├── cdp_service.py        # V2: CDP DOM service
├── element_marker_v2.py  # V2: Enhanced element marker with DPR
├── clickable_detector.py # V2.3: Multi-layer clickable element detector
├── element_finder.py     # V2: Element finder with CDP support
├── performance_monitor.py # V2: Performance monitoring
└── llm/                  # LLM Abstraction Layer
    ├── __init__.py       # Exports: BaseLLM, create_llm, etc.
    ├── base.py           # BaseLLM Protocol, LLMResponse dataclass
    ├── gemini.py         # GeminiLLM implementation (OpenAI SDK)
    ├── anthropic.py      # AnthropicLLM implementation (Native + Third-party)
    └── factory.py        # create_llm() factory function
```

## Components

### ScreenshotManager (screenshot_manager.py) 🆕

Unified screenshot capture entry point with optional SoM (Set-of-Mark) element marking.

**Key Features**:
- Configurable SoM element extraction
- Screenshot compression for cost optimization
- Element summary generation for AI prompts
- Element lookup by ID

**Usage**:
```python
from core.ai_browser_agent import ScreenshotManager, ScreenshotResult

manager = ScreenshotManager(
    use_som=True,           # Enable element marking
    compress=False,         # Compress screenshot
    max_elements=30,        # Max elements in summary
)

result: ScreenshotResult = await manager.capture(page)
# result.screenshot: bytes (PNG)
# result.elements: List[MarkedElement]
# result.elements_summary: str (for AI prompt)
```

### AIBrowserAgent (agent.py)

Core agent class that integrates vision analysis and action execution.

**Key Methods**:
| Method | Description |
|--------|-------------|
| `execute_task(page, goal, ...)` | Execute automation task on given page |
| `on_action(callback)` | Set action callback |
| `on_step(callback)` | Set step callback |
| `on_screenshot(callback)` | Set screenshot callback |
| `stop()` | Request execution stop |

**New Parameters**:
| Parameter | Default | Description |
|-----------|---------|-------------|
| `use_som` | `True` | Enable SoM element marking |
| `compress_screenshot` | `False` | Enable screenshot compression |

**Convenience Function**:
```python
from core.ai_browser_agent.agent import run_with_ixbrowser

result = await run_with_ixbrowser(
    browser_id="xxx",
    goal="Modify 2SV phone number",
    start_url="https://...",
    account={"email": "...", "password": "...", "secret": "..."},
    params={"new_phone": "+1234567890"},
    task_type="modify_2sv_phone",
    email_imap_config={"email": "...", "password": "..."},  # For auto verification code
)
```

### VisionAnalyzer (vision_analyzer.py)

Multi-LLM Vision API wrapper supporting Gemini and Anthropic/Claude.

**Key Methods**:
| Method | Description |
|--------|-------------|
| `analyze(screenshot, context, task_type, elements_summary)` | Analyze screenshot and return action decision |
| `test_connection()` | Test API connection |
| `from_config(config)` | Create from ConfigManager config |

**Constructor Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `api_key` | str | API Key (auto from config/env) |
| `base_url` | str | Base URL (for third-party services) |
| `model` | str | Model name |
| `provider` | str | Provider: "gemini" or "anthropic" |
| `llm` | BaseLLM | Pre-created LLM instance |

**Features**:
- Multi-provider support (Gemini, Anthropic)
- Auto-detect provider from API key prefix
- Third-party Claude API support via base_url
- `elements_summary` parameter for SoM integration
- Enhanced JSON parsing with auto-repair

**Environment Variables**:
- `GEMINI_API_KEY`: Gemini API key
- `ANTHROPIC_API_KEY`: Anthropic API key

### LLM Abstraction Layer (llm/)

Unified interface for multiple LLM providers.

**Components**:

| Component | Description |
|-----------|-------------|
| `BaseLLM` | Protocol defining LLM interface |
| `LLMResponse` | Standardized response dataclass |
| `GeminiLLM` | Gemini implementation (OpenAI SDK) |
| `AnthropicLLM` | Anthropic implementation (Native API) |
| `create_llm()` | Factory function |

**Usage**:
```python
from core.ai_browser_agent import create_llm, LLM_ABSTRACTION_AVAILABLE

# Create Gemini LLM
gemini = create_llm(
    provider="gemini",
    api_key="your-api-key",
    model="gemini-2.5-flash",
)

# Create Anthropic LLM (official API)
claude = create_llm(
    provider="anthropic",
    api_key="sk-ant-xxx",
    model="claude-sonnet-4-20250514",
)

# Create with third-party service (OpenRouter)
openrouter = create_llm(
    provider="anthropic",
    api_key="your-openrouter-key",
    base_url="https://openrouter.ai/api/v1",
    model="anthropic/claude-3.5-sonnet",
)

# Test connection
success, message, details = gemini.test_connection()

# Analyze screenshot
response = await gemini.analyze_screenshot(
    screenshot=png_bytes,
    prompt="Describe the page",
    system_prompt="You are a browser agent",
)
print(response.content)
```

**LLMResponse Fields**:
| Field | Type | Description |
|-------|------|-------------|
| `content` | str | Response text |
| `usage` | dict | Token usage info |
| `model` | str | Model used |
| `finish_reason` | str | Completion reason |
| `raw_response` | Any | Original API response |

### ActionExecutor (action_executor.py)

Converts AI decisions into Playwright operations.

**New Features** (v2):
- Element ID `[N]` targeting from SoM markers
- Optimized `_wait_for_page_stable()` (~1.5s vs previous 4.5s)
- Coordinate fallback for element clicks

**Supported Actions**:
| ActionType | Description |
|------------|-------------|
| `CLICK` | Click element (supports ID/coordinate/description) |
| `FILL` | Fill input field |
| `TYPE` | Type character by character |
| `PRESS` | Press key |
| `SCROLL` | Scroll page |
| `WAIT` | Wait specified time |
| `NAVIGATE` | Navigate to URL |
| `REFRESH` | Refresh page |
| `DONE` | Task completed |
| `ERROR` | Error termination |
| `NEED_VERIFICATION` | Needs verification code |
| `EXTRACT_SECRET` | Extract authenticator secret |
| `EXTRACT_LINK` | Extract link from page |

### AgentRetryStrategy (retry_strategy.py) 🆕

Unified retry strategy with error classification and global budget.

**Features**:
- Error classification: NETWORK, API, ELEMENT, UNKNOWN
- Category-specific retry configs
- Global retry budget (default: 10)
- Exponential backoff

**Usage**:
```python
from core.ai_browser_agent.retry_strategy import AgentRetryStrategy, ErrorCategory

strategy = AgentRetryStrategy()

# Auto-retry with classification
success, result = await strategy.execute_with_retry(
    async_func, ErrorCategory.API, arg1, arg2
)

# Check remaining budget
print(f"Remaining retries: {strategy.remaining_budget}")
```

### Types (types.py)

**Key Types**:
- `ActionType` - Enum of all action types
- `AgentAction` - Action instruction with parameters
- `AgentState` - Agent execution state (IDLE, RUNNING, COMPLETED, FAILED, etc.)
- `TaskResult` - Task execution result
- `TaskContext` - Task context with account info and history
- `ErrorType` - Error classification (PASSWORD_ERROR, NEED_VERIFICATION, etc.)

## V2 New Modules

### State Management (state.py)

Agent state management with serialization support.

**Key Classes**:
- `ExecutionState` - Enum: IDLE, RUNNING, PAUSED, COMPLETED, FAILED, STOPPED
- `AgentStateData` - Comprehensive state dataclass with serialization
- `StepMetadata` - Step execution metadata
- `StepRecord` - Complete step execution record

**Usage**:
```python
from core.ai_browser_agent import create_state, ExecutionState

state = create_state(task_id="task-001", goal="Login to account")
state.start()
state.start_step(StepMetadata(step_number=1, ...))
state.end_step(success=True, action_result=result)
state_dict = state.to_dict()  # Serialize for persistence
```

### Message Manager (message_manager.py)

Manages conversation history for LLM context.

**Key Features**:
- Role-based messages (system, user, assistant)
- Token budget management with automatic trimming
- Image message support for multimodal LLMs

**Usage**:
```python
from core.ai_browser_agent import MessageManager

manager = MessageManager(max_history=20)
manager.add_system_message("You are a browser agent")
manager.add_user_message("Click the login button", images=[screenshot_bytes])
messages = manager.get_messages()  # For LLM API
```

### Action Registry (action_registry.py)

Decorator-based action handler registration.

**Key Features**:
- `@action()` decorator for handler registration
- Action metadata (timeout, retry, wait_after)
- Type-safe handler lookup

**Usage**:
```python
from core.ai_browser_agent import action, get_registry, ActionType

@action(ActionType.CLICK, requires_target=True, wait_after=0.5)
async def handle_click(page, action, elements=None, **kwargs):
    # Implementation
    pass

# Get registered handler
registry = get_registry()
handler = registry.get_handler(ActionType.CLICK)
result = await handler(page, action, elements=elements)
```

### Action Models (action_models.py)

Parameter validation using dataclasses.

**Key Classes**:
- `ClickParams` - Click action parameters
- `FillParams` - Fill action parameters
- `NavigateParams` - Navigation parameters
- `ValidationError` - Validation error info

**Usage**:
```python
from core.ai_browser_agent import create_params, ActionType

params = create_params(ActionType.CLICK, target="button#submit", x=100, y=200)
errors = params.validate()
if errors:
    print(f"Validation failed: {errors}")
```

### Error Classification (errors.py)

Automatic error classification with recovery strategies.

**Key Classes**:
- `ErrorCategory` - Error categories (NETWORK, LLM_API_ERROR, ELEMENT_NOT_FOUND, etc.)
- `RecoveryAction` - Recovery actions (RETRY, WAIT, REFRESH, ABORT, etc.)
- `ErrorClassifier` - Pattern-based error classifier

**Usage**:
```python
from core.ai_browser_agent import classify_error, with_error_handling

# Classify an exception
classified = classify_error(exception, context={"step": 5})
print(f"Category: {classified.category}, Recoverable: {classified.is_recoverable}")

# Decorator for automatic classification
@with_error_handling(on_error=lambda e: print(f"Error: {e.category}"))
async def my_function():
    ...
```

### Watchdog System (watchdog.py)

Multi-level monitoring for crash/timeout detection.

**Key Classes**:
- `StepWatchdog` - Step-level timeout monitoring
- `NetworkWatchdog` - Network request monitoring
- `AgentWatchdog` - Comprehensive agent monitoring

**Usage**:
```python
from core.ai_browser_agent import create_agent_watchdog

watchdog = create_agent_watchdog(step_timeout=120.0)
watchdog.start()

watchdog.start_step(step_number=1)
# ... execute step ...
watchdog.end_step(success=True)

health = watchdog.check_health()
print(f"Healthy: {watchdog.is_healthy}")
```

### Structured Logging (logging_config.py)

Agent-specific logging with structured output.

**Key Classes**:
- `AgentLogger` - Specialized logger with event tracking
- `StructuredFormatter` - JSON format output
- `PrettyFormatter` - Human-readable colored output

**Usage**:
```python
from core.ai_browser_agent import get_agent_logger, configure_logging

# Configure global logging
configure_logging(level=logging.DEBUG, structured=False, use_colors=True)

# Get logger
logger = get_agent_logger()
logger.task_start("task-001", "Login to Google")
logger.step_start(1, "Navigate to login page")
logger.action_start("CLICK", "Login button")
logger.action_end("CLICK", success=True, duration_ms=150.5)
logger.step_end(success=True, duration_ms=2500.0)
logger.task_end(success=True, total_steps=5, total_duration_ms=15000.0)
```

### LLM Retry (llm_retry.py)

Intelligent retry mechanism for LLM API calls.

**Key Classes**:
- `RetryConfig` - Retry configuration
- `LLMRetryHandler` - Smart retry with error classification
- `RetryResult` - Retry execution result

**Usage**:
```python
from core.ai_browser_agent import create_retry_handler, with_llm_retry

# Using handler
handler = create_retry_handler(max_retries=3, base_delay=2.0)
result = await handler.execute_with_retry(llm_call_func, arg1, arg2)
if result.success:
    print(f"Success after {result.attempts} attempts")

# Using decorator
@with_llm_retry(max_retries=5, base_delay=1.0)
async def call_llm(prompt):
    return await llm.analyze(prompt)
```

### CDP Service (cdp_service.py)

Chrome DevTools Protocol integration for efficient DOM operations.

**Key Features**:
- DOM snapshot capture
- Accessibility tree extraction
- DPR (Device Pixel Ratio) coordinate conversion

**Usage**:
```python
from core.ai_browser_agent import create_cdp_service

service = await create_cdp_service(page)
snapshot = await service.get_dom_snapshot()
ax_elements = await service.get_interactive_elements_via_ax()
css_x, css_y = service.convert_to_css_coords(device_x, device_y)
await service.close()
```

### Enhanced Element Marker (element_marker_v2.py)

Element extraction with CDP support and DPR conversion.

**Key Features**:
- Hybrid extraction: CDP + JS fallback
- Automatic DPR coordinate conversion
- Accessibility tree integration

**Usage**:
```python
from core.ai_browser_agent import create_enhanced_marker

marker = create_enhanced_marker(use_cdp=True, dpr_aware=True)
result = await marker.extract_elements_v2(page, include_ax_tree=True)
print(f"Extracted {len(result.elements)} elements via {result.method}")
print(f"DPR: {result.dpr}, Viewport: {result.viewport_width}x{result.viewport_height}")
```

### Performance Monitor (performance_monitor.py)

Runtime performance metrics collection and analysis.

**Key Features**:
- Step execution timing statistics
- LLM API call latency tracking
- SoM element extraction performance
- Performance report generation

**Usage**:
```python
from core.ai_browser_agent import (
    PerformanceMonitor,
    create_performance_monitor,
    Timer,
)

monitor = create_performance_monitor()
monitor.start_session()

# Record metrics
with Timer(monitor, "llm_call") as t:
    result = await llm.call(prompt)
print(f"LLM call: {t.duration_ms:.1f}ms")

monitor.record_step(success=True, duration_ms=500.0, step_number=1)
monitor.record_som_extraction(duration_ms=150.0, elements_count=25)

# Generate report
print(monitor.get_report())
monitor.end_session()
```

## V2.3 New Modules (Browser-Use Integration)

V2.3 引入了借鉴 browser-use 项目的 Backend Node ID 系统，提供更精确的元素点击能力。

### Clickable Element Detector (clickable_detector.py)

多层启发式可交互元素检测器，借鉴 browser-use 的设计。

**检测层级**:
1. 标签白名单 (button, a, input, etc.)
2. ARIA 角色 (role="button", role="link", etc.)
3. 事件属性 (onclick, onmousedown, etc.)
4. CSS cursor 样式 (pointer, grab, etc.)
5. contenteditable 属性
6. tabindex 属性
7. 自定义组件属性 (data-*, ng-click, etc.)

**Usage**:
```python
from core.ai_browser_agent import (
    ClickableElementDetector,
    create_clickable_detector,
    is_element_clickable,
    detect_interactivity,
)

# 创建检测器
detector = create_clickable_detector()

# 检测元素可交互性
result = detector.detect(
    tag="button",
    attributes={"role": "button", "onclick": "submit()"},
    computed_style={"cursor": "pointer"},
)

print(f"Interactive: {result.is_interactive}")
print(f"Clickable: {result.is_clickable}")
print(f"Confidence: {result.confidence}")
print(f"Reasons: {result.detection_reasons}")

# 便捷函数
is_clickable = is_element_clickable("button", {"type": "submit"})
interactivity = detect_interactivity("a", {"href": "/page"})
```

### Backend Node ID Support (CDP Enhanced)

V2.3 扩展了 MarkedElement 和 CDP 服务以支持 Backend Node ID 点击。

**MarkedElement 新增字段**:
| Field | Type | Description |
|-------|------|-------------|
| `backend_node_id` | int | CDP Backend Node ID（用于精确点击）|
| `node_id` | int | CDP Node ID（会话内有效）|
| `is_clickable` | bool | 是否可点击（多层检测结果）|
| `cursor_style` | str | CSS cursor 样式 |
| `has_event_listener` | bool | 是否有事件监听器 |

**CDP 服务新增方法**:
| Method | Description |
|--------|-------------|
| `click_by_backend_node_id(id)` | 通过 Backend Node ID 精确点击 |
| `focus_by_backend_node_id(id)` | 通过 Backend Node ID 聚焦 |
| `scroll_into_view_by_backend_node_id(id)` | 滚动到视图 |
| `get_center_by_backend_node_id(id)` | 获取中心坐标 |
| `resolve_node_id(backend_id)` | 解析为 Node ID |

**ActionExecutor 点击策略优先级** (V2.3):
1. CDP Backend Node ID 点击（如果元素有 backend_node_id）
2. Playwright Locator 点击
3. 坐标点击

**Usage**:
```python
from core.ai_browser_agent import ActionExecutor

# 启用 CDP 点击优先
executor = ActionExecutor(page, prefer_cdp_click=True)

# ActionExecutor 会自动按优先级尝试：
# 1. CDP Backend Node ID 点击
# 2. Playwright Locator 点击
# 3. 坐标点击
```

## Usage Examples

### Basic Usage with SoM

```python
import asyncio
from playwright.async_api import async_playwright
from core.ai_browser_agent import AIBrowserAgent

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        page = await browser.new_page()

        agent = AIBrowserAgent(
            use_som=True,              # Enable SoM element marking
            compress_screenshot=False,  # Keep high quality
        )
        result = await agent.execute_task(
            page=page,
            goal="Login to Google account",
            start_url="https://accounts.google.com",
            account={"email": "user@gmail.com", "password": "xxx"},
            max_steps=15,
        )

        print(f"Success: {result.success}, Message: {result.message}")
        await browser.close()

asyncio.run(main())
```

### With ixBrowser

```python
from core.ai_browser_agent.agent import run_with_ixbrowser

result = await run_with_ixbrowser(
    browser_id="your_browser_id",
    goal="Replace recovery email with backup@example.com",
    start_url="https://myaccount.google.com/recovery/email",
    account={"email": "user@gmail.com", "password": "xxx", "secret": "2FA_SECRET"},
    params={"new_email": "backup@example.com"},
    task_type="replace_recovery_email",
    close_after=True,
)
```

## Task Types

Predefined task types with specific prompts:

| Task Type | Description |
|-----------|-------------|
| `modify_2sv_phone` | Modify 2-Step Verification phone |
| `replace_recovery_email` | Replace recovery email |
| `replace_recovery_phone` | Replace recovery phone |
| `modify_authenticator` | Add/modify Google Authenticator |
| `bind_card` | Bind payment card |
| `get_sheerlink` | Get SheerID verification link |
| `kick_devices` | Remove logged-in devices |

## Configuration

All settings configurable via `ConfigManager`:

```python
from core import ConfigManager

# Get AI Agent settings
ConfigManager.get("ai_agent.use_som", True)
ConfigManager.get("ai_agent.max_steps", 25)
ConfigManager.get("ai_agent.timeouts.api_call", 30000)
ConfigManager.get("ai_agent.delays.screenshot", 2.0)
```

**Default ai_agent config**:
```json
{
  "default_provider": "gemini",
  "providers": {
    "gemini": {
      "enabled": true,
      "api_key": "",
      "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
      "model": "gemini-2.5-flash",
      "timeout": 60
    },
    "anthropic": {
      "enabled": true,
      "api_key": "",
      "base_url": "",
      "model": "claude-sonnet-4-20250514",
      "timeout": 60
    }
  },
  "max_steps": 25,
  "max_tokens": 8192,
  "use_som": true,
  "compress_screenshot": false,
  "max_elements": 30,
  "timeouts": {
    "operation": 10000,
    "navigation": 60000,
    "api_call": 30000
  },
  "delays": {
    "screenshot": 2.0,
    "after_click": 1.5,
    "min_page_stable": 0.3
  }
}
```

## Exports

```python
from core.ai_browser_agent import (
    # Core Classes
    AIBrowserAgent,
    VisionAnalyzer,
    ActionExecutor,
    ScreenshotManager,
    ElementMarker,

    # LLM Abstraction
    BaseLLM,
    LLMResponse,
    GeminiLLM,
    AnthropicLLM,
    create_llm,
    create_llm_from_config,
    get_available_providers,
    LLM_ABSTRACTION_AVAILABLE,

    # Types
    ActionType,
    AgentAction,
    AgentState,
    TaskResult,
    TaskContext,
    ScreenshotResult,
    MarkedElement,
    ErrorType,

    # V2: State Management
    ExecutionState,
    AgentStateData,
    StepMetadata,
    StepRecord,
    create_state,

    # V2: Message Manager
    MessageManager,
    Message,

    # V2: Action Registry
    ActionRegistry,
    ActionMetadata,
    action,
    get_registry,
    is_terminal_action,

    # V2: Action Models
    ClickParams,
    FillParams,
    NavigateParams,
    ValidationError,
    create_params,

    # V2: Error Classification
    ErrorCategory,
    RecoveryAction,
    ClassifiedError,
    ErrorClassifier,
    classify_error,
    with_error_handling,

    # V2: Watchdog
    WatchdogEvent,
    WatchdogAlert,
    AgentWatchdog,
    create_agent_watchdog,

    # V2: Structured Logging
    AgentLogger,
    get_agent_logger,
    configure_logging,
    log_performance,

    # V2: LLM Retry
    RetryConfig,
    LLMRetryHandler,
    RetryResult,
    with_llm_retry,
    create_retry_handler,

    # V2: CDP Service
    CDPDOMService,
    create_cdp_service,
    CDP_SERVICE_AVAILABLE,

    # V2: Enhanced Marker
    EnhancedElementMarker,
    ExtractionResult,
    create_enhanced_marker,
    css_to_device_coords,
    ENHANCED_MARKER_AVAILABLE,

    # V2: Performance Monitor
    PerformanceMonitor,
    TimingMetric,
    Timer,
    AsyncTimer,
    get_performance_monitor,
    create_performance_monitor,

    # V2.3: Clickable Detector (借鉴 browser-use)
    ClickableElementDetector,
    InteractivityResult,
    get_clickable_detector,
    create_clickable_detector,
    is_element_clickable,
    detect_interactivity,
    CLICKABLE_DETECTOR_AVAILABLE,
)
```

## Dependencies

- **openai**: OpenAI compatible API client (for Gemini)
- **anthropic**: Anthropic API client (for Claude)
- **playwright**: Browser automation
- **Pillow**: Image processing (for compression)

```bash
pip install openai anthropic playwright Pillow
```

## Third-Party Claude API Services

The AnthropicLLM supports third-party services via custom `base_url`:

| Service | Base URL | Notes |
|---------|----------|-------|
| OpenRouter | `https://openrouter.ai/api/v1` | Models: `anthropic/claude-3.5-sonnet` |
| Together AI | `https://api.together.xyz/v1` | Partial Claude support |
| Custom Proxy | Custom URL | Any Anthropic API compatible service |

**GUI Configuration**:
1. Open Settings → AI Agent Configuration
2. Switch to Anthropic/Claude tab
3. Enter third-party API Key
4. Enter Base URL
5. Select/enter model name
6. Click "Test Anthropic Connection"

---

*Updated: 2026-02-03 - Added V2.3 modules: clickable_detector (browser-use Backend Node ID integration), enhanced CDP service methods, ActionExecutor CDP click priority*
