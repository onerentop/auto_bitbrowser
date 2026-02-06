"""
Stagehand Google Engine - 类型定义

定义所有操作结果和状态的数据类型
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, List, Dict, Any


class OperationStatus(Enum):
    """操作状态枚举"""
    SUCCESS = "success"
    FAILED = "failed"
    PARTIAL = "partial"  # 部分成功，需要额外操作
    BLOCKED = "blocked"  # 被阻止（验证码、安全挑战等）
    TIMEOUT = "timeout"
    UNKNOWN = "unknown"


class LoginState(Enum):
    """登录状态枚举"""
    LOGGED_IN = "logged_in"
    LOGGED_OUT = "logged_out"
    NEED_PASSWORD = "need_password"
    NEED_2FA = "need_2fa"
    NEED_RECOVERY = "need_recovery"
    WRONG_PASSWORD = "wrong_password"
    ACCOUNT_NOT_FOUND = "account_not_found"
    ACCOUNT_DISABLED = "account_disabled"
    CAPTCHA_REQUIRED = "captcha_required"
    SECURITY_CHALLENGE = "security_challenge"
    UNKNOWN = "unknown"


class TwoFactorMethod(Enum):
    """两步验证方法"""
    TOTP = "totp"  # Google Authenticator
    SMS = "sms"
    EMAIL = "email"
    PROMPT = "prompt"  # Google 提示
    BACKUP_CODE = "backup_code"
    SECURITY_KEY = "security_key"
    UNKNOWN = "unknown"


class ProStatus(Enum):
    """Pro 订阅状态"""
    ACTIVE = "active"  # 活跃订阅
    EXPIRED = "expired"  # 已过期
    FREE = "free"  # 免费用户
    TRIAL = "trial"  # 试用期
    UNKNOWN = "unknown"


class FamilyRole(Enum):
    """家庭组角色"""
    MANAGER = "manager"  # 管理员
    MEMBER = "member"  # 成员
    NONE = "none"  # 不在家庭组中


@dataclass
class LoginResult:
    """登录操作结果"""
    success: bool
    status: OperationStatus
    login_state: LoginState
    message: str = ""
    error: str = ""
    error_type: Optional[str] = None

    # 账号信息
    account_email: Optional[str] = None

    # 2FA 相关
    need_2fa: bool = False
    two_fa_method: Optional[str] = None

    # 安全挑战
    challenge_type: Optional[str] = None
    challenge_hint: Optional[str] = None

    # 重试信息
    can_retry: bool = False
    retry_delay_seconds: int = 0

    # 调试信息
    page_type: Optional[str] = None
    matched_keywords: List[str] = field(default_factory=list)
    duration_ms: float = 0.0

    def __bool__(self) -> bool:
        return self.success


@dataclass
class ProStatusResult:
    """Pro 状态检测结果"""
    status: ProStatus
    is_pro: bool = False

    # 订阅详情
    plan_name: Optional[str] = None
    storage_used: Optional[str] = None
    storage_total: Optional[str] = None
    expiry_date: Optional[str] = None

    # 检测元数据
    confidence: float = 0.0
    method_used: str = ""
    raw_keywords: List[str] = field(default_factory=list)

    def __bool__(self) -> bool:
        return self.is_pro


@dataclass
class FamilyMember:
    """家庭组成员"""
    email: str
    name: Optional[str] = None
    role: FamilyRole = FamilyRole.MEMBER
    avatar_url: Optional[str] = None


@dataclass
class FamilyStatusResult:
    """家庭组状态检测结果"""
    has_family: bool = False

    # 角色信息
    role: FamilyRole = FamilyRole.NONE
    is_manager: bool = False

    # 成员信息
    member_count: int = 0
    members: List[FamilyMember] = field(default_factory=list)

    # 共享状态
    sharing_enabled: bool = False
    can_share_subscription: bool = False

    # 家庭组详情
    family_name: Optional[str] = None

    def __bool__(self) -> bool:
        return self.has_family


@dataclass
class NavigationResult:
    """导航结果"""
    success: bool
    url: str
    final_url: Optional[str] = None
    error_message: Optional[str] = None
    duration_ms: float = 0.0


@dataclass
class ActionResult:
    """操作结果"""
    success: bool
    message: str = ""
    error: Optional[str] = None
    selector: Optional[str] = None
    method: Optional[str] = None
    duration_ms: float = 0.0


@dataclass
class ExtractResult:
    """提取结果"""
    success: bool
    data: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    duration_ms: float = 0.0


@dataclass
class ObserveResult:
    """观察结果"""
    success: bool
    actions: List[Dict[str, Any]] = field(default_factory=list)
    error: Optional[str] = None
    duration_ms: float = 0.0
