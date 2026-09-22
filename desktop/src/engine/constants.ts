/**
 * Stagehand Google Engine - 常量定义（Node 重写）
 * 对标 core/stagehand_engine/constants.py
 *
 * 本文件由脚本从 Python 源逐字生成，未手工改写，保证关键词完全一致。
 * 这些关键词是业务判定的核心（登录态、Pro 状态、家庭组角色），改动会直接影响判定结果。
 */

/** Google 服务 URL */
export const GoogleURLs = {
  LOGIN: "https://accounts.google.com/signin",
  LOGIN_V2: "https://accounts.google.com/v3/signin/identifier",
  LOGOUT: "https://accounts.google.com/Logout",
  GMAIL: "https://mail.google.com",
  ACCOUNT: "https://myaccount.google.com",
  SECURITY: "https://myaccount.google.com/security",
  PERSONAL_INFO: "https://myaccount.google.com/personal-info",
  PEOPLE_SHARING: "https://myaccount.google.com/people-and-sharing",
  GOOGLE_ONE: "https://one.google.com",
  GOOGLE_ONE_SETTINGS: "https://one.google.com/settings",
  GOOGLE_ONE_STORAGE: "https://one.google.com/storage",
  GOOGLE_ONE_PLANS: "https://one.google.com/about/plans",
  BIND_CARD: "https://one.google.com/ai-student?g1_landing_page=75&utm_source=antigravity&utm_campaign=argon_limit_reached",
  SHEERLINK: "https://goo.gle/freepro",
  STUDENT_SUBSCRIBE: "https://one.google.com/ai-student",
  FAMILY: "https://families.google.com",
  FAMILY_MEMBERS: "https://families.google.com/families",
  FAMILY_SHARING: "https://families.google.com/sharing",
  FAMILY_SETTINGS: "https://one.google.com/settings/family",
  FAMILY_ACCOUNT: "https://myaccount.google.com/family",
  FAMILY_INVITE_MEMBERS: "https://myaccount.google.com/family/invitemembers",
  SUBSCRIPTIONS: "https://myaccount.google.com/subscriptions",
  PAYMENTS: "https://pay.google.com",
  DEVICES: "https://myaccount.google.com/device-activity",
  SECURITY_DEVICES: "https://myaccount.google.com/device-activity",
  ANTIGRAVITY_OAUTH: "https://app.antigravity.com/oauth/google",
  ANTIGRAVITY_OAUTH_REDIRECT: "https://app.antigravity.com/oauth/callback",
  TWO_STEP_VERIFICATION: "https://myaccount.google.com/signinoptions/two-step-verification",
  AUTHENTICATOR: "https://myaccount.google.com/two-step-verification/authenticator",
  RECOVERY_PHONE: "https://myaccount.google.com/recovery/phone",
  RECOVERY_EMAIL: "https://myaccount.google.com/recovery/email",
  RECOVERY_PHONE_SETTINGS: "https://myaccount.google.com/signinoptions/rescuephone",
  RECOVERY_EMAIL_SETTINGS: "https://myaccount.google.com/signinoptions/rescueemail",
  ACCOUNT_RECOVERY: "https://accounts.google.com/signin/v2/challenge/recaptcha",
  ACCOUNT_VERIFY: "https://accounts.google.com/signin/v2/identifier",
} as const;

/** 超时配置（毫秒） */
export const Timeouts = {
  NAVIGATION: 30000,
  PAGE_LOAD: 60000,
  ACTION: 10000,
  OBSERVE: 15000,
  EXTRACT: 20000,
  OPERATION: 120000,
  LOGIN_TOTAL: 120000,
  LOGIN_STEP: 15000,
  AFTER_NAVIGATION: 2000,
  AFTER_CLICK: 1000,
  AFTER_INPUT: 500,
  AFTER_2FA: 3000,
} as const;

/** 登录页面关键词 */
export const LoginKeywords = {
  EMAIL_PAGE: ["sign in", "登录", "email or phone", "电子邮件或电话", "enter your email"],
  PASSWORD_PAGE: ["enter your password", "输入密码", "welcome", "欢迎"],
  ACCOUNT_NOT_FOUND: ["couldn't find your google account", "找不到您的 google 帐号", "couldn't find", "no account found"],
  WRONG_PASSWORD: ["wrong password", "密码错误", "incorrect password", "密码不正确"],
  TWO_FA_TOTP: ["authenticator", "身份验证器", "verification code", "验证码", "6-digit code"],
  TWO_FA_SMS: ["text message", "短信", "sms", "phone number"],
  TWO_FA_EMAIL: ["email verification", "邮件验证", "sent to your email"],
  TWO_FA_PROMPT: ["check your phone", "检查您的手机", "google prompt", "tap yes"],
  LOGIN_SUCCESS: ["myaccount.google.com", "welcome back", "欢迎回来", "account"],
  SECURITY_CHALLENGE: ["verify it's you", "验证是否是您本人", "security check", "confirm your identity"],
  CAPTCHA: ["captcha", "验证码", "robot", "机器人", "recaptcha"],
  ACCOUNT_DISABLED: ["account has been disabled", "帐号已被停用", "suspended", "disabled"],
} as const;

/** Pro 状态关键词 */
export const ProKeywords = {
  POSITIVE: ["google one", "premium", "pro", "2 tb", "100 gb", "200 gb", "member benefits", "会员权益"],
  NEGATIVE: ["upgrade", "升级", "get more storage", "获取更多存储空间", "free plan", "免费方案", "15 gb"],
  EXPIRED: ["expired", "已过期", "renew", "续订", "payment failed", "付款失败"],
} as const;

/** 家庭组关键词 */
export const FamilyKeywords = {
  HAS_FAMILY: ["your family group", "your family on google", "your family", "with a family group", "您的家庭群组", "family members", "家庭成员", "manage family"],
  NO_FAMILY: ["create a family", "create a family group", "you can create a family group", "get started", "创建家庭群组", "start a family group", "set up a family", "no family group"],
  MANAGER: ["you manage this family", "you are the family manager", "you are family manager", "you can manage family settings", "管理成员"],
  FAMILY_MEMBER: ["shared with you", "与您共享", "shared by", "由...共享", "leave family", "退出家庭", "your membership is shared", "您的会员由"],
  INDEPENDENT_SUBSCRIBER: ["next payment", "下次付款", "cancel membership", "取消会员", "change payment method", "更改付款方式", "share google one with family", "与家人共享 google one", "manage family settings", "管理家庭设置"],
  SHARING_ENABLED: ["sharing is on", "共享已开启", "shared with family", "与家人共享"],
  SHARING_DISABLED: ["sharing is off", "共享已关闭", "turn on sharing", "开启共享"],
} as const;

/** 大小写不敏感的关键词命中判断（对标 Python 侧的 any(k in text.lower())） */
export function matchesAny(text: string | null | undefined, keywords: readonly string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

/** 返回命中的关键词列表，便于日志与调试 */
export function matchedKeywords(text: string | null | undefined, keywords: readonly string[]): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  return keywords.filter((k) => lower.includes(k.toLowerCase()));
}
