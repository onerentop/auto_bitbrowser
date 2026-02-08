"""数据仓储层。

用于承接 `services/database.py` 中逐步下沉的数据访问逻辑，
通过 Facade 兼容旧调用，避免一次性重构风险。
"""

from .account_repository import AccountRepository
from .account_io_repository import AccountIoRepository
from .card_repository import CardRepository
from .history_repository import HistoryRepository
from .proxy_repository import ProxyRepository
from .recovery_email_repository import RecoveryEmailRepository

__all__ = [
    "AccountRepository",
    "AccountIoRepository",
    "CardRepository",
    "ProxyRepository",
    "HistoryRepository",
    "RecoveryEmailRepository",
]
