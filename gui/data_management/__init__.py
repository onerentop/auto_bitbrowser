"""
数据管理模块 - Fluent Design 版本
包含账号、代理的管理界面
"""

from gui.data_management.accounts_tab import AccountsTab
from gui.data_management.batch_import_dialog import (
    AccountBatchImportDialog,
    ProxyBatchImportDialog,
)
from gui.data_management.proxies_tab import ProxiesTab

__all__ = [
    'AccountsTab',
    'ProxiesTab',
    'AccountBatchImportDialog',
    'ProxyBatchImportDialog',
]
