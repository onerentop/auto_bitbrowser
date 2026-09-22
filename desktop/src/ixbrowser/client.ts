/**
 * ixBrowser Local API 客户端（Node 重写）
 *
 * 对标 .venv/Lib/site-packages/ixbrowser_local_api/{client,utils}.py
 * 解包逻辑逐条复刻 utils.py:33-52，行为差异会导致上层业务判断失效。
 */

import {
  IX_CODE_SUCCESS,
  IX_DEFAULT_HOST,
  IX_DEFAULT_PORT,
  IX_DEFAULT_TIMEOUT_MS,
  type IxEnvelope,
  type IxOpenOptions,
  type IxOpenResult,
  type IxProfile,
  type IxProfileListData,
  type IxProfileListQuery,
  type IxProxyConfig,
} from "./types.ts";

/** HTTP 状态码非 200 */
export class IxHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`ixBrowser HTTP ${status}`);
    this.name = "IxHttpError";
    this.status = status;
  }
}

/** 响应结构不符合预期 / 网络异常 */
export class IxUnexpectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IxUnexpectedError";
  }
}

/** 服务端返回 error.code !== 0 */
export class IxResponseError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "IxResponseError";
    this.code = code;
  }
}

export interface IxClientOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
  /** 便于单测注入 */
  fetchImpl?: typeof fetch;
}

export class IxBrowserClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  /** 最近一次 profile-list 的总数，对齐 Python 客户端的 self.total */
  public total = 0;

  constructor(options: IxClientOptions = {}) {
    const host = options.host ?? IX_DEFAULT_HOST;
    const port = options.port ?? IX_DEFAULT_PORT;
    this.baseUrl = `http://${host}:${port}/api/v2/`;
    this.timeoutMs = options.timeoutMs ?? IX_DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * 唯一的请求出口，对标 utils.py 的 send_request。
   * 全部接口都是 POST + JSON body。
   */
  async call<T = unknown>(action: string, params: Record<string, unknown> = {}): Promise<T | true> {
    const url = this.baseUrl + action;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    } catch (err) {
      // 对齐 Python：网络层异常统一包装成 UnexpectedError
      throw new IxUnexpectedError(`exception desc:${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    if (response.status !== 200) throw new IxHttpError(response.status);

    let envelope: IxEnvelope<T>;
    try {
      envelope = (await response.json()) as IxEnvelope<T>;
    } catch (err) {
      throw new IxUnexpectedError(`exception desc:${err instanceof Error ? err.message : String(err)}`);
    }

    // 以下 4 个分支顺序与 utils.py:33-52 完全一致，不可调整
    if (envelope == null || typeof envelope !== "object" || !("error" in envelope)) {
      throw new IxUnexpectedError("The returned data does not contain the 'error' key");
    }
    const error = envelope.error;
    if (error == null || typeof error.code !== "number") {
      throw new IxUnexpectedError("The returned data does not contain the 'error.code' key");
    }
    if (error.code !== IX_CODE_SUCCESS) {
      throw new IxResponseError(error.code, error.message ?? "");
    }
    // 成功但无 data 时，Python 返回 True
    return "data" in envelope && envelope.data !== undefined && envelope.data !== null
      ? (envelope.data as T)
      : true;
  }

  /**
   * 窗口列表。
   * 陷阱：传了 profileId 就只发这一个字段（page/limit 全丢弃），对齐 client.py:33-47。
   * keyword 发出去的键名是 name。
   */
  async getProfileList(query: IxProfileListQuery = {}): Promise<IxProfile[]> {
    let params: Record<string, unknown>;

    if (query.profileId !== undefined && query.profileId > 0) {
      params = { profile_id: query.profileId };
    } else {
      params = { page: query.page ?? 1, limit: query.limit ?? 10 };
      if (query.groupId !== undefined && query.groupId > 0) params["group_id"] = query.groupId;
      if (query.tagId !== undefined && query.tagId > 0) params["tag_id"] = query.tagId;
      if (query.keyword) params["name"] = query.keyword;
    }

    const data = await this.call<IxProfileListData>("profile-list", params);
    if (data === true) {
      this.total = 0;
      return [];
    }
    this.total = data.total ?? 0;
    return data.data ?? [];
  }

  /** 按 ID 精确查单个窗口，查不到返回 null */
  async getProfileById(profileId: number): Promise<IxProfile | null> {
    const list = await this.getProfileList({ profileId });
    return list[0] ?? null;
  }

  /**
   * 打开窗口，返回 CDP 端点。
   * 陷阱：cookie 为空时绝对不能发送该键，否则服务端 cookie 加载失败。
   */
  async openProfile(profileId: number, options: IxOpenOptions = {}): Promise<IxOpenResult> {
    const args = [...(options.startupArgs ?? [])];
    const flag = "--disable-extension-welcome-page";
    if ((options.disableExtensionWelcomePage ?? true) && !args.includes(flag)) {
      args.push(flag);
    }

    const params: Record<string, unknown> = {
      profile_id: profileId,
      load_extensions: options.loadExtensions ?? true,
      load_profile_info_page: options.loadProfileInfoPage ?? false,
      cookies_backup: options.cookiesBackup ?? false,
      args,
    };
    if (options.cookie != null) params["cookie"] = options.cookie;

    const data = await this.call<IxOpenResult>("profile-open", params);
    if (data === true) throw new IxUnexpectedError("profile-open 未返回连接信息");
    return data;
  }

  /** 关闭窗口。窗口不存在时服务端返回 code=2007 */
  async closeProfile(profileId: number): Promise<boolean> {
    await this.call("profile-close", { profile_id: profileId });
    return true;
  }

  /** 批量关闭 */
  async closeProfilesInBatches(profileIds: number[]): Promise<boolean> {
    await this.call("profile-close-in-batches", { profile_id: profileIds });
    return true;
  }

  /** 创建窗口，返回新窗口 ID */
  async createProfile(profile: Record<string, unknown>): Promise<number> {
    const data = await this.call<{ profile_id: number }>("profile-create", profile);
    if (data === true) throw new IxUnexpectedError("profile-create 未返回 profile_id");
    return data.profile_id;
  }

  /** 删除窗口 */
  async deleteProfile(profileId: number): Promise<boolean> {
    await this.call("profile-delete", { profile_id: profileId });
    return true;
  }

  /** 更新窗口代理 */
  async updateProfileProxy(profileId: number, proxy: IxProxyConfig): Promise<boolean> {
    await this.call("profile-update", { profile_id: profileId, proxy_config: proxy });
    return true;
  }
  /**
   * 按 ID 查单个窗口的完整信息。
   * 对标 services/ix_api.py 的 get_profile_info()——查不到返回 null。
   */
  async getProfileInfo(profileId: number): Promise<IxProfile | null> {
    try {
      return await this.getProfileById(profileId);
    } catch {
      return null;
    }
  }

  /**
   * 更新窗口信息（备注、2FA 密钥等）。
   * 对标 update_profile()：只发送传入的字段。
   */
  async updateProfile(
    profileId: number,
    fields: { note?: string; tfa_secret?: string; name?: string },
  ): Promise<boolean> {
    const params: Record<string, unknown> = { profile_id: profileId };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) params[k] = v;
    }
    try {
      await this.call("profile-update", params);
      return true;
    } catch (error) {
      console.error(`[ix] update_profile 失败: ${error}`);
      return false;
    }
  }

  /** 分组列表 */
  async getGroupList(page = 1, limit = 100): Promise<unknown[]> {
    const data = await this.call<{ data?: unknown[] }>("group-list", { page, limit });
    if (data === true) return [];
    return data.data ?? [];
  }
}
