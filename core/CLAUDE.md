# core Module

> [Root](../CLAUDE.md) > **core**

## Overview

Core utilities module. Provides configuration management, intelligent retry framework, unified data parsing, and the AI Browser Agent submodule.

## Module Structure

```
core/
├── __init__.py           # Module exports
├── config_manager.py     # Configuration manager (singleton)
├── data_parser.py        # Unified data parser
├── retry_helper.py       # Intelligent retry framework
└── ai_browser_agent/     # AI Browser Agent submodule
    └── CLAUDE.md         # Submodule documentation
```

## Submodule Navigation

| Submodule | Description | CLAUDE.md |
|-----------|-------------|-----------|
| ai_browser_agent | Multi-LLM Vision-based browser agent (Gemini, Anthropic) | [ai_browser_agent/CLAUDE.md](ai_browser_agent/CLAUDE.md) |

## Components

### ConfigManager (config_manager.py)

**Singleton** configuration manager with JSON file persistence.

**Key Features**:
- Nested key support: `ConfigManager.get("timeouts.page_load", 30)`
- Sensitive info encryption: Base64 + XOR obfuscation
- Thread-safe: Uses `threading.Lock`
- Auto-merge default config on load

**Key Methods**:
| Method | Description |
|--------|-------------|
| `load()` | Load config, create default if not exists |
| `get(key, default)` | Get config value (supports nested key) |
| `set(key, value)` | Set config value and auto-save |
| `get_api_key()` | Get decrypted SheerID API Key |
| `set_api_key(key)` | Encrypt and save API Key |
| `get_ai_api_key()` | Get decrypted AI API Key (backward compatible) |
| `set_ai_api_key(key)` | Encrypt and save AI API Key (backward compatible) |
| `get_ai_default_provider()` | Get default AI provider (gemini/anthropic) |
| `set_ai_default_provider(provider)` | Set default AI provider |
| `get_ai_provider_api_key(provider)` | Get API key for specific provider |
| `set_ai_provider_api_key(provider, key)` | Set API key for specific provider |
| `get_ai_provider_base_url(provider)` | Get base URL for specific provider |
| `get_ai_provider_model(provider)` | Get model name for specific provider |
| `get_llm_config(provider)` | Get full config for create_llm() |
| `reload()` | Force reload config from file |

**Default Config**:
```json
{
  "sheerid_api_key": "",
  "default_thread_count": 3,
  "timeouts": {
    "page_load": 30,
    "status_check": 20,
    "iframe_wait": 15
  },
  "delays": {
    "after_login": 3,
    "after_offer": 8,
    "after_add_card": 10,
    "after_save": 18
  },
  "proxy": {
    "max_windows_per_ip": 3
  },
  "ai_agent": {
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
    "max_tokens": 8192
  }
}
```

### DataParser (data_parser.py)

Unified account info parser ensuring consistent parsing logic across all modules.

**Supported Formats**:
- `email----password----recovery_email----2fa_secret`
- `link----email----password----recovery_email----2fa_secret`
- Auto-detect separators: `----`, `---`, `|`, `,`, `;`, `\t`

**Key Functions**:
| Function | Description |
|----------|-------------|
| `parse_account_line(line)` | Parse line -> (email, password, recovery, secret, link) |
| `build_account_line(...)` | Build account line string |

### RetryHelper (retry_helper.py)

Intelligent retry framework with exponential backoff.

**Key Classes**:
| Class | Description |
|-------|-------------|
| `RetryHelper` | Supports sync/async function retry |
| `FailedTaskQueue` | Failed task queue management (JSON persistence) |

**Configuration**:
- `max_retries`: Maximum retry attempts (default: 3)
- `base_delay`: Base delay seconds (default: 2.0)
- `backoff_factor`: Backoff multiplier (default: 2.0)
- `max_delay`: Maximum delay seconds (default: 60.0)

**Decorators**:
```python
from core import with_retry, with_retry_async

@with_retry(max_retries=3)
def my_function():
    ...

@with_retry_async(max_retries=3)
async def my_async_function():
    ...
```

## Usage Examples

```python
# Configuration management
from core import ConfigManager

timeout = ConfigManager.get("timeouts.page_load", 30)
ConfigManager.set("default_thread_count", 5)
api_key = ConfigManager.get_ai_api_key()

# Data parsing
from core import parse_account_line, build_account_line

email, pwd, rec, sec, link = parse_account_line("user@mail.com----pass----backup@mail.com----SECRET")
line = build_account_line(email, pwd, rec, sec)

# Retry framework
from core import RetryHelper, FailedTaskQueue

helper = RetryHelper(max_retries=3, base_delay=2.0)
result = await helper.execute_async(async_func, arg1, arg2)

# AI Browser Agent
from core import AIBrowserAgent, AI_BROWSER_AGENT_AVAILABLE

if AI_BROWSER_AGENT_AVAILABLE:
    agent = AIBrowserAgent()
```

## Exports

```python
from core import (
    # Configuration
    ConfigManager,
    # Retry
    RetryHelper, FailedTaskQueue, with_retry, with_retry_async,
    # Data parsing
    parse_account_line, build_account_line,
    # AI Browser Agent
    AIBrowserAgent, VisionAnalyzer, ActionExecutor,
    ActionType, AgentAction, AgentState, TaskResult, TaskContext,
    AI_BROWSER_AGENT_AVAILABLE,
)
```

## Dependencies

- **Internal dependencies**: None (pure infrastructure module)
- **External usage**: Used by `automation/*`, `gui/*`, `services/*`

---

*Updated: 2026-02-02*
