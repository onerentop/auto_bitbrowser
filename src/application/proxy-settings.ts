/**
 * 设置页「代理」标签的用例（列表 / 增删改 / 批量导入 / 绑定详情 / 解绑）
 *
 * 数据来源：列表来自 DataStore.getProxies()，使用情况来自 ProxyAllocator.getAllUsageStats()，按 host:port 关联。
 *
 * DataStore 是「内存列表 + 每次写入全量回写库」：内存若比库旧，回写会把别处新增的代理删掉。
 * 因此每次读写前都先 reload()；编辑 / 删除按下标定位，并用 host:port 核对下标没有漂移，
 * 漂移时拒绝操作并提示刷新（InvalidInputError → 界面收到 INVALID_ARGUMENT）。
 *
 * 入参都是 handler 校验过形状的 DTO；这里只做与数据有关的判断。
 */
import type {
  ImportResultDto,
  ProxyBindingDto,
  ProxyInputDto,
  ProxyListItemDto,
  ProxyRefDto,
} from "../../app/shared/channels/settings.ts";
import { dedupeProxiesByKey, proxyKey, type ImportedProxy } from "../../app/shared/logic/settings-data.ts";
import type { ConfigManager } from "../core/config-manager.ts";
import type { ProxyRepository } from "../db/proxy-repository.ts";
import { DataStore, makeProxyInfo, type ProxyInfo } from "../services/data-store.ts";
import { DEFAULT_MAX_WINDOWS_PER_IP, ProxyAllocator } from "../services/proxy-allocator.ts";
import { InvalidInputError } from "./errors.ts";

export interface ProxySettingsDeps {
  repo: ProxyRepository;
  /** 每次构造分配器时现读「每个 IP 可绑定的窗口数」 */
  config: Pick<ConfigManager, "get">;
}

export function createProxySettings(deps: ProxySettingsDeps) {
  let store: DataStore | null = null;

  /** 取 DataStore 并从库重新加载 */
  const freshStore = (): DataStore => {
    if (!store) store = new DataStore(deps.repo, { silent: true });
    else store.reload();
    return store;
  };

  /** 每个 IP 可绑定的窗口数：每次现读配置 */
  const allocator = (): ProxyAllocator => {
    const raw = deps.config.get("proxy.max_windows_per_ip", DEFAULT_MAX_WINDOWS_PER_IP);
    const n = typeof raw === "number" ? raw : Number(raw);
    return new ProxyAllocator(deps.repo, Number.isFinite(n) ? n : DEFAULT_MAX_WINDOWS_PER_IP);
  };

  /** 核对下标对应的代理仍是界面上看到的那条 */
  const checkRef = (proxies: ProxyInfo[], ref: ProxyRefDto): void => {
    const p = proxies[ref.index];
    if (!p || proxyKey(p) !== ref.key) {
      throw new InvalidInputError("代理列表已变化，请刷新后重试");
    }
  };

  return {
    /** 列表数据（含使用情况） */
    list(): ProxyListItemDto[] {
      const proxies = freshStore().getProxies();
      const alloc = allocator();
      const usageMap = new Map<string, ReturnType<ProxyAllocator["getAllUsageStats"]>[number]>();
      for (const stat of alloc.getAllUsageStats()) {
        usageMap.set(`${stat.host ?? ""}:${stat.port ?? ""}`, stat);
      }
      return proxies.map((p, index) => {
        const key = proxyKey(p);
        const stat = usageMap.get(key);
        return {
          index,
          key,
          proxy_type: p.proxy_type,
          host: p.host,
          port: p.port,
          username: p.username,
          password: p.password,
          // 使用情况的默认值
          used_count: stat?.used_count ?? 0,
          max_count: stat?.max_count ?? 3,
          is_full: stat?.is_full ?? false,
          proxy_id: stat?.proxy_id ?? null,
        };
      });
    },

    /** 新增代理 */
    add(input: ProxyInputDto): void {
      freshStore().addProxy(makeProxyInfo(input));
    },

    /** 修改代理（下标漂移时拒绝） */
    update(ref: ProxyRefDto, input: ProxyInputDto): void {
      const s = freshStore();
      checkRef(s.getProxies(), ref);
      s.updateProxy(ref.index, makeProxyInfo(input));
    },

    /**
     * 删除选中的代理，返回删除条数。
     * 一次过滤后只回写一次，而不是按下标倒序逐条删除（每次全量回写）。
     * 最终列表相同，saveAllProxies 按「新列表里不再出现的 host:port」删行并级联删绑定，
     * 所以删除结果与绑定级联和逐条删除一致。
     */
    remove(refs: readonly ProxyRefDto[]): number {
      const s = freshStore();
      const proxies = s.getProxies();
      for (const r of refs) checkRef(proxies, r);
      const indexes = new Set(refs.map((r) => r.index));
      s.setProxies(proxies.filter((_, i) => !indexes.has(i)));
      return indexes.size;
    },

    /**
     * 批量导入代理：一次性追加后只回写一次。
     * 一次回写时 saveAllProxies 只按导入前的库判断 INSERT / UPDATE，同批重复的 host:port 会插两行，
     * 所以先按 host:port 去重（后出现的覆盖先出现的），让库里结果与逐条添加一致。
     * success_count 仍按有效行数计。
     */
    importProxies(rows: readonly ImportedProxy[]): ImportResultDto {
      const s = freshStore();
      s.setProxies([...s.getProxies(), ...dedupeProxiesByKey([...rows]).map((d) => makeProxyInfo(d))]);
      return { success_count: rows.length, fail_count: 0 };
    },

    /**
     * 某个代理的绑定详情。
     * 绑定表里没有 window_name / profile_id 这两个键（按它们显示会恒为「未知窗口」），
     * 这里返回绑定表的真实字段 browser_id / email / bound_at。
     */
    bindings(proxyId: number): ProxyBindingDto[] {
      return allocator()
        .getProxyBindingDetails(proxyId)
        .map((b) => ({
          id: typeof b.id === "number" ? b.id : null,
          proxy_id: typeof b.proxy_id === "number" ? b.proxy_id : null,
          browser_id: String(b.browser_id ?? ""),
          email: b.email ?? null,
          bound_at: b.bound_at ?? null,
        }));
    },

    /** 解绑窗口（调 ProxyAllocator 实际存在的解绑接口） */
    unbind(browserId: string): boolean {
      return allocator().unbindWindow(browserId);
    },
  };
}

export type ProxySettings = ReturnType<typeof createProxySettings>;
