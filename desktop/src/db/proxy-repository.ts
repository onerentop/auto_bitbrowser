/**
 * 代理仓储（Node 重写）
 * 对标 services/repositories/proxy_repository.py
 */
import type { Db } from "./connection.ts";

export interface ProxyRow {
  id: number;
  proxy_type: string | null;
  host: string | null;
  port: string | number | null;
  username: string | null;
  password: string | null;
  [key: string]: unknown;
}

export interface ProxyUsageStat {
  proxy_id: number;
  proxy_type: string | null;
  host: string | null;
  port: string | number | null;
  username: string | null;
  password: string | null;
  used_count: number;
  max_count: number;
  is_full: boolean;
}

export class ProxyRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** 对标 get_all_proxies() */
  getAllProxies(): ProxyRow[] {
    return this.db.prepare("SELECT * FROM proxies ORDER BY id").all() as ProxyRow[];
  }

  /** 对标 get_proxy_binding_count() */
  getProxyBindingCount(proxyId: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM proxy_window_bindings WHERE proxy_id = ?")
      .get(proxyId) as { n: number };
    return row.n;
  }

  /** 对标 get_proxy_bindings() */
  getProxyBindings(proxyId: number): { browser_id: string; email: string | null }[] {
    return this.db
      .prepare("SELECT browser_id, email FROM proxy_window_bindings WHERE proxy_id = ?")
      .all(proxyId) as { browser_id: string; email: string | null }[];
  }

  /**
   * 对标 get_all_proxy_usage_stats(max_per_ip)
   * Python 侧用 LEFT JOIN + GROUP BY 统计每个代理已绑定多少窗口。
   */
  getAllProxyUsageStats(maxPerIp: number): ProxyUsageStat[] {
    const rows = this.db
      .prepare(
        `SELECT p.id AS proxy_id, p.proxy_type, p.host, p.port, p.username, p.password,
                COUNT(b.browser_id) AS used_count
         FROM proxies p
         LEFT JOIN proxy_window_bindings b ON p.id = b.proxy_id
         GROUP BY p.id
         ORDER BY p.id`,
      )
      .all() as Omit<ProxyUsageStat, "max_count" | "is_full">[];

    return rows.map((r) => ({
      ...r,
      max_count: maxPerIp,
      is_full: r.used_count >= maxPerIp,
    }));
  }

  /**
   * 对标 get_next_available_proxy(max_per_ip)
   * Python: HAVING used_count < ? ORDER BY p.id LIMIT 1
   */
  getNextAvailableProxy(maxPerIp: number): ProxyRow | null {
    const row = this.db
      .prepare(
        `SELECT p.*, COUNT(b.browser_id) AS used_count
         FROM proxies p
         LEFT JOIN proxy_window_bindings b ON p.id = b.proxy_id
         GROUP BY p.id
         HAVING used_count < ?
         ORDER BY p.id
         LIMIT 1`,
      )
      .get(maxPerIp);
    return (row as ProxyRow) ?? null;
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM proxies").get() as { n: number };
    return row.n;
  }
}
