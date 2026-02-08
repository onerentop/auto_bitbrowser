# automation Module

> [Root](../CLAUDE.md) > **automation**

## Overview

AI Agent automation scripts module. Contains high-level automation workflows that combine ixBrowser window management, **StagehandGoogleEngine** (AI browser agent), and database operations.

## Module Structure

```
automation/
├── __init__.py                    # Module initialization
├── auto_bind_card_ai.py           # Card binding (StagehandGoogleEngine)
├── auto_get_sheerlink_ai.py       # SheerID link retrieval (StagehandGoogleEngine)
├── auto_modify_2sv_phone.py       # Modify 2-Step Verification phone (StagehandGoogleEngine)
├── auto_modify_authenticator.py   # Modify Google Authenticator (StagehandGoogleEngine)
├── auto_replace_recovery_email.py # Replace recovery email (StagehandGoogleEngine)
├── auto_replace_recovery_phone.py # Replace recovery phone (StagehandGoogleEngine)
├── auto_kick_devices.py           # Remove logged-in devices (StagehandGoogleEngine)
├── auto_subscribe.py              # Auto subscribe to Google One (StagehandGoogleEngine)
├── auto_unlock_403.py             # Unlock 403 with SMS verification (StagehandGoogleEngine)
├── auto_google_login.py           # Google login (StagehandGoogleEngine)
├── auto_antigravity_oauth.py      # Antigravity OAuth (StagehandGoogleEngine)
├── auto_join_family.py            # Join family group (StagehandGoogleEngine)
├── auto_enable_family_sharing.py  # Enable family sharing (StagehandGoogleEngine)
├── batch_account_processor.py     # Batch processing (orchestrator)
└── pro_status_detector.py         # Pro status detection (shared utility)
```

## Components

### Script Pattern (StagehandGoogleEngine)

Scripts using StagehandGoogleEngine follow this pattern:

```python
from core.stagehand_engine import StagehandGoogleEngine

async def auto_xxx(
    browser_id: str,
    account_info: dict,  # {'email', 'password', 'secret'}
    close_after: bool = False,
    api_key: str = None,
    model: str = None,
    provider: str = None,
) -> Tuple[bool, str]:
    """
    Execute automation task.

    Returns:
        (success: bool, message: str)
    """
    engine = await StagehandGoogleEngine.connect_to_ixbrowser(
        browser_id=browser_id,
        model_name=model_name,
        model_api_key=api_key,
        close_browser_on_exit=close_after,
    )

    try:
        result = await engine.xxx_operation()
        return result.success, result.message
    finally:
        await engine.stop(close_browser=close_after)
```

### Available Scripts

| Script | Description | Engine |
|--------|-------------|--------|
| `auto_bind_card_ai.py` | Bind payment card to Google One | StagehandGoogleEngine |
| `auto_get_sheerlink_ai.py` | Get SheerID verification link | StagehandGoogleEngine |
| `auto_modify_2sv_phone.py` | Modify 2SV phone number | StagehandGoogleEngine |
| `auto_modify_authenticator.py` | Add/replace Google Authenticator | StagehandGoogleEngine |
| `auto_replace_recovery_email.py` | Replace recovery email | StagehandGoogleEngine |
| `auto_replace_recovery_phone.py` | Replace recovery phone | StagehandGoogleEngine |
| `auto_kick_devices.py` | Remove all logged-in devices | StagehandGoogleEngine |
| `auto_subscribe.py` | Subscribe to Google One plan | StagehandGoogleEngine |
| `auto_unlock_403.py` | Unlock 403 with SMS verification | StagehandGoogleEngine |
| `auto_google_login.py` | Google account login | StagehandGoogleEngine |
| `auto_antigravity_oauth.py` | Antigravity OAuth authorization | StagehandGoogleEngine |
| `auto_join_family.py` | Join family group | StagehandGoogleEngine |
| `auto_enable_family_sharing.py` | Enable family sharing | StagehandGoogleEngine |

## Usage Example

```python
import asyncio
from automation.auto_bind_card_ai import auto_bind_card_ai

async def main():
    success, message = await auto_bind_card_ai(
        browser_id="12345",
        account_info={
            "email": "user@gmail.com",
            "password": "password123",
            "secret": "2FA_SECRET_KEY",
        },
        card_info={
            "number": "4111111111111111",
            "exp_month": "12",
            "exp_year": "2028",
            "cvv": "123",
            "name": "John Doe",
            "zip_code": "10001"
        },
        close_after=True,
    )

    if success:
        print("Card bound successfully!")
    else:
        print(f"Failed: {message}")

asyncio.run(main())
```

## Dependencies

- **Internal**:
  - `core/stagehand_engine/` - StagehandGoogleEngine (AI browser automation)
  - `services/ix_api.py` - ixBrowser window management
  - `services/database.py` - Data persistence
  - `core/config_manager.py` - Configuration
  - `services/sheerid_verifier.py` - SheerID API (for auto_subscribe)
  - `services/sms_bus_client.py` - SMS-Bus (for auto_unlock_403)
- **External**: stagehand, playwright, asyncio

## Error Handling

Scripts return operation-specific result types from `core.stagehand_engine.types`:
- `BindCardResult`, `SheerlinkResult`, `KickDevicesResult`
- `ModifyPhoneResult`, `ModifyAuthenticatorResult`
- `ReplaceEmailResult`, `ReplacePhoneResult`
- `SubscribeResult`, `UnlockResult`
- `LoginResult`, `OAuthResult`, `JoinFamilyResult`, `EnableSharingResult`

Common fields:
- `success: bool` - Whether the task completed successfully
- `message: str` - Human-readable result description
- `duration_ms: float` - Execution time in milliseconds
- `error: Optional[str]` - Error details (if failed)

## Best Practices

1. **Always handle engine cleanup**: Use try/finally to call `engine.stop()`
2. **Check result.success**: Before proceeding to next steps
3. **Use callback for progress**: GUI needs real-time feedback
4. **Update database on completion**: Call DBManager methods after success

---

*Updated: 2026-02-04 - Migrated to StagehandGoogleEngine*
