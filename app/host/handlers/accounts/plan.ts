/**
 * 账号管理页：批量操作的「前置校验 + 候选筛选 + 确认文案」
 *
 * 每个分支对应界面上一个入口按钮的处理逻辑（详见各 case）。
 * 界面层边判断边弹框；这里把判断结果整理成一份计划：
 *   - ok=false：按 level 显示 title / message 后 return
 *   - ok=true ：依次弹 confirms 里的确认框，全部确认后才启动 task
 * precheck 与 start 共用本函数，start 时会重新执行一遍（数据可能在两次调用之间变化）。
 *
 * 已按用户要求删除：OAuth（批量 / 单个 / 一键登录+OAuth）、检测 Pro、刷新家庭组、开启共享、检测 403、批量解锁 403。
 */
import type {
  AccountsAction,
  AccountsPrecheckResult,
  ConfirmStep,
  SelectedRow,
} from "../../../shared/channels/accounts.ts";
import { DELETE_ACCOUNTS_ONLY_LABEL } from "../../../shared/channels/accounts.ts";
import {
  buildBatchDeleteConfirmMessage,
  checkTaskConflicts,
  collectMissingBrowserEmails,
  collectUnboundEmails,
  getAccountAndBrowser,
  matchAccountsToWindows,
  resolveSelectedAccounts,
  type AccountDict,
  type AccountLookup,
  type WindowLike,
} from "../../../../src/application/account-manager-service.ts";

export interface PlanEnv {
  repo: AccountLookup;
  /** 是否已有任务在跑 */
  busy: boolean;
  /** 窗口列表查询参数（ixBrowser 每次取前 500 个窗口）；不可达时抛错 */
  listWindows(): Promise<WindowLike[]>;
}

export type TaskSpec =
  | {
      kind: "login";
      label: string;
      accounts: AccountDict[];
      browserIds: string[];
      /** 任务开始时写入的第一条日志 */
      startLog: string;
    }
  | { kind: "bind"; label: string; matched: Array<[string, string]>; notMatchedCount: number }
  | {
      kind: "delete";
      label: string;
      accounts: AccountDict[];
      browserIds: string[];
      withWindows: boolean;
      /** 界面行上的窗口 ID 与数据库不一致而跳过的账号（执行时记日志并计为失败） */
      staleEmails: string[];
    }
  | {
      /**
       * 账号健康巡检（本地新增）：只读检查每个账号在窗口里的会话状态。
       * browserIds 与 accounts 一一对应；未绑定窗口的账号在编排层直接判 window_error。
       */
      kind: "health_check";
      label: string;
      accounts: AccountDict[];
      browserIds: string[];
    };

export type PlanFailure = Extract<AccountsPrecheckResult, { ok: false }>;
export type Plan = PlanFailure | { ok: true; confirms: ConfirmStep[]; logs: string[]; total: number; task: TaskSpec };

const info = (message: string, title = "提示"): PlanFailure => ({ ok: false, level: "info", title, message });
const warning = (message: string, title = "警告"): PlanFailure => ({ ok: false, level: "warning", title, message });

function ok(task: TaskSpec, total: number, confirms: ConfirmStep[] = [], logs: string[] = []): Plan {
  return { ok: true, confirms, logs, total, task };
}

/** 去掉 task（precheck 只把提示信息返回给界面） */
export function toPrecheckResult(plan: Plan): AccountsPrecheckResult {
  if (!plan.ok) return plan;
  return { ok: true, confirms: plan.confirms, logs: plan.logs, total: plan.total };
}

/** 任务开始时的日志 */
function login(accounts: AccountDict[], browserIds: string[], label = "批量登录"): TaskSpec {
  return {
    kind: "login",
    label,
    accounts,
    browserIds,
    startLog: `开始 login 任务，共 ${accounts.length} 个账号...`,
  };
}

/** 「以下账号未绑定窗口」提示 */
function missingMessage(missing: string[]): string {
  let msg = `以下账号未绑定窗口:\n${missing.slice(0, 5).join(", ")}`;
  if (missing.length > 5) msg += `\n...等 ${missing.length} 个`;
  return msg;
}

/** 数据库里账号当前绑定的窗口 ID（未绑定为 ""） */
export function dbBrowserId(account: AccountDict): string {
  const id = account["browser_profile_id"];
  return id ? String(id) : "";
}

export const staleLog = (email: string): string => `数据已变化，请刷新后重试: ${email}`;

function staleMessage(emails: string[]): string {
  let msg = `数据已变化，请刷新后重试:\n${emails.slice(0, 5).join(", ")}`;
  if (emails.length > 5) msg += `\n...等 ${emails.length} 个`;
  return msg;
}

export async function planAction(action: AccountsAction, rows: readonly SelectedRow[], env: PlanEnv): Promise<Plan> {
  // 界面表格里的 (email, browser_id)
  const pairs = rows.map((r) => [r.email, r.browserId] as const);
  const selected = () => resolveSelectedAccounts(env.repo, pairs);
  // 设计取舍：worker 类任务的窗口 ID 一律以数据库的 browser_profile_id 为准，
  // 不信任界面行上可能已过期的值；数据库里未绑定的按「未绑定窗口」处理（沿用原有前置校验文案）。
  const selectedDb = () => {
    const { accounts } = selected();
    return { accounts, browserIds: accounts.map(dbBrowserId) };
  };

  // 冲突检查：后端只允许一个任务，所以所有 flag 归并为 workerRunning
  const conflict = (waitAction = ""): PlanFailure | null => {
    const [can, message] = checkTaskConflicts({ workerRunning: env.busy, waitAction });
    return can ? null : warning(message);
  };

  switch (action) {
    // ---------- 单个账号 ----------
    case "single_login": {
      const busy = conflict();
      if (busy) return busy;
      const email = rows[0]?.email ?? "";
      const { account, browserId } = getAccountAndBrowser(env.repo, email);
      if (!account) return warning(`未找到账号: ${email}`);
      if (!browserId) return warning(`账号 ${email} 未绑定浏览器窗口`);
      return ok(login([account], [browserId], `登录 ${email}`), 1);
    }

    // ---------- 批量登录 ----------
    case "login": {
      const busy = conflict();
      if (busy) return busy;
      const { accounts, browserIds } = selectedDb();
      if (accounts.length === 0) return info("请先选择要登录的账号");
      const missing = collectMissingBrowserEmails(accounts, browserIds);
      if (missing.length) return warning(missingMessage(missing));
      return ok(login(accounts, browserIds), accounts.length);
    }

    // ---------- 批量绑定窗口 ----------
    case "batch_bind": {
      const busy = conflict();
      if (busy) return busy;
      const unbound = collectUnboundEmails(pairs);
      if (unbound.length === 0) return info("请先选择未绑定窗口的账号");

      let windows: WindowLike[];
      try {
        windows = await env.listWindows();
      } catch (error) {
        const e = error instanceof Error ? error.message : String(error);
        return { ok: false, level: "error", title: "错误", message: `批量绑定失败:\n${e}` };
      }
      if (!windows.length) return warning("未找到可用的浏览器窗口\n请先在主界面创建窗口");

      const { matched, notMatched, alreadyBound } = matchAccountsToWindows(env.repo, unbound, windows);
      if (matched.length === 0) {
        let msg = "未找到可用的匹配窗口!\n\n";
        if (alreadyBound.length) msg += `⚠️ ${alreadyBound.length} 个窗口已被其他账号绑定\n`;
        if (notMatched.length) msg += `❌ ${notMatched.length} 个账号未找到匹配窗口`;
        return warning(msg);
      }

      let msg = `将绑定 ${matched.length} 个账号到对应窗口`;
      if (alreadyBound.length) msg += `\n\n⚠️ ${alreadyBound.length} 个窗口已被其他账号绑定（已跳过）`;
      if (notMatched.length) {
        msg += `\n\n❌ ${notMatched.length} 个账号未找到匹配窗口:\n${notMatched.slice(0, 5).join(", ")}`;
        if (notMatched.length > 5) msg += `\n...等 ${notMatched.length} 个`;
      }
      return ok(
        { kind: "bind", label: "批量绑定窗口", matched, notMatchedCount: notMatched.length },
        matched.length,
        [{ title: "确认", message: `${msg}\n\n是否继续？` }],
      );
    }

    // ---------- 批量删除 ----------
    case "delete":
    case "delete_with_windows": {
      const busy = conflict("删除");
      if (busy) return busy;
      const { accounts: all, browserIds: rowIds } = selected();
      if (all.length === 0) return info("请先勾选要删除的账号");
      const withWindows = action === "delete_with_windows";
      if (!withWindows) {
        return ok(
          { kind: "delete", label: DELETE_ACCOUNTS_ONLY_LABEL, accounts: all, browserIds: rowIds, withWindows, staleEmails: [] },
          all.length,
          [{ title: "确认删除", message: buildBatchDeleteConfirmMessage(all.length, false) }],
        );
      }
      // 设计取舍：窗口 ID 一律取数据库里的 browser_profile_id，而不是界面行上的旧值。
      // 行上的值与数据库不一致（界面数据过期）时整条跳过 —— 既不删账号也不删窗口，只记日志，
      // 避免误删已被重新绑定给其他账号的窗口。
      const accounts: AccountDict[] = [];
      const browserIds: string[] = [];
      const staleEmails: string[] = [];
      all.forEach((account, i) => {
        const dbId = dbBrowserId(account);
        if ((rowIds[i] ?? "") !== dbId) {
          staleEmails.push(String(account["email"] ?? ""));
          return;
        }
        accounts.push(account);
        browserIds.push(dbId);
      });
      if (accounts.length === 0) return warning(staleMessage(staleEmails));
      return ok(
        { kind: "delete", label: "删除+窗口", accounts, browserIds, withWindows, staleEmails },
        accounts.length,
        [{ title: "确认删除", message: buildBatchDeleteConfirmMessage(accounts.length, true) }],
        staleEmails.map(staleLog),
      );
    }

    // ---------- 右键「删除账号和窗口」 ----------
    // 与批量删除共用后台任务（batch_delete）的实现要点：
    //   1. 执行方式：不在界面线程同步执行，而是与批量删除共用后台任务（batch_delete），
    //      结束后由任务完成事件刷新列表、弹「删除完成」提示。
    //   2. 冲突检查：与批量删除一样走 checkTaskConflicts（等待运行中的任务结束后再删除）。
    //   3. 顺序与日志：先删账号成功后再删窗口，日志为
    //      「开始批量删除…」「已删除: email」
    //      「批量删除完成: …」「已删除 N 个窗口」。
    //   4. 窗口 ID 取数据库的 browser_profile_id；与界面行上的值不一致时拒绝（数据已变化，请刷新后重试）。
    case "delete_one_with_window": {
      const busy = conflict("删除");
      if (busy) return busy;
      const row = rows[0];
      const email = row?.email ?? "";
      const account = env.repo.getAccountByEmail(email);
      if (!account) return warning(`未找到账号: ${email}`);
      const rowId = row && row.browserId !== "-" ? row.browserId : "";
      const browserId = dbBrowserId(account);
      if (!browserId && !rowId) return warning(`账号 ${email} 未绑定浏览器窗口`);
      if (rowId !== browserId) return warning(staleMessage([email]));
      return ok(
        {
          kind: "delete",
          label: "删除账号和窗口",
          accounts: [account],
          browserIds: [browserId],
          withWindows: true,
          staleEmails: [],
        },
        1,
        [
          {
            title: "确认删除",
            message: `确定要删除账号 ${email} 及其对应的浏览器窗口吗？\n\n窗口 ID: ${browserId}\n\n⚠️ 此操作不可恢复！`,
          },
        ],
      );
    }

    // ---------- 账号健康巡检（本地新增能力） ----------
    // 只读，所以不做「未绑定窗口」之类的阻断：没绑窗口的账号在编排层直接记 window_error，
    // 免得一个坏账号挡住整批巡检。
    case "health_check": {
      const busy = conflict("巡检");
      if (busy) return busy;
      const { accounts, browserIds } = selectedDb();
      if (accounts.length === 0) return info("请先选择要巡检的账号");
      return ok(
        { kind: "health_check", label: `健康巡检（${accounts.length} 个账号）`, accounts, browserIds },
        accounts.length,
      );
    }
  }
}
