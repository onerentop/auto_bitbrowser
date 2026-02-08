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
    # SheerID 相关状态
    SUBSCRIBED = "subscribed"      # 已订阅
    VERIFIED = "verified"          # 已验证未绑卡
    LINK_READY = "link_ready"      # 链接已获取
    INELIGIBLE = "ineligible"      # 无资格
    ERROR = "error"                # 错误


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

    # 家庭组信息
    is_family_member: bool = False  # 是否是家庭组成员（被邀请加入的）
    family_manager_email: Optional[str] = None  # 家庭管理员邮箱

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


# ==================== 新增操作结果类型 ====================
# 用于迁移 automation/ 层的各种操作

@dataclass
class BaseOperationResult:
    """操作结果基类"""
    success: bool
    message: str = ""
    error: Optional[str] = None
    error_type: Optional[str] = None
    duration_ms: float = 0.0
    can_retry: bool = False

    def __bool__(self) -> bool:
        return self.success


@dataclass
class BindCardResult(BaseOperationResult):
    """绑卡操作结果"""
    # 卡片信息
    card_last_four: Optional[str] = None
    card_masked: Optional[str] = None  # 掩码卡号 (如 **** 1234)
    card_type: Optional[str] = None  # visa, mastercard, etc.

    # 订阅信息
    subscription_created: bool = False
    already_subscribed: bool = False  # 是否已订阅（跳过绑卡）
    subscription_plan: Optional[str] = None
    next_billing_date: Optional[str] = None

    # 错误详情
    decline_reason: Optional[str] = None  # 拒绝原因


@dataclass
class SheerlinkResult(BaseOperationResult):
    """获取 SheerID 链接操作结果"""
    # 链接信息
    sheerlink_url: Optional[str] = None
    verification_status: Optional[str] = None  # pending, verified, rejected

    # 操作状态 (用于 sheerlink.py 传参)
    op_status: Optional["OperationStatus"] = None

    # 额外信息
    program_id: Optional[str] = None
    program_name: Optional[str] = None

    @property
    def sheerlink(self) -> Optional[str]:
        """向后兼容别名"""
        return self.sheerlink_url

    @property
    def link(self) -> Optional[str]:
        """向后兼容别名"""
        return self.sheerlink_url

    @property
    def status(self) -> Optional[str]:
        """向后兼容别名 - 返回 verification_status 或 op_status 的值"""
        if self.verification_status:
            return self.verification_status
        if self.op_status:
            return self.op_status.value
        return None


@dataclass
class KickDevicesResult(BaseOperationResult):
    """踢出设备操作结果"""
    # 踢出统计
    devices_found: int = 0
    devices_kicked: int = 0
    devices_failed: int = 0

    # 设备列表
    kicked_devices: List[str] = field(default_factory=list)
    failed_devices: List[str] = field(default_factory=list)

    @property
    def kicked_count(self) -> int:
        """向后兼容别名"""
        return self.devices_kicked

    @property
    def failed_count(self) -> int:
        """向后兼容别名"""
        return self.devices_failed


@dataclass
class ModifyPhoneResult(BaseOperationResult):
    """修改手机号操作结果 (2SV 或恢复手机)"""
    # 操作类型
    operation_type: str = ""  # "2sv" 或 "recovery"

    # 手机号信息
    old_phone: Optional[str] = None
    new_phone: Optional[str] = None

    # 验证信息
    verification_sent: bool = False
    verification_code_used: Optional[str] = None


@dataclass
class ModifyAuthenticatorResult(BaseOperationResult):
    """修改验证器操作结果"""
    # 验证器信息
    authenticator_name: Optional[str] = None
    secret_key: Optional[str] = None  # 新的 TOTP 密钥 (Base32)
    qr_code_url: Optional[str] = None

    # 操作类型
    operation: str = ""  # "add", "replace", "remove"

    # 验证状态
    verified: bool = False

    @property
    def new_secret(self) -> Optional[str]:
        """向后兼容别名"""
        return self.secret_key


@dataclass
class ReplaceEmailResult(BaseOperationResult):
    """替换辅助邮箱操作结果"""
    # 邮箱信息
    old_email: Optional[str] = None
    new_email: Optional[str] = None

    # 验证信息
    verification_sent: bool = False
    verification_code_used: Optional[str] = None


@dataclass
class SubscribeResult(BaseOperationResult):
    """订阅操作结果"""
    # 订阅类型
    plan_type: str = ""  # "student", "regular", "trial"
    plan: str = ""  # 别名字段 (用于 subscribe.py 传参)

    # 订阅信息
    subscription_id: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    price: Optional[str] = None
    already_subscribed: bool = False  # 是否已订阅（跳过订阅流程）

    # 学生验证
    student_verified: bool = False

    def __post_init__(self):
        # 同步 plan 和 plan_type
        if self.plan and not self.plan_type:
            self.plan_type = self.plan
        elif self.plan_type and not self.plan:
            self.plan = self.plan_type


@dataclass
class UnlockResult(BaseOperationResult):
    """解锁 403 操作结果"""
    # 解锁状态
    was_locked: bool = False
    unlocked: bool = False

    # 验证信息
    verification_url: Optional[str] = None
    phone_used: Optional[str] = None
    sms_code_used: Optional[str] = None

    # 需要人工操作
    needs_manual: bool = False

    # 错误详情
    lock_reason: Optional[str] = None


@dataclass
class JoinFamilyResult(BaseOperationResult):
    """加入家庭组操作结果"""
    # 角色信息
    joined_as: FamilyRole = FamilyRole.NONE

    # 家庭组信息
    family_manager_email: Optional[str] = None
    inviter_email: Optional[str] = None  # 邀请人邮箱 (用于传参记录)
    member_count_after: int = 0
    already_in_family: bool = False  # 是否已在其他家庭组中

    # 邀请信息
    invite_sent: bool = False
    invite_accepted: bool = False


@dataclass
class EnableSharingResult(BaseOperationResult):
    """开启家庭共享操作结果"""
    # 共享状态
    was_already_enabled: bool = False
    sharing_enabled: bool = False

    # 家庭组信息
    family_created: bool = False
    member_count: int = 0


@dataclass
class OAuthResult(BaseOperationResult):
    """OAuth 授权操作结果"""
    # 授权信息
    service_name: str = ""  # 如 "antigravity", "sub2api"
    service: str = ""  # 别名字段 (用于 oauth.py 传参)
    authorized: bool = False
    redirect_url: Optional[str] = None  # OAuth 重定向 URL

    # Token 信息 (如果返回)
    access_token: Optional[str] = None
    refresh_token: Optional[str] = None
    expires_in: Optional[int] = None

    # 账号信息
    oauth_email: Optional[str] = None
    account_id: Optional[str] = None

    def __post_init__(self):
        # 同步 service 和 service_name
        if self.service and not self.service_name:
            self.service_name = self.service
        elif self.service_name and not self.service:
            self.service = self.service_name


# ==================== 类型别名 ====================

# ReplacePhoneResult 是 ModifyPhoneResult 的别名
# 用于替换恢复手机号操作，与修改 2SV 手机号使用相同的返回结构
ReplacePhoneResult = ModifyPhoneResult
