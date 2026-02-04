"""
数据管理模块 - Fluent Design 版本
包含账号、卡片、代理的管理界面
"""

from gui.data_management.accounts_tab import AccountsTab
from gui.data_management.cards_tab import CardsTab
from gui.data_management.proxies_tab import ProxiesTab
from gui.data_management.batch_import_dialog import (
    AccountBatchImportDialog,
    CardBatchImportDialog,
    ProxyBatchImportDialog,
)

__all__ = [
    'AccountsTab',
    'CardsTab',
    'ProxiesTab',
    'AccountBatchImportDialog',
    'CardBatchImportDialog',
    'ProxyBatchImportDialog',
]
