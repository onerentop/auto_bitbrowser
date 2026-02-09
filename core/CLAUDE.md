# core Module

> [Root](../CLAUDE.md) > **core**

## Overview

Core utilities module. Provides configuration management, intelligent retry framework, unified data parsing, **StagehandGoogleEngine** (AI browser agent for Google operations), **BrowserUseEngine** (general AI browser agent), and legacy AI Browser Agent (deprecated).

## Module Structure

```
core/
├── __init__.py           # Module exports
├── config_manager.py     # Configuration manager (singleton)
├── data_parser.py        # Unified data parser
├── retry_helper.py       # Intelligent retry framework
├── stagehand_engine/     # StagehandGoogleEngine (Google operations)
│   ├── __init__.py       # Module exports
│   ├── engine.py         # Main StagehandGoogleEngine class
│   ├── types.py          # Operation result types
│   └── operations/       # Operation implementations
│       ├── login.py          # Google login
│       ├── pro_status.py     # Pro status detection
│       ├── family.py         # Family status detection
│       ├── bind_card.py      # Card binding
│       ├── sheerlink.py      # SheerID link extraction
│       ├── kick_devices.py   # Device removal
│       ├── modify_2sv.py     # 2SV phone modification
│       ├── modify_auth.py    # Authenticator modification
│       ├── replace_email.py  # Recovery email replacement
│       ├── replace_phone.py  # Recovery phone replacement
│       ├── subscribe.py      # Subscription
│       ├── unlock_403.py     # 403 unlock
│       ├── join_family.py    # Join family group
│       ├── enable_sharing.py # Enable family sharing
│       └── oauth.py          # OAuth authorization
├── browseruse_engine/    # BrowserUseEngine (general AI browser control)
│   ├── __init__.py       # Module exports
│   ├── protocol.py       # EngineProtocol interface
│   ├── types.py          # Data models
│   ├── engine.py         # Main BrowserUseEngine class
│   ├── llm/              # LLM adapters (OpenAI, Anthropic, Google)
│   ├── dom/              # DOM extraction service
│   ├── tools/            # Action system (registry, executor)
│   └── agent/            # Agent core (service, prompts)
├── ai_browser_agent/     # [DEPRECATED] Legacy AI Browser Agent
│   └── CLAUDE.md         # Submodule documentation
└── totp_extractor/       # TOTP secret extraction
    ├── __init__.py       # Module exports
    ├── migration_decoder.py  # Google Authenticator Protobuf decoder
    └── qr_scanner.py     # QR code scanner (pyzbar)
```

## Submodule Navigation

| Submodule | Description | Status |
|-----------|-------------|--------|
| stagehand_engine | Stagehand-based Google account automation engine | ✅ RECOMMENDED for Google |
| browseruse_engine | Browser-use based general AI browser control | ✅ NEW - General tasks |
| ai_browser_agent | Multi-LLM Vision-based browser agent | ⚠️ DEPRECATED |
| totp_extractor | Extract TOTP secrets from Google Authenticator QR codes | ✅ Active |

## Engine Comparison

| Feature | StagehandGoogleEngine | BrowserUseEngine |
|---------|----------------------|------------------|
| Architecture | Stagehand SDK wrapper | Agent loop with DOM extraction |
| Best For | Google account operations | General web automation |
| Protocol | Implements EngineProtocol | Implements EngineProtocol |
| Interchangeable | ✅ Yes | ✅ Yes |

## BrowserUseEngine (New)

General-purpose AI browser automation engine based on browser-use architecture.

### Quick Start

```python
from core.browseruse_engine import BrowserUseEngine

async def example():
    # Connect to existing ixBrowser window
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
    finally:
        await engine.stop()
```

### EngineProtocol Methods

| Method | Description | Returns |
|--------|-------------|---------|
| `navigate(url)` | Navigate to URL | `NavigationResult` |
| `act(instruction)` | Execute single-step instruction | `ActionResult` |
| `extract(instruction)` | Extract data from page | `ExtractResult` |
| `observe(instruction)` | Observe page elements | `ObserveResult` |
| `run(task, max_steps)` | Execute multi-step Agent task | `AgentResult` |

## StagehandGoogleEngine (Google Operations)

The primary AI browser automation engine for Google account operations.

### Quick Start

```python
from core.stagehand_engine import StagehandGoogleEngine

async def example():
    # Connect to existing ixBrowser window
    engine = await StagehandGoogleEngine.connect_to_ixbrowser(
        browser_id="12345",
        model_name="google/gemini-2.5-flash",
        model_api_key="your-api-key",
    )

    try:
        # Execute operations
        result = await engine.bind_card(
            card_number="4111111111111111",
            card_exp="12/28",
            card_cvv="123",
        )
        print(f"Success: {result.success}")
    finally:
        await engine.stop()
```

### Available Operations

| Operation | Method | Returns |
|-----------|--------|---------|
| Login | `login()` | `LoginResult` |
| Pro Status | `detect_pro_status()` | `ProStatusResult` |
| Family Status | `detect_family_status()` | `FamilyStatusResult` |
| Bind Card | `bind_card()` | `BindCardResult` |
| Get SheerLink | `get_sheerlink()` | `SheerlinkResult` |
| Kick Devices | `kick_devices()` | `KickDevicesResult` |
| Modify 2SV Phone | `modify_2sv_phone()` | `ModifyPhoneResult` |
| Modify Authenticator | `modify_authenticator()` | `ModifyAuthenticatorResult` |
| Replace Recovery Email | `replace_recovery_email()` | `ReplaceEmailResult` |
| Replace Recovery Phone | `replace_recovery_phone()` | `ReplacePhoneResult` |
| Subscribe | `subscribe()` | `SubscribeResult` |
| Unlock 403 | `unlock_403()` | `UnlockResult` |
| Join Family | `join_family()` | `JoinFamilyResult` |
| Enable Family Sharing | `enable_family_sharing()` | `EnableSharingResult` |
| OAuth Authorize | `oauth_authorize()` | `OAuthResult` |

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
| `get_ai_api_key()` | Get decrypted AI API Key |
| `get_ai_default_provider()` | Get default AI provider |
| `get_ai_provider_api_key(provider)` | Get API key for specific provider |
| `get_ai_provider_model(provider)` | Get model name for specific provider |

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

# StagehandGoogleEngine (RECOMMENDED)
from core.stagehand_engine import StagehandGoogleEngine

engine = await StagehandGoogleEngine.connect_to_ixbrowser("12345")
result = await engine.kick_devices()
await engine.stop()
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
)

# StagehandGoogleEngine (recommended import for Google operations)
from core.stagehand_engine import (
    StagehandGoogleEngine,
    # Result types
    LoginResult, ProStatusResult, FamilyStatusResult,
    BindCardResult, SheerlinkResult, KickDevicesResult,
    ModifyPhoneResult, ModifyAuthenticatorResult,
    ReplaceEmailResult, ReplacePhoneResult,
    SubscribeResult, UnlockResult, JoinFamilyResult,
    EnableSharingResult, OAuthResult,
)

# BrowserUseEngine (recommended import for general tasks)
from core.browseruse_engine import (
    BrowserUseEngine,
    EngineProtocol,
    # Result types
    NavigationResult, ActionResult, ExtractResult,
    ObserveResult, AgentResult,
)
```

## Dependencies

- **Internal dependencies**: None (pure infrastructure module)
- **External usage**: Used by `automation/*`, `gui/*`, `services/*`
- **External packages**: stagehand, playwright, openai, anthropic, google-generativeai

---

*Updated: 2026-02-04 - Added BrowserUseEngine, StagehandGoogleEngine, deprecated ai_browser_agent*
