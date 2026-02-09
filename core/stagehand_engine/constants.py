"""
Stagehand Google Engine - 常量定义

Google 服务 URL 和关键词常量
"""


class GoogleURLs:
    """Google 服务 URL"""

    # 登录相关
    LOGIN = "https://accounts.google.com/signin"
    LOGIN_V2 = "https://accounts.google.com/v3/signin/identifier"
    LOGOUT = "https://accounts.google.com/Logout"
    GMAIL = "https://mail.google.com"

    # 账号管理
    ACCOUNT = "https://myaccount.google.com"
    SECURITY = "https://myaccount.google.com/security"
    PERSONAL_INFO = "https://myaccount.google.com/personal-info"
    PEOPLE_SHARING = "https://myaccount.google.com/people-and-sharing"

    # Google One
    GOOGLE_ONE = "https://one.google.com"
    GOOGLE_ONE_SETTINGS = "https://one.google.com/settings"
    GOOGLE_ONE_STORAGE = "https://one.google.com/storage"
    GOOGLE_ONE_PLANS = "https://one.google.com/about/plans"

    # 绑卡订阅
    BIND_CARD = "https://one.google.com/ai-student?g1_landing_page=75&utm_source=antigravity&utm_campaign=argon_limit_reached"
    SHEERLINK = "https://goo.gle/freepro"
    STUDENT_SUBSCRIBE = "https://one.google.com/ai-student"

    # 家庭组
    FAMILY = "https://families.google.com"
    FAMILY_MEMBERS = "https://families.google.com/families"
    FAMILY_SHARING = "https://families.google.com/sharing"
    FAMILY_SETTINGS = "https://one.google.com/settings/family"
    FAMILY_ACCOUNT = "https://myaccount.google.com/family"
    FAMILY_INVITE_MEMBERS = "https://myaccount.google.com/family/invitemembers"

    # 订阅
    SUBSCRIPTIONS = "https://myaccount.google.com/subscriptions"
    PAYMENTS = "https://pay.google.com"

    # 设备
    DEVICES = "https://myaccount.google.com/device-activity"
    SECURITY_DEVICES = "https://myaccount.google.com/device-activity"  # 别名，与 DEVICES 相同

    # OAuth
    ANTIGRAVITY_OAUTH = "https://app.antigravity.com/oauth/google"
    ANTIGRAVITY_OAUTH_REDIRECT = "https://app.antigravity.com/oauth/callback"

    # 安全设置
    TWO_STEP_VERIFICATION = "https://myaccount.google.com/signinoptions/two-step-verification"
    AUTHENTICATOR = "https://myaccount.google.com/two-step-verification/authenticator"
    RECOVERY_PHONE = "https://myaccount.google.com/recovery/phone"
    RECOVERY_EMAIL = "https://myaccount.google.com/recovery/email"
    RECOVERY_PHONE_SETTINGS = "https://myaccount.google.com/signinoptions/rescuephone"
    RECOVERY_EMAIL_SETTINGS = "https://myaccount.google.com/signinoptions/rescueemail"

    # 账号恢复
    ACCOUNT_RECOVERY = "https://accounts.google.com/signin/v2/challenge/recaptcha"
    ACCOUNT_VERIFY = "https://accounts.google.com/signin/v2/identifier"


class Timeouts:
    """超时配置（毫秒）"""

    # 导航超时
    NAVIGATION = 30000
    PAGE_LOAD = 60000

    # 操作超时
    ACTION = 10000
    OBSERVE = 15000
    EXTRACT = 20000
    OPERATION = 120000  # 复杂操作 (如绑卡、OAuth)

    # 登录流程
    LOGIN_TOTAL = 120000
    LOGIN_STEP = 15000

    # 等待时间
    AFTER_NAVIGATION = 2000
    AFTER_CLICK = 1000
    AFTER_INPUT = 500
    AFTER_2FA = 3000


class LoginKeywords:
    """登录页面关键词"""

    # 邮箱页面
    EMAIL_PAGE = [
        "sign in",
        "登录",
        "email or phone",
        "电子邮件或电话",
        "enter your email",
    ]

    # 密码页面
    PASSWORD_PAGE = [
        "enter your password",
        "输入密码",
        "welcome",
        "欢迎",
    ]

    # 账号不存在
    ACCOUNT_NOT_FOUND = [
        "couldn't find your google account",
        "找不到您的 google 帐号",
        "couldn't find",
        "no account found",
    ]

    # 密码错误
    WRONG_PASSWORD = [
        "wrong password",
        "密码错误",
        "incorrect password",
        "密码不正确",
    ]

    # 2FA 页面
    TWO_FA_TOTP = [
        "authenticator",
        "身份验证器",
        "verification code",
        "验证码",
        "6-digit code",
    ]

    TWO_FA_SMS = [
        "text message",
        "短信",
        "sms",
        "phone number",
    ]

    TWO_FA_EMAIL = [
        "email verification",
        "邮件验证",
        "sent to your email",
    ]

    TWO_FA_PROMPT = [
        "check your phone",
        "检查您的手机",
        "google prompt",
        "tap yes",
    ]

    # 登录成功
    LOGIN_SUCCESS = [
        "myaccount.google.com",
        "welcome back",
        "欢迎回来",
        "account",
    ]

    # 安全挑战
    SECURITY_CHALLENGE = [
        "verify it's you",
        "验证是否是您本人",
        "security check",
        "confirm your identity",
    ]

    # 验证码
    CAPTCHA = [
        "captcha",
        "验证码",
        "robot",
        "机器人",
        "recaptcha",
    ]

    # 账号被禁用
    ACCOUNT_DISABLED = [
        "account has been disabled",
        "帐号已被停用",
        "suspended",
        "disabled",
    ]


class ProKeywords:
    """Pro 状态关键词"""

    # Pro 会员标识
    POSITIVE = [
        "google one",
        "premium",
        "pro",
        "2 tb",
        "100 gb",
        "200 gb",
        "member benefits",
        "会员权益",
    ]

    # 非 Pro 标识
    NEGATIVE = [
        "upgrade",
        "升级",
        "get more storage",
        "获取更多存储空间",
        "free plan",
        "免费方案",
        "15 gb",
    ]

    # 已过期
    EXPIRED = [
        "expired",
        "已过期",
        "renew",
        "续订",
        "payment failed",
        "付款失败",
    ]


class FamilyKeywords:
    """家庭组关键词"""

    # 有家庭组
    HAS_FAMILY = [
        "your family group",
        "您的家庭群组",
        "family members",
        "家庭成员",
        "manage family",
    ]

    # 无家庭组
    NO_FAMILY = [
        "create a family",
        "创建家庭群组",
        "start a family group",
        "set up a family",
        "no family group",
    ]

    # 管理员标识
    MANAGER = [
        "you manage this family",
        "you are the family manager",
        "manage members",
        "you can manage family settings",
        "管理成员",
    ]

    # 家庭组成员标识（被邀请加入的，非管理员）
    FAMILY_MEMBER = [
        "shared with you",
        "与您共享",
        "shared by",
        "由...共享",
        "leave family",
        "退出家庭",
        "your membership is shared",
        "您的会员由",
    ]

    # 独立订阅者标识（自己付费）
    INDEPENDENT_SUBSCRIBER = [
        "next payment",
        "下次付款",
        "cancel membership",
        "取消会员",
        "change payment method",
        "更改付款方式",
        "share google one with family",
        "与家人共享 google one",
        "manage family settings",
        "管理家庭设置",
    ]

    # 共享状态
    SHARING_ENABLED = [
        "sharing is on",
        "共享已开启",
        "shared with family",
        "与家人共享",
    ]

    SHARING_DISABLED = [
        "sharing is off",
        "共享已关闭",
        "turn on sharing",
        "开启共享",
    ]
