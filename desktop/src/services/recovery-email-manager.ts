/**
 * 辅助邮箱池管理器（Node 重写）
 *
 * 在 RecoveryEmailRepository 之上实现「选哪个邮箱」的业务策略：
 * 启用 + 未超每日上限 + 不在排除列表，再按今日用量升序取第一个。
 */
import type { RecoveryEmailRepository } from "../db/recovery-email-repository.ts";
import type { HistoryRepository } from "../db/history-repository.ts";

/** 每个辅助邮箱每日可绑定的账号数上限 */
export const DAILY_BIND_LIMIT = 10;

/** 本地日期 YYYY-MM-DD */
export function todayString(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface PoolUsageItem {
  email: string;
  imap_password: string;
  is_enabled: number;
  note: string;
  today_usage: number;
  remaining: number;
  is_full: boolean;
}

export interface SelectedEmail {
  email: string;
  imap_password: string;
}

/** check_account_binding 的三种结果 */
export type BindingStatus = "already_bound" | "need_bind" | "no_available";

export class RecoveryEmailManager {
  private readonly repo: RecoveryEmailRepository;
  private readonly history: HistoryRepository | null;

  constructor(repo: RecoveryEmailRepository, history: HistoryRepository | null = null) {
    this.repo = repo;
    this.history = history;
  }

  /** 池中所有启用的邮箱地址 */
  getPoolEmails(): string[] {
    return this.repo
      .getPool()
      .filter((item) => item.is_enabled)
      .map((item) => item.email);
  }

  /** 池 + 今日用量。注意：不过滤 is_enabled，由调用方决定 */
  getPoolWithUsage(date: string = todayString()): PoolUsageItem[] {
    const pool = this.repo.getPool();
    const usage = this.repo.getDailyUsage(date);

    return pool.map((item) => {
      const used = usage[item.email] ?? 0;
      return {
        email: item.email,
        imap_password: item.imap_password ?? "",
        is_enabled: item.is_enabled,
        note: item.note ?? "",
        today_usage: used,
        remaining: Math.max(0, DAILY_BIND_LIMIT - used),
        is_full: used >= DAILY_BIND_LIMIT,
      };
    });
  }

  /** 今日总剩余额度，返回 [剩余, 总额]。只统计启用的邮箱 */
  getTotalRemaining(date: string = todayString()): [number, number] {
    const items = this.getPoolWithUsage(date).filter((i) => i.is_enabled);
    const total = items.length * DAILY_BIND_LIMIT;
    const used = items.reduce((s, i) => s + i.today_usage, 0);
    return [Math.max(0, total - used), total];
  }

  /** 选一个可用邮箱：启用 + 未满，按今日用量升序取第一个 */
  selectAvailableEmail(date: string = todayString()): SelectedEmail | null {
    return this.selectNextAvailableEmail([], date);
  }

  /**
   * 选下一个可用邮箱，排除指定列表。
   * 用于轮换场景：某邮箱绑定失败后换一个。
   */
  selectNextAvailableEmail(
    excludeEmails: string[] = [],
    date: string = todayString(),
  ): SelectedEmail | null {
    const exclude = new Set(excludeEmails);
    const available = this.getPoolWithUsage(date).filter(
      (i) => i.is_enabled && !i.is_full && !exclude.has(i.email),
    );
    if (available.length === 0) return null;

    available.sort((a, b) => a.today_usage - b.today_usage);
    const selected = available[0] as PoolUsageItem;
    return { email: selected.email, imap_password: selected.imap_password };
  }

  isEmailInPool(email: string): boolean {
    return this.getPoolEmails().includes(email);
  }

  /**
   * 判断账号的辅助邮箱绑定状态。
   * 当前已绑定池中邮箱时顺带写入绑定关系。
   */
  checkAccountBinding(
    accountEmail: string,
    currentRecoveryEmail: string | null,
    date: string = todayString(),
  ): [BindingStatus, string | null] {
    if (currentRecoveryEmail && this.isEmailInPool(currentRecoveryEmail)) {
      this.repo.setBinding(accountEmail, currentRecoveryEmail, "bound");
      return ["already_bound", currentRecoveryEmail];
    }

    const available = this.selectAvailableEmail(date);
    if (!available) return ["no_available", null];
    return ["need_bind", available.email];
  }

  /** 绑定成功：用量 +1、写绑定关系、补一条邮箱修改历史（兼容旧版） */
  recordBindSuccess(
    accountEmail: string,
    recoveryEmail: string,
    date: string = todayString(),
  ): void {
    this.repo.incrementUsage(recoveryEmail, date);
    this.repo.setBinding(accountEmail, recoveryEmail, "bound");
    this.history?.addEmailModification(accountEmail, recoveryEmail);
  }

  recordBindFailure(accountEmail: string, recoveryEmail: string): void {
    this.repo.setBinding(accountEmail, recoveryEmail, "failed");
  }

  addEmailToPool(email: string, imapPassword = "", note = ""): boolean {
    return this.repo.addToPool(email, imapPassword, note);
  }

  removeEmailFromPool(email: string): boolean {
    return this.repo.removeFromPool(email);
  }

  setEmailEnabled(email: string, enabled: boolean): boolean {
    return this.repo.updateEnabled(email, enabled);
  }

  resetTodayUsage(date: string = todayString()): number {
    return this.repo.resetDailyUsage(date);
  }

  /** 标记邮箱今日已满：Google 提示该邮箱不可绑定时调用 */
  markEmailFullToday(email: string, date: string = todayString()): boolean {
    return this.repo.setUsageFull(email, date, DAILY_BIND_LIMIT);
  }

  /** 取某个辅助邮箱的 IMAP 配置 */
  getImapConfig(recoveryEmail: string): { email: string; password: string } | null {
    const item = this.repo.getPool().find((i) => i.email === recoveryEmail);
    if (!item) return null;
    return { email: item.email, password: item.imap_password ?? "" };
  }
}