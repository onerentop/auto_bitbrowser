# gui Module

> [Root](../CLAUDE.md) > **gui**

## Overview

PyQt6-Fluent-Widgets GUI windows module. Contains all user interface components for the ixBrowser Automation Tool with modern Windows 11 Fluent Design style.

## Module Structure

```
gui/
├── __init__.py                  # Module initialization and exports
├── main_window_fluent.py        # FluentWindow main application window
├── main_window.py               # Legacy main window (preserved)
├── fluent_utils.py              # Fluent UI utility functions
├── base_interface.py            # Base classes for all interfaces
├── ai_task_interface.py         # Base class for AI task interfaces
├── placeholder_interface.py     # Placeholder for unimplemented features
│
├── home_interface.py            # Home - window management
├── setting_interface.py         # Settings configuration
├── sheerid_interface.py         # SheerID verification
├── bindcard_interface.py        # AI card binding
├── sheerlink_interface.py       # AI SheerLink retrieval
├── replacephone_interface.py    # AI replace phone
├── replaceemail_interface.py    # AI replace email
├── modify2sv_interface.py       # AI modify 2SV phone
├── modifyauth_interface.py      # AI modify authenticator
├── kickdevices_interface.py     # AI kick devices
├── query_interface.py           # Comprehensive query
│
└── (legacy dialogs...)          # Original PyQt6 dialogs preserved
```

## Architecture

### FluentWindow Navigation Structure

```
MainFluentWindow (FluentWindow)
├── NavigationInterface (左侧导航栏)
│   ├── 首页 (HomeInterface)
│   ├── ─── 分隔线 ───
│   ├── SheerID 验证 (SheerIDInterface)
│   ├── 绑卡订阅 (BindCardInterface)
│   ├── 获取 SheerLink (GetSheerlinkInterface)
│   ├── 替换手机号 (ReplacePhoneInterface)
│   ├── 替换辅助邮箱 (ReplaceEmailInterface)
│   ├── 修改 2SV 手机 (Modify2SVInterface)
│   ├── 修改验证器 (ModifyAuthInterface)
│   ├── 踢出设备 (KickDevicesInterface)
│   ├── 综合查询 (QueryInterface)
│   ├── ─── 分隔线 ───
│   ├── 账号管理 (PlaceholderInterface)
│   ├── 全自动订阅 (PlaceholderInterface)
│   └── 设置 (SettingInterface) [底部]
└── StackedWidget (右侧内容区)
```

### Class Hierarchy

```
QFrame
├── BaseInterface
│   ├── HomeInterface
│   └── BaseDialogInterface
│       ├── PlaceholderInterface
│       └── AITaskInterface
│           ├── GetSheerlinkInterface
│           ├── ReplacePhoneInterface
│           ├── ReplaceEmailInterface
│           ├── Modify2SVInterface
│           ├── ModifyAuthInterface
│           └── KickDevicesInterface

ScrollArea
├── SettingInterface
├── SheerIDInterface
├── BindCardInterface
└── QueryInterface
```

## Components

### MainFluentWindow (main_window_fluent.py)

The main application window using FluentWindow with sidebar navigation.

**Key Features**:
- Left sidebar navigation with icons
- Theme support (Light/Dark/Auto)
- Persistent window configuration
- All sub-interfaces integrated

### Base Classes

| Class | File | Description |
|-------|------|-------------|
| `BaseInterface` | base_interface.py | Base for all sub-interfaces with common layout |
| `BaseDialogInterface` | base_interface.py | Base with start/stop buttons and progress |
| `AITaskInterface` | ai_task_interface.py | Template for AI automation tasks |

### Feature Interfaces

| Interface | File | Description |
|-----------|------|-------------|
| `HomeInterface` | home_interface.py | Browser window list management |
| `SettingInterface` | setting_interface.py | Application configuration |
| `SheerIDInterface` | sheerid_interface.py | SheerID batch verification |
| `BindCardInterface` | bindcard_interface.py | AI-powered card binding |
| `GetSheerlinkInterface` | sheerlink_interface.py | AI SheerID link retrieval |
| `ReplacePhoneInterface` | replacephone_interface.py | AI replace recovery phone |
| `ReplaceEmailInterface` | replaceemail_interface.py | AI replace recovery email |
| `Modify2SVInterface` | modify2sv_interface.py | AI modify 2SV phone |
| `ModifyAuthInterface` | modifyauth_interface.py | AI modify authenticator |
| `KickDevicesInterface` | kickdevices_interface.py | AI kick devices |
| `QueryInterface` | query_interface.py | Comprehensive account query |

## Component Mapping (PyQt6 → Fluent)

| Original | Fluent | Notes |
|----------|--------|-------|
| `QPushButton` | `PushButton` / `PrimaryPushButton` | Primary for main actions |
| `QLineEdit` | `LineEdit` / `SearchLineEdit` | SearchLineEdit for search |
| `QTextEdit` | `TextEdit` | Used in log areas |
| `QSpinBox` | `SpinBox` | Same API |
| `QCheckBox` | `CheckBox` | Same API |
| `QComboBox` | `ComboBox` | Same API |
| `QProgressBar` | `ProgressBar` / `ProgressRing` | Ring for indeterminate |
| `QGroupBox` | `CardWidget` | Card-based layout |
| `QTreeWidget` | `TreeWidget` | Enhanced styling |
| `QTableWidget` | `TableWidget` | Enhanced styling |
| `QMessageBox` | `MessageBox` / `InfoBar` | InfoBar for toast |

## Usage Example

```python
from gui import MainFluentWindow, run_fluent_app

# Run the application
if __name__ == "__main__":
    run_fluent_app()

# Or create window manually
from PyQt6.QtWidgets import QApplication
app = QApplication([])
window = MainFluentWindow()
window.show()
app.exec()
```

## Theme Support

```python
from qfluentwidgets import setTheme, Theme

# Switch theme
setTheme(Theme.DARK)   # Dark mode
setTheme(Theme.LIGHT)  # Light mode
setTheme(Theme.AUTO)   # Follow system
```

## Dependencies

- **Internal**: `automation/*`, `services/database.py`, `core/config_manager.py`
- **External**: PyQt6, PyQt6-Fluent-Widgets

## Thread Safety

GUI operations use `QThread` workers for background tasks to prevent UI freezing. Communication with workers uses Qt signals/slots.

---

*Updated: 2024 - Fluent UI Migration Complete*
