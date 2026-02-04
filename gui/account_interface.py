"""
账号管理界面 - Fluent Design 版本
用于主窗口导航的独立账号管理界面
"""
from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QVBoxLayout, QFrame

from qfluentwidgets import SubtitleLabel

from gui.base_interface import BaseInterface
from gui.data_management.accounts_tab import AccountsTab


class AccountInterface(BaseInterface):
    """账号管理界面 - 主窗口导航版本"""

    def __init__(self, parent=None):
        super().__init__('accountInterface', parent)
        self._initUI()

    def _initUI(self):
        """初始化界面"""
        # 标题
        titleLabel = SubtitleLabel("账号管理", self)
        self.mainLayout.addWidget(titleLabel)

        # 添加 AccountsTab（已经是完整的 Fluent Design 组件）
        self.accountsTab = AccountsTab(self)
        self.mainLayout.addWidget(self.accountsTab)

    def refresh(self):
        """刷新数据"""
        if hasattr(self, 'accountsTab'):
            self.accountsTab.loadData()
