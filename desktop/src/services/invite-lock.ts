/**
 * 邀请锁管理器（Node 重写）
 * 对标 services/invite_lock.py
 *
 * 作用：防止同一邮箱被并发重复邀请。
 *
 * 线程模型差异：Python 用 threading.Lock 保护共享字典；
 * Node 单线程事件循环内不存在同一函数体被打断的竞态，
 * 因此不需要互斥锁，语义等价。
 *
 * 行为要点（与 Python 一致）：
 *   - 邮箱统一 toLowerCase().trim() 后作为键
 *   - 空邮箱视为"不需要锁"，try_lock 直接返回 true
 *   - 每次 tryLock / isLocked / getLockInfo 前都会先清理过期锁
 *   - 默认超时 30 分钟
 */

export const DEFAULT_LOCK_TIMEOUT_MS = 30 * 60_000;

export class InviteLockManager {
  private lockedEmails = new Map<string, Date>();
  private timeoutMs: number;

  /** 单例，对标 Python 的 __new__ 单例 */
  private static instance: InviteLockManager | null = null;

  static getInstance(): InviteLockManager {
    if (!InviteLockManager.instance) {
      InviteLockManager.instance = new InviteLockManager();
    }
    return InviteLockManager.instance;
  }

  constructor(timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  private normalize(email: string): string {
    return email.toLowerCase().trim();
  }

  /** 清理过期锁，返回清理数量 */
  private cleanupExpiredInternal(now: number = Date.now()): number {
    let removed = 0;
    for (const [email, lockTime] of this.lockedEmails) {
      if (now - lockTime.getTime() > this.timeoutMs) {
        this.lockedEmails.delete(email);
        removed += 1;
      }
    }
    return removed;
  }

  /** 尝试锁定。已被锁定返回 false；空邮箱返回 true（无需锁） */
  tryLock(email: string): boolean {
    if (!email) return true;
    const key = this.normalize(email);

    this.cleanupExpiredInternal();
    if (this.lockedEmails.has(key)) return false;

    this.lockedEmails.set(key, new Date());
    return true;
  }

  /** 解锁。空邮箱与不存在的键都静默忽略 */
  unlock(email: string): void {
    if (!email) return;
    this.lockedEmails.delete(this.normalize(email));
  }

  /** 是否被锁定（会先清理过期锁） */
  isLocked(email: string): boolean {
    if (!email) return false;
    this.cleanupExpiredInternal();
    return this.lockedEmails.has(this.normalize(email));
  }

  /** 取锁定时间，未锁定返回 null */
  getLockInfo(email: string): Date | null {
    if (!email) return null;
    this.cleanupExpiredInternal();
    return this.lockedEmails.get(this.normalize(email)) ?? null;
  }

  /** 主动清理过期锁，返回清理数量 */
  cleanupExpired(): number {
    return this.cleanupExpiredInternal();
  }

  getLockedCount(): number {
    this.cleanupExpiredInternal();
    return this.lockedEmails.size;
  }

  getLockedEmails(): string[] {
    this.cleanupExpiredInternal();
    return [...this.lockedEmails.keys()];
  }

  /** 清空全部锁，返回被清除的数量 */
  clearAll(): number {
    const count = this.lockedEmails.size;
    this.lockedEmails.clear();
    return count;
  }

  /** 设置超时（分钟）。Python 侧只在 minutes > 0 时生效 */
  setTimeout(minutes: number): void {
    if (minutes > 0) this.timeoutMs = minutes * 60_000;
  }
}