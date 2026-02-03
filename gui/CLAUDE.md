# gui Module

> [Root](../CLAUDE.md) > **gui**

## Overview

PyQt6 GUI windows module. Contains all user interface components for the ixBrowser Automation Tool.

## Module Structure

```
gui/
├── __init__.py                  # Module initialization
├── main_window.py               # Main application window
├── bind_card_ai_gui.py          # AI card binding dialog
├── get_sheerlink_ai_gui.py      # AI SheerLink retrieval dialog
├── modify_2sv_phone_gui.py      # 2SV phone modification dialog
├── modify_authenticator_gui.py  # Authenticator modification dialog
├── replace_phone_gui.py         # Replace recovery phone dialog
├── replace_email_v2_gui.py      # Replace recovery email V2 dialog
├── kick_devices_gui.py          # Kick devices dialog
├── comprehensive_query_gui.py   # Comprehensive account query dialog
├── config_ui.py                 # Configuration management dialog
├── sheerid_gui_v2.py            # SheerID verification dialog
└── import_totp_gui.py           # TOTP secret import dialog (Google Authenticator)
```

## Components

### MainWindow (main_window.py)

The main application window that serves as the entry point for all GUI operations.

**Key Features**:
- Menu-based navigation to all feature dialogs
- Account list display and management
- Status monitoring

### Feature Dialogs

| Dialog | File | Description |
|--------|------|-------------|
| `BindCardAIDialog` | bind_card_ai_gui.py | AI-powered card binding workflow |
| `GetSheerlinkAIDialog` | get_sheerlink_ai_gui.py | AI-powered SheerID link retrieval |
| `Modify2SVPhoneDialog` | modify_2sv_phone_gui.py | Modify 2-Step Verification phone |
| `ModifyAuthenticatorDialog` | modify_authenticator_gui.py | Modify Google Authenticator |
| `ReplacePhoneDialog` | replace_phone_gui.py | Replace recovery phone number |
| `ReplaceEmailV2Dialog` | replace_email_v2_gui.py | Replace recovery email (V2) |
| `KickDevicesDialog` | kick_devices_gui.py | Remove logged-in devices |
| `ComprehensiveQueryDialog` | comprehensive_query_gui.py | Query all account data |
| `ConfigDialog` | config_ui.py | Application configuration |
| `SheerIDDialogV2` | sheerid_gui_v2.py | SheerID batch verification |
| `ImportTOTPDialog` | import_totp_gui.py | Import TOTP secrets from Google Authenticator QR codes |

## Dialog Pattern

All dialogs follow a common pattern:

1. **Initialization**: Load accounts/data from DBManager
2. **User Input**: Collect parameters (thread count, target accounts, etc.)
3. **Execution**: Call corresponding automation script from `automation/`
4. **Progress Reporting**: Display progress via QProgressDialog or embedded log
5. **Result Handling**: Update database and refresh display

## Usage Example

```python
from PyQt6.QtWidgets import QApplication
from gui.main_window import MainWindow

app = QApplication([])
window = MainWindow()
window.show()
app.exec()
```

## Dependencies

- **Internal**: `automation/*`, `services/database.py`, `core/config_manager.py`
- **External**: PyQt6

## Thread Safety

GUI operations use `QThread` workers for background tasks to prevent UI freezing. Communication with workers uses Qt signals/slots.

---

*Generated: 2026-02-02*
