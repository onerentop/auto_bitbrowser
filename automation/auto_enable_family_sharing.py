"""
自动开启家庭组共享

为普通 Pro 账户开启家庭组共享功能：
1. 导航到 Google One 设置页面
2. 展开 "Manage family settings"
3. 开启 "Share Google One with family" 开关
4. 更新数据库状态

采用 CDP 优先策略：Playwright -> CDP -> AI Agent
"""

import asyncio
from typing import Callable, Optional
from dataclasses import dataclass

from playwright.async_api import async_playwright, Page

from core.config_manager import ConfigManager
from services.database import DBManager
from services.ix_api import openBrowser, closeBrowser

# 尝试导入 AI Browser Agent 模块
try:
    from core.ai_browser_agent import AIBrowserAgent
    AI_BROWSER_AGENT_AVAILABLE = True
except ImportError:
    AI_BROWSER_AGENT_AVAILABLE = False
    AIBrowserAgent = None


@dataclass
class EnableFamilySharingResult:
    """开启家庭共享结果"""
    success: bool
    message: str
    email: str
    was_already_enabled: bool = False
    family_created: bool = False  # 是否创建了新的家庭组
    error_type: Optional[str] = None


# ==================== 提示词模板 ====================

CREATE_FAMILY_PROMPT = """
你是一个专业的浏览器自动化助手，需要在 Google One 设置页面创建家庭组。

## 当前状态
- 账号: {email}
- 目标: 创建家庭组 (Create a family group)

## 任务目标
在 Google One 设置页面，找到并点击创建家庭组功能，完成家庭组创建流程。

## 操作步骤

### 1. 检查当前页面
- 当前应该在 https://one.google.com/settings 或类似的设置页面
- 如果不是，请导航到该页面

### 2. 处理可能的弹窗遮挡
- 如果出现弹窗或遮罩层，按 Escape 键关闭
- 如果有账号选择器弹窗，关闭它

### 3. 找到 "Create a family group" 或 "Start a family group" 入口
- 在页面中找到家庭组创建入口
- 可能的按钮文本: "Create a family group", "Start a family group", "Get started", "创建家庭群组", "开始使用"
- 点击该按钮进入创建流程

### 4. 完成创建流程
- 在创建流程中点击 "Create" / "Continue" / "Next" / "创建" / "继续" 等按钮
- 可能需要确认条款，勾选同意复选框
- 完成所有步骤直到家庭组创建成功

### 5. 确认创建成功
- 创建成功后，页面应该显示 "Manage family settings" 或类似管理选项
- 如果看到管理选项，任务完成，报告 DONE

## 多语言关键词

**创建家庭组按钮:**
- "Create a family group" / "Start a family group" / "Get started"
- "创建家庭群组" / "开始使用家庭群组" / "创建家庭组"
- "ファミリーグループを作成" / "가족 그룹 만들기"

**确认/继续按钮:**
- "Create" / "Continue" / "Next" / "Done" / "Confirm"
- "创建" / "继续" / "下一步" / "完成" / "确认"

**成功标志:**
- "Manage family settings" / "管理家庭设置"
- "Family group created" / "家庭群组已创建"
- "You're the family manager" / "您是家庭管理员"

## 成功标准
- 页面显示 "Manage family settings" 或家庭管理选项
- 表明家庭组已创建

## 错误情况
- 如果账户不是 Pro 会员，可能无法创建家庭组
- 如果账户已加入其他家庭组，无法创建新的
- 如果创建过程中出现错误，报告 ERROR
"""

ENABLE_SHARING_PROMPT = """
你是一个专业的浏览器自动化助手，需要在 Google One 设置页面开启家庭共享功能。

## 当前状态
- 账号: {email}
- 目标: 开启 "Share Google One with family" 开关

## 任务目标
在 Google One 设置页面，找到并开启家庭共享开关。

## 操作步骤

### 1. 检查当前页面
- 当前应该在 https://one.google.com/settings 或类似的设置页面
- 如果不是，请导航到该页面

### 2. 处理可能的弹窗遮挡
- 如果出现弹窗或遮罩层，按 Escape 键关闭
- 如果有账号选择器弹窗，关闭它

### 3. 找到并展开 "Manage family settings"
- 在页面中找到 "Manage family settings" 选项
- 如果是折叠状态，点击展开

### 4. 找到 "Share Google One with family" 开关
- 展开后应该能看到 "Share Google One with family" 选项
- 旁边有一个 Toggle 开关

### 5. 检查开关状态
- 如果开关已经是开启状态（蓝色/右侧），任务已完成，报告 DONE
- 如果开关是关闭状态（灰色/左侧），点击开启

### 6. 处理确认弹窗（如果有）
- 开启后可能出现确认弹窗
- 点击 "Continue" / "Got it" / "确认" 等按钮

### 7. 确认开关已开启
- 确保开关变为开启状态
- 如果成功，报告 DONE

## 多语言关键词

**Manage family settings:**
- "Manage family settings" / "管理家庭设置" / "ファミリー設定を管理"

**Share toggle:**
- "Share Google One with family" / "与家庭成员共享 Google One"
- Toggle 开关通常是 role="switch" 或 input[type="checkbox"]

**确认按钮:**
- "Continue" / "Got it" / "Confirm" / "继续" / "确认" / "知道了"

## 成功标准
- 开关变为开启状态（蓝色）
- 或确认弹窗点击后开关开启

## 错误情况
- 如果找不到 "Manage family settings"，可能账户不是 Pro 会员
- 如果开关无法点击，报告 ERROR
"""


async def auto_enable_family_sharing(
    account: dict,
    browser_id: str,
    callback: Callable[[str], None] = None,
    api_key: str = None,
    model: str = None,
    provider: str = None,
    max_steps: int = None,
    close_browser_on_success: bool = False,
) -> EnableFamilySharingResult:
    """
    为账户开启家庭组共享功能

    Args:
        account: 账号信息 {email, password, secret_key, browser_profile_id}
        browser_id: 浏览器窗口 ID
        callback: 进度回调函数
        api_key: AI API Key（可选）
        model: AI 模型名称（可选）
        provider: AI 提供商（可选）
        max_steps: 最大步骤数（可选）
        close_browser_on_success: 成功后是否关闭浏览器窗口

    Returns:
        EnableFamilySharingResult: 开启结果
    """
    email = account.get("email", "")

    def log(msg: str):
        """日志输出"""
        print(f"[EnableSharing] {msg}")
        if callback:
            callback(msg)

    log(f"开始为 {email} 开启家庭共享...")

    # 获取 AI 配置
    if not provider:
        provider = ConfigManager.get_ai_default_provider()
    if not api_key:
        api_key = ConfigManager.get_ai_provider_api_key(provider)
    if not model:
        model = ConfigManager.get_ai_provider_model(provider)
    if not max_steps:
        max_steps = 15  # 开启共享流程相对简单

    base_url = ConfigManager.get_ai_provider_base_url(provider)

    try:
        # 打开浏览器
        result = openBrowser(browser_id)
        if not result.get("success"):
            return EnableFamilySharingResult(
                success=False,
                message=result.get("msg", "打开浏览器失败"),
                email=email,
                error_type="browser_error",
            )

        ws_endpoint = result.get("data", {}).get("ws", "")
        if not ws_endpoint:
            return EnableFamilySharingResult(
                success=False,
                message="无法获取浏览器 WebSocket 连接",
                email=email,
                error_type="browser_error",
            )

        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(ws_endpoint)
            contexts = browser.contexts
            if not contexts:
                return EnableFamilySharingResult(
                    success=False,
                    message="没有浏览器上下文",
                    email=email,
                    error_type="browser_error",
                )

            context = contexts[0]
            pages = context.pages
            page = pages[0] if pages else await context.new_page()

            # 导航到 Google One 设置页面
            log(f"[{email}] 导航到 Google One 设置页面...")
            try:
                await page.goto("https://one.google.com/settings", wait_until="domcontentloaded", timeout=30000)
                await page.wait_for_timeout(2000)
            except Exception as e:
                log(f"[{email}] 导航超时: {e}")

            # ========== 新增：检测家庭组状态 ==========
            family_status = await _detect_family_group_status(page, email, log)
            family_created = False

            if family_status == "no_family":
                log(f"[{email}] 账户尚未创建家庭组，开始创建...")
                create_result = await _create_family_group(
                    page=page,
                    email=email,
                    log=log,
                    account=account,
                    api_key=api_key,
                    base_url=base_url,
                    model=model,
                    provider=provider,
                    max_steps=10,
                )

                if create_result.get("success"):
                    family_created = True
                    log(f"[{email}] 家庭组创建成功，继续开启共享...")
                    # 更新数据库家庭成员数量（创建者算1人）
                    DBManager.update_family_member_count(email, 1)
                    # 刷新页面以确保状态更新
                    try:
                        await page.reload(wait_until="domcontentloaded", timeout=15000)
                        await page.wait_for_timeout(2000)
                    except Exception as e:
                        log(f"[{email}] 页面刷新超时: {e}，继续执行...")
                else:
                    error_msg = create_result.get("message", "创建家庭组失败")
                    log(f"[{email}] 创建家庭组失败: {error_msg}")
                    return EnableFamilySharingResult(
                        success=False,
                        message=f"创建家庭组失败: {error_msg}",
                        email=email,
                        error_type="create_family_failed",
                    )
            elif family_status == "has_family":
                log(f"[{email}] 账户已有家庭组，直接开启共享...")
            else:
                log(f"[{email}] 无法确定家庭组状态，尝试开启共享...")

            # ========== 阶段1: 使用纯 Playwright 尝试 ==========
            log(f"[{email}] 阶段1: 使用 Playwright 直接操作...")
            playwright_result = await _try_playwright_enable(page, email, log)

            if playwright_result.get("success"):
                was_already = playwright_result.get("was_already_enabled", False)
                DBManager.update_family_sharing_enabled(email, "yes")

                if close_browser_on_success:
                    try:
                        closeBrowser(browser_id)
                    except Exception:
                        pass

                return EnableFamilySharingResult(
                    success=True,
                    message="已开启" if was_already else ("成功创建家庭组并开启共享" if family_created else "成功开启家庭共享"),
                    email=email,
                    was_already_enabled=was_already,
                    family_created=family_created,
                )

            # ========== 阶段2: 使用 CDP 精确点击 ==========
            log(f"[{email}] 阶段2: 使用 CDP 精确操作...")
            cdp_result = await _try_cdp_enable(page, email, log)

            if cdp_result.get("success"):
                was_already = cdp_result.get("was_already_enabled", False)
                DBManager.update_family_sharing_enabled(email, "yes")

                if close_browser_on_success:
                    try:
                        closeBrowser(browser_id)
                    except Exception:
                        pass

                return EnableFamilySharingResult(
                    success=True,
                    message="已开启 (CDP)" if was_already else ("成功创建家庭组并开启共享 (CDP)" if family_created else "成功开启家庭共享 (CDP)"),
                    email=email,
                    was_already_enabled=was_already,
                    family_created=family_created,
                )

            # ========== 阶段3: 使用 AI Agent 保底 ==========
            if AI_BROWSER_AGENT_AVAILABLE:
                log(f"[{email}] 阶段3: 使用 AI Agent 保底...")

                agent = AIBrowserAgent(
                    api_key=api_key,
                    base_url=base_url,
                    model=model,
                    provider=provider,
                )
                agent.on_step(lambda step, action: log(f"[{email}][Agent] 步骤{step}: {action}"))

                agent_account = {
                    "email": email,
                    "password": account.get("password", ""),
                    "secret": account.get("secret_key", ""),
                    "recovery_email": account.get("recovery_email", ""),
                }

                prompt = ENABLE_SHARING_PROMPT.format(email=email)

                task_result = await agent.execute_task(
                    page=page,
                    goal=prompt,
                    start_url="https://one.google.com/settings",
                    account=agent_account,
                    max_steps=max_steps,
                    navigate_first=False,
                )

                if task_result.success:
                    DBManager.update_family_sharing_enabled(email, "yes")

                    if close_browser_on_success:
                        try:
                            closeBrowser(browser_id)
                        except Exception:
                            pass

                    return EnableFamilySharingResult(
                        success=True,
                        message="成功创建家庭组并开启共享 (AI Agent)" if family_created else "成功开启家庭共享 (AI Agent)",
                        email=email,
                        family_created=family_created,
                    )
                else:
                    return EnableFamilySharingResult(
                        success=False,
                        message=task_result.message or "AI Agent 操作失败",
                        email=email,
                        error_type="agent_failed",
                    )
            else:
                return EnableFamilySharingResult(
                    success=False,
                    message="Playwright 和 CDP 操作均失败，AI Agent 不可用",
                    email=email,
                    error_type="all_methods_failed",
                )

    except Exception as e:
        error_msg = str(e)
        log(f"[{email}] 异常: {error_msg}")
        return EnableFamilySharingResult(
            success=False,
            message=f"开启家庭共享异常: {error_msg}",
            email=email,
            error_type="exception",
        )


async def _try_playwright_enable(page: Page, email: str, log: Callable) -> dict:
    """
    使用 Playwright 尝试开启家庭共享

    Returns:
        dict: {success: bool, was_already_enabled: bool}
    """
    try:
        # 关闭可能的弹窗
        for _ in range(3):
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(200)

        # 移除遮罩层
        await page.evaluate("""
            () => {
                document.querySelectorAll('trans-layer').forEach(t => t.remove());
                document.querySelectorAll('.KL4X6e').forEach(d => d.remove());
                document.querySelectorAll('[role="dialog"]').forEach(d => {
                    if (d.querySelector('iframe')) d.remove();
                });
            }
        """)
        await page.wait_for_timeout(500)

        # ===== 步骤1: 找到并展开 "Manage family settings" =====
        log(f"[{email}] 查找 Manage family settings...")

        expand_clicked = False
        expand_keywords = [
            "Manage family settings",
            "管理家庭设置",
            "ファミリー設定を管理",
            "가족 설정 관리",
        ]

        for keyword in expand_keywords:
            try:
                # 尝试多种选择器
                selectors = [
                    f'text="{keyword}"',
                    f'[aria-label*="{keyword}" i]',
                    f'button:has-text("{keyword}")',
                    f'div:has-text("{keyword}")',
                ]

                for sel in selectors:
                    try:
                        elem = page.locator(sel).first
                        if await elem.is_visible(timeout=1500):
                            await elem.click()
                            log(f"[{email}] 点击了: {keyword}")
                            expand_clicked = True
                            await page.wait_for_timeout(1000)
                            break
                    except Exception:
                        continue

                if expand_clicked:
                    break
            except Exception:
                continue

        if not expand_clicked:
            log(f"[{email}] 未找到 Manage family settings，可能已展开或不存在")

        # ===== 步骤2: 查找 Share 开关 =====
        log(f"[{email}] 查找 Share 开关...")
        await page.wait_for_timeout(1000)

        # 检查开关状态
        toggle_selectors = [
            '[role="switch"]',
            'input[type="checkbox"]',
            '.mdc-switch',
            '[aria-label*="Share" i]',
            '[aria-label*="family" i][role="switch"]',
        ]

        share_toggle = None
        for sel in toggle_selectors:
            try:
                elem = page.locator(sel).first
                if await elem.is_visible(timeout=1500):
                    share_toggle = elem
                    log(f"[{email}] 找到开关: {sel}")
                    break
            except Exception:
                continue

        if not share_toggle:
            log(f"[{email}] 未找到开关元素")
            return {"success": False}

        # 检查是否已开启
        try:
            is_checked = await share_toggle.is_checked()
        except Exception:
            try:
                aria_checked = await share_toggle.get_attribute("aria-checked")
                is_checked = aria_checked == "true"
            except Exception:
                is_checked = False

        if is_checked:
            log(f"[{email}] ✅ 开关已经是开启状态")
            return {"success": True, "was_already_enabled": True}

        # ===== 步骤3: 点击开关开启 =====
        log(f"[{email}] 点击开关开启...")
        try:
            await share_toggle.click(force=True)
            await page.wait_for_timeout(2000)
        except Exception as e:
            log(f"[{email}] 点击开关失败: {e}")
            return {"success": False}

        # ===== 步骤4: 处理可能的确认弹窗 =====
        confirm_keywords = [
            "Continue", "Got it", "Confirm", "OK",
            "继续", "确认", "知道了", "好的",
        ]

        for keyword in confirm_keywords:
            try:
                btn = page.locator(f'button:has-text("{keyword}")').first
                if await btn.is_visible(timeout=1000):
                    await btn.click()
                    log(f"[{email}] 点击确认按钮: {keyword}")
                    await page.wait_for_timeout(1500)
                    break
            except Exception:
                continue

        # ===== 步骤5: 验证开关状态 =====
        await page.wait_for_timeout(1000)
        try:
            is_now_checked = await share_toggle.is_checked()
        except Exception:
            try:
                aria_checked = await share_toggle.get_attribute("aria-checked")
                is_now_checked = aria_checked == "true"
            except Exception:
                is_now_checked = False

        if is_now_checked:
            log(f"[{email}] ✅ 成功开启家庭共享")
            return {"success": True, "was_already_enabled": False}
        else:
            log(f"[{email}] 开关状态未改变")
            return {"success": False}

    except Exception as e:
        log(f"[{email}] Playwright 操作异常: {e}")
        return {"success": False}


async def _try_cdp_enable(page: Page, email: str, log: Callable) -> dict:
    """
    使用 CDP 尝试开启家庭共享

    Returns:
        dict: {success: bool, was_already_enabled: bool}
    """
    try:
        from core.ai_browser_agent import create_cdp_service, CDP_SERVICE_AVAILABLE

        if not CDP_SERVICE_AVAILABLE:
            log(f"[{email}] CDP 服务不可用")
            return {"success": False}

        cdp_service = await create_cdp_service(page)

        try:
            # 获取可访问性树
            ax_elements = await cdp_service.get_interactive_elements_via_ax()
            log(f"[{email}] CDP 发现 {len(ax_elements)} 个可交互元素")

            # 查找 Manage family settings 或 Share 相关元素
            target_backend_id = None
            is_toggle = False
            current_checked = False

            for elem in ax_elements:
                elem_name = (elem.get("name") or "").lower()
                elem_role = (elem.get("role") or "").lower()
                elem_checked = elem.get("checked", False)

                # 查找 switch/toggle 元素
                if elem_role in ("switch", "checkbox"):
                    if "share" in elem_name or "family" in elem_name:
                        target_backend_id = elem.get("backend_node_id")
                        is_toggle = True
                        current_checked = elem_checked
                        log(f"[{email}] CDP 找到开关: {elem.get('name')} (checked={current_checked})")
                        break

                # 查找 Manage family settings 按钮
                if "manage family" in elem_name and elem_role == "button":
                    target_backend_id = elem.get("backend_node_id")
                    log(f"[{email}] CDP 找到展开按钮: {elem.get('name')}")
                    break

            if not target_backend_id:
                log(f"[{email}] CDP 未找到目标元素")
                return {"success": False}

            # 如果是开关且已开启
            if is_toggle and current_checked:
                log(f"[{email}] ✅ CDP 检测到开关已开启")
                return {"success": True, "was_already_enabled": True}

            # 点击元素
            success, msg = await cdp_service.click_by_backend_node_id(target_backend_id)
            if not success:
                log(f"[{email}] CDP 点击失败: {msg}")
                return {"success": False}

            log(f"[{email}] CDP 点击成功")
            await page.wait_for_timeout(1500)

            # 如果点击的是展开按钮，需要再找开关
            if not is_toggle:
                # 重新获取可访问性树
                ax_elements = await cdp_service.get_interactive_elements_via_ax()

                for elem in ax_elements:
                    elem_name = (elem.get("name") or "").lower()
                    elem_role = (elem.get("role") or "").lower()
                    elem_checked = elem.get("checked", False)

                    if elem_role in ("switch", "checkbox"):
                        if "share" in elem_name or "family" in elem_name:
                            if elem_checked:
                                log(f"[{email}] ✅ CDP 展开后检测到开关已开启")
                                return {"success": True, "was_already_enabled": True}

                            target_backend_id = elem.get("backend_node_id")
                            success, msg = await cdp_service.click_by_backend_node_id(target_backend_id)
                            if success:
                                log(f"[{email}] ✅ CDP 成功点击开关")
                                await page.wait_for_timeout(2000)

                                # 处理确认弹窗
                                ax_elements2 = await cdp_service.get_interactive_elements_via_ax()
                                for elem2 in ax_elements2:
                                    elem2_name = (elem2.get("name") or "").lower()
                                    elem2_role = (elem2.get("role") or "").lower()
                                    if elem2_role == "button":
                                        if any(kw in elem2_name for kw in ["continue", "got it", "confirm", "ok", "继续", "确认"]):
                                            confirm_id = elem2.get("backend_node_id")
                                            await cdp_service.click_by_backend_node_id(confirm_id)
                                            log(f"[{email}] CDP 点击确认按钮")
                                            await page.wait_for_timeout(1000)
                                            break

                                return {"success": True, "was_already_enabled": False}
                            break

            else:
                # 直接点击的就是开关
                await page.wait_for_timeout(1500)

                # 处理确认弹窗
                ax_elements2 = await cdp_service.get_interactive_elements_via_ax()
                for elem2 in ax_elements2:
                    elem2_name = (elem2.get("name") or "").lower()
                    elem2_role = (elem2.get("role") or "").lower()
                    if elem2_role == "button":
                        if any(kw in elem2_name for kw in ["continue", "got it", "confirm", "ok", "继续", "确认"]):
                            confirm_id = elem2.get("backend_node_id")
                            await cdp_service.click_by_backend_node_id(confirm_id)
                            log(f"[{email}] CDP 点击确认按钮")
                            await page.wait_for_timeout(1000)
                            break

                return {"success": True, "was_already_enabled": False}

            return {"success": False}

        finally:
            await cdp_service.close()

    except ImportError:
        log(f"[{email}] CDP 模块导入失败")
        return {"success": False}
    except Exception as e:
        log(f"[{email}] CDP 操作异常: {e}")
        return {"success": False}


async def _detect_family_group_status(page: Page, email: str, log: Callable) -> str:
    """
    检测账户是否已创建家庭组

    使用 CDP 优先，Playwright 兜底

    Args:
        page: Playwright Page 对象
        email: 账号邮箱
        log: 日志函数

    Returns:
        str: "has_family" = 已有家庭组
             "no_family" = 尚未创建家庭组
             "unknown" = 无法确定
    """
    log(f"[{email}] 检测家庭组状态...")

    try:
        # ========== CDP 检测 ==========
        try:
            from core.ai_browser_agent import create_cdp_service, CDP_SERVICE_AVAILABLE

            if CDP_SERVICE_AVAILABLE:
                cdp_service = await create_cdp_service(page)
                try:
                    ax_elements = await cdp_service.get_interactive_elements_via_ax()
                    log(f"[{email}] CDP 发现 {len(ax_elements)} 个可交互元素")

                    # 家庭组已存在标识
                    has_family_keywords = [
                        "manage family", "管理家庭", "family settings",
                        "share google one", "share with family", "与家庭成员共享",
                    ]

                    # 家庭组未创建标识
                    no_family_keywords = [
                        "create a family", "start a family", "get started",
                        "创建家庭", "开始使用", "create family group",
                    ]

                    for elem in ax_elements:
                        elem_name = (elem.get("name") or "").lower()

                        # 先检测未创建家庭组（避免页面上有推广内容干扰）
                        for keyword in no_family_keywords:
                            if keyword in elem_name:
                                log(f"[{email}] CDP 检测到尚未创建家庭组: {keyword}")
                                return "no_family"

                    # 再检测已有家庭组
                    for elem in ax_elements:
                        elem_name = (elem.get("name") or "").lower()

                        for keyword in has_family_keywords:
                            if keyword in elem_name:
                                log(f"[{email}] CDP 检测到家庭组已存在: {keyword}")
                                return "has_family"

                finally:
                    await cdp_service.close()

        except ImportError:
            log(f"[{email}] CDP 不可用，回退到 Playwright")
        except Exception as e:
            log(f"[{email}] CDP 检测异常: {e}，回退到 Playwright")

        # ========== Playwright 文本分析兜底 ==========
        page_text = await page.inner_text("body")
        page_text_lower = page_text.lower()

        # 家庭组已存在标识
        has_family_indicators = [
            "manage family settings", "管理家庭设置",
            "share google one with family", "与家庭成员共享 google one",
            "family manager", "家庭管理员",
        ]

        # 家庭组未创建标识
        no_family_indicators = [
            "create a family group", "start a family group", "get started",
            "创建家庭群组", "开始使用家庭群组",
            "you can create a family", "可以创建家庭",
        ]

        # 先检测未创建（避免页面上有推广内容干扰）
        for indicator in no_family_indicators:
            if indicator.lower() in page_text_lower:
                log(f"[{email}] Playwright 检测到尚未创建家庭组: {indicator}")
                return "no_family"

        # 再检测已存在
        for indicator in has_family_indicators:
            if indicator.lower() in page_text_lower:
                log(f"[{email}] Playwright 检测到家庭组已存在: {indicator}")
                return "has_family"

        log(f"[{email}] 无法确定家庭组状态")
        return "unknown"

    except Exception as e:
        log(f"[{email}] 检测家庭组状态异常: {e}")
        return "unknown"


async def _create_family_group(
    page: Page,
    email: str,
    log: Callable,
    account: dict = None,
    api_key: str = None,
    base_url: str = None,
    model: str = None,
    provider: str = None,
    max_steps: int = 10,
) -> dict:
    """
    创建家庭组

    采用三阶段策略: Playwright -> CDP -> AI Agent

    Args:
        page: Playwright Page 对象
        email: 账号邮箱
        log: 日志函数
        account: 账号信息（用于 AI Agent）
        api_key: AI API Key
        base_url: AI Base URL
        model: AI 模型
        provider: AI 提供商
        max_steps: AI Agent 最大步骤数

    Returns:
        dict: {"success": bool, "message": str}
    """
    log(f"[{email}] 开始创建家庭组...")

    try:
        # ========== 阶段1: Playwright 尝试 ==========
        log(f"[{email}] 阶段1: 使用 Playwright 创建家庭组...")

        # 关闭弹窗
        for _ in range(3):
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(200)

        # 查找并点击创建按钮
        create_keywords = [
            "Create a family group", "Start a family group", "Get started",
            "创建家庭群组", "开始使用", "创建家庭组",
        ]

        create_clicked = False
        for keyword in create_keywords:
            try:
                selectors = [
                    f'button:has-text("{keyword}")',
                    f'text="{keyword}"',
                    f'[aria-label*="{keyword}" i]',
                    f'a:has-text("{keyword}")',
                ]

                for sel in selectors:
                    try:
                        elem = page.locator(sel).first
                        if await elem.is_visible(timeout=1500):
                            await elem.click()
                            log(f"[{email}] Playwright 点击了: {keyword}")
                            create_clicked = True
                            await page.wait_for_timeout(2000)
                            break
                    except Exception:
                        continue

                if create_clicked:
                    break
            except Exception:
                continue

        if create_clicked:
            # 继续完成创建流程
            confirm_keywords = [
                "Create", "Continue", "Next", "Done", "Confirm",
                "创建", "继续", "下一步", "完成", "确认",
            ]

            for attempt in range(5):  # 最多点击5次确认按钮
                await page.wait_for_timeout(1000)
                clicked = False

                for keyword in confirm_keywords:
                    try:
                        btn = page.locator(f'button:has-text("{keyword}")').first
                        if await btn.is_visible(timeout=1000):
                            await btn.click()
                            log(f"[{email}] Playwright 点击确认: {keyword}")
                            clicked = True
                            await page.wait_for_timeout(1500)
                            break
                    except Exception:
                        continue

                if not clicked:
                    break

            # 验证是否创建成功
            await page.wait_for_timeout(2000)
            page_text = await page.inner_text("body")
            page_text_lower = page_text.lower()

            success_indicators = [
                "manage family settings", "管理家庭设置",
                "family manager", "家庭管理员",
                "share google one", "与家庭成员共享",
            ]

            for indicator in success_indicators:
                if indicator.lower() in page_text_lower:
                    log(f"[{email}] ✅ Playwright 成功创建家庭组")
                    return {"success": True, "message": "Playwright 创建成功"}

        # ========== 阶段2: CDP 尝试 ==========
        log(f"[{email}] 阶段2: 使用 CDP 创建家庭组...")

        try:
            from core.ai_browser_agent import create_cdp_service, CDP_SERVICE_AVAILABLE

            if CDP_SERVICE_AVAILABLE:
                cdp_service = await create_cdp_service(page)
                try:
                    ax_elements = await cdp_service.get_interactive_elements_via_ax()

                    # 查找创建按钮
                    create_keywords_lower = [
                        "create a family", "start a family", "get started",
                        "创建家庭", "开始使用",
                    ]

                    for elem in ax_elements:
                        elem_name = (elem.get("name") or "").lower()
                        elem_role = (elem.get("role") or "").lower()

                        # 扩展可点击元素类型：button, link, menuitem 等
                        if elem_role in ("button", "link", "menuitem", "listitem"):
                            for keyword in create_keywords_lower:
                                if keyword in elem_name:
                                    backend_id = elem.get("backend_node_id")
                                    success, msg = await cdp_service.click_by_backend_node_id(backend_id)
                                    if success:
                                        log(f"[{email}] CDP 点击创建按钮成功")
                                        await page.wait_for_timeout(2000)

                                        # 继续点击确认按钮
                                        for _ in range(5):
                                            ax_elements2 = await cdp_service.get_interactive_elements_via_ax()
                                            clicked = False

                                            for elem2 in ax_elements2:
                                                elem2_name = (elem2.get("name") or "").lower()
                                                elem2_role = (elem2.get("role") or "").lower()

                                                if elem2_role == "button":
                                                    confirm_kw = ["create", "continue", "next", "done", "confirm", "创建", "继续"]
                                                    if any(kw in elem2_name for kw in confirm_kw):
                                                        bid = elem2.get("backend_node_id")
                                                        await cdp_service.click_by_backend_node_id(bid)
                                                        log(f"[{email}] CDP 点击确认按钮")
                                                        clicked = True
                                                        await page.wait_for_timeout(1500)
                                                        break

                                            if not clicked:
                                                break

                                        # 验证成功
                                        ax_final = await cdp_service.get_interactive_elements_via_ax()
                                        for ef in ax_final:
                                            ef_name = (ef.get("name") or "").lower()
                                            # 更精确的成功标识
                                            if "manage family" in ef_name or "share google one" in ef_name or "与家庭成员共享" in ef_name:
                                                log(f"[{email}] ✅ CDP 成功创建家庭组")
                                                return {"success": True, "message": "CDP 创建成功"}
                                    break

                finally:
                    await cdp_service.close()

        except ImportError:
            log(f"[{email}] CDP 不可用")
        except Exception as e:
            log(f"[{email}] CDP 创建异常: {e}")

        # ========== 阶段3: AI Agent 保底 ==========
        if AI_BROWSER_AGENT_AVAILABLE and account:
            log(f"[{email}] 阶段3: 使用 AI Agent 创建家庭组...")

            agent = AIBrowserAgent(
                api_key=api_key,
                base_url=base_url,
                model=model,
                provider=provider,
            )
            agent.on_step(lambda step, action: log(f"[{email}][Agent] 步骤{step}: {action}"))

            agent_account = {
                "email": email,
                "password": account.get("password", ""),
                "secret": account.get("secret_key", ""),
                "recovery_email": account.get("recovery_email", ""),
            }

            prompt = CREATE_FAMILY_PROMPT.format(email=email)

            task_result = await agent.execute_task(
                page=page,
                goal=prompt,
                start_url="https://one.google.com/settings",
                account=agent_account,
                max_steps=max_steps,
                navigate_first=False,
            )

            if task_result.success:
                log(f"[{email}] ✅ AI Agent 成功创建家庭组")
                return {"success": True, "message": "AI Agent 创建成功"}
            else:
                log(f"[{email}] AI Agent 创建失败: {task_result.message}")
                return {"success": False, "message": task_result.message or "AI Agent 创建失败"}
        else:
            log(f"[{email}] AI Agent 不可用或缺少账号信息")
            return {"success": False, "message": "所有方法均失败"}

    except Exception as e:
        error_msg = str(e)
        log(f"[{email}] 创建家庭组异常: {error_msg}")
        return {"success": False, "message": error_msg}


async def batch_enable_family_sharing(
    accounts: list,
    browser_ids: list,
    callback: Callable[[str], None] = None,
    close_browser_on_success: bool = False,
) -> dict:
    """
    批量开启家庭共享

    Args:
        accounts: 账号列表
        browser_ids: 浏览器ID列表
        callback: 进度回调函数
        close_browser_on_success: 成功后是否关闭浏览器

    Returns:
        dict: {total, success_count, failed_count, already_enabled_count, results}
    """
    results = {
        "total": len(accounts),
        "success_count": 0,
        "failed_count": 0,
        "already_enabled_count": 0,
        "results": [],
    }

    def log(msg: str):
        print(f"[BatchEnableSharing] {msg}")
        if callback:
            callback(msg)

    for i, (account, browser_id) in enumerate(zip(accounts, browser_ids)):
        email = account.get("email", "")
        log(f"[{i+1}/{len(accounts)}] 处理: {email}")

        result = await auto_enable_family_sharing(
            account=account,
            browser_id=browser_id,
            callback=callback,
            close_browser_on_success=close_browser_on_success,
        )

        results["results"].append(result)

        if result.success:
            if result.was_already_enabled:
                results["already_enabled_count"] += 1
                log(f"[{email}] 已开启（跳过）")
            else:
                results["success_count"] += 1
                log(f"[{email}] ✅ 成功")
        else:
            results["failed_count"] += 1
            log(f"[{email}] ❌ 失败: {result.message}")

    log(f"批量完成: 成功 {results['success_count']}, 已开启 {results['already_enabled_count']}, 失败 {results['failed_count']}")
    return results


# ==================== 测试代码 ====================

if __name__ == "__main__":
    async def main():
        print("开启家庭共享测试")
        print("=" * 50)

        # 测试账号（需要替换为真实账号）
        test_account = {
            "email": "pro_account@gmail.com",
            "password": "password",
            "secret_key": "",
        }
        test_browser_id = "12345"

        result = await auto_enable_family_sharing(
            account=test_account,
            browser_id=test_browser_id,
            callback=print,
        )

        print(f"\n结果: {result}")

    asyncio.run(main())
