"""
Fluent UI 通用工具模块
提供 PyQt-Fluent-Widgets 的通用配置、样式和工具函数
"""
import os
import sys
from typing import Optional

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QIcon, QColor
from PyQt6.QtWidgets import QWidget

# PyQt-Fluent-Widgets 导入
from qfluentwidgets import (
    setTheme, Theme, setThemeColor,
    InfoBar, InfoBarPosition, InfoBarIcon,
    MessageBox,
    FluentIcon as FIF,
)


def resource_path(relative_path: str) -> str:
    """获取资源文件的绝对路径，兼容 PyInstaller 打包环境"""
    try:
        # PyInstaller 创建临时文件夹并将路径存储在 _MEIPASS
        base_path = sys._MEIPASS
    except Exception:
        # 回溯到项目根目录 (gui/ 的父目录)
        base_path = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    return os.path.join(base_path, relative_path)


def get_app_icon() -> QIcon:
    """获取应用图标"""
    icon_path = resource_path("beta-1.svg")
    if os.path.exists(icon_path):
        return QIcon(icon_path)
    return QIcon()


def setup_fluent_theme(theme: Theme = Theme.AUTO):
    """
    设置 Fluent 主题

    Args:
        theme: Theme.LIGHT, Theme.DARK, 或 Theme.AUTO (跟随系统)
    """
    setTheme(theme)


def setup_theme_color(color: str = "#E65100"):
    """
    设置主题强调色

    Args:
        color: 十六进制颜色值，默认为橙色
    """
    setThemeColor(QColor(color))


# ==================== InfoBar 工具函数 ====================

def show_success(parent: QWidget, title: str, content: str, duration: int = 2000):
    """显示成功消息"""
    InfoBar.success(
        title=title,
        content=content,
        orient=Qt.Orientation.Horizontal,
        isClosable=True,
        position=InfoBarPosition.TOP,
        duration=duration,
        parent=parent
    )


def show_error(parent: QWidget, title: str, content: str, duration: int = 3000):
    """显示错误消息"""
    InfoBar.error(
        title=title,
        content=content,
        orient=Qt.Orientation.Horizontal,
        isClosable=True,
        position=InfoBarPosition.TOP,
        duration=duration,
        parent=parent
    )


def show_warning(parent: QWidget, title: str, content: str, duration: int = 3000):
    """显示警告消息"""
    InfoBar.warning(
        title=title,
        content=content,
        orient=Qt.Orientation.Horizontal,
        isClosable=True,
        position=InfoBarPosition.TOP,
        duration=duration,
        parent=parent
    )


def show_info(parent: QWidget, title: str, content: str, duration: int = 2000):
    """显示信息消息"""
    InfoBar.info(
        title=title,
        content=content,
        orient=Qt.Orientation.Horizontal,
        isClosable=True,
        position=InfoBarPosition.TOP,
        duration=duration,
        parent=parent
    )


# ==================== MessageBox 工具函数 ====================

def confirm_dialog(parent: QWidget, title: str, content: str,
                   yes_text: str = "确定", no_text: str = "取消") -> bool:
    """
    显示确认对话框

    Returns:
        True 如果用户点击确定，False 否则
    """
    w = MessageBox(title, content, parent)
    w.yesButton.setText(yes_text)
    w.cancelButton.setText(no_text)
    return w.exec()


def info_dialog(parent: QWidget, title: str, content: str, ok_text: str = "确定"):
    """显示信息对话框（仅确定按钮）"""
    w = MessageBox(title, content, parent)
    w.yesButton.setText(ok_text)
    w.cancelButton.hide()
    w.exec()


# ==================== 图标映射 ====================

# 功能图标映射表
FEATURE_ICONS = {
    'home': FIF.HOME,
    'google': FIF.GLOBE,
    'sheerid': FIF.CERTIFICATE,
    'bind_card': FIF.SHOPPING_CART,  # 使用购物车图标代替支付卡
    'sheerlink': FIF.LINK,
    'replace_phone': FIF.PHONE,
    'replace_email': FIF.MAIL,
    'modify_2sv': FIF.FINGERPRINT,
    'modify_auth': FIF.VPN,
    'kick_devices': FIF.REMOVE_FROM,
    'query': FIF.SEARCH,
    'account': FIF.PEOPLE,
    'subscribe': FIF.PLAY,
    'import': FIF.DOWNLOAD,
    'config': FIF.SETTING,
    'browser': FIF.APPLICATION,
    'create': FIF.ADD,
    'delete': FIF.DELETE,
    'open': FIF.VIEW,
    'refresh': FIF.SYNC,
    'start': FIF.PLAY_SOLID,
    'stop': FIF.PAUSE,
    'log': FIF.DOCUMENT,
    'folder': FIF.FOLDER,
}


def get_feature_icon(feature_key: str) -> FIF:
    """
    获取功能图标

    Args:
        feature_key: 功能键名，如 'home', 'google', 'sheerid' 等

    Returns:
        FluentIcon 枚举值
    """
    return FEATURE_ICONS.get(feature_key, FIF.APPLICATION)


# ==================== 样式常量 ====================

# 卡片圆角
CARD_BORDER_RADIUS = 8

# 内容边距
CONTENT_MARGINS = (20, 20, 20, 20)

# 日志区域最大高度
LOG_AREA_MAX_HEIGHT = 150

# 日志区域样式
LOG_AREA_STYLE = """
    TextEdit {
        background-color: #1e1e1e;
        color: #d4d4d4;
        font-family: Consolas, 'Courier New', monospace;
        font-size: 12px;
        border: 1px solid #3c3c3c;
        border-radius: 4px;
    }
"""

# 树形控件加载覆盖层样式
LOADING_OVERLAY_STYLE = """
    QWidget {
        background-color: rgba(255, 255, 255, 0.95);
    }
"""
