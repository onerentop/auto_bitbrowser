/**
 * 设置页「代理」标签的 handler（列表 / 增删改 / 批量导入 / 绑定详情 / 解绑）
 *
 * 数据来源：列表来自 DataStore.getProxies()，使用情况来自
 * ProxyAllocator.getAllUsageStats()，按 host:port 关联。
 *
 * DataStore 是「内存列表 + 每次写入全量回写库」：内存若比库旧，回写会把别处新增的代理删掉。
 * 因此每次读写前都先 reload()；编辑 / 删除按下标定位，
 * 并用 host:port 核对下标没有漂移，漂移时拒绝操作并提示刷新。
 */
import {
  dedupeProxiesByKey,
  parseImportText,
  parseProxyImportLine,
  proxyKey,
  type ImportedProxy,
} from "../../../shared/logic/settings-data.ts";
import { ProxyRepository } from "../../../../src/db/proxy-repository.ts";
import { DataStore, makeProxyInfo, type ProxyInfo } from "../../../../src/services/data-store.ts";
import { DEFAULT_MAX_WINDOWS_PER_IP, ProxyAllocator } from "../../../../src/services/proxy-allocator.ts";
import {
  PROXY_TYPES,
  SETTINGS_INVOKE,
  type ImportResultDto,
  type ProxyBindingDto,
  type ProxyInputDto,
  type ProxyListItemDto,
  type ProxyRefDto,
} from "../../../shared/channels/settings.ts";
import type { HostContext } from "../../context.ts";
import type { HostHandlerTable } from "../../dispatch.ts";
import {
  MAX_IMPORT_TEXT_LENGTH,
  asArray,
  asInt,
  asOneOf,
  asRecord,
  asString,
  field,
  invalid,
} from "./validate.ts";

/** 校验代理输入：除类型外全部 strip */
export function parseProxyInputArg(value: unknown): ProxyInputDto {
  const o = asRecord(value, "proxy");
  return {
    proxy_type: asOneOf(o["proxy_type"], "proxy_type", PROXY_TYPES),
    host: field(o, "host").trim(),
    port: field(o, "port").trim(),
    username: field(o, "username").trim(),
    password: field(o, "password").trim(),
  };
}

export function parseProxyRefArg(value: unknown, name = "ref"): ProxyRefDto {
  const o = asRecord(value, name);
  return {
    index: asInt(o["index"], `${name}.index`, 0, Number.MAX_SAFE_INTEGER),
    key: field(o, "key", `${name}.key`),
  };
}

export function createProxiesHandlers(ctx: HostContext): HostHandlerTable {
  let repo: ProxyRepository | null = null;
  let store: DataStore | null = null;

  const getRepo = (): ProxyRepository => (repo ??= new ProxyRepository(ctx.db()));
  /** 取 DataStore 并从库重新加载 */
  const freshStore = (): DataStore => {
    if (!store) store = new DataStore(getRepo(), { silent: true });
    else store.reload();
    return store;
  };
  /** 每个 IP 可绑定的窗口数：每次现读配置 */
  const allocator = (): ProxyAllocator => {
    const raw = ctx.config().get("proxy.max_windows_per_ip", DEFAULT_MAX_WINDOWS_PER_IP);
    const n = typeof raw === "number" ? raw : Number(raw);
    return new ProxyAllocator(getRepo(), Number.isFinite(n) ? n : DEFAULT_MAX_WINDOWS_PER_IP);
  };

  /** 核对下标对应的代理仍是界面上看到的那条 */
  const checkRef = (proxies: ProxyInfo[], ref: ProxyRefDto): void => {
    const p = proxies[ref.index];
    if (!p || proxyKey(p) !== ref.key) {
      invalid("代理列表已变化，请刷新后重试");
    }
  };

  return {
    /** 加载列表数据（含使用情况） */
    [SETTINGS_INVOKE.settingsProxiesList]: (): ProxyListItemDto[] => {
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
    [SETTINGS_INVOKE.settingsProxiesAdd]: (proxy: unknown): boolean => {
      const data = parseProxyInputArg(proxy);
      if (!data.host || !data.port) invalid("主机和端口不能为空");
      freshStore().addProxy(makeProxyInfo(data));
      return true;
    },

    /**
     * 修改代理。
     * 编辑时**不**校验主机 / 端口非空（只在添加时校验）。
     */
    [SETTINGS_INVOKE.settingsProxiesUpdate]: (ref: unknown, proxy: unknown): boolean => {
      const r = parseProxyRefArg(ref);
      const data = parseProxyInputArg(proxy);
      const s = freshStore();
      checkRef(s.getProxies(), r);
      s.updateProxy(r.index, makeProxyInfo(data));
      return true;
    },

    /**
     * 删除选中的代理，返回删除条数。
     * 一次过滤后只回写一次，而不是按下标倒序逐条删除（每次全量回写）。
     * 最终列表相同，saveAllProxies 按「新列表里不再出现的 host:port」删行并级联删绑定，
     * 所以删除结果与绑定级联和逐条删除一致。
     */
    [SETTINGS_INVOKE.settingsProxiesDelete]: (refs: unknown): number => {
      const list = asArray(refs, "refs").map((r, i) => parseProxyRefArg(r, `refs[${i}]`));
      if (list.length === 0) invalid("请先选择要删除的代理");
      const s = freshStore();
      const proxies = s.getProxies();
      for (const r of list) checkRef(proxies, r);
      const indexes = new Set(list.map((r) => r.index));
      s.setProxies(proxies.filter((_, i) => !indexes.has(i)));
      return indexes.size;
    },

    /**
     * 批量导入代理：一次性追加后只回写一次。
     * 后端按同一纯函数重新解析文本，不信任渲染层的预览结果。
     * 去重与回写次数的取舍：
     * 一次回写时 saveAllProxies 只按导入前的库判断 INSERT / UPDATE，同批重复的 host:port 会插两行，
     * 所以先按 host:port 去重（后出现的覆盖先出现的），让库里结果与逐条添加一致。
     * success_count 仍按有效行数计。
     */
    [SETTINGS_INVOKE.settingsProxiesImport]: (text: unknown): ImportResultDto => {
      const raw = asString(text, "text", MAX_IMPORT_TEXT_LENGTH);
      const valid: ImportedProxy[] = [];
      for (const row of parseImportText(raw, parseProxyImportLine)) {
        if (row.result.ok) valid.push(row.result.data);
      }
      if (valid.length === 0) invalid("没有可导入的有效数据");
      const s = freshStore();
      s.setProxies([...s.getProxies(), ...dedupeProxiesByKey(valid).map((d) => makeProxyInfo(d))]);
      return { success_count: valid.length, fail_count: 0 };
    },

    /**
     * 读取某个代理的绑定详情。
     * 绑定表里没有 window_name / profile_id 这两个键（按它们显示会恒为「未知窗口」），
     * 这里返回绑定表的真实字段 browser_id / email / bound_at。
     */
    [SETTINGS_INVOKE.settingsProxiesBindings]: (proxyId: unknown): ProxyBindingDto[] => {
      const id = asInt(proxyId, "proxyId", 1, Number.MAX_SAFE_INTEGER);
      return allocator()
        .getProxyBindingDetails(id)
        .map((b) => ({
          id: typeof b.id === "number" ? b.id : null,
          proxy_id: typeof b.proxy_id === "number" ? b.proxy_id : null,
          browser_id: String(b.browser_id ?? ""),
          email: b.email ?? null,
          bound_at: b.bound_at ?? null,
        }));
    },

    /**
     * 解绑窗口。
     * 必须调 ProxyAllocator 真正提供的方法名，否则点击必然报「解绑失败」。
     * 这里调的是实际存在的解绑接口。
     */
    [SETTINGS_INVOKE.settingsProxiesUnbind]: (browserId: unknown): boolean => {
      const id = asString(browserId, "browserId").trim();
      if (!id) invalid("browserId 不能为空");
      return allocator().unbindWindow(id);
    },
  };
}
