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

/** 写入用的宽松代理结构：不要求索引签名，便于 DataStore 等上层传入 */
export interface ProxyLike {
  proxy_type?: string | null;
  host?: string | null;
  port?: string | number | null;
  username?: string | null;
  password?: string | null;
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

  /**
   * 绑定代理到窗口。browser_id 唯一，冲突时改绑并刷新 bound_at。
   * 对标 bind_proxy_to_window()，异常吞掉返回 false。
   */
  bindProxyToWindow(proxyId: number, browserId: string, email: string | null): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO proxy_window_bindings (proxy_id, browser_id, email)
           VALUES (?, ?, ?)
           ON CONFLICT(browser_id) DO UPDATE SET
             proxy_id = excluded.proxy_id,
             email = excluded.email,
             bound_at = CURRENT_TIMESTAMP`,
        )
        .run(proxyId, browserId, email);
      return true;
    } catch (error) {
      console.error(`[DB ERROR] bind_proxy_to_window 失败: ${error}`);
      return false;
    }
  }

  /** 解绑窗口。对标 unbind_proxy_from_window() */
  unbindProxyFromWindow(browserId: string): boolean {
    try {
      this.db.prepare("DELETE FROM proxy_window_bindings WHERE browser_id = ?").run(browserId);
      return true;
    } catch (error) {
      console.error(`[DB ERROR] unbind_proxy_from_window 失败: ${error}`);
      return false;
    }
  }

  /**
   * 增量保存代理列表，并清理不再出现的代理及其绑定。
   * 对标 save_all_proxies()：以 host:port 为身份键，
   * 命中则 UPDATE（只更新 type/username/password），否则 INSERT；
   * 库里多出来的按 key 删除，连带删除 proxy_window_bindings。
   */
  saveAllProxies(proxies: ProxyLike[]): void {
    try {
      const rows = this.db.prepare("SELECT id, host, port FROM proxies").all() as {
        id: number; host: string | null; port: string | number | null;
      }[];
      const existing = new Map<string, number>();
      for (const r of rows) existing.set(`${r.host ?? ""}:${r.port ?? ""}`, r.id);

      const updateStmt = this.db.prepare(
        "UPDATE proxies SET proxy_type=?, username=?, password=? WHERE id=?",
      );
      const insertStmt = this.db.prepare(
        "INSERT INTO proxies (proxy_type, username, password, host, port) VALUES (?, ?, ?, ?, ?)",
      );
      const delBind = this.db.prepare("DELETE FROM proxy_window_bindings WHERE proxy_id = ?");
      const delProxy = this.db.prepare("DELETE FROM proxies WHERE id = ?");

      this.db.exec("BEGIN");
      try {
        const newKeys = new Set<string>();
        for (const proxy of proxies) {
          const key = `${proxy.host ?? ""}:${proxy.port ?? ""}`;
          newKeys.add(key);
          const id = existing.get(key);
          if (id !== undefined) {
            updateStmt.run(proxy.proxy_type ?? "socks5", proxy.username ?? "", proxy.password ?? "", id);
          } else {
            insertStmt.run(
              proxy.proxy_type ?? "socks5",
              proxy.username ?? "",
              proxy.password ?? "",
              proxy.host ?? "",
              proxy.port ?? "",
            );
          }
        }

        for (const [key, id] of existing) {
          if (!newKeys.has(key)) {
            delBind.run(id);
            delProxy.run(id);
          }
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      console.error(`[DB ERROR] save_all_proxies 失败: ${error}`);
    }
  }

  /** 新增单个代理 */
  addProxy(proxy: ProxyLike): void {
    try {
      this.db
        .prepare(
          "INSERT INTO proxies (proxy_type, username, password, host, port) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          proxy.proxy_type ?? "socks5",
          proxy.username ?? "",
          proxy.password ?? "",
          proxy.host ?? "",
          proxy.port ?? "",
        );
    } catch (error) {
      console.error(`[DB ERROR] add_proxy 失败: ${error}`);
    }
  }

  /** 删除代理 */
  deleteProxy(proxyId: number): void {
    try {
      this.db.prepare("DELETE FROM proxies WHERE id = ?").run(proxyId);
    } catch (error) {
      console.error(`[DB ERROR] delete_proxy 失败: ${error}`);
    }
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM proxies").get() as { n: number };
    return row.n;
  }
}
