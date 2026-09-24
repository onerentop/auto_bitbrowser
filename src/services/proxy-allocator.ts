/**
 * 代理分配器（Node 重写）
 *
 * 只是 ProxyRepository 之上的一层薄封装 + ixBrowser 配置格式转换。
 * 直接依赖仓储。
 */
import type { ProxyBindingRow, ProxyRepository, ProxyRow, ProxyUsageStat } from "../db/proxy-repository.ts";

/** 传给 ixBrowser 建窗口用的代理配置。注意键名与库表字段不同 */
export interface BrowserProxyConfig {
  type: string;
  host: string;
  port: string | number;
  username: string;
  password: string;
}

export const DEFAULT_MAX_WINDOWS_PER_IP = 3;

export class ProxyAllocator {
  private readonly repo: ProxyRepository;
  private readonly maxPerIp: number;

  constructor(repo: ProxyRepository, maxPerIp: number = DEFAULT_MAX_WINDOWS_PER_IP) {
    this.repo = repo;
    this.maxPerIp = maxPerIp;
  }

  getMaxWindowsPerIp(): number {
    return this.maxPerIp;
  }

  /** 取下一个未满的代理 */
  getNextAvailableProxy(): ProxyRow | null {
    return this.repo.getNextAvailableProxy(this.maxPerIp);
  }

  /**
   * 为窗口分配代理并写入绑定。
   * 无可用代理、或绑定失败，都返回 null。
   */
  allocateProxy(browserId: string, email: string | null = null): ProxyRow | null {
    const proxy = this.getNextAvailableProxy();
    if (!proxy) return null;

    const ok = this.repo.bindProxyToWindow(proxy.id, browserId, email);
    return ok ? proxy : null;
  }

  unbindWindow(browserId: string): boolean {
    return this.repo.unbindProxyFromWindow(browserId);
  }

  getAllUsageStats(): ProxyUsageStat[] {
    return this.repo.getAllProxyUsageStats(this.maxPerIp);
  }

  getProxyBindings(proxyId: number): { browser_id: string; email: string | null }[] {
    return this.repo.getProxyBindings(proxyId);
  }

  /**
   * 代理绑定情况的完整返回：
   * [{id, proxy_id, browser_id, email, bound_at}]。已有的 getProxyBindings 只返回两列，保持不变。
   */
  getProxyBindingDetails(proxyId: number): ProxyBindingRow[] {
    return this.repo.getProxyBindingDetails(proxyId);
  }

  /** 剩余可分配窗口总数：未满代理的剩余额度之和 */
  getAvailableCount(): number {
    return this.getAllUsageStats()
      .filter((s) => !s.is_full)
      .reduce((sum, s) => sum + (s.max_count - s.used_count), 0);
  }

  hasAvailableProxy(): boolean {
    return this.getNextAvailableProxy() !== null;
  }

  /**
   * 库表字段 → ixBrowser proxy_config 的字段名转换。
   * proxy_type→type, host→host, port→port, username/password 原样。
   */
  static getProxyConfigForBrowser(proxy: ProxyRow | null | undefined): BrowserProxyConfig | null {
    if (!proxy) return null;
    return {
      type: proxy.proxy_type ?? "socks5",
      host: proxy.host ?? "",
      port: proxy.port ?? "",
      username: proxy.username ?? "",
      password: proxy.password ?? "",
    };
  }
}