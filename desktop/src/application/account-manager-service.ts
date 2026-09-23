/**
 * 账号管理应用服务（Node 重写）
 * 对标 application/account_manager_service.py（整文件）
 *
 * 与 Python 的差异（全部为结构性差异，判定分支与文案逐字对齐）：
 *   1. Python 是 @staticmethod 集合 + 直接调全局 DBManager；这里是纯函数，
 *      需要查库的函数显式接收一个仓储（AccountLookup），便于离线单测。
 *   2. 返回元组 → 返回具名对象（字段名是 Python 局部变量名的 camelCase）。
 *   3. allocate_to_pro_accounts 里的全局 invite_lock_manager 改为参数注入。
 *   4. Python 的 `account.get(k, default)`：键存在但值为 None 时拿到 None 而不是默认值，
 *      这里用 `k in account ? account[k] : default` 还原这一点。
 */

/** 账号字典（Python 侧是无类型 dict） */
export type AccountDict = Record<string, unknown>;

/** 查库所需的最小仓储接口（真实实现：src/db/account-repository.ts 的 AccountRepository） */
export interface AccountLookup {
  getAccountByEmail(email: string): AccountDict | null;
  getAllAccounts(): AccountDict[];
}

/** 窗口字典（ixBrowser profile-list 的一项，只用到 name / profile_id） */
export interface WindowLike {
  name?: unknown;
  profile_id?: unknown;
}

/** 对标 Python 的 dict.get(key, default)：键存在（即使值为 null）就返回原值 */
function pyGet(obj: AccountDict | WindowLike, key: string, fallback: unknown): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as Record<string, unknown>)[key] : fallback;
}

/** Python 的 `str(x)`（None → "None"）只出现在 profile_id 上；其余位置都是字符串原样拼接 */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  return String(value);
}

/** 取邮箱：Python 用 account.get("email", "") 后直接放进列表 / 文案 */
function emailOf(account: AccountDict): string {
  const v = pyGet(account, "email", "");
  return v === null || v === undefined ? "" : String(v);
}

// ==================== 任务冲突 ====================

export interface TaskConflictFlags {
  workerRunning?: boolean;
  batchJoinRunning?: boolean;
  enableSharingRunning?: boolean;
  batchBindRunning?: boolean;
  detect403Running?: boolean;
  batchDeleteRunning?: boolean;
  waitAction?: string;
}

/** 对标 check_task_conflicts（:19-47）：返回 [可以执行, 提示文案] */
export function checkTaskConflicts(flags: TaskConflictFlags = {}): [boolean, string] {
  const checks: Array<[boolean, string]> = [
    [!!flags.batchBindRunning, "批量绑定任务正在执行中"],
    [!!flags.batchDeleteRunning, "批量删除任务正在执行中"],
    [!!flags.detect403Running, "检测任务正在执行中"],
    [!!flags.workerRunning, "已有任务在执行中"],
    [!!flags.batchJoinRunning, "批量加入家庭组任务正在执行中"],
    [!!flags.enableSharingRunning, "开启共享任务正在执行中"],
  ];
  for (const [running, message] of checks) {
    if (!running) continue;
    if (flags.waitAction) return [false, `${message}，请等待完成后再${flags.waitAction}`];
    return [false, message];
  }
  return [true, ""];
}

// ==================== 选中行解析 ====================

/** 对标 resolve_selected_accounts（:50-68） */
export function resolveSelectedAccounts(
  repo: Pick<AccountLookup, "getAccountByEmail">,
  selectedRows: ReadonlyArray<readonly [string, string]>,
): { accounts: AccountDict[]; browserIds: string[] } {
  const accounts: AccountDict[] = [];
  const browserIds: string[] = [];
  for (const [email, browserId] of selectedRows) {
    if (!email) continue;
    const account = repo.getAccountByEmail(email);
    if (!account) continue;
    accounts.push(account);
    browserIds.push(browserId && browserId !== "-" ? browserId : "");
  }
  return { accounts, browserIds };
}

/** 对标 collect_unbound_emails（:71-79） */
export function collectUnboundEmails(selectedRows: ReadonlyArray<readonly [string, string]>): string[] {
  const unbound: string[] = [];
  for (const [email, browserId] of selectedRows) {
    if (!email) continue;
    if (!browserId || browserId === "-") unbound.push(email);
  }
  return unbound;
}

/**
 * 对标 match_accounts_to_windows（:82-124）：按窗口名称（去空白、小写）匹配邮箱
 *
 * matched：可绑定的 [email, browserId]；notMatched：未找到匹配窗口的邮箱；
 * alreadyBound：匹配到但窗口已被（任意）账号绑定的 [email, browserId]
 *
 * 与 Python 的有意偏差：匹配成功后立即把窗口记为已占用。Python 不这样做，
 * 两个邮箱（例如只有大小写不同）匹配到同一窗口时会把该窗口同时绑给两个账号。
 * 这里第二个及之后的匹配归入 alreadyBound（窗口已被本批次前面的账号占用，语义与
 * 「已被其他账号绑定」一致，界面按「已跳过」提示）。
 */
export function matchAccountsToWindows(
  repo: Pick<AccountLookup, "getAllAccounts">,
  targetEmails: readonly string[],
  windows: readonly WindowLike[],
): { matched: Array<[string, string]>; notMatched: string[]; alreadyBound: Array<[string, string]> } {
  const bound = new Set<string>();
  for (const account of repo.getAllAccounts()) {
    const id = pyGet(account, "browser_profile_id", "");
    if (id) bound.add(String(id));
  }

  // Python 的 dict 赋值：同名窗口后者覆盖前者
  const windowMap = new Map<string, string>();
  for (const w of windows) {
    const rawName = pyGet(w, "name", "");
    const name = typeof rawName === "string" ? rawName.trim().toLowerCase() : "";
    const profileId = pyStr(pyGet(w, "profile_id", ""));
    if (name && profileId) windowMap.set(name, profileId);
  }

  const matched: Array<[string, string]> = [];
  const notMatched: string[] = [];
  const alreadyBound: Array<[string, string]> = [];
  for (const email of targetEmails) {
    const key = email.trim().toLowerCase();
    const browserId = windowMap.get(key);
    if (browserId === undefined) {
      notMatched.push(email);
      continue;
    }
    if (bound.has(browserId)) {
      alreadyBound.push([email, browserId]);
    } else {
      matched.push([email, browserId]);
      bound.add(browserId);
    }
  }
  return { matched, notMatched, alreadyBound };
}

/** 对标 get_account_and_browser（:127-134） */
export function getAccountAndBrowser(
  repo: Pick<AccountLookup, "getAccountByEmail">,
  email: string,
): { account: AccountDict | null; browserId: string } {
  const account = repo.getAccountByEmail(email);
  if (!account) return { account: null, browserId: "" };
  const id = pyGet(account, "browser_profile_id", "");
  return { account, browserId: id ? String(id) : "" };
}

/** 对标 collect_missing_browser_emails（:137-146） */
export function collectMissingBrowserEmails(accounts: readonly AccountDict[], browserIds: readonly string[]): string[] {
  const out: string[] = [];
  const n = Math.min(accounts.length, browserIds.length);
  for (let i = 0; i < n; i++) {
    if (!browserIds[i]) out.push(emailOf(accounts[i] as AccountDict));
  }
  return out;
}

/** 对标 build_batch_delete_confirm_message（:149-156） */
export function buildBatchDeleteConfirmMessage(total: number, withWindows: boolean): string {
  if (withWindows) return `确定要删除选中的 ${total} 个账号及其对应的浏览器窗口吗？\n\n⚠️ 此操作不可恢复！`;
  return `确定要删除选中的 ${total} 个账号吗？\n\n注意：仅删除账号记录，不会删除对应的浏览器窗口。`;
}

// ==================== 家庭组加入（仅移植，不接线） ====================

/** 对标 prepare_family_join_candidates（:159-196） */
export function prepareFamilyJoinCandidates(
  accounts: readonly AccountDict[],
  browserIds: readonly string[],
): {
  normalAccounts: AccountDict[];
  normalBrowserIds: string[];
  skippedAlreadyPro: string[];
  skippedNotLogged: string[];
  skippedNoBrowser: string[];
} {
  const r = {
    normalAccounts: [] as AccountDict[],
    normalBrowserIds: [] as string[],
    skippedAlreadyPro: [] as string[],
    skippedNotLogged: [] as string[],
    skippedNoBrowser: [] as string[],
  };
  zip(accounts, browserIds, (account, browserId) => {
    const email = emailOf(account);
    const isPro = pyGet(account, "is_pro", "unknown");
    const loginStatus = pyGet(account, "login_status", "");
    if (isPro === "yes" || isPro === "family_yes") return void r.skippedAlreadyPro.push(email);
    if (loginStatus !== "logged_in") return void r.skippedNotLogged.push(email);
    if (!browserId) return void r.skippedNoBrowser.push(email);
    r.normalAccounts.push(account);
    r.normalBrowserIds.push(browserId);
  });
  return r;
}

/** 对标 build_no_family_candidates_message（:199-212） */
export function buildNoFamilyCandidatesMessage(
  skippedAlreadyPro: readonly string[],
  skippedNotLogged: readonly string[],
  skippedNoBrowser: readonly string[],
): string {
  let message = "没有可加入家庭组的普通账户\n\n";
  if (skippedAlreadyPro.length) message += `⚠️ ${skippedAlreadyPro.length} 个已是 Pro 会员\n`;
  if (skippedNotLogged.length) message += `⚠️ ${skippedNotLogged.length} 个未登录\n`;
  if (skippedNoBrowser.length) message += `⚠️ ${skippedNoBrowser.length} 个未绑定窗口`;
  return message;
}

// ==================== Pro 检测 ====================

/** 对标 prepare_detect_pro_candidates（:215-240） */
export function prepareDetectProCandidates(
  accounts: readonly AccountDict[],
  browserIds: readonly string[],
): { validAccounts: AccountDict[]; validBrowserIds: string[]; skippedNotLogged: string[]; skippedNoBrowser: string[] } {
  const r = {
    validAccounts: [] as AccountDict[],
    validBrowserIds: [] as string[],
    skippedNotLogged: [] as string[],
    skippedNoBrowser: [] as string[],
  };
  zip(accounts, browserIds, (account, browserId) => {
    const email = emailOf(account);
    if (pyGet(account, "login_status", "") !== "logged_in") return void r.skippedNotLogged.push(email);
    if (!browserId) return void r.skippedNoBrowser.push(email);
    r.validAccounts.push(account);
    r.validBrowserIds.push(browserId);
  });
  return r;
}

/** 对标 build_no_detect_pro_candidates_message（:243-253） */
export function buildNoDetectProCandidatesMessage(
  skippedNotLogged: readonly string[],
  skippedNoBrowser: readonly string[],
): string {
  let message = "没有可检测的账号\n\n";
  if (skippedNotLogged.length) message += `❌ ${skippedNotLogged.length} 个未登录\n`;
  if (skippedNoBrowser.length) message += `❌ ${skippedNoBrowser.length} 个未绑定窗口`;
  return message;
}

/** 对标 build_detect_pro_confirm_message（:256-267） */
export function buildDetectProConfirmMessage(
  validCount: number,
  skippedNotLoggedCount: number,
  skippedNoBrowserCount: number,
): string {
  let message = `将检测 ${validCount} 个已登录账号的 Pro 状态`;
  if (skippedNotLoggedCount) message += `\n\n⚠️ 跳过 ${skippedNotLoggedCount} 个未登录账号`;
  if (skippedNoBrowserCount) message += `\n⚠️ 跳过 ${skippedNoBrowserCount} 个未绑定窗口账号`;
  return message;
}

/**
 * 「刷新家庭组」的确认文案 —— 对标 gui/account_manager_interface.py:1083-1093（Python 写在界面层）
 * 末尾已含「是否继续？」
 */
export function buildRefreshMembershipConfirmMessage(
  validCount: number,
  skippedNotLoggedCount: number,
  skippedNoBrowserCount: number,
): string {
  let msg = `将刷新 ${validCount} 个账号的完整会员信息：\n`;
  msg += "• Pro 会员状态\n";
  msg += "• 家庭组详情（角色、管理员、成员数）\n";
  msg += "• 账户所属国家\n";
  if (skippedNotLoggedCount) msg += `\n⚠️ 跳过 ${skippedNotLoggedCount} 个未登录账号`;
  if (skippedNoBrowserCount) msg += `\n⚠️ 跳过 ${skippedNoBrowserCount} 个未绑定窗口账号`;
  msg += "\n\n是否继续？";
  return msg;
}

// ==================== 403 检测 / 解锁 ====================

/** 对标 filter_linked_accounts_for_detect403（:270-272） */
export function filterLinkedAccountsForDetect403(accounts: readonly AccountDict[]): AccountDict[] {
  return accounts.filter((a) => pyGet(a, "sub2api_status", undefined) === "linked");
}

/** 对标 build_no_linked_accounts_for_detect403_message（:275-280） */
export function buildNoLinkedAccountsForDetect403Message(selectedTotal: number): string {
  return `选中的 ${selectedTotal} 个账号中没有已关联的账号\n\n只有 Sub2API 状态为「已关联」的账号才能检测 403`;
}

/** 对标 collect_unlock_targets_from_selected（:283-297） */
export function collectUnlockTargetsFromSelected(
  selectedAccounts: readonly AccountDict[],
  selectedBrowserIds: readonly string[],
): { accountsToUnlock: AccountDict[]; browserIds: string[] } {
  const accountsToUnlock: AccountDict[] = [];
  const browserIds: string[] = [];
  zip(selectedAccounts, selectedBrowserIds, (account, browserId) => {
    const s = pyGet(account, "unlock_status", "");
    if (s === "needs_unlock" || s === "unlock_failed") {
      accountsToUnlock.push(account);
      browserIds.push(browserId);
    }
  });
  return { accountsToUnlock, browserIds };
}

/** 对标 build_no_selected_unlock_targets_message（:300-305） */
export function buildNoSelectedUnlockTargetsMessage(): string {
  return "选中的账号中没有需要解锁的\n\n请选择 unlock_status 为 needs_unlock 或 unlock_failed 的账号";
}

/** 对标 build_unlock_all_confirm_message（:308-313） */
export function buildUnlockAllConfirmMessage(total: number): string {
  return `未选择账号，是否解锁全部 ${total} 个需要解锁的账号？\n\n提示: 可以先勾选要解锁的账号再点击此按钮`;
}

/** 对标 collect_unlock_targets_from_all（:316-327） */
export function collectUnlockTargetsFromAll(accounts: readonly AccountDict[]): {
  accountsToUnlock: AccountDict[];
  browserIds: string[];
} {
  const accountsToUnlock: AccountDict[] = [];
  const browserIds: string[] = [];
  for (const account of accounts) {
    const id = pyGet(account, "browser_profile_id", "");
    if (id) {
      accountsToUnlock.push(account);
      browserIds.push(String(id));
    }
  }
  return { accountsToUnlock, browserIds };
}

/** 对标 split_accounts_with_browser（:330-347） */
export function splitAccountsWithBrowser(
  accounts: readonly AccountDict[],
  browserIds: readonly string[],
): { accountsWithBrowser: AccountDict[]; validBrowserIds: string[]; noBrowserEmails: string[] } {
  const r = { accountsWithBrowser: [] as AccountDict[], validBrowserIds: [] as string[], noBrowserEmails: [] as string[] };
  zip(accounts, browserIds, (account, browserId) => {
    if (browserId && browserId !== "-") {
      r.accountsWithBrowser.push(account);
      r.validBrowserIds.push(browserId);
      return;
    }
    r.noBrowserEmails.push(emailOf(account));
  });
  return r;
}

/** 对标 build_unlock_confirm_message（:350-361）；`x or '自动'` → 0 / null 都显示「自动」 */
export function buildUnlockConfirmMessage(
  unlockableCount: number,
  noBrowserCount: number,
  countryId: number | null,
  projectId: number | null,
): string {
  let message = `将解锁 ${unlockableCount} 个账号`;
  if (noBrowserCount) message += `\n\n⚠️ ${noBrowserCount} 个账号未绑定窗口（已跳过）`;
  message += `\n\n国家ID: ${countryId || "自动"} | 服务ID: ${projectId || "自动"}`;
  return message;
}

/** 对标 get_available_pro_accounts（:364-366） */
export function getAvailableProAccounts(repo: { getAvailableProAccounts(): AccountDict[] }): AccountDict[] {
  return repo.getAvailableProAccounts();
}

// ==================== 开启家庭共享 ====================

/** 对标 prepare_enable_family_sharing_candidates（:369-406） */
export function prepareEnableFamilySharingCandidates(
  accounts: readonly AccountDict[],
  browserIds: readonly string[],
): {
  validAccounts: AccountDict[];
  validBrowserIds: string[];
  skippedNotPro: string[];
  skippedNotLogged: string[];
  skippedNoBrowser: string[];
} {
  const r = {
    validAccounts: [] as AccountDict[],
    validBrowserIds: [] as string[],
    skippedNotPro: [] as string[],
    skippedNotLogged: [] as string[],
    skippedNoBrowser: [] as string[],
  };
  zip(accounts, browserIds, (account, browserId) => {
    const email = emailOf(account);
    if (pyGet(account, "is_pro", "unknown") !== "yes") return void r.skippedNotPro.push(email);
    if (pyGet(account, "login_status", "") !== "logged_in") return void r.skippedNotLogged.push(email);
    if (!browserId) return void r.skippedNoBrowser.push(email);
    r.validAccounts.push(account);
    r.validBrowserIds.push(browserId);
  });
  return r;
}

/** 对标 build_no_enable_family_sharing_candidates_message（:409-422） */
export function buildNoEnableFamilySharingCandidatesMessage(
  skippedNotPro: readonly string[],
  skippedNotLogged: readonly string[],
  skippedNoBrowser: readonly string[],
): string {
  let message = "没有可开启共享的普通 Pro 账户\n\n";
  if (skippedNotPro.length) message += `⚠️ ${skippedNotPro.length} 个不是普通 Pro 账户\n`;
  if (skippedNotLogged.length) message += `⚠️ ${skippedNotLogged.length} 个未登录\n`;
  if (skippedNoBrowser.length) message += `⚠️ ${skippedNoBrowser.length} 个未绑定窗口`;
  return message;
}

/** 对标 build_enable_family_sharing_confirm_message（:425-439） */
export function buildEnableFamilySharingConfirmMessage(
  validCount: number,
  skippedNotProCount: number,
  skippedNotLoggedCount: number,
  skippedNoBrowserCount: number,
): string {
  let message = `将为 ${validCount} 个普通 Pro 账户开启家庭共享`;
  if (skippedNotProCount) message += `\n\n⚠️ 跳过 ${skippedNotProCount} 个非普通 Pro 账户`;
  if (skippedNotLoggedCount) message += `\n⚠️ 跳过 ${skippedNotLoggedCount} 个未登录账户`;
  if (skippedNoBrowserCount) message += `\n⚠️ 跳过 ${skippedNoBrowserCount} 个未绑定窗口账户`;
  return message;
}

// ==================== 家庭组分配（仅移植，不接线） ====================

/**
 * 对标 allocate_to_pro_accounts（:442-473）：按顺序把普通账户分配到 Pro 家庭组
 * 每个 Pro 的空位 = 6 - max(family_member_count or 0, 1)；被锁的受邀人跳过；
 * Pro 名额用尽即停止（Python 的 while...else: break）。
 */
export function allocateToProAccounts(
  invitees: readonly AccountDict[],
  proAccounts: readonly AccountDict[],
  lock: { isLocked(email: string): boolean },
): { assignments: Array<[AccountDict, AccountDict]>; skippedLockedCount: number } {
  const assignments: Array<[AccountDict, AccountDict]> = [];
  const skippedLocked: string[] = [];
  let proIndex = 0;

  const proSlots = new Map<string, number>();
  for (const account of proAccounts) {
    const count = Number(pyGet(account, "family_member_count", 0) || 0);
    proSlots.set(String(account["email"]), 6 - Math.max(count, 1));
  }

  for (const invitee of invitees) {
    const inviteeEmail = emailOf(invitee);
    if (lock.isLocked(inviteeEmail)) {
      skippedLocked.push(inviteeEmail);
      continue;
    }
    let assigned = false;
    while (proIndex < proAccounts.length) {
      const pro = proAccounts[proIndex] as AccountDict;
      const proEmail = String(pro["email"]);
      const slots = proSlots.get(proEmail) ?? 0;
      if (slots > 0) {
        assignments.push([invitee, pro]);
        proSlots.set(proEmail, slots - 1);
        assigned = true;
        break;
      }
      proIndex += 1;
    }
    if (!assigned) break;
  }

  return { assignments, skippedLockedCount: skippedLocked.length };
}

/** 对标 build_family_assignments_preview_message（:476-502） */
export function buildFamilyAssignmentsPreviewMessage(
  assignments: ReadonlyArray<readonly [AccountDict, AccountDict]>,
  normalAccountsCount: number,
  skippedLockedCount: number,
  previewLimit = 10,
): string {
  let unassigned = normalAccountsCount - assignments.length - skippedLockedCount;
  if (unassigned < 0) unassigned = 0;

  let message = `即将分配 ${assignments.length} 个普通账户到家庭组\n\n`;
  message += "分配预览:\n";
  for (const [invitee, pro] of assignments.slice(0, previewLimit)) {
    message += `  • ${emailOf(invitee)} -> ${emailOf(pro)}\n`;
  }
  if (assignments.length > previewLimit) message += `  ... 等 ${assignments.length} 个\n`;
  if (unassigned > 0) message += `\n⚠️ ${unassigned} 个账户因 Pro 名额不足未能分配\n`;
  if (skippedLockedCount > 0) message += `⚠️ ${skippedLockedCount} 个账户正在被其他任务处理，已跳过\n`;
  return message;
}

// ==================== 工具 ====================

/** Python 的 zip：按较短的长度配对 */
function zip(
  accounts: readonly AccountDict[],
  browserIds: readonly string[],
  fn: (account: AccountDict, browserId: string) => void,
): void {
  const n = Math.min(accounts.length, browserIds.length);
  for (let i = 0; i < n; i++) fn(accounts[i] as AccountDict, browserIds[i] as string);
}
