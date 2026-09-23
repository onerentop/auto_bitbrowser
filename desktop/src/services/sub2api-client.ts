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

  /**
   * 测试账号连接 (SSE 流式接口)。对标 test_account_connection()。
   *
   * POST /api/v1/admin/accounts/{account_id}/test
   *
   * 这是一个 SSE 流式接口，用于测试账号是否能正常发送请求。
   * 当账号需要 403 验证时，会在响应中返回错误信息。
   *
   * 返回 success=true 表示账号正常；success=false 时可能带 403 验证信息
   * （data.needs_unlock / data.validation_url / data.account_id / data.raw_error）。
   *
   * 不走 request()：SSE 响应体不是 JSON，需要按原始文本逐行解析。
   */
  async testAccountConnection(accountId: number, modelId: string = ""): Promise<Sub2ApiResponse> {
    const url = `${this.baseUrl}/api/v1/admin/accounts/${accountId}/test`;
    const headers = this.headers(true);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const data: Record<string, unknown> = {};
      if (modelId) data["model_id"] = modelId;

      const res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        // 对标 `json=data if data else None`：空对象时不带请求体
        body: Object.keys(data).length > 0 ? JSON.stringify(data) : undefined,
        signal: controller.signal,
      });
      const statusCode = res.status;

      // 读取 SSE 流式响应
      const content = await res.text();

      // 解析 SSE 事件
      const events = this.parseSseEvents(content);

      // 检查是否有错误事件
      for (const event of events) {
        if (event["type"] === "error") {
          const errorMsg = (event["error"] as string) ?? "Unknown error";

          // 检测 403 VALIDATION_REQUIRED 错误
          if (errorMsg.includes("403") || errorMsg.includes("VALIDATION_REQUIRED")) {
            const validationUrl = this.extractValidationUrlFromError(errorMsg);
            return {
              success: false,
              data: {
                needs_unlock: true,
                validation_url: validationUrl,
                account_id: accountId,
                raw_error: errorMsg,
              },
              error: "VALIDATION_REQUIRED",
              statusCode: 403,
            };
          }

          return { success: false, error: errorMsg, statusCode };
        }

        if (event["type"] === "test_complete" && event["success"]) {
          return { success: true, data: { account_id: accountId, status: "ok" }, statusCode };
        }
      }

      // 没有明确结果，检查 HTTP 状态码
      if (statusCode >= 400) {
        return {
          success: false,
          error: `HTTP ${statusCode}: ${content.slice(0, 200)}`,
          statusCode,
        };
      }

      return { success: true, data: { account_id: accountId, status: "ok" }, statusCode };
    } catch (err) {
      // Python 分 aiohttp.ClientError / asyncio.TimeoutError / Exception 三支；
      // Node 只能靠 AbortError 区分超时，其余统一落到「网络请求失败」（与 request() 一致）。
      const msg = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof Error && err.name === "AbortError";
      return { success: false, error: isAbort ? "请求超时" : `网络请求失败: ${msg}`, statusCode: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 解析 SSE 事件流。对标 _parse_sse_events() */
  private parseSseEvents(content: string): Record<string, unknown>[] {
    const events: Record<string, unknown>[] = [];
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("data:")) {
        const jsonStr = line.slice(5).trim();
        if (jsonStr) {
          try {
            events.push(JSON.parse(jsonStr) as Record<string, unknown>);
          } catch {
            // 对标 `except json.JSONDecodeError: pass`
          }
        }
      }
    }
    return events;
  }

  /** 从错误消息中提取验证 URL。对标 _extract_validation_url_from_error() */
  private extractValidationUrlFromError(errorMsg: string): string {
    // 方法1: 尝试从 JSON 结构中提取 (更精确)
    // 错误消息格式: "API 返回 403: {JSON}"
    const jsonMatch = /\{[\s\S]*\}/.exec(errorMsg);
    if (jsonMatch) {
      try {
        const errorJson = JSON.parse(jsonMatch[0] ?? "") as Record<string, unknown>;
        // 从 error.details[0].metadata.validation_url 提取
        const errorNode = (errorJson["error"] ?? {}) as Record<string, unknown>;
        const details = errorNode["details"] ?? [];
        if (Array.isArray(details) && details.length > 0) {
          const metadata = ((details[0] ?? {}) as Record<string, unknown>)["metadata"] ?? {};
          const url = (metadata as Record<string, unknown>)["validation_url"];
          if (url) {
            return String(url);
          }
        }
      } catch {
        // 对标 `except (json.JSONDecodeError, KeyError, IndexError): pass`
      }
    }

    // 方法2: 用正则提取 URL (后备方案)
    const urlPattern = /https?:\/\/accounts\.google\.com\/signin\/continue[^\s"'<>\\]+/;
    const match = urlPattern.exec(errorMsg);
    if (match) {
      return match[0] ?? "";
    }
    return "";
  }
}