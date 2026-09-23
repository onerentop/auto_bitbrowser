/**
 * 设置页「代理」标签的 handler —— 对标 gui/data_management/proxies_tab.py 的 ProxiesTab
 * 与 batch_import_dialog.py 的 ProxyBatchImportDialog
 *
 * 数据来源与 Python 一致：列表来自 DataStore.get_proxies()，使用情况来自
 * ProxyAllocator.get_all_usage_stats()，按 host:port 关联（proxies_tab.py:241-310）。
 *
 * DataStore 是「内存列表 + 每次写入全量回写库」：内存若比库旧，回写会把别处新增的代理删掉。
 * 因此每次读写前都先 reload()；编辑 / 删除按下标定位（对标 Python 的 row），
 * 并用 host:port 核对下标没有漂移，漂移时拒绝操作并提示刷新。
 */
import {
  dedupeProxiesByKey,
  parseImportText,
  parseProxyImportLine,
  proxyKey,
  type ImportedProxy,
} from "../../../../src/application/settings-data.ts";
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

/** 校验代理输入；照搬 ProxyEditDialog.get_data（proxies_tab.py:74-81）：除类型外全部 strip */
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
  /** 取 DataStore 并从库重新加载（对标 loadData 里的 dataStore.reload()） */
  const freshStore = (): DataStore => {
    if (!store) store = new DataStore(getRepo(), { silent: true });
    else store.reload();
    return store;
  };
  /** 对标 ProxyAllocator.get_max_windows_per_ip()：每次现读配置 */
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
    /** 对标 ProxiesTab.loadData（proxies_tab.py:241-310） */
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
          // proxies_tab.py:270-272 的默认值
          used_count: stat?.used_count ?? 0,
          max_count: stat?.max_count ?? 3,
          is_full: stat?.is_full ?? false,
          proxy_id: stat?.proxy_id ?? null,
        };
      });
    },

    /** 对标 ProxiesTab.addProxy（proxies_tab.py:329-355） */
    [SETTINGS_INVOKE.settingsProxiesAdd]: (proxy: unknown): boolean => {
      const data = parseProxyInputArg(proxy);
      if (!data.host || !data.port) invalid("主机和端口不能为空");
      freshStore().addProxy(makeProxyInfo(data));
      return true;
    },

    /**
     * 对标 ProxiesTab.editProxy（proxies_tab.py:357-368）。
     * 照搬 Python：编辑时**不**校验主机 / 端口非空（Python 只在添加时校验）。
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
     * 对标 ProxiesTab.deleteSelected（proxies_tab.py:370-402），返回删除条数。
     * Python 按下标倒序逐条 remove_proxy（每次全量回写）；这里一次过滤后只回写一次。
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
     * 对标 ProxyBatchImportDialog + BatchImportDialog._validateInputs（batch_import_dialog.py:128-166, 233-279）。
     * 后端按同一纯函数重新解析文本，不信任渲染层的预览结果。
     * 差异：Python 每条记录各 add_proxy 一次（每次全量回写）；这里一次性追加后只回写一次。
     * 一次回写时 saveAllProxies 只按导入前的库判断 INSERT / UPDATE，同批重复的 host:port 会插两行，
     * 所以先按 host:port 去重（后出现的覆盖先出现的），库里结果与 Python 逐条添加一致。
     * success_count 仍按有效行数计，与 Python 对话框的计数一致。
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
     * 对标 ProxyDetailDialog._loadBindings（proxies_tab.py:101-136）。
     * Python 读取的 window_name / profile_id 两个键在绑定表里并不存在（界面恒显示「未知窗口」），
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
     * 对标 ProxyDetailDialog._unbindWindow（proxies_tab.py:138-162）。
     * Python 调用的 ProxyAllocator.release_proxy 并不存在（点击必然报「解绑失败」），
     * 这里改用实际存在的 unbind_window（proxy_allocator.py:57-68）。
     */
    [SETTINGS_INVOKE.settingsProxiesUnbind]: (browserId: unknown): boolean => {
      const id = asString(browserId, "browserId").trim();
      if (!id) invalid("browserId 不能为空");
      return allocator().unbindWindow(id);
    },
  };
}
