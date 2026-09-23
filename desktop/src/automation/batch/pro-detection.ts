/**
 * 批量处理器 - Pro 会员 / 家庭组状态检测（Node 重写）
 * 对标 automation/batch_account_processor.py 的 L1008-1424，即这 4 个方法：
 *   _check_pro_status_via_cdp     (L1008-1080) → checkProStatusViaCdp
 *   _check_family_status          (L1081-1193) → checkFamilyStatus
 *   _check_google_one_pro_status  (L1194-1327) → checkGoogleOneProStatus
 *   _get_family_member_count      (L1328-1424) → getFamilyMemberCount
 *
 * 与 Python 的差异（仅结构层面，判定逻辑逐字对齐）：
 *   1. Python 是 BatchAccountProcessor 的实例方法，但这 4 个方法对 self 的引用
 *      只有 self._log 与组内互调，因此这里拆成 4 个独立导出函数，log 由参数注入。
 *   2. Python 的 CDP 服务来自 `core.ai_browser_agent`（该模块在仓库中已删除，
 *      import 失败 → CDP_SERVICE_AVAILABLE=False，所有 CDP 分支实际是死路径）。
 *      Node 侧没有对应实现，改为可选依赖 deps.createCdpService 注入：
 *      不注入 = CDP 不可用，等价于 Python 运行时的实际行为。
 *   3. Python 的 DBManager.update_family_member_count 改为可选注入的
 *      deps.accountRepo（db/account-repository.ts 的 AccountRepository 结构上满足）；
 *      未注入时跳过写库，不影响返回值。
 *   4. page.url / page.context 属性 → page.url() / page.context() 方法（Playwright JS API）。
 *   5. 本段 Python 没有任何 asyncio.sleep 与 page.evaluate 注入脚本，
 *      两处等待都是 page.wait_for_timeout(2000) → page.waitForTimeout(2000)。
 *
 * 关键词表说明（重要）：
 *   本文件内的所有关键词表与 automation/pro-status-detector.ts 里的
 *   FAMILY_MEMBER_INDICATORS / OWNER_INDICATORS / NON_SUBSCRIBER_INDICATORS /
 *   SUBSCRIPTION_INDICATORS / PRO_INDICATORS / NON_PRO_INDICATORS
 *   **不是同一张表**（内容、顺序、语言覆盖均不同），已逐条核对。
 *   它们分别来自 batch_account_processor.py 与 pro_status_detector.py 两个 Python 文件，
 *   **勿合并、勿互相 import**。
 */

import { GoogleURLs } from "../../engine/constants.ts";
import { noopLog, type BrowserPageLike, type LogFn } from "../../browseruse/page.ts";

// ==================== 依赖接口 ====================

/**
 * 本模块需要的页面能力。
 * 在 BrowserPageLike 之外额外要求两个 Playwright 原生方法（真实 Page 都有）：
 *   - waitForTimeout：对应 Python 的 page.wait_for_timeout
 *   - querySelectorAll：对应 Python 的 page.query_selector_all（只用到返回数组的长度）
 */
export interface ProDetectPage extends BrowserPageLike {
  waitForTimeout(timeout: number): Promise<void>;
  querySelectorAll(selector: string): Promise<unknown[]>;
}

/** CDP 可访问性树元素。Python 侧是 dict，只读取 name 字段 */
export interface CdpAxElement {
  name?: string | null;
  [key: string]: unknown;
}

/** 对标 Python `create_cdp_service(page)` 返回的服务对象 */
export interface CdpService {
  getInteractiveElementsViaAx(): Promise<CdpAxElement[]>;
  close(): Promise<void>;
}

/** 对标 Python 的 `create_cdp_service`；不注入即表示 CDP_SERVICE_AVAILABLE=False */
export type CdpServiceFactory = (page: ProDetectPage) => Promise<CdpService>;

/** 只需要 DBManager.update_family_member_count 这一个能力 */
export interface FamilyCountRepository {
  updateFamilyMemberCount(email: string, count: number): boolean;
}

/** 可选依赖注入（Python 侧是模块级全局） */
export interface ProDetectDeps {
  /** 对标 create_cdp_service / CDP_SERVICE_AVAILABLE */
  createCdpService?: CdpServiceFactory | null;
  /** 对标 DBManager（仅用 update_family_member_count） */
  accountRepo?: FamilyCountRepository | null;
}

// ==================== 关键词表（逐字照搬 Python，勿与 pro-status-detector.ts 合并） ====================

/** 非会员标识（CDP 中查找）— batch_account_processor.py:1035-1041 */
export const CDP_NON_PRO_KEYWORDS = [
  "upgrade", "升级", "升級",
  "get started", "开始使用",
  "get google one", "获取 google one",
  "choose a plan", "选择方案",
  "get basic", "get premium",
];

/** Pro 会员标识（CDP 中查找）— batch_account_processor.py:1044-1051 */
export const CDP_PRO_KEYWORDS = [
  "manage membership", "管理会员", "管理成员资格",
  "cancel membership", "取消会员",
  "your membership", "您的成员资格",
  "member since", "成为会员",
  "next payment", "下次付款",
  "renews on", "续订",
];

/** 家庭组成员标识（只有成员才有退出按钮）— batch_account_processor.py:1109-1112 */
export const CDP_FAMILY_MEMBER_KEYWORDS = [
  "leave family", "退出家庭", "离开家庭",
  "you're a member", "您已加入",
];

/** 家庭组管理员标识 — batch_account_processor.py:1115-1121 */
export const CDP_FAMILY_MANAGER_KEYWORDS = [
  "manage family", "管理家庭",
  "invite family", "邀请家庭",
  "add family member", "添加家庭成员",
  "delete family", "删除家庭",
  "family manager", "家庭管理员",
];

/** 家庭组成员标识（Playwright 兜底）— batch_account_processor.py:1154-1158 */
export const FAMILY_MEMBER_INDICATORS_BATCH = [
  "退出家庭群组", "Leave family group", "离开家庭群组",
  "Leave family", "您已加入家庭群组", "You're a member of",
  "家庭群组成员", "Family group member", "Family member",
];

/** 管理员/独立订阅标识（Playwright 兜底）— batch_account_processor.py:1166-1172 */
export const FAMILY_MANAGER_INDICATORS_BATCH = [
  "管理家庭群组", "Manage family group", "Manage family",
  "邀请家庭成员", "Invite family members", "Add family member",
  "添加家庭成员", "创建家庭群组", "Create family group",
  "Create a family", "删除家庭群组", "Delete family group",
  "您是家庭管理员", "You are the family manager", "Family manager",
];

/**
 * 非会员标识 - 明确表示用户尚未订阅的关键词 — batch_account_processor.py:1242-1273
 * 注意：这些标识在已订阅用户页面上通常不会出现
 */
export const NON_PRO_INDICATORS_BATCH = [
  // ===== 最重要：Upgrade 按钮（非会员页面左侧导航栏必有）=====
  "Upgrade",            // 英文 - 升级按钮（只有非会员才有）
  "升级",               // 中文简体
  "升級",               // 中文繁体
  "アップグレード",      // 日语
  "업그레이드",          // 韩语
  "Nâng cấp",           // 越南语
  "Tingkatkan",         // 印尼语/马来语
  "อัปเกรด",            // 泰语
  // ===== 其他非会员标识 =====
  "Get started",        // 页面显示"开始使用"按钮（家庭组创建页面）
  "开始使用",
  "Sign up now",        // 注册按钮
  "立即注册",
  "Get Google One",     // 获取 Google One
  "获取 Google One",
  "加入 Google One",
  "Get Basic",          // 获取基础套餐按钮
  "获取 Basic",
  "Get Premium",        // 获取高级套餐按钮
  "获取 Premium",
  "Get Google AI Pro",  // 获取 AI Pro 按钮
  "Choose a plan",      // 选择方案页面
  "选择方案",
  "Pick a plan",
  "Choose your plan",
  "You can create a Family Group",  // 家庭组创建提示（非会员）
  "可以创建家庭群组",
  "Get more out of Google",  // 非会员页面底部推广语
  "With a Google One membership",  // 非会员页面推广语
];

/**
 * Pro 会员标识 - 明确表示用户已订阅的关键词 — batch_account_processor.py:1277-1297
 * 注意：只使用已订阅用户页面上才会出现的标识
 */
export const PRO_INDICATORS_BATCH = [
  "Manage membership",  // 管理会员（只有订阅者才有）
  "管理会员",
  "管理成员资格",
  "Cancel membership",  // 取消会员（只有订阅者才有）
  "取消会员",
  "取消成员资格",
  "Change membership plan",  // 更改会员计划
  "更改成员资格方案",
  "Your membership",    // 您的会员资格
  "您的成员资格",
  "您的会员",
  "Member since",       // 会员起始日期
  "成为会员的时间",
  "Next payment",       // 下次付款
  "下次付款",
  "Renews on",          // 续订时间
  "续订日期",
  "您当前的方案",       // 表示已订阅某个方案
  "Your current plan",  // 英文版
];

/** 家庭成员卡片/头像选择器 — batch_account_processor.py:1352-1360 */
export const FAMILY_MEMBER_SELECTORS = [
  "[data-member-email]",  // 成员邮箱属性
  "[role='listitem']",  // 列表项
  ".family-member",  // 家庭成员 class
  "[data-member]",  // 成员数据属性
  "div[data-email]",  // 带邮箱的 div
  "img[alt*='profile']",  // 用户头像
  "[class*='member']",  // 包含 member 的 class
];

/** 中文模式: "X 位成员" / "X位家庭成员" — batch_account_processor.py:1379-1385 */
export const CN_MEMBER_COUNT_PATTERNS = [
  String.raw`(\d)\s*位\s*(?:家庭)?成员`,
  String.raw`家庭群组\s*\((\d)\)`,
  String.raw`(\d)\s*人`,
  String.raw`(\d)\s*位\s*家庭群组成员`,
  String.raw`家庭成员\s*[:：]?\s*(\d)`,
];

/** 英文模式: "X members" / "X family members" — batch_account_processor.py:1388-1393 */
export const EN_MEMBER_COUNT_PATTERNS = [
  String.raw`(\d)\s*(?:family\s+)?members?`,
  String.raw`Family\s+group\s*\((\d)\)`,
  String.raw`(\d)\s+people`,
  String.raw`Family\s+members?\s*[:：]?\s*(\d)`,
];

/** 邮箱正则 — batch_account_processor.py:1405 */
export const EMAIL_PATTERN = String.raw`[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}`;

// ==================== 实现 ====================

/**
 * 使用 CDP 检测 Pro 会员状态
 * 对标 _check_pro_status_via_cdp (L1008-1080)
 *
 * @returns "pro" = Pro 会员（需进一步检测家庭组状态）
 *          "no" = 非 Pro 会员
 *          null = 检测失败
 */
export async function checkProStatusViaCdp(
  page: ProDetectPage,
  email: string,
  log: LogFn = noopLog,
  deps: ProDetectDeps = {},
): Promise<string | null> {
  const createCdpService = deps.createCdpService;

  // 检查 CDP 服务是否可用
  if (!createCdpService) {
    log(`[${email}] CDP 服务不可用`);
    return null;
  }

  try {
    const cdpService = await createCdpService(page);

    try {
      // 获取可访问性树中的所有元素
      const axElements = await cdpService.getInteractiveElementsViaAx();
      log(`[${email}] CDP 发现 ${axElements.length} 个可交互元素`);

      // ========== 第一步：先遍历所有元素检查非会员标识 ==========
      // 重要：必须先完成非会员检测，因为非会员页面也可能显示 "Premium" 等推广内容
      for (const elem of axElements) {
        const elemName = (elem["name"] || "").toString().toLowerCase();

        for (const keyword of CDP_NON_PRO_KEYWORDS) {
          if (elemName.includes(keyword)) {
            log(`[${email}] CDP 检测到非会员标识: ${keyword} (元素: ${String(elem["name"] ?? "").slice(0, 50)})`);
            return "no";
          }
        }
      }

      // ========== 第二步：再遍历所有元素检查 Pro 会员标识 ==========
      for (const elem of axElements) {
        const elemName = (elem["name"] || "").toString().toLowerCase();

        for (const keyword of CDP_PRO_KEYWORDS) {
          if (elemName.includes(keyword)) {
            log(`[${email}] CDP 检测到 Pro 标识: ${keyword} (元素: ${String(elem["name"] ?? "").slice(0, 50)})`);
            return "pro";
          }
        }
      }

      return null; // 无法确定
    } finally {
      await cdpService.close();
    }
  } catch (e) {
    log(`[${email}] CDP 检测异常: ${e}`);
    return null;
  }
}

/**
 * 检测家庭组状态（CDP 优先，Playwright 兜底）
 * 对标 _check_family_status (L1081-1193)
 *
 * @returns "yes" = 普通 Pro 会员（管理员/独立订阅）
 *          "family_yes" = 家庭组 Pro 会员（被邀请）
 */
export async function checkFamilyStatus(
  page: ProDetectPage,
  email: string,
  log: LogFn = noopLog,
  deps: ProDetectDeps = {},
): Promise<string> {
  try {
    log(`[${email}] 检测家庭组状态...`);

    // 导航到家庭组页面
    await page.goto(GoogleURLs.FAMILY_ACCOUNT, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);

    // ========== CDP 优先检测 ==========
    if (deps.createCdpService) {
      try {
        const cdpService = await deps.createCdpService(page);

        try {
          const axElements = await cdpService.getInteractiveElementsViaAx();

          // ========== 第一步：先遍历所有元素检查成员标识 ==========
          // 优先检测成员标识，因为成员身份比管理员更明确
          for (const elem of axElements) {
            const elemName = (elem["name"] || "").toString().toLowerCase();
            for (const keyword of CDP_FAMILY_MEMBER_KEYWORDS) {
              if (elemName.includes(keyword)) {
                log(`[${email}] CDP 检测到家庭组成员标识: ${keyword}`);
                return "family_yes";
              }
            }
          }

          // ========== 第二步：再遍历所有元素检查管理员标识 ==========
          for (const elem of axElements) {
            const elemName = (elem["name"] || "").toString().toLowerCase();
            for (const keyword of CDP_FAMILY_MANAGER_KEYWORDS) {
              if (elemName.includes(keyword)) {
                log(`[${email}] CDP 检测到管理员标识: ${keyword}`);
                // 检测家庭成员数量
                const memberCount = await getFamilyMemberCount(page, email, log);
                if (memberCount > 0) {
                  deps.accountRepo?.updateFamilyMemberCount(email, memberCount);
                }
                return "yes";
              }
            }
          }
        } finally {
          await cdpService.close();
        }
      } catch (e) {
        log(`[${email}] CDP 家庭组检测异常: ${e}，回退到 Playwright...`);
      }
    }

    // ========== Playwright 兜底 ==========
    const familyPageText = await page.innerText("body");
    const familyPageTextLower = familyPageText.toLowerCase();

    for (const indicator of FAMILY_MEMBER_INDICATORS_BATCH) {
      if (familyPageTextLower.includes(indicator.toLowerCase())) {
        log(`[${email}] 检测到家庭组成员标识: ${indicator}`);
        return "family_yes";
      }
    }

    for (const indicator of FAMILY_MANAGER_INDICATORS_BATCH) {
      if (familyPageTextLower.includes(indicator.toLowerCase())) {
        log(`[${email}] 检测到普通 Pro 标识: ${indicator}`);
        // 检测家庭成员数量
        const memberCount = await getFamilyMemberCount(page, email, log);
        if (memberCount > 0) {
          deps.accountRepo?.updateFamilyMemberCount(email, memberCount);
        }
        return "yes";
      }
    }

    // 默认为普通 Pro
    log(`[${email}] 未检测到明确的家庭组状态，默认为普通 Pro`);
    const memberCount = await getFamilyMemberCount(page, email, log);
    if (memberCount > 0) {
      deps.accountRepo?.updateFamilyMemberCount(email, memberCount);
    }
    return "yes";
  } catch (e) {
    log(`[${email}] 家庭组状态检测失败: ${e}，默认为普通 Pro`);
    return "yes";
  }
}

/**
 * 检测 Google One Pro 会员状态（CDP 优先，Playwright 文本分析兜底）
 * 对标 _check_google_one_pro_status (L1194-1327)
 *
 * @returns "yes" = 普通 Pro 会员（自己订阅）
 *          "family_yes" = 家庭组 Pro 会员（被邀请）
 *          "no" = 非 Pro 会员
 *          null = 检测失败
 */
export async function checkGoogleOneProStatus(
  page: ProDetectPage,
  email: string,
  log: LogFn = noopLog,
  deps: ProDetectDeps = {},
): Promise<string | null> {
  try {
    log(`[${email}] 正在检测 Google One 会员状态...`);

    // 导航到 Google One 页面
    await page.goto(GoogleURLs.GOOGLE_ONE, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);

    // ========== 阶段1: CDP 优先检测 ==========
    if (deps.createCdpService) {
      log(`[${email}] 阶段1: 使用 CDP 检测 Pro 状态...`);
      const cdpResult = await checkProStatusViaCdp(page, email, log, deps);
      if (cdpResult !== null) {
        log(`[${email}] CDP 检测成功: ${cdpResult}`);
        // CDP 检测到 Pro/非Pro，继续检测家庭组状态
        if (cdpResult === "pro") {
          // 检测是普通 Pro 还是家庭组 Pro
          return await checkFamilyStatus(page, email, log, deps);
        } else if (cdpResult === "no") {
          return "no";
        }
      } else {
        log(`[${email}] CDP 检测无结果，回退到 Playwright 文本分析...`);
      }
    }

    // ========== 阶段2: Playwright 文本分析兜底 ==========
    log(`[${email}] 阶段2: 使用 Playwright 文本分析...`);

    // 检查页面内容
    const pageText = await page.innerText("body");

    // ========== 重要修复：改变检测顺序，先检测非会员标识 ==========
    // 原因：非会员页面也会显示 "Premium plan" 等作为套餐推广/选项
    // 因此需要先排除非会员情况，再检测 Pro 会员标识
    const pageTextLower = pageText.toLowerCase();

    // 第一步：先检查是否有明确的非会员标识
    for (const indicator of NON_PRO_INDICATORS_BATCH) {
      if (pageTextLower.includes(indicator.toLowerCase())) {
        log(`[${email}] 检测到非会员标识: ${indicator}`);
        return "no";
      }
    }

    // 第二步：检查是否有 Pro 会员标识
    let isPro = false;
    for (const indicator of PRO_INDICATORS_BATCH) {
      if (pageTextLower.includes(indicator.toLowerCase())) {
        log(`[${email}] 检测到 Pro 标识: ${indicator}`);
        isPro = true;
        break;
      }
    }

    // 如果没检测到任何明确标识，返回 None（无法确定）
    if (!isPro) {
      log(`[${email}] 未检测到明确的会员/非会员标识`);
      return null;
    }

    // 是 Pro 会员，调用统一的家庭组状态检测方法
    log(`[${email}] 检测到 Pro 会员，正在检测家庭组状态...`);
    return await checkFamilyStatus(page, email, log, deps);
  } catch (e) {
    log(`[${email}] [!] 检测 Pro 状态失败: ${e}`);
    return null;
  }
}

/**
 * 获取家庭组成员数量
 * 对标 _get_family_member_count (L1328-1424)
 *
 * @param page 页面对象（应已在家庭组页面）
 * @returns 家庭成员数量 (1-6)，0 表示检测失败
 */
export async function getFamilyMemberCount(
  page: ProDetectPage,
  email: string,
  log: LogFn = noopLog,
): Promise<number> {
  try {
    log(`[${email}] 正在检测家庭成员数量...`);

    // 当前页面应该是 https://myaccount.google.com/family
    // 如果不是，先导航
    const currentUrl = page.url();
    if (!currentUrl.includes("myaccount.google.com/family") && !currentUrl.includes("families.google.com")) {
      // Python: GoogleURLs.FAMILY_ACCOUNT if GoogleURLs else "https://families.google.com/families"
      // Node 侧常量表恒可用，故直接取 FAMILY_ACCOUNT
      const familyUrl = GoogleURLs.FAMILY_ACCOUNT;
      await page.goto(familyUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
      await page.waitForTimeout(2000);
    }

    // 方法 1: 通过计数页面上的成员头像/卡片
    // 家庭成员通常显示为卡片或头像列表
    for (const selector of FAMILY_MEMBER_SELECTORS) {
      try {
        const members = await page.querySelectorAll(selector);
        if (members && members.length > 0) {
          const count = members.length;
          log(`[${email}] 通过选择器 '${selector}' 检测到 ${count} 个成员`);
          if (count >= 1 && count <= 6) {
            return count;
          }
        }
      } catch {
        continue;
      }
    }

    // 方法 2: 从页面文本中提取数字
    // 例如: "3 位家庭成员" / "3 family members"
    const pageText = await page.innerText("body");

    const allPatterns = [...CN_MEMBER_COUNT_PATTERNS, ...EN_MEMBER_COUNT_PATTERNS];
    for (const pattern of allPatterns) {
      const match = new RegExp(pattern, "i").exec(pageText);
      if (match) {
        const count = parseInt(match[1] ?? "", 10);
        log(`[${email}] 通过正则匹配检测到 ${count} 个成员 (模式: ${pattern})`);
        if (count >= 1 && count <= 6) {
          return count;
        }
      }
    }

    // 方法 3: 计算页面中邮箱地址的数量（通常每个成员都有邮箱显示）
    const emailsFound = pageText.match(new RegExp(EMAIL_PATTERN, "g")) ?? [];
    const uniqueEmails = new Set(emailsFound);
    // 过滤掉明显不是用户邮箱的（如支持邮箱等）
    const userEmails = [...uniqueEmails].filter(
      (e) => !e.toLowerCase().includes("support") && !e.toLowerCase().includes("help"),
    );
    if (userEmails.length >= 1 && userEmails.length <= 6) {
      log(`[${email}] 通过邮箱计数检测到 ${userEmails.length} 个成员`);
      return userEmails.length;
    }

    // 方法 4: 输出页面文本用于调试（仅前500字符）
    log(`[${email}] 页面文本前500字: ${pageText.slice(0, 500).replace(/\n/g, " ")}`);

    // 方法 5: 默认返回 1（至少有管理员自己）
    log(`[${email}] 无法精确检测成员数量，默认为 1（管理员自己）`);
    return 1;
  } catch (e) {
    log(`[${email}] [!] 获取家庭成员数量失败: ${e}`);
    return 0;
  }
}
