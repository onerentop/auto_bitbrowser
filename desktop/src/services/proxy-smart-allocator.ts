/**
 * 代理智能分配器（Node 重写）
 * 对标 services/proxy_smart_allocator.py
 *
 * 功能（与 Python 一致）：
 *   1. 从 Sub2API 获取代理列表
 *   2. 选择账号数最少的代理（平均分配策略）
 *   3. 绑定账号到代理
 *   4. 同步更新 ixBrowser 窗口代理和备注
 *
 * 与 Python 的差异：
 *   - asyncio.Lock → Promise 串行队列（withLock）。Node 单线程但 async 函数会在 await
 *     处让出，仍可能交叉执行，因此这把"锁"是必需的，语义等价。
 *   - Python 的 `print()` 固定输出到 stdout；这里改为构造注入的 LogFn（默认 noopLog），
 *     callback 通道保持不变，仍是 `[ProxyBind] xxx`。双通道结构与 Python 一致。
 *   - Python 用 `loop.run_in_executor` 把同步的 ix_api 调用丢线程池；TS 侧
 *     IxBrowserClient 本身就是异步的，直接 await。
 *   - Python 的 `ix_api.update_profile_proxy` 内部自带重试并在失败时返回 False；
 *     TS 的 IxBrowserClient.updateProfileProxy 失败时抛异常（无重试），会落到 catch
 *     分支打印"更新异常"而不是"返回失败"。两者最终都返回 false。
 *   - Sub2ApiClient 必须注入（Python 侧同样是构造函数必填参数）；ixBrowser 客户端可选，
 *     默认自建 new IxBrowserClient()，对应 Python 的模块级 ix_api。
 *   - sleepImpl 可注入，便于离线测试；本文件的 Python 原型没有 sleep 调用，
 *     保留该钩子仅为与同批移植文件的构造参数保持一致。
 */

import { IxBrowserClient } from "../ixbrowser/client.ts";
import type { IxProxyConfig } from "../ixbrowser/types.ts";
import { noopLog, type LogFn } from "../browseruse/page.ts";
import type { Sub2ApiClient } from "./sub2api-client.ts";

// ==================== ProxyInfo（对应 Python dataclass） ====================

/** Sub2API 代理信息，保留 Python 的 snake_case 字段名 */
export interface ProxyInfo {
  id: number;
  name: string;
  /** http/https/socks5 */
  protocol: string;
  host: string;
  port: number;
  username: string;
  password: string;
  account_count: number;
  status: string;
}

/** dataclass 的默认值在工厂里给，覆盖时跳过 undefined */
export function createProxyInfo(overrides: Partial<ProxyInfo> = {}): ProxyInfo {
  const base: ProxyInfo = {
    id: 0,
    name: "",
    protocol: "http",
    host: "",
    port: 0,
    username: "",
    password: "",
    account_count: 0,
    status: "active",
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (base as unknown as Record<string, unknown>)[k] = v;
  }
  return base;
}

/**
 * int(x or 0) 的等价实现。
 * 差异：Python 对 `int("abc")` 会抛 ValueError，这里返回 0（不中断整批解析）。
 */
function toInt(value: unknown): number {
  if (!value) return 0;
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : 0;
}

/**
 * 从字典创建 ProxyInfo —— 对标 ProxyInfo.from_dict()
 * Python 的 `data.get(k, default) or default` 语义：取到假值（None/0/""）也回落默认值。
 */
export function proxyInfoFromDict(data: Record<string, unknown>): ProxyInfo {
  return {
    id: (data["id"] as number) || 0,
    name: (data["name"] as string) || "",
    protocol: (data["protocol"] as string) || "http",
    host: (data["host"] as string) || "",
    port: toInt(data["port"]),
    username: (data["username"] as string) || "",
    password: (data["password"] as string) || "",
    account_count: toInt(data["account_count"]),
    status: (data["status"] as string) || "active",
  };
}

// ==================== 分配器 ====================

/** get_proxy_stats() 返回的单条统计，字段与 Python 的 dict 逐字对应 */
export interface ProxyStat {
  id: number;
  name: string;
  account_count: number;
  host: string;
  port: number;
}

/** 代理列表缓存有效期（秒），对应 Python 的 cache_ttl 默认值 5.0 */
export const DEFAULT_PROXY_CACHE_TTL_SECONDS = 5.0;

export interface ProxySmartAllocatorOptions {
  /** 代理列表缓存有效期（秒），默认 5.0 */
  cacheTtl?: number;
  /** 对应 Python 的 print 通道，默认 noopLog */
  log?: LogFn;
  /** ixBrowser 客户端，默认自建（对应 Python 的模块级 ix_api） */
  ixClient?: IxBrowserClient;
  /** 可注入的 sleep，便于离线测试 */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * 代理智能分配器（带并发锁）
 *
 * 使用示例：
 *   const allocator = new ProxySmartAllocator(sub2apiClient);
 *   const ok = await allocator.allocateAndBind(123, "456");
 */
export class ProxySmartAllocator {
  private readonly client: Sub2ApiClient;
  private readonly ixClient: IxBrowserClient;
  private readonly cacheTtl: number;
  private readonly log: LogFn;
  /** 本文件的 Python 原型没有 sleep 调用，保留注入钩子供子类/测试使用 */
  protected readonly sleepImpl: (ms: number) => Promise<void>;

  private proxyCache: ProxyInfo[] = [];
  private cacheTime = 0;
  /** asyncio.Lock 的等价物：串行执行队列的队尾 */
  private lockTail: Promise<void> = Promise.resolve();

  constructor(sub2apiClient: Sub2ApiClient, options: ProxySmartAllocatorOptions = {}) {
    this.client = sub2apiClient;
    this.ixClient = options.ixClient ?? new IxBrowserClient();
    this.cacheTtl = options.cacheTtl ?? DEFAULT_PROXY_CACHE_TTL_SECONDS;
    this.log = options.log ?? noopLog;
    this.sleepImpl =
      options.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /** 日志输出（双通道：注入的 LogFn + 可选 callback），对标 _log() */
  private logMessage(msg: string, callback?: (message: string) => void): void {
    this.log(`[ProxyAllocator] ${msg}`);
    if (callback) callback(`[ProxyBind] ${msg}`);
  }

  /** 单位：秒，对齐 Python 的 time.time() */
  private now(): number {
    return Date.now() / 1000;
  }

  /** asyncio.Lock 的等价实现：先到先得地串行执行 */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lockTail;
    let release!: () => void;
    this.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** 刷新代理缓存，对标 _refresh_proxy_cache() */
  private async refreshProxyCache(): Promise<boolean> {
    const response = await this.client.getAllProxiesWithCount();

    if (!response.success) {
      this.logMessage(`获取代理列表失败: ${response.error}`);
      return false;
    }

    const data = response.data as unknown;
    let proxies: Record<string, unknown>[] = [];

    // 处理响应格式（判定顺序与 Python 一致）
    if (Array.isArray(data)) {
      // 直接是代理列表
      proxies = data as Record<string, unknown>[];
    } else if (data && typeof data === "object") {
      // 可能是 {items: [...]} 或 {proxies: [...]}
      const dict = data as Record<string, unknown>;
      const items = dict["items"];
      const alt = dict["proxies"];
      if (Array.isArray(items) && items.length > 0) {
        proxies = items as Record<string, unknown>[];
      } else if (Array.isArray(alt) && alt.length > 0) {
        proxies = alt as Record<string, unknown>[];
      } else {
        proxies = [];
      }
    }

    // 注意：这里的 status 过滤发生在 from_dict 之前，且用的是 dict.get 语义
    // ——键存在但值为 null 时不会回落 "active"，会被过滤掉（与 Python 一致）
    this.proxyCache = proxies
      .filter((p) => ("status" in p ? p["status"] : "active") === "active")
      .map((p) => proxyInfoFromDict(p));
    this.cacheTime = this.now();

    return true;
  }

  /**
   * 获取关联账号数最少的代理，对标 get_least_used_proxy()
   *
   * @returns ProxyInfo 或 null（无可用代理）
   */
  async getLeastUsedProxy(callback?: (message: string) => void): Promise<ProxyInfo | null> {
    // 检查缓存是否过期
    if (this.now() - this.cacheTime > this.cacheTtl || this.proxyCache.length === 0) {
      if (!(await this.refreshProxyCache())) {
        return null;
      }
    }

    if (this.proxyCache.length === 0) {
      this.logMessage("无可用代理", callback);
      return null;
    }

    // 按账号数升序排序，取第一个（sort 与 Python sorted 同为稳定排序）
    const sortedProxies = [...this.proxyCache].sort((a, b) => a.account_count - b.account_count);
    const leastUsed = sortedProxies[0]!;

    this.logMessage(
      `选择代理: ${leastUsed.name} (账号数: ${leastUsed.account_count})`,
      callback,
    );

    return leastUsed;
  }

  /**
   * 分配代理并绑定（原子操作，带锁），对标 allocate_and_bind()
   *
   * 操作流程：
   *   1. 获取锁
   *   2. 获取最少使用的代理
   *   3. 调用 Sub2API 更新账号 proxy_id
   *   4. 调用 Sub2API 更新账号 notes 为代理名称
   *   5. 调用 ixBrowser 更新窗口代理配置
   *   6. 调用 ixBrowser 更新窗口备注
   *   7. 更新本地缓存（使该代理 account_count +1）
   *   8. 释放锁
   */
  async allocateAndBind(
    sub2apiAccountId: number,
    browserProfileId: string,
    callback?: (message: string) => void,
  ): Promise<boolean> {
    return this.withLock(async () => {
      try {
        // 1. 获取最少使用的代理
        const proxy = await this.getLeastUsedProxy(callback);
        if (!proxy) {
          this.logMessage("无可用代理，跳过绑定", callback);
          return false;
        }

        // 2. 更新 Sub2API 账号（绑定代理 + 更新备注）
        this.logMessage(`更新 Sub2API 账号 ${sub2apiAccountId} -> 代理 ${proxy.name}`, callback);
        const updateResponse = await this.client.updateAccount(sub2apiAccountId, {
          proxyId: proxy.id,
          notes: proxy.name,
        });

        if (!updateResponse.success) {
          this.logMessage(`Sub2API 更新失败: ${updateResponse.error}`, callback);
          return false;
        }

        this.logMessage("Sub2API 账号代理绑定成功", callback);

        // 3. 并行更新 ixBrowser 窗口代理和备注（对应 asyncio.gather）
        const [ixProxySuccess, ixNoteSuccess] = await Promise.all([
          this.updateIxBrowserProxy(browserProfileId, proxy, callback),
          this.updateIxBrowserNote(browserProfileId, proxy.name, callback),
        ]);

        if (!ixProxySuccess) {
          this.logMessage("⚠️ ixBrowser 代理更新失败（Sub2API 绑定仍生效）", callback);
        }

        if (!ixNoteSuccess) {
          this.logMessage("⚠️ ixBrowser 备注更新失败", callback);
        }

        // 5. 更新本地缓存（该代理账号数 +1）
        for (const p of this.proxyCache) {
          if (p.id === proxy.id) {
            p.account_count += 1;
            break;
          }
        }

        this.logMessage(`✅ 代理绑定完成: ${proxy.name}`, callback);
        return true;
      } catch (err) {
        this.logMessage(`代理绑定异常: ${err instanceof Error ? err.message : String(err)}`, callback);
        return false;
      }
    });
  }

  /** 更新 ixBrowser 窗口代理配置，对标 _update_ix_browser_proxy() */
  private async updateIxBrowserProxy(
    browserProfileId: string,
    proxy: ProxyInfo,
    callback?: (message: string) => void,
  ): Promise<boolean> {
    try {
      const profileId = toProfileId(browserProfileId);
      const proxyConfig: IxProxyConfig = {
        proxy_type: proxy.protocol as IxProxyConfig["proxy_type"],
        proxy_ip: proxy.host,
        proxy_port: String(proxy.port),
        proxy_user: proxy.username,
        proxy_password: proxy.password,
      };
      const result = await this.ixClient.updateProfileProxy(profileId, proxyConfig);

      if (result) {
        this.logMessage("ixBrowser 代理更新成功", callback);
        return true;
      }
      this.logMessage("ixBrowser 代理更新返回失败", callback);
      return false;
    } catch (err) {
      this.logMessage(
        `ixBrowser 代理更新异常: ${err instanceof Error ? err.message : String(err)}`,
        callback,
      );
      return false;
    }
  }

  /** 更新 ixBrowser 窗口备注，对标 _update_ix_browser_note() */
  private async updateIxBrowserNote(
    browserProfileId: string,
    note: string,
    callback?: (message: string) => void,
  ): Promise<boolean> {
    try {
      const profileId = toProfileId(browserProfileId);
      const result = await this.ixClient.updateProfile(profileId, { note });

      if (result) {
        this.logMessage("ixBrowser 备注更新成功", callback);
        return true;
      }
      this.logMessage("ixBrowser 备注更新返回失败", callback);
      return false;
    } catch (err) {
      this.logMessage(
        `ixBrowser 备注更新异常: ${err instanceof Error ? err.message : String(err)}`,
        callback,
      );
      return false;
    }
  }

  /**
   * 获取代理统计信息，对标 get_proxy_stats()
   * 注意：与 Python 一致，忽略刷新失败（此时返回上一次缓存的内容）
   */
  async getProxyStats(): Promise<ProxyStat[]> {
    await this.refreshProxyCache();
    return [...this.proxyCache]
      .sort((a, b) => a.account_count - b.account_count)
      .map((p) => ({
        id: p.id,
        name: p.name,
        account_count: p.account_count,
        host: p.host,
        port: p.port,
      }));
  }
}

/** int(browser_profile_id) 的等价实现：非数字字符串抛错，落到调用方的 catch（与 Python 一致） */
function toProfileId(browserProfileId: string): number {
  const n = Number(browserProfileId);
  if (!Number.isFinite(n)) {
    throw new Error(`invalid literal for int(): '${browserProfileId}'`);
  }
  return Math.trunc(n);
}
