/**
 * 设置页「代理」标签的 handler（列表 / 增删改 / 批量导入 / 绑定详情 / 解绑）
 *
 * 只做入参校验，业务在 src/application/proxy-settings.ts。
 * 后端按同一纯函数重新解析导入文本，不信任渲染层的预览结果。
 */
import { parseImportText, parseProxyImportLine, type ImportedProxy } from "../../../shared/logic/settings-data.ts";
import { createProxySettings, type ProxySettings, type ProxySettingsDeps } from "../../../../src/application/proxy-settings.ts";
import {
  PROXY_TYPES,
  SETTINGS_INVOKE,
  type ImportResultDto,
  type ProxyBindingDto,
  type ProxyCheckResultDto,
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

/** 单次检测的条数上限（防止误传超大数组） */
const MAX_CHECK_REFS = 500;

/** 测试注入点（生产环境不传） */
export interface ProxiesHandlerDeps {
  /** 替换真实探测（真机会连代理出网） */
  checkProxy?: ProxySettingsDeps["checkProxy"];
}

export function createProxiesHandlers(ctx: HostContext, deps: ProxiesHandlerDeps = {}): HostHandlerTable {
  let service: ProxySettings | null = null;
  const proxies = (): ProxySettings =>
    (service ??= createProxySettings({ repo: ctx.proxyRepo(), config: ctx.config(), ...deps }));

  return {
    [SETTINGS_INVOKE.settingsProxiesList]: (): ProxyListItemDto[] => proxies().list(),

    [SETTINGS_INVOKE.settingsProxiesAdd]: (proxy: unknown): boolean => {
      const data = parseProxyInputArg(proxy);
      if (!data.host || !data.port) invalid("主机和端口不能为空");
      proxies().add(data);
      return true;
    },

    /** 编辑时**不**校验主机 / 端口非空（只在添加时校验） */
    [SETTINGS_INVOKE.settingsProxiesUpdate]: (ref: unknown, proxy: unknown): boolean => {
      const r = parseProxyRefArg(ref);
      const data = parseProxyInputArg(proxy);
      proxies().update(r, data);
      return true;
    },

    [SETTINGS_INVOKE.settingsProxiesDelete]: (refs: unknown): number => {
      const list = asArray(refs, "refs").map((r, i) => parseProxyRefArg(r, `refs[${i}]`));
      if (list.length === 0) invalid("请先选择要删除的代理");
      return proxies().remove(list);
    },

    [SETTINGS_INVOKE.settingsProxiesImport]: (text: unknown): ImportResultDto => {
      const raw = asString(text, "text", MAX_IMPORT_TEXT_LENGTH);
      const valid: ImportedProxy[] = [];
      for (const row of parseImportText(raw, parseProxyImportLine)) {
        if (row.result.ok) valid.push(row.result.data);
      }
      if (valid.length === 0) invalid("没有可导入的有效数据");
      return proxies().importProxies(valid);
    },

    [SETTINGS_INVOKE.settingsProxiesBindings]: (proxyId: unknown): ProxyBindingDto[] => {
      const id = asInt(proxyId, "proxyId", 1, Number.MAX_SAFE_INTEGER);
      return proxies().bindings(id);
    },

    [SETTINGS_INVOKE.settingsProxiesUnbind]: (browserId: unknown): boolean => {
      const id = asString(browserId, "browserId").trim();
      if (!id) invalid("browserId 不能为空");
      return proxies().unbind(id);
    },

    /**
     * 连通性检测：经每个代理出网并回读出站 IP；结果写库（界面刷新后仍在）。
     * 单条失败不报错——那是真实结果，逐条返回 ok:false + 原因。
     */
    [SETTINGS_INVOKE.settingsProxiesCheck]: async (refs: unknown): Promise<ProxyCheckResultDto[]> => {
      const list = asArray(refs, "refs");
      if (list.length === 0) invalid("请先选择要检测的代理");
      if (list.length > MAX_CHECK_REFS) invalid(`一次最多检测 ${MAX_CHECK_REFS} 个代理`);
      return proxies().check(list.map((r, i) => parseProxyRefArg(r, `refs[${i}]`)));
    },
  };
}
