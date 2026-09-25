/**
 * 代理仓储
 */
import type { Db } from "./connection.ts";

export interface ProxyRow {
  id: number;
  proxy_type: string | null;
  host: string | null;
  port: string | number | null;
  username: string | null;
  password: string | null;
  /** 最近一次连通性检测时间（本地时间串），从未检测为 null */
  last_check_at?: string | null;
  /** 1=可达 / 0=不可达 / null=未检测 */
  last_check_ok?: number | null;
  last_check_error?: string | null;
  /** 经该代理出网的 IP */
  outbound_ip?: string | null;
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


/** Date → 本地时间串（与任务历史同一格式，界面直接读） */
function localStamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
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

  getAllProxies(): ProxyRow[] {
    return this.db.prepare("SELECT * FROM proxies ORDER BY id").all() as ProxyRow[];
  }

  getProxyBindingCount(proxyId: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM proxy_window_bindings WHERE proxy_id = ?")
      .get(proxyId) as { n: number };
    return row.n;
  }

  getProxyBindings(proxyId: number): { browser_id: string; email: string | null }[] {
    return this.db
      .prepare("SELECT browser_id, email FROM proxy_window_bindings WHERE proxy_id = ?")
      .all(proxyId) as { browser_id: string; email: string | null }[];
  }

  /**
 * max_per_ip
   * 用 LEFT JOIN + GROUP BY 统计每个代理已绑定多少窗口。
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
 * max_per_ip
   * SQL: HAVING used_count < ? ORDER BY p.id LIMIT 1
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
   * 异常吞掉返回 false。
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

 /** 解绑窗口。 */
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
 * 以 host:port 为身份键 
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

  /**
   * 返回绑定表整行（id / proxy_id / browser_id / email / bound_at），按 bound_at 倒序，出错返回 []。
   * 已有的 getProxyBindings 只取 browser_id / email 两列，行为保持不变；设置页「详情」用本方法。
   */
  getProxyBindingDetails(proxyId: number): ProxyBindingRow[] {
    try {
      return this.db
        .prepare("SELECT * FROM proxy_window_bindings WHERE proxy_id = ? ORDER BY bound_at DESC")
        .all(proxyId) as ProxyBindingRow[];
    } catch (error) {
      console.error(`[DB ERROR] get_proxy_bindings 失败: ${error}`);
      return [];
    }
  }
  /**
   * 写下一次连通性检测的结果。
   * 时间取**本地时间串**（与任务历史一致，界面直接显示无需换算）；
   * 失败写原因，成功写 null（清掉旧原因）。
   */
  updateCheckResult(
    proxyId: number,
    result: { ok: boolean; outboundIp: string | null; error: string | null },
    checkedAt = new Date(),
  ): boolean {
    try {
      this.db
        .prepare(
          `UPDATE proxies
             SET last_check_at = ?, last_check_ok = ?, last_check_error = ?, outbound_ip = ?
           WHERE id = ?`,
        )
        .run(localStamp(checkedAt), result.ok ? 1 : 0, result.ok ? null : result.error, result.outboundIp, proxyId);
      return true;
    } catch (error) {
      console.error(`[DB ERROR] update_check_result 失败: ${error}`);
      return false;
    }
  }
}

/** proxy_window_bindings 表的一行 */
export interface ProxyBindingRow {
  id: number;
  proxy_id: number;
  browser_id: string;
  email: string | null;
  bound_at: string | null;
  [key: string]: unknown;
}
