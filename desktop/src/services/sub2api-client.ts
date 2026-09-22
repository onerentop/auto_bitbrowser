/**
 * Sub2API 客户端（Node 重写）
 * 对标 services/sub2api_client.py
 *
 * 协议要点：
 *   - 认证走 header `x-api-key`（不是 Authorization Bearer）
 *   - 公共端点 /public/** 不带认证；管理端点 /api/v1/admin/** 需要 admin token
 *   - 双层错误语义：先看 HTTP status >= 400，再看响应体里的 code !== 0
 *   - 成功且响应体含 code 字段时，解包内层 data；data 为 null 时取 {}
 *   - 响应体不是 JSON 时包装成 { raw_response: text }
 *   - 所有异常吞掉，统一返回 { success:false, error }
 */

export interface Sub2ApiResponse<T = Record<string, unknown>> {
  success: boolean;
  data?: T;
  error?: string;
  statusCode: number;
}

export interface Sub2ApiClientOptions {
  baseUrl: string;
  adminToken?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export class Sub2ApiClient {
  private readonly baseUrl: string;
  private readonly adminToken: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: Sub2ApiClientOptions) {
    // 与 Python 的 .rstrip('/') 等价
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.adminToken = options.adminToken ?? "";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  private headers(useAdmin: boolean): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (useAdmin) h["x-api-key"] = this.adminToken;
    return h;
  }

  /** 唯一请求出口，对标 _request() */
  async request<T = Record<string, unknown>>(
    method: HttpMethod,
    endpoint: string,
    options: {
      data?: Record<string, unknown>;
      params?: Record<string, string | number>;
      useAdmin?: boolean;
    } = {},
  ): Promise<Sub2ApiResponse<T>> {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    for (const [k, v] of Object.entries(options.params ?? {})) {
      url.searchParams.set(k, String(v));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(url.toString(), {
        method,
        headers: this.headers(options.useAdmin ?? false),
        body: options.data === undefined ? undefined : JSON.stringify(options.data),
        signal: controller.signal,
      });

      const statusCode = res.status;

      // 非 JSON 响应包装成 raw_response（与 Python 一致）
      let result: Record<string, unknown>;
      try {
        result = (await res.json()) as Record<string, unknown>;
      } catch {
        result = { raw_response: await res.text().catch(() => "") };
      }

      if (statusCode >= 400) {
        const error =
          (result["error"] as string) || (result["message"] as string) || `HTTP ${statusCode}`;
        return { success: false, error, statusCode };
      }

      // 业务层信封 { code, message, data }
      if (result && typeof result === "object" && "code" in result) {
        const apiCode = (result["code"] as number) ?? 0;
        if (apiCode !== 0) {
          const error = (result["message"] as string) || `API Error (code=${apiCode})`;
          return { success: false, error, statusCode };
        }
        const inner = result["data"];
        return { success: true, data: ((inner ?? {}) as T), statusCode };
      }

      return { success: true, data: result as T, statusCode };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof Error && err.name === "AbortError";
      return { success: false, error: isAbort ? "请求超时" : `网络请求失败: ${msg}`, statusCode: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- 公共端点（无需 admin token） ----------

  /** POST /public/antigravity/oauth/start */
  startAntigravityOauth(): Promise<Sub2ApiResponse> {
    return this.request("POST", "/public/antigravity/oauth/start", { useAdmin: false });
  }

  /** POST /public/antigravity/oauth/complete */
  completeAntigravityOauth(
    sessionId: string,
    state: string,
    code: string,
  ): Promise<Sub2ApiResponse<{ success?: boolean; account_id?: number; email?: string }>> {
    return this.request("POST", "/public/antigravity/oauth/complete", {
      data: { session_id: sessionId, state, code },
      useAdmin: false,
    });
  }

  /** POST /public/antigravity/wake */
  wakeAntigravityAccount(accountId: number): Promise<Sub2ApiResponse> {
    return this.request("POST", "/public/antigravity/wake", {
      data: { account_id: accountId },
      useAdmin: false,
    });
  }

  /** GET /health */
  testConnection(): Promise<Sub2ApiResponse> {
    return this.request("GET", "/health", { useAdmin: false });
  }

  // ---------- 管理端点（需要 admin token） ----------

  /** GET /api/v1/admin/accounts */
  listAccounts(
    options: { platform?: string; page?: number; limit?: number } = {},
  ): Promise<Sub2ApiResponse<{ items?: Record<string, unknown>[] }>> {
    return this.request("GET", "/api/v1/admin/accounts", {
      params: {
        platform: options.platform ?? "antigravity",
        page: options.page ?? 1,
        limit: options.limit ?? 100,
      },
      useAdmin: true,
    });
  }

  /** GET /api/v1/admin/accounts/{id} */
  getAccount(accountId: number): Promise<Sub2ApiResponse> {
    return this.request("GET", `/api/v1/admin/accounts/${accountId}`, { useAdmin: true });
  }

  /**
   * 按邮箱查 account_id，不存在返回 null。
   * 注意：接口返回的是 data.items（不是 data.accounts）；
   * 邮箱可能在 item.name 或 item.credentials.email，大小写不敏感比较。
   */
  async checkAccountExists(email: string): Promise<number | null> {
    const res = await this.listAccounts({ platform: "antigravity", limit: 1000 });
    if (!res.success) {
      console.error(`[Sub2API] 检查账号存在失败: ${res.error}`);
      return null;
    }

    const items = res.data?.items;
    if (!Array.isArray(items)) return null;

    for (const item of items) {
      const credentials = (item["credentials"] ?? {}) as Record<string, unknown>;
      const itemEmail =
        (item["name"] as string) || (credentials["email"] as string) || "";
      if (itemEmail.toLowerCase() === email.toLowerCase()) {
        return (item["id"] as number) ?? null;
      }
    }
    return null;
  }

  /** GET /api/v1/admin/proxies/all?with_count=true */
  getAllProxiesWithCount(): Promise<Sub2ApiResponse> {
    return this.request("GET", "/api/v1/admin/proxies/all", {
      params: { with_count: "true" },
      useAdmin: true,
    });
  }

  /**
   * PUT /api/v1/admin/accounts/{id}
   * 两个字段都没传时不发请求，直接返回错误（与 Python 一致）。
   */
  updateAccount(
    accountId: number,
    options: { proxyId?: number; notes?: string } = {},
  ): Promise<Sub2ApiResponse> {
    const payload: Record<string, unknown> = {};
    if (options.proxyId !== undefined) payload["proxy_id"] = options.proxyId;
    if (options.notes !== undefined) payload["notes"] = options.notes;

    if (Object.keys(payload).length === 0) {
      return Promise.resolve({ success: false, error: "没有要更新的字段", statusCode: 0 });
    }

    return this.request("PUT", `/api/v1/admin/accounts/${accountId}`, {
      data: payload,
      useAdmin: true,
    });
  }
}