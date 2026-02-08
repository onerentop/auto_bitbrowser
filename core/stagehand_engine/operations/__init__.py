"""
Stagehand Google Engine - 操作模块

提供 Google 账号的各种操作实现
"""

from .login import LoginOperation
from .pro_status import ProStatusOperation
from .family import FamilyOperation
from .kick_devices import KickDevicesOperation
from .bind_card import BindCardOperation
from .sheerlink import SheerlinkOperation
from .join_family import JoinFamilyOperation
from .enable_sharing import EnableSharingOperation
from .modify_2sv import Modify2SVOperation
from .modify_auth import ModifyAuthenticatorOperation
from .replace_email import ReplaceEmailOperation
from .replace_phone import ReplacePhoneOperation
from .oauth import OAuthOperation
from .subscribe import SubscribeOperation
from .unlock_403 import Unlock403Operation

# 别名（兼容性）
FamilyStatusOperation = FamilyOperation
UnlockOperation = Unlock403Operation

__all__ = [
    "LoginOperation",
    "ProStatusOperation",
    "FamilyOperation",
    "FamilyStatusOperation",  # 别名
    "KickDevicesOperation",
    "BindCardOperation",
    "SheerlinkOperation",
    "JoinFamilyOperation",
    "EnableSharingOperation",
    "Modify2SVOperation",
    "ModifyAuthenticatorOperation",
    "ReplaceEmailOperation",
    "ReplacePhoneOperation",
    "OAuthOperation",
    "SubscribeOperation",
    "Unlock403Operation",
    "UnlockOperation",  # 别名
]
