/**
 * 账号健康巡检（只读）
 *
 * 本地新增能力 —— 想知道「这批号还有多少能用」，跑一次批量登录成本太高
 * （会改动会话、耗时，还容易触发风控），所以这里改成只读巡检。
 *
 * 做法：只读访问 `myaccount.google.com`，按落点判定结论。**不提交密码、不提交验证码**，
 * 所以不会产生新的登录会话，账号状态也不会因为巡检本身变化。
 *
 * 判定顺序（每一步都给得出「依据」，写进任务日志便于复核）：
 *   1. 导航失败 / 拿不到页面地址              → window_error（窗口问题，不是账号问题）
 *   2. 地址含 /disabled，或页面文本出现停用词 → suspended（复用 login.ts 的停用词表，单一来源）
 *   3. 域名是 myaccount 且页面（文本或 HTML）出现该邮箱 → ok
 *   4. 其它（跳回 accounts.google.com 登录页、跳 www.google.com 等）→ need_login
 *   5. myaccount 两个页面都看不到该邮箱（登录的是别的账号）→ need_login
 */
import type { AccountRepository } from "../db/account-repository.ts";
import { Timeouts } from "../engine/constants.ts";
import { MYACCOUNT_URLS, TEXT } from "../engine/operations/login.ts";
import { printBanner, withEngine } from "./shared.ts";

/** 巡检结论 */
export type HealthStatus = "ok" | "need_login" | "suspended" | "window_error";

export interface HealthCheckResult {
  status: HealthStatus;
  /** 给人看的一句话（也是写进 last_error / 任务历史的内容） */
  message: string;
  /** 判定时的页面地址 */
  url: string;
  /** 判定依据（写进任务日志，便于事后复核为什么是这个结论） */
  reason: string;
}

/** 巡检用到的引擎能力：全部只读，没有任何 fill / click / act */
export interface HealthCheckEngine {
  navigate(url: string, options?: { timeoutMs?: number }): Promise<{ success: boolean; error?: string }>;
  wait(milliseconds: number): Promise<void>;
  getCurrentUrl(): Promise<string>;
  getPageContent(): Promise<string>;
  getPageHtml(): Promise<string>;
}

const MYACCOUNT_HOST = "myaccount.google.com";
const SIGNIN_HOST = "accounts.google.com";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

const hasAny = (text: string, words: readonly string[]): boolean => words.some((w) => text.includes(w));

/** Google 文案用弯引号（Couldn’t / it’s），统一成直引号再比较（与 login.ts 的 detectStage 一致） */
function normalize(text: unknown): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'");
}

/**
 * 只读判定一个账号在某个窗口里的状态。
 * email 必须是该窗口**当前登录的那个**邮箱；传别的邮箱就会得到 need_login（见真机用例）。
 */
export async function checkAccountHealth(
  engine: HealthCheckEngine,
  email: string,
): Promise<HealthCheckResult> {
  const target = email.trim().toLowerCase();
  let lastUrl = "";
  let navError = "";

  for (const pageUrl of MYACCOUNT_URLS) {
    const nav = await engine.navigate(pageUrl, { timeoutMs: Timeouts.NAVIGATION });
    if (!nav.success) {
      // 导航失败不算「未登录」：窗口坏了也可能导航失败，两种结论的处置完全不同
      navError = nav.error ?? "导航失败";
      continue;
    }
    await engine.wait(Timeouts.AFTER_NAVIGATION);
    const url = await engine.getCurrentUrl();
    const host = hostOf(url);
    if (!host) {
      return {
        status: "window_error",
        message: `页面地址异常: ${url || "(空)"}`,
        url,
        reason: "导航成功但拿不到页面地址",
      };
    }

    lastUrl = url;
    const text = normalize(await engine.getPageContent());

    // 停用优先于一切：停用页也可能显示该邮箱，但那是「已停用」而不是「正常」
    if (pathOf(url).includes("/disabled") || hasAny(text, TEXT.ACCOUNT_DISABLED)) {
      return {
        status: "suspended",
        message: "账号已被停用",
        url,
        reason: pathOf(url).includes("/disabled") ? `地址含 /disabled` : "页面出现停用提示文案",
      };
    }

    if (host === MYACCOUNT_HOST) {
      const html = normalize(await engine.getPageHtml());
      if (target && (text.includes(target) || html.includes(target))) {
        return { status: "ok", message: "已登录", url, reason: "myaccount 页面显示了该账号邮箱" };
      }
      // 在 myaccount 但看不到目标邮箱 —— 可能只是这个页面不显示邮箱，再看下一个验证页面
      continue;
    }

    // 其余域名（accounts.google.com 登录页 / www.google.com 等）都说明这个窗口没登录该账号
    return {
      status: "need_login",
      message: "需要登录",
      url,
      reason: `页面落在 ${host}（不是 myaccount${host === SIGNIN_HOST ? "，是登录页" : ""}）`,
    };
  }

  if (!lastUrl && navError) {
    return { status: "window_error", message: `窗口打不开: ${navError}`, url: "", reason: navError };
  }
  return {
    status: "need_login",
    message: "需要登录",
    url: lastUrl,
    reason: "myaccount 页面未显示该邮箱（窗口里登录的可能是别的账号）",
  };
}

/** 巡检结论 → 数据库写回（契约：窗口坏不算账号状态变坏） */
export function applyHealthResult(
  repo: Pick<AccountRepository, "updateLoginStatus" | "setLastError"> | undefined,
  email: string,
  result: HealthCheckResult,
): void {
  if (!repo) return;
  switch (result.status) {
    case "ok":
      // logged_in 会顺带刷新 last_login_at 并清空 last_error
      repo.updateLoginStatus(email, "logged_in");
      return;
    case "need_login":
      // 先清掉上一次的错误：只是「需要登录」时，旧错误信息会误导人
      repo.setLastError(email, null);
      repo.updateLoginStatus(email, "not_logged");
      return;
    case "suspended":
      repo.updateLoginStatus(email, "login_failed", result.message);
      return;
    case "window_error":
      // 不改 login_status（窗口坏 ≠ 账号状态变坏），也不能走 updateLoginStatus（它会清空 last_error）
      repo.setLastError(email, result.message);
      return;
  }
}

export interface AutoHealthCheckOptions {
  /** 任务日志回调 */
  callback?: ((msg: string) => void) | null;
  /** 写回账号状态；单测可注入假仓储 */
  accountRepo?: Pick<AccountRepository, "updateLoginStatus" | "setLastError">;
}

/**
 * 连接窗口 → 只读判定 → 写回状态。
 * 与其它 auto_* 一致：异常不抛出，转成 window_error 结论（一个坏窗口不能中断整批巡检）。
 */
export async function autoHealthCheck(
  browserId: string,
  account: Record<string, unknown>,
  options: AutoHealthCheckOptions = {},
): Promise<HealthCheckResult> {
  const email = String(account["email"] ?? "");
  const log = (msg: string): void => {
    process.stdout.write(`[HealthCheck] ${email}: ${msg}\n`);
    options.callback?.(`[${email}] ${msg}`);
  };

  printBanner("账号健康巡检（只读）", [`账号: ${email}`, `窗口: ${browserId}`]);
  log("只读检查窗口内的登录状态（不提交密码或验证码，不产生新会话）...");

  const result = await withEngine(
    browserId,
    { closeAfter: false },
    async (engine): Promise<HealthCheckResult> => {
      const r = await checkAccountHealth(engine, email);
      log(`结论: ${r.status} —— ${r.reason}${r.url ? `（${r.url}）` : ""}`);
      return r;
    },
    (msg): HealthCheckResult => {
      log(`[X] 异常: ${msg}`);
      return { status: "window_error", message: `窗口打不开: ${msg}`, url: "", reason: msg };
    },
  );

  applyHealthResult(options.accountRepo, email, result);
  return result;
}
