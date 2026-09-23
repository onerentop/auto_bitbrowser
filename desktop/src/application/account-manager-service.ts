/**
 * 账号管理应用服务（Node 重写）
 * 对标 application/account_manager_service.py（仅保留登录 / 绑定 / 删除相关部分；
 * Pro 检测、会员刷新、开启共享、403 检测 / 解锁、家庭组加入 / 分配已随对应功能删除）
 *
 * 与 Python 的差异（全部为结构性差异，判定分支与文案逐字对齐）：
 *   1. Python 是 @staticmethod 集合 + 直接调全局 DBManager；这里是纯函数，
 *      需要查库的函数显式接收一个仓储（AccountLookup），便于离线单测。
 *   2. 返回元组 → 返回具名对象（字段名是 Python 局部变量名的 camelCase）。
 *   3. Python 的 `account.get(k, default)`：键存在但值为 None 时拿到 None 而不是默认值，
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
  batchBindRunning?: boolean;
  batchDeleteRunning?: boolean;
  waitAction?: string;
}

/** 对标 check_task_conflicts（:19-47）：返回 [可以执行, 提示文案]（已删除功能的 flag 一并移除） */
export function checkTaskConflicts(flags: TaskConflictFlags = {}): [boolean, string] {
  const checks: Array<[boolean, string]> = [
    [!!flags.batchBindRunning, "批量绑定任务正在执行中"],
    [!!flags.batchDeleteRunning, "批量删除任务正在执行中"],
    [!!flags.workerRunning, "已有任务在执行中"],
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
