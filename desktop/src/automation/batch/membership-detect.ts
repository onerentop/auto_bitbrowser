/**
 * 批量账号处理 - 家庭组详情 / 账户国家检测（Node 重写）
 *
 * 对标 automation/batch_account_processor.py：
 *   - L64-92    两个 pydantic 提取模型（FamilyInfoExtractModel / AccountCountryExtractModel）
 *   - L1751-2070 BatchAccountProcessor._detect_family_details_via_browseruse
 *   - L2071-2191 BatchAccountProcessor._extract_account_country_via_browseruse
 *
 * 与 Python 的差异（仅结构性差异，业务判定逐行照搬）：
 *   1. 这两个方法对 `self` 的引用只有 `self._log`，因此**不移植整个类**，
 *      改为两个独立导出的异步函数，日志由 `options.log` 注入（默认 noopLog）。
 *   2. Python 直接摸 `engine._page`（Playwright Page）读 `page.url` / `page.inner_text("body")`；
 *      TS 侧只依赖引擎公开的 `getCurrentUrl()` / `getPageContent()`，
 *      并把 `page is None` 的分支映射为 `getCurrentUrl()` 抛错的分支
 *      （BrowserUseEngine 未初始化时 ensureInitialized() 正是抛错）。
 *   3. 本文件**不 import BrowserUseEngine**，只声明它的最小能力子集 MembershipDetectEngine，
 *      单测可注入假引擎，也避免与 engine.ts 耦合（同 operations/join-family.ts 的 JoinFamilyEngine）。
 *   4. `asyncio.sleep(秒)` → 可注入的 `sleep(秒)`，默认 setTimeout(秒 * 1000)。
 *   5. Python `\w` 是 Unicode 语义，JS `\w` 只匹配 ASCII，
 *      因此用 `[\p{L}\p{N}_]` + `u` 标志还原（见 PY_WORD）。
 *   6. `str | None` → `string | null`；返回/写入的状态字符串字面量与 Python 完全一致。
 */
import { noopLog, type LogFn } from "../../browseruse/page.ts";

// ==================== AI 提取数据模型（对标 L64-92 的 pydantic 模型） ====================

/** 家庭组信息提取模型 —— 对标 FamilyInfoExtractModel（L65-82） */
export interface FamilyInfoExtractModel {
  has_family_group: string;
  family_role: string;
  family_member_count: number;
  family_manager_email: string;
}

/**
 * FamilyInfoExtractModel 各字段的 description —— 与 Python Field(description=...) 逐字一致。
 * 这些文本会随 schema 进 AI 提示词，不得改动。
 */
export const FAMILY_INFO_FIELD_DESCRIPTIONS = {
  has_family_group: "是否有家庭组。可选值: yes（有）, no（无）, unknown（无法确定）",
  family_role:
    "用户在家庭组中的角色。可选值: manager（管理员/创建者）, member（成员/被邀请者）, none（无家庭组）, unknown（无法确定）",
  family_member_count: "家庭组成员数量（包括管理员自己），范围 1-6。如果无法确定返回 0",
  family_manager_email:
    "家庭组管理员的邮箱地址。如果当前用户是成员，这里应该是管理员的邮箱；如果是管理员则为空",
} as const;

/** 默认值照搬 pydantic Field(default=...) */
export function createFamilyInfoExtractModel(
  overrides: Partial<FamilyInfoExtractModel> = {},
): FamilyInfoExtractModel {
  return {
    has_family_group: "unknown",
    family_role: "unknown",
    family_member_count: 0,
    family_manager_email: "",
    ...overrides,
  };
}

/** 可直接传给 engine.extract(instruction, schema) 的 schema 描述（对标 model_json_schema()） */
export const FAMILY_INFO_EXTRACT_SCHEMA = {
  title: "FamilyInfoExtractModel",
  type: "object",
  properties: {
    has_family_group: {
      type: "string",
      default: "unknown",
      description: FAMILY_INFO_FIELD_DESCRIPTIONS.has_family_group,
    },
    family_role: {
      type: "string",
      default: "unknown",
      description: FAMILY_INFO_FIELD_DESCRIPTIONS.family_role,
    },
    family_member_count: {
      type: "integer",
      default: 0,
      description: FAMILY_INFO_FIELD_DESCRIPTIONS.family_member_count,
    },
    family_manager_email: {
      type: "string",
      default: "",
      description: FAMILY_INFO_FIELD_DESCRIPTIONS.family_manager_email,
    },
  },
};

/** 账户国家提取模型 —— 对标 AccountCountryExtractModel（L84-89） */
export interface AccountCountryExtractModel {
  account_country: string;
}

/** AccountCountryExtractModel 字段 description —— 与 Python 逐字一致 */
export const ACCOUNT_COUNTRY_FIELD_DESCRIPTIONS = {
  account_country:
    "账户所在国家的英文名称（如 'United States', 'China', 'Japan'）。如果无法确定返回 'unknown'",
} as const;

export function createAccountCountryExtractModel(
  overrides: Partial<AccountCountryExtractModel> = {},
): AccountCountryExtractModel {
  return {
    account_country: "unknown",
    ...overrides,
  };
}

/** 可直接传给 engine.extract(instruction, schema) 的 schema 描述 */
export const ACCOUNT_COUNTRY_EXTRACT_SCHEMA = {
  title: "AccountCountryExtractModel",
  type: "object",
  properties: {
    account_country: {
      type: "string",
      default: "unknown",
      description: ACCOUNT_COUNTRY_FIELD_DESCRIPTIONS.account_country,
    },
  },
};

// ==================== 引擎最小能力接口 ====================

/**
 * 本模块用到的引擎能力（BrowserUseEngine 的结构化子集）。
 *
 * 与 BrowserUseEngine 真实签名的对照：
 *   navigate(url, {waitUntil?, timeoutMs?}) → Promise<NavigationResult>  （NavigationResult 含 success/error）
 *   extract<T>(instruction, schema?, {timeoutMs?, maxSteps?}) → Promise<ExtractResult<T>>（含 success/data/error）
 *   getPageContent() → Promise<string>      （内部即 page.inner_text("body")）
 *   getCurrentUrl()  → Promise<string>      （内部即 page.url()，未初始化时抛错）
 */
export interface MembershipDetectEngine {
  navigate(
    url: string,
    options?: { waitUntil?: string; timeoutMs?: number },
  ): Promise<{ success: boolean; error?: string | null }>;
  extract<T = Record<string, unknown>>(
    instruction: string,
    schema?: unknown,
    options?: { timeoutMs?: number; maxSteps?: number },
  ): Promise<{ success: boolean; data?: T | null; error?: string | null }>;
  getPageContent(): Promise<string>;
  getCurrentUrl(): Promise<string>;
}

/**
 * 被写入的结果对象（AccountMembershipRefreshResult 的可变字段子集）。
 * 故意用结构化子集而不是 import batch/types.ts，避免与并行开发的模块耦合；
 * 字段名与 Python dataclass 一致，完整的 AccountMembershipRefreshResult 可直接传入。
 */
export interface MembershipDetectResult {
  is_pro: string;
  has_family_group: string;
  family_role: string;
  family_member_count: number;
  family_manager_email: string;
  account_country: string;
}

export interface MembershipDetectOptions {
  /** 对标 self._log，文案逐字保留 */
  log?: LogFn | null;
  /** 对标 asyncio.sleep(seconds)，参数单位是**秒** */
  sleep?: (seconds: number) => Promise<void>;
}

/** 默认 sleep：参数单位秒，对标 asyncio.sleep */
export function sleepSeconds(seconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
}

// ==================== 关键词 / 正则（逐字照搬 Python） ====================

/** Python `\w` 的 Unicode 语义（JS `\w` 仅 ASCII），配合 `u` 标志使用 */
const PY_WORD = "[\\p{L}\\p{N}_]";

/** 有家庭组的标识 —— L1823-1835 */
export const HAS_FAMILY_INDICATORS = [
  "your family group", // 英文
  "family group details", // 英文
  "家庭群组详细信息", // 中文简体
  "你的家庭群组", // 中文简体
  "您的家庭群组", // 中文简体
  "family manager", // 英文
  "家庭管理员", // 中文简体
  "家庭群组管理員", // 中文繁体
  "leave family", // 英文（退出家庭组）
  "退出家庭群组", // 中文
  "离开家庭群组", // 中文
];

/** 无家庭组的标识 —— L1837-1843 */
export const NO_FAMILY_INDICATORS = [
  "create a family group", // 英文
  "创建家庭群组", // 中文
  "you can create", // 英文
  "start a family group", // 英文
  "no family group", // 英文
];

/** 方法1：只有 member 才能看到的 "Leave Family Group" —— L1879-1884 */
export const LEAVE_PATTERNS = [
  /leave\s+famil/iu, // "Leave Family Group" / "Leave Family"
  /退出家庭群组/iu,
  /离开家庭群组/iu,
  /退出家庭/iu,
];

/** 方法2："X's Family Group"（X 是管理员名字）—— L1894-1898 */
export const MANAGER_NAME_PATTERNS = [
  new RegExp(`(?:leaving|leave)\\s+(${PY_WORD}+(?:\\s+${PY_WORD}+)?)'s\\s+family`, "iu"), // "leaving Bruna's Family"
  new RegExp(`(${PY_WORD}+(?:\\s+${PY_WORD}+)?)'s\\s+family\\s+group`, "iu"), // "Bruna's Family Group"
  /(\S+)\s*的家庭群组/iu, // "xxx 的家庭群组"
];

/** 方法4：只有 manager 才能看到的按钮 —— L1927-1934 */
export const MANAGER_ONLY_PATTERNS = [
  /delete\s+family\s+group/iu, // 只有管理员才有删除按钮
  /删除家庭群组/iu,
  /invite\s+family\s+member/iu, // 只有管理员才能邀请
  /邀请家庭成员/iu,
  /add\s+family\s+member/iu, // 添加成员
  /添加家庭成员/iu,
];

/** 成员数量正则 —— L1952-1957 */
export const MEMBER_COUNT_PATTERNS = [
  /(\d+)\s*(?:family\s+)?members?/iu,
  /(\d+)\s*位\s*(?:家庭)?成员/iu,
  /(\d+)\s*人/iu,
  /家庭群组\s*\((\d+)\)/iu,
];

/** 页面文本邮箱正则 —— L1969 / L1995 的 `[\w.+-]+@[\w-]+\.\w+` */
const PAGE_EMAIL_PATTERN = new RegExp(
  `[\\p{L}\\p{N}_.+-]+@[\\p{L}\\p{N}_-]+\\.${PY_WORD}+`,
  "gu",
);

/** AI 返回文本里的邮箱正则 —— L2039 的 `[\w.+-]+@[\w-]+\.[\w.]+` */
const AI_EMAIL_PATTERN = new RegExp(
  `[\\p{L}\\p{N}_.+-]+@[\\p{L}\\p{N}_-]+\\.[\\p{L}\\p{N}_.]+`,
  "u",
);

/** AI 自然语言回复中的国家名正则 —— L2165-2168 */
export const COUNTRY_PATTERNS = [
  /(?:country|国家|地区|region)\s*(?:is|为|：|:)\s*([A-Z][a-zA-Z\s]+)/iu,
  /(?:United States|United Kingdom|China|Japan|South Korea|Germany|France|Brazil|India|Canada|Australia|Mexico|Russia|Italy|Spain|Netherlands|Turkey|Indonesia|Thailand|Vietnam|Philippines|Malaysia|Singapore|Taiwan|Hong Kong)/iu,
];

// ==================== AI 提示词（与 Python 逐字一致） ====================

/** 管理员邮箱补充提取 —— batch_account_processor.py L2014-2026 */
export const FAMILY_MANAGER_EMAIL_EXTRACT_INSTRUCTION = `Look at this Google Family page. I need the family manager's EMAIL ADDRESS.

The family manager is the person who created/manages this family group.
Their email should be visible on this page as text, OR you may need to click on their name/profile to reveal it.

IMPORTANT: Look for email addresses in format like name@gmail.com
- Check near each person's name
- If emails are hidden, try clicking on the family manager's name or profile picture

Return ONLY a JSON object:
{"family_manager_email": "email@gmail.com"}

If truly not found after clicking, return: {"family_manager_email": ""}`;

/** 账户国家提取 —— batch_account_processor.py L2129-2138 */
export const ACCOUNT_COUNTRY_EXTRACT_INSTRUCTION = `Analyze this Google Account personal info page and find the user's country/region.

Look for:
- "Country/Region" field and its value
- Location or address information
- Any country name displayed on the page

Return ONLY a valid JSON object with one key:
- account_country: The country name in English (e.g., "United States", "China", "Japan", "United Kingdom")
  - Return "unknown" if the country cannot be determined`;

// ==================== 内部小工具 ====================

/** 异常 → 文本（对标 Python f-string 里的 `{e}`） */
function formatError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 对标 isinstance(data, dict)：数组与 null 都不算 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 模仿 Python set 的 repr，用于日志里的 `{unique_emails}` */
function formatPySet(values: Iterable<string>): string {
  const items = [...values];
  if (items.length === 0) return "set()";
  return `{${items.map((v) => `'${v}'`).join(", ")}}`;
}

/** 日志里打印 AI 返回数据（Python 打 dict repr，这里用 JSON） */
function formatData(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

/** 对标 re.findall(EMAIL, text) */
function findAllEmails(text: string): string[] {
  return [...text.matchAll(PAGE_EMAIL_PATTERN)].map((m) => m[0]);
}

// ==================== 家庭组详情检测 ====================

/**
 * 检测家庭组详情 - 页面文本优先方案（Plan B）
 * 对标 _detect_family_details_via_browseruse（L1751-2070）
 *
 * 策略：
 * 1. 导航到 myaccount.google.com/family/details（唯一可靠 URL）
 * 2. 先用 Playwright inner_text 提取页面文本
 * 3. 用正则从页面文本提取：角色、管理员名、成员数、邮箱
 * 4. AI 仅在管理员邮箱缺失时使用（可能需要点击成员头像）
 * 5. 导航失败不级联影响后续步骤
 */
export async function detectFamilyDetailsViaBrowserUse(
  engine: MembershipDetectEngine,
  email: string,
  refreshResult: MembershipDetectResult,
  options: MembershipDetectOptions = {},
): Promise<void> {
  const log: LogFn = options.log ?? noopLog;
  const sleep = options.sleep ?? sleepSeconds;

  try {
    // 重要修复：如果已经是 family_yes（家庭组成员），角色一定是 member
    // 这个逻辑放在最前面，确保即使后续失败也能设置正确的角色
    if (refreshResult.is_pro === "family_yes") {
      refreshResult.family_role = "member";
      log(`[${email}] 账号是 family_yes，角色固定为 member`);
    }

    // ========== Step 1: 导航到家庭组页面 ==========
    // 注意：只使用 myaccount.google.com，因为 families.google.com 被 SOCKS 代理阻断
    const familyUrl = "https://myaccount.google.com/family/details";
    log(`[${email}] 导航到家庭组页面: ${familyUrl}`);
    const navResult = await engine.navigate(familyUrl, { timeoutMs: 15000 });

    if (!navResult.success) {
      log(`[${email}] 导航家庭组页面失败: ${navResult.error ?? ""}`);
      return;
    }

    // 等待页面加载
    await sleep(3);

    // 检查是否导航到了错误页面（如 chrome-error://）
    // Python 判断 `engine._page is None`；TS 侧等价条件是 getCurrentUrl() 抛错（页面未就绪）
    let actualUrl: string;
    try {
      actualUrl = await engine.getCurrentUrl();
    } catch {
      log(`[${email}] Page 对象不可用`);
      return;
    }
    log(`[${email}] 家庭组页面实际 URL: ${actualUrl}`);

    if (actualUrl.includes("chrome-error") || actualUrl.includes("about:blank")) {
      log(`[${email}] 页面加载失败（错误页面），跳过家庭组检测`);
      return;
    }

    // ========== Step 2: 从页面文本提取信息（主要方法） ==========
    log(`[${email}] 从页面文本提取家庭组信息...`);
    let pageText: string;
    try {
      pageText = await engine.getPageContent();
    } catch (e) {
      log(`[${email}] 获取页面文本失败: ${formatError(e)}`);
      return;
    }

    const pageTextLower = pageText.toLowerCase();
    log(`[${email}] 页面文本 (前500字): ${pageText.slice(0, 500).replace(/\n/g, " ")}`);

    // ---------- 2a: 判断是否有家庭组 ----------
    let hasFamily = false;
    let noFamily = false;
    for (const indicator of HAS_FAMILY_INDICATORS) {
      if (pageTextLower.includes(indicator.toLowerCase())) {
        hasFamily = true;
        log(`[${email}] 检测到家庭组标识: '${indicator}'`);
        break;
      }
    }
    for (const indicator of NO_FAMILY_INDICATORS) {
      if (pageTextLower.includes(indicator.toLowerCase())) {
        noFamily = true;
        log(`[${email}] 检测到无家庭组标识: '${indicator}'`);
        break;
      }
    }

    if (noFamily && !hasFamily) {
      refreshResult.has_family_group = "no";
      refreshResult.family_role = "none";
      log(`[${email}] 页面文本确认：无家庭组`);
      return;
    } else if (hasFamily) {
      refreshResult.has_family_group = "yes";
    } else {
      log(`[${email}] 无法从页面文本判断家庭组状态`);
      refreshResult.has_family_group = "unknown";
    }

    // ---------- 2b: 检测用户角色（Member vs Family manager） ----------
    // 关键逻辑：
    // - 如果页面文本包含 "Leave Family" / "退出家庭" → 当前用户是 member
    // - 如果页面文本包含 "X's Family Group" → X 是管理员，当前用户是 member
    // - 如果当前用户邮箱旁边标注 "Family manager" → 当前用户是 manager
    // - 如果当前用户邮箱旁边标注 "Member" → 当前用户是 member
    let detectedRole: string | null = null;

    // 方法1: 查找 "Leave Family Group" 按钮（只有 member 才能看到）
    for (const pattern of LEAVE_PATTERNS) {
      if (pattern.test(pageText)) {
        detectedRole = "member";
        log(`[${email}] 页面文本检测到 'Leave Family' → 角色=member`);
        break;
      }
    }

    // 方法2: 查找 "X's Family Group"（X 是管理员名字）
    if (!detectedRole) {
      // 匹配 "Bruna's Family Group" / "xxx 的家庭群组"
      for (const pattern of MANAGER_NAME_PATTERNS) {
        const match = pageText.match(pattern);
        if (match) {
          const managerName = (match[1] ?? "").trim();
          detectedRole = "member";
          log(`[${email}] 页面文本检测到管理员名: '${managerName}' → 角色=member`);
          break;
        }
      }
    }

    // 方法3: 查找当前用户邮箱附近的角色标注
    if (!detectedRole) {
      // 提取当前用户邮箱前后的文本上下文
      const emailLower = email.toLowerCase();
      const emailPos = pageTextLower.indexOf(emailLower);
      if (emailPos >= 0) {
        // 取邮箱前后 200 个字符
        const contextStart = Math.max(0, emailPos - 200);
        const contextEnd = Math.min(pageText.length, emailPos + email.length + 200);
        const emailContext = pageText.slice(contextStart, contextEnd).toLowerCase();

        if (emailContext.includes("member") && !emailContext.includes("family manager")) {
          detectedRole = "member";
          log(`[${email}] 邮箱上下文检测到 'Member' → 角色=member`);
        } else if (
          emailContext.includes("family manager") ||
          emailContext.includes("家庭管理员")
        ) {
          detectedRole = "manager";
          log(`[${email}] 邮箱上下文检测到 'Family manager' → 角色=manager`);
        }
      }
    }

    // 方法4: 查找 "Delete Family Group" 按钮（只有 manager 才能看到）
    if (!detectedRole) {
      for (const pattern of MANAGER_ONLY_PATTERNS) {
        if (pattern.test(pageText)) {
          detectedRole = "manager";
          log(`[${email}] 页面文本检测到管理员专属按钮 → 角色=manager`);
          break;
        }
      }
    }

    // 应用检测到的角色（如果 is_pro 不是 family_yes，才使用页面文本检测结果）
    if (detectedRole) {
      if (refreshResult.is_pro === "family_yes") {
        // family_yes 的角色已固定为 member，不覆盖
        log(`[${email}] family_yes 角色固定为 member，忽略页面文本检测到的: ${detectedRole}`);
      } else {
        refreshResult.family_role = detectedRole;
        log(`[${email}] 页面文本最终角色: ${detectedRole}`);
      }
    }

    // ---------- 2c: 提取成员数量 ----------
    // 方法1: 正则匹配 "X members" / "X 位成员"
    for (const pattern of MEMBER_COUNT_PATTERNS) {
      const match = pageText.match(pattern);
      if (match) {
        const count = Number.parseInt(match[1] ?? "", 10);
        if (count >= 1 && count <= 6) {
          refreshResult.family_member_count = count;
          log(`[${email}] 页面文本提取成员数: ${count}`);
          break;
        }
      }
    }

    // 方法2: 统计页面上的邮箱地址数量
    if (refreshResult.family_member_count === 0) {
      const emailsFound = findAllEmails(pageText);
      const uniqueEmails = new Set(
        emailsFound.filter(
          (e) =>
            !e.toLowerCase().includes("support") &&
            !e.toLowerCase().includes("help") &&
            !e.toLowerCase().includes("noreply") &&
            !e.toLowerCase().endsWith("@google.com"),
        ),
      );
      if (uniqueEmails.size >= 1) {
        // 注意：页面可能只显示当前用户的邮箱
        // 如果检测到 has_family_group=yes 且角色=member，至少有 2 人
        let count = uniqueEmails.size;
        if (refreshResult.has_family_group === "yes" && count === 1) {
          count = 2; // 至少有管理员 + 当前用户
        }
        if (count >= 1 && count <= 6) {
          refreshResult.family_member_count = count;
          log(`[${email}] 通过邮箱计数提取成员数: ${count} (页面邮箱: ${formatPySet(uniqueEmails)})`);
        }
      }
    }

    // 方法3: 默认值
    if (refreshResult.family_member_count === 0 && refreshResult.has_family_group === "yes") {
      refreshResult.family_member_count = 2; // 至少有管理员 + 当前用户
      log(`[${email}] 默认成员数: 2`);
    }

    // ---------- 2d: 提取管理员邮箱（从页面文本） ----------
    if (!refreshResult.family_manager_email) {
      // 从页面文本中查找邮箱
      const emailsFound = findAllEmails(pageText);
      // 过滤：排除当前用户邮箱和系统邮箱
      const candidateEmails = emailsFound.filter(
        (e) =>
          e.toLowerCase() !== email.toLowerCase() &&
          !e.toLowerCase().includes("support") &&
          !e.toLowerCase().includes("help") &&
          !e.toLowerCase().includes("noreply") &&
          !e.toLowerCase().endsWith("@google.com"),
      );
      const firstCandidate = candidateEmails[0];
      if (firstCandidate !== undefined) {
        refreshResult.family_manager_email = firstCandidate;
        log(`[${email}] 页面文本提取管理员邮箱: ${firstCandidate}`);
      }
    }

    // ========== Step 3: AI 补充提取（仅在管理员邮箱缺失时） ==========
    if (!refreshResult.family_manager_email && refreshResult.has_family_group === "yes") {
      log(`[${email}] 管理员邮箱仍为空，使用 AI 尝试提取...`);
      try {
        const extractResult = await engine.extract(
          FAMILY_MANAGER_EMAIL_EXTRACT_INSTRUCTION,
          undefined,
          { timeoutMs: 30000, maxSteps: 6 },
        );

        if (extractResult.success && extractResult.data) {
          let data: unknown = extractResult.data;
          log(`[${email}] AI 管理员邮箱提取结果: ${formatData(data)}`);

          // 处理 {'content': '...'} 包装格式
          if (isPlainObject(data) && "content" in data && Object.keys(data).length === 1) {
            const contentStr = typeof data["content"] === "string" ? data["content"] : "";
            // 从文本中提取邮箱
            const emailMatch = contentStr.match(AI_EMAIL_PATTERN);
            if (emailMatch) {
              const foundEmail = emailMatch[0];
              if (foundEmail.toLowerCase() !== email.toLowerCase()) {
                data = { family_manager_email: foundEmail };
              }
            }
            // 尝试提取 JSON
            const jsonMatch = contentStr.match(/\{[^{}]*"family_manager_email"[^{}]*\}/u);
            if (jsonMatch) {
              try {
                data = JSON.parse(jsonMatch[0]);
              } catch {
                /* JSONDecodeError → pass */
              }
            }
          }

          if (isPlainObject(data)) {
            const mgrEmail =
              typeof data["family_manager_email"] === "string" ? data["family_manager_email"] : "";
            if (mgrEmail && mgrEmail.includes("@") && mgrEmail.toLowerCase() !== email.toLowerCase()) {
              refreshResult.family_manager_email = mgrEmail;
              log(`[${email}] ✅ AI 提取管理员邮箱成功: ${mgrEmail}`);
            } else {
              log(`[${email}] AI 未找到管理员邮箱`);
            }
          }
        } else {
          log(`[${email}] AI 提取失败: ${extractResult.error ?? ""}`);
        }
      } catch (e) {
        log(`[${email}] AI 提取管理员邮箱异常: ${formatError(e)}`);
      }
    }

    log(
      `[${email}] 家庭组: has=${refreshResult.has_family_group}, role=${refreshResult.family_role}, count=${refreshResult.family_member_count}, manager_email=${refreshResult.family_manager_email}`,
    );
  } catch (e) {
    log(`[${email}] 家庭组检测失败: ${formatError(e)}`);
  }
}

// ==================== 账户国家提取 ====================

/**
 * 使用 BrowserUseEngine AI 提取账户国家
 * 对标 _extract_account_country_via_browseruse（L2071-2191）
 */
export async function extractAccountCountryViaBrowserUse(
  engine: MembershipDetectEngine,
  email: string,
  refreshResult: MembershipDetectResult,
  options: MembershipDetectOptions = {},
): Promise<void> {
  const log: LogFn = options.log ?? noopLog;
  const sleep = options.sleep ?? sleepSeconds;

  try {
    // ========== 导航错误恢复 ==========
    // 如果之前的步骤导致浏览器停留在 chrome-error 页面，需要先恢复
    try {
      const currentUrl = await engine.getCurrentUrl();
      if (currentUrl.includes("chrome-error") || currentUrl.includes("about:blank")) {
        log(`[${email}] 检测到错误页面 (${currentUrl})，尝试恢复...`);
        // 先导航到一个简单的 Google 页面恢复状态
        const recoveryResult = await engine.navigate("https://myaccount.google.com", {
          timeoutMs: 15000,
        });
        if (!recoveryResult.success) {
          log(`[${email}] 页面恢复失败，跳过国家提取`);
          refreshResult.account_country = "unknown";
          return;
        }
        await sleep(2);
      }
    } catch (e) {
      log(`[${email}] 检查页面状态异常: ${formatError(e)}`);
    }

    // 导航到 Google 账号设置页面
    log(`[${email}] BrowserUseEngine: 导航到账号设置页面...`);
    const navResult = await engine.navigate("https://myaccount.google.com/personal-info", {
      timeoutMs: 15000,
    });
    if (!navResult.success) {
      log(`[${email}] 导航账号设置页面失败: ${navResult.error ?? ""}`);
      refreshResult.account_country = "unknown";
      return;
    }

    // 检查导航后是否又到了错误页面
    let navigatedToErrorPage = false;
    try {
      const currentUrl = await engine.getCurrentUrl();
      if (currentUrl.includes("chrome-error") || currentUrl.includes("about:blank")) {
        log(`[${email}] 导航后仍在错误页面，跳过国家提取`);
        refreshResult.account_country = "unknown";
        navigatedToErrorPage = true;
      }
    } catch {
      /* except Exception: pass */
    }
    if (navigatedToErrorPage) return;

    // 等待页面加载
    await sleep(2);

    // 使用 AI 提取国家信息
    log(`[${email}] BrowserUseEngine: 使用 AI 提取国家信息...`);

    const extractResult = await engine.extract(
      ACCOUNT_COUNTRY_EXTRACT_INSTRUCTION,
      ACCOUNT_COUNTRY_EXTRACT_SCHEMA,
      { timeoutMs: 30000, maxSteps: 10 },
    );

    if (extractResult.success && extractResult.data) {
      let data: unknown = extractResult.data;
      log(`[${email}] AI 提取国家结果: ${formatData(data)}`);

      // 处理 {'content': '...'} 包装格式
      if (isPlainObject(data) && "content" in data && Object.keys(data).length === 1) {
        const contentStr = typeof data["content"] === "string" ? data["content"] : "";
        const jsonMatch = contentStr.match(/\{[^{}]*"account_country"[^{}]*\}/su);
        if (jsonMatch) {
          try {
            data = JSON.parse(jsonMatch[0]);
            log(`[${email}] 从 content 中提取 JSON: ${formatData(data)}`);
          } catch {
            /* JSONDecodeError → pass */
          }
        } else {
          // AI 返回自然语言，尝试从中提取国家名
          for (const pattern of COUNTRY_PATTERNS) {
            const match = contentStr.match(pattern);
            if (match) {
              const countryName = match[1] !== undefined ? match[1].trim() : match[0].trim();
              data = { account_country: countryName };
              log(`[${email}] 从自然语言中提取国家: ${countryName}`);
              break;
            }
          }
        }
      }

      if (isPlainObject(data)) {
        const country =
          typeof data["account_country"] === "string" ? data["account_country"] : "unknown";
        if (country && country !== "unknown") {
          refreshResult.account_country = country;
          log(`[${email}] 检测到国家: ${country}`);
          return;
        }
      } else {
        log(`[${email}] AI 返回非字典类型数据: ${typeof data}`);
      }
    }

    refreshResult.account_country = "unknown";
    log(`[${email}] 未检测到国家，设为 unknown`);
  } catch (e) {
    log(`[${email}] BrowserUseEngine 国家提取失败: ${formatError(e)}`);
    refreshResult.account_country = "unknown";
  }
}
