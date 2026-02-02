# automation Module

> [Root](../CLAUDE.md) > **automation**

## Overview

AI Agent automation scripts module. Contains high-level automation workflows that combine ixBrowser window management, AI browser agent (supporting Gemini and Anthropic/Claude), and database operations.

## Module Structure

```
automation/
├── __init__.py                  # Module initialization
├── auto_bind_card_ai.py         # AI-powered card binding
├── auto_get_sheerlink_ai.py     # AI-powered SheerID link retrieval
├── auto_modify_2sv_phone.py     # Modify 2-Step Verification phone
├── auto_modify_authenticator.py # Modify Google Authenticator
├── auto_replace_email.py        # Replace recovery email
├── auto_replace_phone.py        # Replace recovery phone
├── auto_kick_devices.py         # Remove logged-in devices
└── auto_subscribe.py            # Auto subscribe to Google One
```

## Components

### Script Pattern

All automation scripts follow a consistent pattern:

```python
async def auto_xxx(
    browser_id: str,
    account: dict,       # {'email', 'password', 'secret', 'recovery_email'}
    params: dict = None, # Task-specific parameters
    callback: Callable = None,  # Progress callback
    api_key: str = None,       # API key (default from config)
    base_url: str = None,      # Base URL (for third-party services)
    model: str = None,         # Model name (default from config)
    provider: str = None,      # LLM provider (gemini/anthropic)
) -> TaskResult:
    """
    Execute automation task.

    Returns:
        TaskResult with success/failure status and data
    """
```

### Available Scripts

| Script | Description | Task Type |
|--------|-------------|-----------|
| `auto_bind_card_ai.py` | Bind payment card to Google One | `bind_card` |
| `auto_get_sheerlink_ai.py` | Get SheerID verification link | `get_sheerlink` |
| `auto_modify_2sv_phone.py` | Modify 2SV phone number | `modify_2sv_phone` |
| `auto_modify_authenticator.py` | Add/replace Google Authenticator | `modify_authenticator` |
| `auto_replace_email.py` | Replace recovery email | `replace_recovery_email` |
| `auto_replace_phone.py` | Replace recovery phone | `replace_recovery_phone` |
| `auto_kick_devices.py` | Remove all logged-in devices | `kick_devices` |
| `auto_subscribe.py` | Subscribe to Google One plan | `subscribe` |

## Usage Example

```python
import asyncio
from automation.auto_bind_card_ai import auto_bind_card_ai

async def main():
    result = await auto_bind_card_ai(
        browser_id="12345",
        account={
            "email": "user@gmail.com",
            "password": "password123",
            "secret": "2FA_SECRET_KEY",
        },
        params={
            "card": {
                "number": "4111111111111111",
                "exp_month": "12",
                "exp_year": "2028",
                "cvv": "123",
                "name": "John Doe",
                "zip_code": "10001"
            }
        },
        callback=lambda msg: print(msg)
    )

    if result.success:
        print("Card bound successfully!")
    else:
        print(f"Failed: {result.message}")

asyncio.run(main())
```

## Dependencies

- **Internal**:
  - `core/ai_browser_agent/` - AI vision and action execution
  - `services/ix_api.py` - ixBrowser window management
  - `services/database.py` - Data persistence
  - `core/config_manager.py` - Configuration
- **External**: playwright, asyncio

## Error Handling

All scripts return `TaskResult` objects with:
- `success: bool` - Whether the task completed successfully
- `message: str` - Human-readable result description
- `state: AgentState` - Final agent state
- `total_steps: int` - Number of steps executed
- `data: dict` - Task-specific result data
- `error_type: ErrorType` - Type of error (if failed)

## Best Practices

1. **Always use callback for progress**: GUI needs real-time feedback
2. **Handle TaskResult properly**: Check `result.success` before proceeding
3. **Respect rate limits**: Add delays between operations
4. **Update database on completion**: Call DBManager methods after success

---

*Generated: 2026-02-02*
