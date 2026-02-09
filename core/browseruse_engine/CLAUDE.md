# browseruse_engine Module

> [Root](../../CLAUDE.md) > [core](../CLAUDE.md) > **browseruse_engine**

## Overview

AI browser automation engine based on the browser-use architecture. Provides intelligent browser control through multi-step Agent loops, DOM element extraction, and multi-LLM support.

Implements `EngineProtocol` interface, allowing interchangeable use with `StagehandGoogleEngine`.

## Module Structure

```
browseruse_engine/
├── __init__.py           # Module exports
├── protocol.py           # EngineProtocol interface definition
├── types.py              # Data models (Actions, Agent, DOM, Browser)
├── engine.py             # Main BrowserUseEngine class
├── llm/                  # LLM adapters
│   ├── __init__.py       # LLM module exports
│   ├── base.py           # BaseChatModel abstract class
│   └── adapters.py       # OpenAI, Anthropic, Google adapters
├── dom/                  # DOM extraction
│   ├── __init__.py       # DOM module exports
│   ├── views.py          # DOMElement, DOMTree models
│   ├── service.py        # DOMService (JS extraction)
│   └── serializer.py     # DOM serialization
├── tools/                # Action system
│   ├── __init__.py       # Tools module exports
│   ├── registry.py       # ActionRegistry decorator
│   ├── actions.py        # Built-in actions
│   └── executor.py       # ActionExecutor
└── agent/                # Agent core
    ├── __init__.py       # Agent module exports
    ├── views.py          # AgentState, StepResult models
    ├── message_manager.py # LLM conversation history
    ├── service.py        # AgentService (main loop)
    └── prompts/          # Prompt templates
        ├── __init__.py       # PromptManager
        ├── system_prompt.md  # English system prompt
        └── system_prompt_zh.md # Chinese system prompt
```

## Quick Start

```python
from core.browseruse_engine import BrowserUseEngine

async def example():
    # Method 1: Connect to ixBrowser window (Recommended)
    engine = await BrowserUseEngine.connect_to_ixbrowser(
        browser_id="12345",
        llm_provider="google",
        llm_model="gemini-2.0-flash",
        llm_api_key="your-api-key",
    )

    try:
        # Execute multi-step task
        result = await engine.run(
            task="Open Google and search for Python tutorials",
            max_steps=20,
        )
        print(f"Success: {result.success}")
        print(f"Steps: {result.total_steps}")
    finally:
        await engine.stop()

    # Method 2: Use as context manager
    async with await BrowserUseEngine.connect_to_ixbrowser("12345") as engine:
        result = await engine.act("Click the login button")
```

## Core Components

### BrowserUseEngine (engine.py)

Main engine class implementing `EngineProtocol`.

**Connection Methods**:
| Method | Description |
|--------|-------------|
| `connect_to_ixbrowser(browser_id)` | Connect to existing ixBrowser window (Recommended) |
| `connect_cdp(ws_endpoint)` | Connect to CDP WebSocket endpoint |
| `start()` | Start in local mode (launches browser) |
| `stop()` | Close engine and cleanup |

**EngineProtocol Methods**:
| Method | Description | Returns |
|--------|-------------|---------|
| `navigate(url)` | Navigate to URL | `NavigationResult` |
| `act(instruction)` | Execute single-step instruction | `ActionResult` |
| `extract(instruction)` | Extract data from page | `ExtractResult` |
| `observe(instruction)` | Observe page elements | `ObserveResult` |
| `run(task, max_steps)` | Execute multi-step Agent task | `AgentResult` |

### AgentService (agent/service.py)

Core Agent loop implementation.

**Agent Loop**:
1. Get browser state (DOM + optional screenshot)
2. Build LLM prompt with state and history
3. Call LLM for decision (thinking + actions)
4. Execute action sequence
5. Record history and check completion
6. Repeat until done or max_steps

### DOMService (dom/service.py)

JavaScript-based DOM extraction.

**Key Features**:
- Extract interactive elements (buttons, inputs, links)
- Index elements for LLM reference
- Calculate visibility and bounding boxes
- Support screenshot capture

### ActionRegistry (tools/registry.py)

Decorator-based action registration.

**Built-in Actions**:
| Action | Description |
|--------|-------------|
| `navigate` | Navigate to URL |
| `click` | Click element by index |
| `input` | Input text into element |
| `scroll` | Scroll page |
| `extract` | Extract content |
| `screenshot` | Take screenshot |
| `wait` | Wait for milliseconds |
| `press_key` | Press keyboard key |
| `go_back` | Navigate back |
| `done` | Mark task complete |

### LLM Adapters (llm/adapters.py)

Multi-provider LLM support.

**Supported Providers**:
| Provider | Adapter | Models |
|----------|---------|--------|
| OpenAI | `OpenAIAdapter` | gpt-4o, gpt-4-turbo, gpt-3.5-turbo |
| Anthropic | `AnthropicAdapter` | claude-3-opus, claude-3-sonnet, claude-3-haiku |
| Google | `GoogleAdapter` | gemini-2.0-flash, gemini-1.5-pro |

## EngineProtocol

Unified interface for AI browser engines.

```python
from core.browseruse_engine import EngineProtocol

async def run_task(engine: EngineProtocol, task: str):
    """Works with both BrowserUseEngine and StagehandGoogleEngine"""
    result = await engine.run(task)
    return result
```

## Comparison with StagehandGoogleEngine

| Feature | BrowserUseEngine | StagehandGoogleEngine |
|---------|------------------|----------------------|
| Architecture | Agent loop with DOM extraction | Stagehand SDK wrapper |
| LLM Integration | Direct API calls | Through Stagehand |
| Action System | Custom registry | Stagehand actions |
| Prompts | Customizable templates | Stagehand prompts |
| Best For | Complex multi-step tasks | Google account operations |

## Usage Examples

```python
from core.browseruse_engine import (
    BrowserUseEngine,
    create_engine_from_config,
    EngineProtocol,
)

# 1. From configuration
async def example_from_config():
    engine = await create_engine_from_config()
    result = await engine.run("Search for Python tutorials")
    await engine.stop()

# 2. With custom LLM
async def example_custom_llm():
    engine = await BrowserUseEngine.connect_to_ixbrowser(
        browser_id="12345",
        llm_provider="anthropic",
        llm_model="claude-3-sonnet",
        llm_api_key="your-key",
    )
    result = await engine.run("Fill out the form")
    await engine.stop()

# 3. Single-step actions
async def example_single_step():
    async with await BrowserUseEngine.connect_to_ixbrowser("12345") as engine:
        await engine.navigate("https://google.com")
        await engine.act("Type 'hello' in the search box")
        await engine.act("Click the search button")

# 4. Extract data
async def example_extract():
    async with await BrowserUseEngine.connect_to_ixbrowser("12345") as engine:
        await engine.navigate("https://example.com/products")
        result = await engine.extract("Get all product names and prices")
        print(result.data)
```

## Exports

```python
from core.browseruse_engine import (
    # Main class
    BrowserUseEngine,
    create_engine,
    create_engine_from_config,

    # Protocol
    EngineProtocol,
    is_engine,

    # Result types
    NavigationResult,
    ActionResult,
    ExtractResult,
    ObserveResult,
    AgentResult,
    AgentStep,

    # Action models
    ActionModel,
    NavigateAction,
    ClickAction,
    InputAction,
    DoneAction,

    # Agent models
    AgentOutput,
    AgentConfig,

    # DOM models
    DOMElement,
    DOMTree,
    BrowserState,

    # LLM
    BaseChatModel,
    create_llm_adapter,
)
```

## Dependencies

- **Internal**: services.ix_api (optional, for ixBrowser)
- **External**: playwright, openai, anthropic, google-generativeai, pydantic

---

*Created: 2026-02-04 - Based on browser-use architecture*
