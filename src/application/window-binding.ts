/**
 * 账号 ↔ 窗口绑定的规则（纯逻辑 + 一个薄的执行用例，单测全部离线）
 *
 * 绑定关系（accounts.browser_profile_id）被批量登录、单个登录、健康巡检、删除+窗口、账号列表使用。
 * 规则：窗口名（去空白、不区分大小写）= 邮箱，视为「同名窗口」。
 *   - 自动绑定只在「恰好一个未被占用的同名窗口」时进行；同名多个**不猜**，交给用户在绑定对话框里挑；
 *   - 已绑定的账号一律不动（换窗口走「重新绑定」）；
 *   - 已被其它账号绑定的窗口不用；同一批里前面的账号绑走的窗口，后面的也不能再用。
 * 以前的「批量绑定窗口」遇到同名窗口时取后一个（可能绑错），已随该按钮删除。
 */
import type { AutoBindSummary } from "../../app/shared/channels/accounts.ts";
import type { AccountRepository } from "../db/account-repository.ts";

/** 窗口 / 账号的最小形状 */
export interface BindWindow {
  name?: unknown;
  profile_id?: unknown;
}
export interface BindAccount {
  email?: unknown;
  browser_profile_id?: unknown;
}

/** 窗口名 / 邮箱的比较键：去空白、小写；非字符串为空串 */
export function windowNameKey(name: unknown): string {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

function idOf(w: BindWindow): string {
  const id = w.profile_id;
  return id === null || id === undefined ? "" : String(id);
}

function boundId(a: BindAccount): string {
  const id = a.browser_profile_id;
  return id === null || id === undefined ? "" : String(id);
}

/** 规范化窗口名 → 同名窗口个数（空名不计） */
export function sameNameWindowCounts(windows: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const w of windows) {
    if (w === null || typeof w !== "object") continue;
    const key = windowNameKey((w as BindWindow).name);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export interface AutoBindPlan {
  toBind: Array<[string, string]>;
  ambiguous: Array<{ email: string; windowIds: string[] }>;
  notFound: string[];
  alreadyBound: number;
}

/**
 * 规划自动绑定：accounts 为库里全部账号（用来判断哪些窗口已被占用），targetEmails 为这次要处理的账号。
 * 库里没有的邮箱直接忽略；重复邮箱只处理一次。
 * targetEmails 必须与库里的邮箱逐字相同（调用方传的就是刚写库用的同一字符串）：库里允许只差大小写的两个账号并存，
 * 这里不做大小写归一，以免串号。
 */
export function planAutoBind(
  accounts: readonly BindAccount[],
  targetEmails: readonly string[],
  windows: readonly BindWindow[],
): AutoBindPlan {
  const taken = new Set<string>();
  const byEmail = new Map<string, BindAccount>();
  for (const a of accounts) {
    const id = boundId(a);
    if (id) taken.add(id);
    if (typeof a.email === "string") byEmail.set(a.email, a);
  }
  const byName = new Map<string, string[]>();
  for (const w of windows) {
    const key = windowNameKey(w.name);
    const id = idOf(w);
    if (!key || !id) continue;
    const list = byName.get(key);
    if (list) list.push(id);
    else byName.set(key, [id]);
  }

  const plan: AutoBindPlan = { toBind: [], ambiguous: [], notFound: [], alreadyBound: 0 };
  const seen = new Set<string>();
  for (const email of targetEmails) {
    if (seen.has(email)) continue;
    seen.add(email);
    const account = byEmail.get(email);
    if (!account) continue;
    if (boundId(account)) {
      plan.alreadyBound += 1;
      continue;
    }
    const free = (byName.get(windowNameKey(email)) ?? []).filter((id) => !taken.has(id));
    if (free.length === 1) {
      const id = free[0] as string;
      plan.toBind.push([email, id]);
      taken.add(id);
    } else if (free.length > 1) {
      plan.ambiguous.push({ email, windowIds: free });
    } else {
      plan.notFound.push(email);
    }
  }
  return plan;
}

export interface AutoBindDeps {
  repo: Pick<AccountRepository, "bindAccountToBrowser"> & { getAllAccounts(): readonly BindAccount[] };
  /** 取全部窗口；失败抛错（不影响调用方的导入 / 添加，只在结果里记 error） */
  listWindows: () => Promise<readonly BindWindow[]>;
  /** 有批量任务在跑时返回 true：此时跳过自动绑定（账号本身照常保存），结果里记 error */
  isBusy?: () => boolean;
}

export const BUSY_SKIP_MESSAGE = "有任务正在执行，本次没有自动绑定窗口";

/** 执行自动绑定；取窗口失败不抛错，写库失败列入 failed */
export async function autoBindAccounts(deps: AutoBindDeps, emails: readonly string[]): Promise<AutoBindSummary> {
  const summary: AutoBindSummary = { bound: 0, ambiguous: [], notFound: [], failed: [], alreadyBound: 0, error: null };
  if (emails.length === 0) return summary;
  if (deps.isBusy?.()) {
    summary.error = BUSY_SKIP_MESSAGE;
    return summary;
  }
  let windows: readonly BindWindow[];
  try {
    windows = await deps.listWindows();
  } catch (error) {
    summary.error = `获取窗口列表失败：${error instanceof Error ? error.message : String(error)}`;
    return summary;
  }
  // 取窗口要等网络，期间可能有批量任务启动（如「删除+窗口」）；任务运行中不写绑定，与单条绑定的 TASK_BUSY 规则一致
  if (deps.isBusy?.()) {
    summary.error = BUSY_SKIP_MESSAGE;
    return summary;
  }
  const plan = planAutoBind(deps.repo.getAllAccounts(), emails, windows);
  summary.ambiguous = plan.ambiguous;
  summary.notFound = plan.notFound;
  summary.alreadyBound = plan.alreadyBound;
  for (const [email, id] of plan.toBind) {
    if (deps.repo.bindAccountToBrowser(email, id)) summary.bound += 1;
    else summary.failed.push(email);
  }
  return summary;
}

/** 绑定对话框的候选：与邮箱同名的窗口排最前并标注，其余保持原顺序 */
export function rankBindCandidates<T extends { profileId: string; name: string }>(
  email: string,
  options: readonly T[],
): Array<T & { sameName: boolean }> {
  const key = windowNameKey(email);
  const tagged = options.map((o) => ({ ...o, sameName: key !== "" && windowNameKey(o.name) === key }));
  return [...tagged.filter((o) => o.sameName), ...tagged.filter((o) => !o.sameName)];
}
