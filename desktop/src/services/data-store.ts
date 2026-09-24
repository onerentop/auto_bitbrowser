/**
 * 代理内存数据存储（Node 重写）
 *
 * 语义：内存里持有一份代理列表，任何写操作都立即全量回写数据库。
 * 保留 getDataStore() 单例入口，同时允许直接 new 便于测试。
 */
import type { ProxyRepository, ProxyRow } from "../db/proxy-repository.ts";

export interface ProxyInfo {
  proxy_type: string;
  username: string;
  password: string;
  host: string;
  port: string;
}

export function makeProxyInfo(data: Partial<ProxyInfo> = {}): ProxyInfo {
  return {
    proxy_type: data.proxy_type ?? "socks5",
    username: data.username ?? "",
    password: data.password ?? "",
    host: data.host ?? "",
    port: data.port ?? "",
  };
}

/** 转成 URL 形式；无凭据时省略 user:pass@ 段 */
export function proxyToUrl(p: ProxyInfo): string {
  if (p.username && p.password) {
    return `${p.proxy_type}://${p.username}:${p.password}@${p.host}:${p.port}`;
  }
  return `${p.proxy_type}://${p.host}:${p.port}`;
}

export class DataStore {
  private readonly repo: ProxyRepository;
  private proxies: ProxyInfo[] = [];

  constructor(repo: ProxyRepository, options: { silent?: boolean } = {}) {
    this.repo = repo;
    this.loadFromDb(options.silent ?? false);
  }

  private loadFromDb(silent = true): void {
    try {
      const rows = this.repo.getAllProxies();
      this.proxies = rows.map((r: ProxyRow) =>
        makeProxyInfo({
          proxy_type: r.proxy_type ?? "socks5",
          username: r.username ?? "",
          password: r.password ?? "",
          host: r.host ?? "",
          port: String(r.port ?? ""),
        }),
      );
      if (!silent) console.log(`[DataStore] 从数据库加载 ${this.proxies.length} 个代理`);
    } catch (error) {
      if (!silent) console.error(`[DataStore] 数据库加载失败（可能表不存在）: ${error}`);
    }
  }

  private saveToDb(): void {
    try {
      this.repo.saveAllProxies(this.proxies);
    } catch (error) {
      console.error(`[DataStore] 保存代理失败: ${error}`);
    }
  }

  getProxies(): ProxyInfo[] {
    return [...this.proxies];
  }

  getProxiesAsDicts(): ProxyInfo[] {
    return this.proxies.map((p) => ({ ...p }));
  }

  setProxies(proxies: ProxyInfo[]): void {
    this.proxies = [...proxies];
    this.saveToDb();
  }

  addProxy(proxy: ProxyInfo): void {
    this.proxies.push(proxy);
    this.saveToDb();
  }

  /** 按下标删除，越界静默忽略 */
  removeProxy(index: number): void {
    if (index >= 0 && index < this.proxies.length) {
      this.proxies.splice(index, 1);
    }
    this.saveToDb();
  }

  updateProxy(index: number, proxy: ProxyInfo): void {
    if (index >= 0 && index < this.proxies.length) {
      this.proxies[index] = proxy;
    }
    this.saveToDb();
  }

  clearProxies(): void {
    this.proxies = [];
    this.saveToDb();
  }

  reload(silent = true): void {
    this.loadFromDb(silent);
  }
}

let globalStore: DataStore | null = null;

/** 单例入口 */
export function getDataStore(repo: ProxyRepository): DataStore {
  if (!globalStore) globalStore = new DataStore(repo, { silent: false });
  return globalStore;
}

/** 测试用：重置单例 */
export function resetDataStore(): void {
  globalStore = null;
}