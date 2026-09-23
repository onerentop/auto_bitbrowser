/**
 * Google One Pro 会员状态检测器
 * 对标 automation/pro_status_detector.py
 *
 * 返回语义（与 Python 完全一致的三态字符串）：
 *   "yes"        普通 Pro（自己订阅）
 *   "family_yes" 家庭组 Pro（被他人共享）
 *   "no"         非 Pro
 *   null         检测失败
 *
 * 关于引擎选择的说明：
 * Python 侧主路径走 BrowserUseEngine（check_pro_status_via_stagehand 只是
 * 转发到 browseruse 版本）。Node 侧 BrowserUse 尚未移植，因此核心逻辑
 * detectWithEngine 被抽成**引擎无关**的形式——只要求引擎提供
 * navigate / extract / getPageContent 三个能力。
 * StagehandGoogleEngine 已满足，BrowserUse 移植后可无缝接入同一函数。
 */
import type { StagehandGoogleEngine } from "../engine/stagehand-engine.ts";

/**
 * 检测所需的最小引擎能力。
 *
 * data 允许为 null：BrowserUseEngine 的结果类型照搬 Python 的 Optional（用 null 表达），
 * StagehandGoogleEngine 侧用 undefined，两者都能满足本接口。
 * 下游 unwrapExtractData() 内部已用 `raw ?? {}` 兜底，不受影响。
 */
export interface ProDetectEngine {
  navigate(url: string, options?: { timeoutMs?: number }): Promise<{ success: boolean; error?: string | null }>;
  extract<T = unknown>(instruction: string, schema?: unknown): Promise<{ success: boolean; data?: T | null; error?: string | null }>;
  getPageContent(): Promise<string>;
}

/** AI 配置（由调用方从 config.json 读好后注入） */
export interface AiConfigProvider {
  getDefaultProvider(): string;
  getProviderApiKey(provider: string): string;
  getProviderModel(provider: string): string;
  getProviderBaseUrl(provider: string): string;
}

/** provider（配置格式）→ Stagehand 模型前缀 */
export const PROVIDER_MAP: Record<string, string> = {
  gemini: "google",
  anthropic: "anthropic",
  openai: "openai",
};

export interface StagehandAiConfig {
  apiKey: string;
  baseUrl: string | null;
  modelName: string;
}

/**
 * 从配置读取 Stagehand AI 配置。
 * 对标 get_stagehand_config()：缺 api_key 或 model 时返回 null。
 * Anthropic 的 base_url 需补 /v1 后缀（第三方代理要求）。
 */
export function getStagehandConfig(
  config: AiConfigProvider,
  log?: ((msg: string) => void) | null,
): StagehandAiConfig | null {
  const provider = config.getDefaultProvider();
  const apiKey = config.getProviderApiKey(provider);
  const model = config.getProviderModel(provider);
  const baseUrl = config.getProviderBaseUrl(provider);

  if (!apiKey || !model) {
    log?.(`[!] AI 配置不完整: provider=${provider}, has_key=${Boolean(apiKey)}, model=${model}`);
    return null;
  }

  const prefix = PROVIDER_MAP[provider] ?? provider;
  const modelName = `${prefix}/${model}`;

  let normalizedBaseUrl: string | null = null;
  if (baseUrl) {
    normalizedBaseUrl =
      provider === "anthropic" && !baseUrl.endsWith("/v1")
        ? `${baseUrl.replace(/\/+$/, "")}/v1`
        : baseUrl;
  }

  log?.(`使用 ${provider} 模型: ${modelName}`);
  if (normalizedBaseUrl) log?.(`使用第三方 API: ${normalizedBaseUrl}`);

  return { apiKey, baseUrl: normalizedBaseUrl, modelName };
}

// ==================== 二次验证关键词（逐字照搬 Python） ====================

/** 仅家庭成员可见的特征 */
export const FAMILY_MEMBER_INDICATORS = [
  "shared by",
  "plan manager",
  "由此共享",
  "共享方案",
  "方案管理员",
  "family storage",
  "家庭存储",
  "family group member",
  "家庭群组成员",
  "プランマネージャー",
];

/** 仅个人订阅者（方案管理者）可见的特征 */
export const OWNER_INDICATORS = [
  "manage membership",
  "cancel membership",
  "管理会员",
  "管理成员资格",
  "取消会员",
  "取消成员资格",
  "change membership",
  "更改成员资格",
  "your membership",
  "您的成员资格",
  "next payment",
  "下次付款",
  "renews on",
  "续订日期",
  "member since",
  "成为会员",
];

/** 仅非订阅者可见的特征 */
export const NON_SUBSCRIBER_INDICATORS = [
  "upgrade",
  "升级",
  "升級",
  "get started",
  "开始使用",
  "choose a plan",
  "选择方案",
  "get google one",
  "获取 google one",
  "pick a plan",
];

/** 有订阅（无论自有还是被共享）的一般性特征 */
export const SUBSCRIPTION_INDICATORS = [
  "google one ai premium",
  "ai premium",
  "premium plan",
  "2 tb",
  "100 gb",
  "200 gb",
  "your storage",
  "您的存储",
  "storage used",
  "已使用",
  "google photos",
  "vpn by google",
  "google one vpn",
];

/**
 * 这段提示词是调试出来的资产，逐字照搬 Python。
 * 关键约束（改坏会导致家庭成员被误判为普通 Pro，进而错误切号）：
 *   - 必须反复强调「有方案名但没有管理按钮 = 家庭成员」
 *   - 必须显式列出三类的可见特征
 *   - 必须要求只返回 JSON 不要 markdown
 */
export const PRO_DETECT_INSTRUCTION = `Analyze the current Google One page and determine the subscription status.

**CRITICAL - How to distinguish family member vs individual subscriber:**

A FAMILY MEMBER (someone using a plan shared by another person) will see:
- "Shared by [Name]" or "由[姓名]共享" text on the page
- "plan manager" or "方案管理员" mentioned (referring to someone else)
- They will NOT see "Manage membership" or "Cancel membership" buttons
- They may see the plan name (e.g. "2 TB", "Google One AI Premium") but it's shared, not owned
- Storage section may show "Family storage" or "家庭存储空间"
- They may see other family members' storage usage

An INDIVIDUAL SUBSCRIBER (the plan owner/manager) will see:
- "Manage membership" or "管理会员" or "管理成员资格" buttons
- "Cancel membership" or "取消会员" or "取消成员资格" options
- "Your membership" or "您的成员资格"
- "Next payment" or "下次付款" or "Renews on" or "续订"
- They are the "plan manager" themselves

A NON-SUBSCRIBER will see:
- "Upgrade" or "升级" button
- "Get started" or "开始使用"
- "Choose a plan" or "选择方案"
- "Get Google One" or "获取 Google One"

**IMPORTANT**: If you see a plan name like "2 TB" but do NOT see "Manage membership" or "Cancel membership",
and instead see "Shared by" or "plan manager" (referring to someone else), the user is a FAMILY MEMBER, not an individual subscriber.

**Return a JSON object with these fields:**
- is_subscribed: boolean (true if user has an active subscription, either own or shared)
- is_family_member: boolean (true if the plan is SHARED BY someone else / user is NOT the plan manager)
- plan_name: string or null (the plan name if visible, e.g. "2 TB", "Google One AI Premium")

Return ONLY the JSON object, no markdown.`;

export type ProStatusString = "yes" | "family_yes" | "no";

/** 命中任一关键词即返回 true */
export function matchesAnyIndicator(text: string, indicators: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return indicators.some((ind) => lower.includes(ind.toLowerCase()));
}

/**
 * 从 AI 返回里取出三个字段。
 * 需要处理一种包装：部分模型返回 { content: "```json {...}```" }，
 * 真值埋在 content 的字符串里，要用正则把 JSON 抠出来。
 */
export function unwrapExtractData(
  raw: unknown,
  log?: ((msg: string) => void) | null,
): { is_subscribed: boolean; is_family_member: boolean; plan_name: string | null } {
  let data = (raw ?? {}) as Record<string, unknown>;

  const keys = Object.keys(data);
  if (typeof data["content"] === "string" && keys.length === 1) {
    const contentStr = data["content"] as string;
    const m = contentStr.match(/\{[^{}]*"is_subscribed"[^{}]*\}/s);
    if (m) {
      try {
        data = JSON.parse(m[0]) as Record<string, unknown>;
        log?.(`从 content 中提取 JSON: ${JSON.stringify(data)}`);
      } catch {
        /* 解析失败就用原始 data，下面取默认值 */
      }
    }
  }

  return {
    is_subscribed: Boolean(data["is_subscribed"]),
    is_family_member: Boolean(data["is_family_member"]),
    plan_name: (data["plan_name"] as string | null) ?? null,
  };
}

/**
 * 二次验证：用页面文本修正 AI 判断。
 *
 * 为什么必须始终执行（而不是只在 AI 说不确定时）：
 * 家庭成员页面可能既没有 "Upgrade" 也没有 "Manage membership"，
 * AI 容易返回 is_subscribed=false。四种修正分支的顺序不可调换。
 */
export function applySecondaryCheck(
  pageText: string,
  input: { is_subscribed: boolean; is_family_member: boolean; plan_name: string | null },
  log?: ((msg: string) => void) | null,
): { is_subscribed: boolean; is_family_member: boolean; plan_name: string | null } {
  const { is_subscribed, is_family_member, plan_name } = input;
  let subscribed = is_subscribed;
  let familyMember = is_family_member;

  const hasFamily = matchesAnyIndicator(pageText, FAMILY_MEMBER_INDICATORS);
  const hasOwner = matchesAnyIndicator(pageText, OWNER_INDICATORS);
  const hasNonSubscriber = matchesAnyIndicator(pageText, NON_SUBSCRIBER_INDICATORS);
  const hasSubscription = matchesAnyIndicator(pageText, SUBSCRIPTION_INDICATORS);

  log?.(
    `页面分析: 家庭成员标识=${hasFamily}, 管理员标识=${hasOwner}, ` +
      `非订阅标识=${hasNonSubscriber}, 订阅标识=${hasSubscription}`,
  );

  // 情况1：AI 说不订阅，但有家庭成员标识且无非订阅标识 → 家庭成员
  if (!subscribed && hasFamily && !hasNonSubscriber) {
    log?.("[!] 二次验证修正: 检测到家庭成员标识 → 修正为家庭成员");
    subscribed = true;
    familyMember = true;
  }
  // 情况2：AI 说不订阅，但有订阅标识且无非订阅标识
  else if (!subscribed && hasSubscription && !hasNonSubscriber) {
    if (hasOwner) {
      log?.("[!] 二次验证修正: 检测到管理员标识 → 修正为个人订阅者");
      subscribed = true;
      familyMember = false;
    } else {
      log?.("[!] 二次验证修正: 检测到订阅标识但无管理按钮 → 修正为家庭成员");
      subscribed = true;
      familyMember = true;
    }
  }
  // 情况3：AI 说订阅且非家庭，但有家庭成员标识且无管理员标识 → 家庭成员
  else if (subscribed && !familyMember && hasFamily && !hasOwner) {
    log?.("[!] 二次验证修正: 检测到家庭成员标识，修正为 family_member");
    familyMember = true;
  }
  // 情况4：AI 说订阅，但只有非订阅标识 → 非订阅
  else if (subscribed && hasNonSubscriber && !hasOwner && !hasSubscription) {
    log?.("[!] 二次验证修正: 检测到非订阅标识 → 修正为非订阅");
    subscribed = false;
    familyMember = false;
  }

  return { is_subscribed: subscribed, is_family_member: familyMember, plan_name };
}

/**
 * 用已有引擎检测 Pro 状态。
 * 对标 check_pro_status_with_engine()——不创建/销毁引擎，避免重复建 CDP 连接。
 */
export async function checkProStatusWithEngine(
  engine: ProDetectEngine,
  email: string,
  log?: ((msg: string) => void) | null,
): Promise<ProStatusString | null> {
  const _log = (m: string) => (log ? log(m) : process.stdout.write(`[ProDetector-Reuse] ${m}\n`));

  try {
    _log("[AI] 使用已有引擎检测 Pro 状态...");

    const nav = await engine.navigate("https://one.google.com", { timeoutMs: 15000 });
    if (!nav.success) {
      _log(`[!] 导航 Google One 失败: ${nav.error ?? ""}`);
      return null;
    }

    _log("引擎: 使用 AI 提取 Pro 状态...");
    const extracted = await engine.extract(PRO_DETECT_INSTRUCTION);
    if (!extracted.success) {
      _log(`[!] AI 提取失败: ${extracted.error ?? ""}`);
      return null;
    }

    let { is_subscribed, is_family_member, plan_name } = unwrapExtractData(extracted.data, _log);

    // 二次验证：读页面可见文本做修正
    try {
      const pageText = await engine.getPageContent();
      if (pageText) {
        _log(`页面文本长度: ${pageText.length}, 前200字: ${pageText.slice(0, 200).replace(/\n/g, " ")}`);
        const corrected = applySecondaryCheck(
          pageText,
          { is_subscribed, is_family_member, plan_name },
          _log,
        );
        is_subscribed = corrected.is_subscribed;
        is_family_member = corrected.is_family_member;
        plan_name = corrected.plan_name;
      }
    } catch (err) {
      _log(`[!] 二次验证异常: ${err}`);
    }

    _log(`检测结果: subscribed=${is_subscribed}, family=${is_family_member}, plan=${plan_name}`);

    if (!is_subscribed) {
      _log("[OK] 非 Pro 会员");
      return "no";
    }
    if (is_family_member) {
      _log(`[OK] 家庭组 Pro 会员 (${plan_name})`);
      return "family_yes";
    }
    _log(`[OK] 普通 Pro 会员 (${plan_name})`);
    return "yes";
  } catch (err) {
    _log(`[!] Pro 状态检测失败: ${err}`);
    return null;
  }
}

/**
 * 连接 CDP 端点后检测 Pro 状态。
 * 对标 check_pro_status_via_browseruse()——自带引擎生命周期管理。
 */
export async function checkProStatusViaEngine(
  wsEndpoint: string,
  email: string,
  createEngine: (ws: string) => Promise<ProDetectEngine & { stop(closeBrowser?: boolean): Promise<void> }>,
  log?: ((msg: string) => void) | null,
): Promise<ProStatusString | null> {
  const _log = (m: string) => (log ? log(m) : process.stdout.write(`[ProDetector] ${m}\n`));
  let engine: (ProDetectEngine & { stop(closeBrowser?: boolean): Promise<void> }) | null = null;

  try {
    _log("[AI] 连接引擎检测 Pro 状态...");
    engine = await createEngine(wsEndpoint);
    _log("引擎已连接");

    return await checkProStatusWithEngine(engine, email, _log);
  } catch (err) {
    _log(`[!] 检测失败: ${err}`);
    return null;
  } finally {
    if (engine) {
      try {
        await engine.stop(false);
      } catch {
        /* 关闭失败不影响结果 */
      }
    }
  }
}

// ==================== 简单检测（基于页面文本，无需 AI） ====================

/** 非 Pro 的明确标识 */
export const NON_PRO_INDICATORS = [
  "Upgrade",
  "升级",
  "升級",
  "Get started",
  "开始使用",
  "Sign up now",
  "Get Google One",
  "获取 Google One",
  "Choose a plan",
  "选择方案",
];

/** Pro 会员的标识 */
export const PRO_INDICATORS = [
  "Manage membership",
  "管理会员",
  "Cancel membership",
  "取消会员",
  "Your membership",
  "您的会员",
  "Next payment",
  "下次付款",
];

/**
 * 简化检测：纯文本关键词，不调 AI。
 * 对标 check_pro_status_simple()——作为 AI 检测的备用方案。
 *
 * 判定顺序不可调换：先查非 Pro 标识，命中即返回 false；
 * 再查 Pro 标识；都没有则返回 null（不确定）。
 */
export function checkProStatusSimple(
  pageText: string,
  log?: ((msg: string) => void) | null,
): boolean | null {
  const _log = (m: string) => (log ? log(m) : process.stdout.write(`[ProDetector] ${m}\n`));
  const lower = pageText.toLowerCase();

  // 第一步：明确的非会员标识优先
  for (const indicator of NON_PRO_INDICATORS) {
    if (lower.includes(indicator.toLowerCase())) {
      _log(`检测到非 Pro 标识: ${indicator}`);
      return false;
    }
  }

  // 第二步：会员标识
  for (const indicator of PRO_INDICATORS) {
    if (lower.includes(indicator.toLowerCase())) {
      _log(`检测到 Pro 标识: ${indicator}`);
      return true;
    }
  }

  _log("未检测到明确的会员/非会员标识");
  return null;
}

// ==================== 登录状态检测 ====================

/** 登录态检测的提示词，逐字照搬 Python（含 email 插值） */
export function buildLoginCheckInstruction(email: string): string {
  return `分析当前 Google 账号页面，判断用户是否已登录。

**判断规则：**
1. 如果页面显示邮箱地址，提取该邮箱
2. 检查是否登录的是目标账号: ${email}

请返回：
- is_logged_in: 是否已登录 (true/false)
- logged_in_email: 已登录的邮箱地址
- is_target_account: 是否是目标账号 ${email} (true/false)`;
}

export interface LoginCheckEngine extends ProDetectEngine {
  getCurrentUrl(): Promise<string>;
  wait(ms: number): Promise<void>;
}

/**
 * 检测是否已登录目标账号。
 * 对标 check_login_status_via_stagehand()。
 *
 * 判定路径：
 *   1. URL 落在登录页 → false
 *   2. URL 在 myaccount.google.com → 用 AI 提取邮箱，比对是否目标账号
 *   3. 其它 → null（无法确定）
 *
 * 注意一个刻意的宽松处理：在 myaccount 页面但 AI 提取失败时返回 true
 * （能进 myaccount 说明确实已登录，只是拿不到邮箱），照搬 Python。
 */
export async function checkLoginStatusViaEngine(
  engine: LoginCheckEngine,
  email: string,
  log?: ((msg: string) => void) | null,
): Promise<boolean | null> {
  const _log = (m: string) => (log ? log(m) : process.stdout.write(`[LoginDetector] ${m}\n`));

  try {
    _log("[AI] 检测登录状态...");

    const nav = await engine.navigate("https://myaccount.google.com");
    if (!nav.success) {
      _log(`[!] 导航失败: ${nav.error ?? ""}`);
      return null;
    }

    await engine.wait(2000);

    const url = await engine.getCurrentUrl();
    _log(`当前页面 URL: ${url}`);

    if (url.includes("accounts.google.com") && url.includes("signin")) {
      _log("[OK] 检测结果: 未登录");
      return false;
    }

    if (url.includes("myaccount.google.com")) {
      const extracted = await engine.extract(
        buildLoginCheckInstruction(email),
      );

      if (!extracted.success) {
        _log(`[!] 提取登录状态失败: ${extracted.error ?? ""}`);
        _log("[OK] 检测结果: 已登录（无法确认邮箱）");
        return true;
      }

      const data = (extracted.data ?? {}) as Record<string, unknown>;
      const isLoggedIn = data["is_logged_in"] === undefined ? true : Boolean(data["is_logged_in"]);
      const loggedInEmail = String(data["logged_in_email"] ?? "");
      const isTarget = Boolean(data["is_target_account"]);

      _log(`AI 分析: 已登录=${isLoggedIn}, 登录邮箱=${loggedInEmail}, 是目标账号=${isTarget}`);

      if (!isLoggedIn) {
        _log("[OK] 检测结果: 未登录");
        return false;
      }

      if (isTarget) {
        _log(`[OK] 检测结果: 已登录目标账号 (${email})`);
        return true;
      }
      _log(`[!] 检测结果: 已登录其他账号 (${loggedInEmail})，需要切换到 ${email}`);
      return false;
    }

    _log("[!] 无法确定登录状态");
    return null;
  } catch (err) {
    _log(`[!] 登录检测失败: ${err}`);
    return null;
  }
}