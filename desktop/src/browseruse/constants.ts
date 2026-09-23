/**
 * BrowserUse Engine - 常量（Node 重写）
 *
 * 集中存放从 Python 侧逐条抄来的 URL、超时与关键词表。
 * 来源：
 *   - core/browseruse_engine/operations/join_family.py（URL 常量 + 5 组关键词）
 *   - core/browseruse_engine/engine.py（默认超时与步数）
 *
 * ⚠️ 关键词的**内容与顺序**都必须与 Python 一致：
 *    判定是 `any(kw in content_lower)`，虽然顺序不影响布尔结果，
 *    但保持一致才便于逐条对拍（scripts/verify-prompts.mjs 会校验）。
 *    新增/删除关键词等于改变业务判定，不要擅自动。
 */

// ==================== URL 常量（join_family.py L19-21） ====================

export const FAMILY_INVITE_URL = "https://myaccount.google.com/family/invitemembers";
export const FAMILY_DETAILS_URL = "https://families.google.com/families";
export const GMAIL_URL = "https://mail.google.com";

// ==================== 超时与步数（join_family.py 内联值） ====================

/** send_invite / accept_invite 的默认超时（毫秒） */
export const JOIN_FAMILY_DEFAULT_TIMEOUT_MS = 60000;
/** 每次 navigate 的超时（毫秒） */
export const JOIN_FAMILY_NAV_TIMEOUT_MS = 30000;
/** 导航后的固定等待（毫秒） */
export const JOIN_FAMILY_WAIT_AFTER_NAV_MS = 2000;
/** 导航到 Gmail 后的固定等待（毫秒） */
export const JOIN_FAMILY_WAIT_AFTER_GMAIL_MS = 3000;
/** 发送邀请的 Agent 最大步数 */
export const SEND_INVITE_MAX_STEPS = 10;
/** 接受邀请的 Agent 最大步数 */
export const ACCEPT_INVITE_MAX_STEPS = 15;
/** 创建家庭组的 Agent 最大步数 */
export const CREATE_FAMILY_MAX_STEPS = 8;
/** 处理 Gmail 弹窗的 Agent 最大步数 */
export const GMAIL_POPUP_MAX_STEPS = 8;

// ==================== 关键词表 ====================

/** 需要创建家庭组 —— _check_needs_create_family（join_family.py L268-285） */
export const CREATE_FAMILY_KEYWORDS: readonly string[] = [
  // 英文
  "create a family",
  "create family",
  "create a family group",
  "bring your family together",
  "start a family",
  "no family group",
  "you don't have a family",
  "get more with a family group",
  // 西班牙语
  "crear un grupo familiar",
  "comenzar",
  // 中文
  "创建家庭",
  "创建家庭组",
  "创建家庭群组",
];

/** 家庭组已满 —— _check_family_full（join_family.py L317-323） */
export const FAMILY_FULL_KEYWORDS: readonly string[] = [
  "family is full",
  "已达上限",
  "maximum members",
  "6 members",
  "no more members",
];

/** 邀请已发送 —— _check_invite_sent（join_family.py L331-338） */
export const INVITE_SENT_KEYWORDS: readonly string[] = [
  "invitation sent",
  "invite sent",
  "已发送邀请",
  "邀请已发送",
  "pending",
  "待处理",
];

/** 加入成功 —— _verify_join（join_family.py L372-379） */
export const JOIN_SUCCESS_KEYWORDS: readonly string[] = [
  "welcome",
  "欢迎",
  "joined",
  "已加入",
  "family members",
  "家庭成员",
];

/** 已在其他家庭组 —— _verify_join（join_family.py L384） */
export const ALREADY_IN_FAMILY_KEYWORDS: readonly string[] = ["already in", "已在"];

/** 家庭页面确认成员 —— _verify_join（join_family.py L395） */
export const FAMILY_MEMBERS_KEYWORDS: readonly string[] = ["family members", "家庭成员"];

/** 子串命中判定：对标 Python 的 `any(kw in content_lower for kw in ...)` */
export function matchesAnyKeyword(contentLower: string, keywords: readonly string[]): boolean {
  return keywords.some((kw) => contentLower.includes(kw));
}
