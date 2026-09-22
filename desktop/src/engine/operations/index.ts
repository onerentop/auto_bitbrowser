/**
 * Stagehand operations 索引
 * 对标 core/stagehand_engine/operations/__init__.py
 *
 * 注意：Python 侧的 bind_card / sheerlink / subscribe 三个 operation
 * 已在「移除 SheerID、绑卡订阅」那次改动中删除，这里同样不提供。
 */
export { LoginOperation } from "./login.ts";
export { ProStatusOperation, ProStatusSchema } from "./pro-status.ts";
export { FamilyOperation, FamilyStatusSchema } from "./family.ts";
export { KickDevicesOperation, CURRENT_DEVICE_KEYWORDS } from "./kick-devices.ts";
export { JoinFamilyOperation } from "./join-family.ts";
export { EnableSharingOperation } from "./enable-sharing.ts";
export { Modify2SVOperation } from "./modify-2sv.ts";
export {
  ModifyAuthenticatorOperation,
  parseSecret,
  isValidBase32,
} from "./modify-auth.ts";
export { ReplaceEmailOperation } from "./replace-email.ts";
export { ReplacePhoneOperation } from "./replace-phone.ts";
export { OAuthOperation, DEFAULT_OAUTH_URLS, isValidUrl } from "./oauth.ts";
export { Unlock403Operation } from "./unlock-403.ts";

// Python 侧别名（兼容旧调用）
export { FamilyOperation as FamilyStatusOperation } from "./family.ts";
export { Unlock403Operation as UnlockOperation } from "./unlock-403.ts";