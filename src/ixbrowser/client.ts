/**
 * ixBrowser Local API 客户端
 *
 * 与 ixBrowser 本地服务 :53200 的 HTTP 客户端。
 * 解包逻辑必须逐条严格：分支顺序错了会导致上层业务判断失效。
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
  type IxTagListData,
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

  /** 最近一次 profile-list 请求的总数 */
  public total = 0;

  constructor(options: IxClientOptions = {}) {
    const host = options.host ?? IX_DEFAULT_HOST;
    const port = options.port ?? IX_DEFAULT_PORT;
    this.baseUrl = `http://${host}:${port}/api/v2/`;
    this.timeoutMs = options.timeoutMs ?? IX_DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * 唯一的请求出口。
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
      // 网络层异常统一包装成 UnexpectedError
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

    // 以下 4 个分支顺序固定，不可调整
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
    // 成功但无 data 时返回 true
    return "data" in envelope && envelope.data !== undefined && envelope.data !== null
      ? (envelope.data as T)
      : true;
  }

  /**
   * 窗口列表。
   * 陷阱：传了 profileId 就只发这一个字段（page/limit 全丢弃）。
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
   * 标签词表（分页，默认 limit=10，所以取全量时要显式给大 limit）。
   * 实测 2026-09-25：返回 { total, data: [{id, title, color}] }。
   */
  async getTagList(query: { page?: number; limit?: number; title?: string } = {}): Promise<IxTagListData> {
    const params: Record<string, unknown> = { page: query.page ?? 1, limit: query.limit ?? 100 };
    if (query.title) params["title"] = query.title;
    const data = await this.call<IxTagListData>("tag-list", params);
    if (data === true) return { total: 0, data: [] };
    return { total: data?.total ?? 0, data: data?.data ?? [] };
  }

  /**
   * 新建标签，返回新标签 id。
   * 重名由服务端拒绝（code 113002「标签名称已经存在」），这里不特殊处理，交给上层展示。
   */
  async createTag(title: string): Promise<number> {
    const data = await this.call<number>("tag-create", { title });
    if (typeof data !== "number" || !Number.isInteger(data) || data <= 0) {
      throw new IxUnexpectedError(`tag-create 返回的标签 ID 不合法: ${JSON.stringify(data)}`);
    }
    return data;
  }

  /** 重命名标签（影响所有挂了它的窗口）；接口只收 title 与 id */
  async updateTag(id: number, title: string): Promise<void> {
    await this.call("tag-update", { id, title });
  }

  /** 删除标签（影响所有挂了它的窗口） */
  async deleteTag(id: number): Promise<void> {
    await this.call("tag-delete", { id });
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

  /**
   * 以某个窗口为模板创建新窗口（ixBrowser 官方的「复制窗口」），返回新窗口 ID。
   *
   * 为什么用官方复制而不是自己把模板字段读出来再 profile-create：
   * 服务端自己知道一个「复制」要带哪些东西，手工映射字段只会漏（漏掉的字段会静默变成默认值，
   * 产出一个「看起来像模板、实际不同」的窗口）。我们只决定名字与分组，其余交给服务端。
   * 参数定义对齐官方 SDK ixbrowser_local_api.client.create_profile_by_copying
   * （ACTION_FOR_PROFILE_COPY = "profile-copy"，可选 name / group_id / site_id / site_url）。
   */
  async copyProfile(profileId: number, fields: { name?: string; groupId?: number } = {}): Promise<number> {
    const params: Record<string, unknown> = { profile_id: profileId };
    if (fields.name !== undefined) params["name"] = fields.name;
    if (fields.groupId !== undefined) params["group_id"] = fields.groupId;

    // 真机实测（2026-09-24）：profile-copy 的 data 是**裸数字**（{"data":835}），
    // 与 profile-create 的 {"data":{"profile_id":N}} 不是同一个形状。
    // 官方 SDK 用 isinstance(result, dict) 分流，这里两种都认，认不出就报错（绝不能静默返回 undefined）。
    const data = await this.call<number | { profile_id?: number }>("profile-copy", params);
    const id = typeof data === "number" ? data : data && typeof data === "object" ? data.profile_id : undefined;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new IxUnexpectedError(`profile-copy 未返回可用的新窗口 ID: ${JSON.stringify(data)}`);
    }
    return id;
  }

  /** 删除窗口 */
  async deleteProfile(profileId: number): Promise<boolean> {
    await this.call("profile-delete", { profile_id: profileId });
    return true;
  }
  /**
   * 按 ID 查单个窗口的完整信息。
   * 按 ID 查单个窗口的完整信息——查不到返回 null。
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
 * 只发送传入的字段。
   */
  async updateProfile(
    profileId: number,
    // password / username 是窗口信息面板上的账号字段（F1 改密后要同步窗口 password）
    fields: { note?: string; tfa_secret?: string; name?: string; password?: string; username?: string; tag?: string[] },
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
