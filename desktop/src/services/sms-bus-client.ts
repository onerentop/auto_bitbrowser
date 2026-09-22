/**
 * SMS-Bus 接码平台客户端（Node 重写）
 * 对标 services/sms_bus_client.py
 * API 文档: https://sms-bus.com/docs
 *
 * 协议要点（逐条核对 Python 源码）：
 *   - 全部接口都是 GET，参数走 query string
 *   - token 作为 query 参数 token=xxx，不走 header
 *   - 响应信封 { code, message, data }，code === 200 才算成功
 *   - code 50101 是「短信尚未到达」的特殊语义，轮询时不算错误
 *   - 所有异常都被吞掉，统一转成 { success:false, error }，不抛出
 */

export const SMS_BUS_BASE_URL = "https://sms-bus.com/api/control";

/** Google 服务的可能 code，用于在项目列表里定位 project_id */
export const GOOGLE_PROJECT_CODES = ["go", "google", "gg", "gl"];

/** 「等待短信」的业务码，非错误 */
export const SMS_CODE_WAITING = 50101;

export interface SmsBusResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code: number;
}

export interface PhoneNumber {
  request_id: number;
  number: string;
  country_id: number;
  project_id: number;
  cost: number;
  country_name: string;
}

/** 手机号加 + 前缀（对标 PhoneNumber.formatted_number） */
export function formattedNumber(phone: Pick<PhoneNumber, "number">): string {
  return phone.number.startsWith("+") ? phone.number : `+${phone.number}`;
}

export interface PriceInfo {
  country_id: number;
  project_id: number;
  cost: number;
  total_count: number;
  country_name: string;
  country_code: string;
}

export interface SmsBusClientOptions {
  token: string;
  /** 总超时，Python 默认 30s */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** 便于测试注入，默认真实等待 */
  sleepImpl?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SmsBusClient {
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private googleProjectId: number | null = null;

  constructor(options: SmsBusClientOptions) {
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleepImpl ?? defaultSleep;
  }

  /**
   * 唯一请求出口。对标 _request()：GET + query，异常全部转成 error 结果。
   */
  async request<T = unknown>(
    endpoint: string,
    params: Record<string, string | number> = {},
  ): Promise<SmsBusResponse<T>> {
    const url = new URL(`${SMS_BUS_BASE_URL}/${endpoint}`);
    url.searchParams.set("token", this.token);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url.toString(), { signal: controller.signal });
      const result = (await res.json()) as { code?: number; message?: string; data?: T };
      const code = result.code ?? 0;
      if (code === 200) {
        return { success: true, data: result.data, code };
      }
      return { success: false, error: result.message ?? `API Error (code=${code})`, code };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof Error && err.name === "AbortError";
      return { success: false, error: isAbort ? "请求超时" : `网络请求失败: ${msg}`, code: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 账户余额：data = { balance, frozen } */
  getBalance(): Promise<SmsBusResponse<{ balance: number; frozen: number }>> {
    return this.request("get/balance");
  }

  /** 国家列表：data 是 { [country_id]: { title, code, ... } } */
  listCountries(): Promise<SmsBusResponse<Record<string, Record<string, unknown>>>> {
    return this.request("list/countries");
  }

  /** 项目（服务）列表 */
  listProjects(): Promise<SmsBusResponse<Record<string, Record<string, unknown>>>> {
    return this.request("list/projects");
  }

  /** 指定国家的价格表 */
  listPrices(countryId: number): Promise<SmsBusResponse<Record<string, Record<string, unknown>>>> {
    return this.request("list/prices", { country_id: countryId });
  }

  /** 定位 Google 的 project_id，结果会缓存 */
  async findGoogleProjectId(): Promise<number | null> {
    if (this.googleProjectId !== null) return this.googleProjectId;

    const res = await this.listProjects();
    if (!res.success || !res.data) return null;

    for (const [projectId, info] of Object.entries(res.data)) {
      const code = String(info["code"] ?? "").toLowerCase();
      const title = String(info["title"] ?? "").toLowerCase();
      if (GOOGLE_PROJECT_CODES.includes(code) || title.includes("google")) {
        this.googleProjectId = Number.parseInt(projectId, 10);
        return this.googleProjectId;
      }
    }
    return null;
  }

  /**
   * 按价格升序取最便宜的若干个国家。
   * 默认取国家列表的前 20 个逐个查价；查不到国家列表时退化为 [1..5]。
   * 只保留 total_count > 0 的条目。
   */
  async getCheapestPrices(options: {
    projectId?: number;
    countryIds?: number[];
    limit?: number;
  } = {}): Promise<PriceInfo[]> {
    let projectId = options.projectId;
    if (projectId === undefined) {
      const found = await this.findGoogleProjectId();
      if (found === null) return [];
      projectId = found;
    }

    let countryIds = options.countryIds;
    if (!countryIds) {
      const res = await this.listCountries();
      countryIds =
        res.success && res.data
          ? Object.keys(res.data).slice(0, 20).map((k) => Number.parseInt(k, 10))
          : [1, 2, 3, 4, 5];
    }

    const all: PriceInfo[] = [];
    for (const countryId of countryIds) {
      const res = await this.listPrices(countryId);
      if (!res.success || !res.data) continue;
      for (const [pid, info] of Object.entries(res.data)) {
        const pidNum = Number.parseInt(pid, 10);
        if (pidNum === projectId || info["project_id"] === projectId) {
          const price: PriceInfo = {
            country_id: (info["country_id"] as number) ?? countryId,
            project_id: Number.isNaN(pidNum) ? ((info["project_id"] as number) ?? projectId) : pidNum,
            cost: (info["cost"] as number) ?? 0,
            total_count: (info["total_count"] as number) ?? 0,
            country_name: (info["title"] as string) ?? "",
            country_code: (info["code"] as string) ?? "",
          };
          if (price.total_count > 0) all.push(price);
        }
      }
    }

    all.sort((a, b) => a.cost - b.cost);
    return all.slice(0, options.limit ?? 5);
  }

  /**
   * 取号。返回 [号码, 错误]，与 Python 的元组语义一致。
   * country_id 缺省时自动挑最便宜的；再缺省则退化为 1（美国）。
   */
  async getNumber(options: {
    countryId?: number;
    projectId?: number;
    preferCheapest?: boolean;
  } = {}): Promise<[PhoneNumber | null, string | null]> {
    let projectId = options.projectId;
    if (projectId === undefined) {
      const found = await this.findGoogleProjectId();
      if (found === null) return [null, "未找到 Google 服务"];
      projectId = found;
    }

    let countryId = options.countryId;
    let cost = 0;
    let countryName = "";

    if (countryId === undefined && (options.preferCheapest ?? true)) {
      const prices = await this.getCheapestPrices({ projectId, limit: 1 });
      const best = prices[0];
      if (!best) return [null, "没有可用的号码"];
      countryId = best.country_id;
      cost = best.cost;
      countryName = best.country_name;
    }

    if (countryId === undefined) countryId = 1;

    if (!countryName) {
      const res = await this.listCountries();
      if (res.success && res.data) {
        const info = res.data[String(countryId)];
        countryName = (info?.["title"] as string) ?? "";
      }
    }

    const res = await this.request<{ request_id: number; number: string }>("get/number", {
      country_id: countryId,
      project_id: projectId,
    });

    if (!res.success || !res.data) return [null, res.error ?? "取号失败"];

    return [
      {
        request_id: res.data.request_id,
        number: res.data.number,
        country_id: countryId,
        project_id: projectId,
        cost,
        country_name: countryName,
      },
      null,
    ];
  }

  /**
   * 查一次短信。返回 [验证码, 错误]。
   * 关键：code === 50101 时返回 error="waiting"，调用方据此判断是否继续轮询。
   */
  async getSms(requestId: number): Promise<[string | null, string | null]> {
    const res = await this.request<string>("get/sms", { request_id: requestId });
    if (res.success) return [(res.data ?? null) as string | null, null];
    if (res.code === SMS_CODE_WAITING) return [null, "waiting"];
    return [null, res.error ?? "获取短信失败"];
  }

  /** 轮询等待验证码。默认 120s 超时、5s 间隔。 */
  async waitForSms(
    requestId: number,
    options: {
      timeoutMs?: number;
      intervalMs?: number;
      onProgress?: (message: string) => void;
    } = {},
  ): Promise<[string | null, string | null]> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const intervalMs = options.intervalMs ?? 5_000;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const [code, error] = await this.getSms(requestId);
      if (code) return [code, null];
      // 非 waiting 的错误直接终止，不再重试
      if (error !== "waiting") return [null, error];

      if (options.onProgress) {
        const elapsed = Math.floor((Date.now() - start) / 1000);
        options.onProgress(`等待验证码... (${elapsed}s/${Math.floor(timeoutMs / 1000)}s)`);
      }
      await this.sleep(intervalMs);
    }

    return [null, `等待验证码超时 (${Math.floor(timeoutMs / 1000)}s)`];
  }

  /** 取消请求，释放号码 */
  cancelRequest(requestId: number): Promise<SmsBusResponse> {
    return this.request("cancel", { request_id: requestId });
  }
}