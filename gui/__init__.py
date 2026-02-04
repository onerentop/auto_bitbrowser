# GUI 模块
# 包含所有 PyQt6-Fluent-Widgets GUI 窗口组件

"""
Fluent Design GUI 模块

主要组件:
- MainFluentWindow: Fluent 风格主窗口
- HomeInterface: 首页 - 窗口管理
- SettingInterface: 设置界面（包含账号、卡片、代理、配置管理）
- SheerIDInterface: SheerID 验证界面
- BindCardInterface: 绑卡订阅界面
- GetSheerlinkInterface: 获取 SheerLink 界面
- ReplacePhoneInterface: 替换手机号界面
- ReplaceEmailInterface: 替换辅助邮箱界面
- Modify2SVInterface: 修改 2SV 手机界面
- ModifyAuthInterface: 修改身份验证器界面
- KickDevicesInterface: 踢出设备界面
- QueryInterface: 综合查询界面

数据管理模块 (gui.data_management):
- AccountsTab: 账号管理标签页
- CardsTab: 卡片管理标签页
- ProxiesTab: 代理管理标签页
- AccountBatchImportDialog: 账号批量导入对话框
- CardBatchImportDialog: 卡片批量导入对话框
- ProxyBatchImportDialog: 代理批量导入对话框
"""

# 主窗口
from gui.main_window_fluent import MainFluentWindow, run_fluent_app

# 基础组件
from gui.base_interface import BaseInterface, BaseDialogInterface
from gui.ai_task_interface import AITaskInterface
from gui.placeholder_interface import PlaceholderInterface

# 功能界面
from gui.home_interface import HomeInterface
from gui.setting_interface import SettingInterface
from gui.sheerid_interface import SheerIDInterface
from gui.bindcard_interface import BindCardInterface
from gui.sheerlink_interface import GetSheerlinkInterface
from gui.replacephone_interface import ReplacePhoneInterface
from gui.replaceemail_interface import ReplaceEmailInterface
from gui.modify2sv_interface import Modify2SVInterface
from gui.modifyauth_interface import ModifyAuthInterface
from gui.kickdevices_interface import KickDevicesInterface
from gui.query_interface import QueryInterface

# 工具函数
from gui.fluent_utils import (
    show_success, show_error, show_warning, show_info,
    confirm_dialog, info_dialog,
    get_feature_icon, get_app_icon,
    setup_fluent_theme, setup_theme_color,
)

__all__ = [
    # 主窗口
    'MainFluentWindow',
    'run_fluent_app',
    # 基础组件
    'BaseInterface',
    'BaseDialogInterface',
    'AITaskInterface',
    'PlaceholderInterface',
    # 功能界面
    'HomeInterface',
    'SettingInterface',
    'SheerIDInterface',
    'BindCardInterface',
    'GetSheerlinkInterface',
    'ReplacePhoneInterface',
    'ReplaceEmailInterface',
    'Modify2SVInterface',
    'ModifyAuthInterface',
    'KickDevicesInterface',
    'QueryInterface',
    # 工具函数
    'show_success',
    'show_error',
    'show_warning',
    'show_info',
    'confirm_dialog',
    'info_dialog',
    'get_feature_icon',
    'get_app_icon',
    'setup_fluent_theme',
    'setup_theme_color',
]
