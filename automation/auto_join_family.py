"""
自动加入家庭组

自动完成家庭组加入流程：
1. 在普通 Pro 账户窗口发送家庭邀请
2. 在被邀请账户窗口接受邀请（通过 Gmail）
3. 更新数据库状态
"""

import asyncio
from typing import Callable, Optional
from dataclasses import dataclass

from playwright.async_api import async_playwright

from core.config_manager import ConfigManager
# 尝试导入 AI Browser Agent 模块
try:
    from core.ai_browser_agent import AIBrowserAgent
    AI_BROWSER_AGENT_AVAILABLE = True
except ImportError:
    AI_BROWSER_AGENT_AVAILABLE = False
    AIBrowserAgent = None
from services.database import DBManager
from services.ix_api import openBrowser, closeBrowser


@dataclass
class JoinFamilyResult:
    """加入家庭组结果"""
    success: bool
    message: str
    inviter_email: str
    invitee_email: str
    error_type: Optional[str] = None
    total_steps: int = 0


# ==================== 提示词模板 ====================

SEND_INVITE_PROMPT = """
你是一个专业的浏览器自动化助手，需要完成发送 Google 家庭组邀请的任务。

## 当前状态
- 邀请人账号: {inviter_email}
- 被邀请人: {invitee_email}
- 目标: 向被邀请人发送家庭组邀请

## 任务目标
在 Google 家庭管理页面，向 {invitee_email} 发送家庭组邀请。

## 操作步骤

### 1. 检查当前页面
- 当前应该在 https://myaccount.google.com/family 或类似的家庭管理页面
- 如果不是，请导航到该页面

### 2. 发送邀请
- 找到"邀请家庭成员"或"Invite family member"按钮并点击
- 在弹出的对话框/输入框中输入 {invitee_email}
- 点击"发送"或"Send"按钮确认邀请

### 3. 确认邀请已发送
- 等待确认消息出现（如"邀请已发送"/"Invitation sent"）
- 如果看到成功消息，任务完成

## 注意事项
- 如果家庭组已满（6人），报告错误
- 如果被邀请人已在家庭组中，报告错误
- 每一步操作后等待页面响应

## 成功标准
看到"邀请已发送"或类似的成功消息时，报告 DONE。
"""

ACCEPT_INVITE_PROMPT = """
你是一个专业的浏览器自动化助手，需要完成接受 Google 家庭组邀请的任务。

## 当前状态
- 被邀请人账号: {invitee_email}
{totp_info}
- 邀请来自: {inviter_email}
- 目标: 接受家庭组邀请

## 任务目标
在 Gmail 中找到家庭组邀请邮件，并接受邀请加入家庭组。

## 操作步骤

### 1. 检查 Gmail
- 当前应该在 https://mail.google.com
- 在搜索框中搜索: "Google One family" 或 "加入家庭群组" 或 "family invitation"
- 或者直接在收件箱中找到来自 Google 的邀请邮件

### 2. 处理 2FA 验证（如果需要）
{totp_instructions}

### 3. 打开邀请邮件
- 找到标题包含 "family" 或 "家庭" 的邮件
- 点击打开邮件

### 4. 接受邀请
- 在邮件中找到"接受邀请"/"Accept invitation"按钮或链接
- 点击该按钮/链接
- 在跳转的 Google 页面上确认加入

### 5. 确认加入成功
- 等待看到"您已加入家庭群组"或类似成功消息

## 邮件搜索关键词（中英文）
- "Google One family"
- "family group invitation"
- "Join your family"
- "加入家庭群组"
- "家庭邀请"
- 发件人: "Google" 或 "no-reply@google.com"

## 注意事项
- 邮件可能需要几分钟才能到达，如果没找到请稍等
- 如果需要登录确认，完成登录
- 如果看到"已加入"或已在家庭组中的提示，也算成功

## 成功标准
看到成功加入家庭组的确认消息时，报告 DONE。
"""


async def auto_join_family(
    inviter_account: dict,
    invitee_account: dict,
    inviter_browser_id: str,
    invitee_browser_id: str,
    callback: Callable[[str], None] = None,
    api_key: str = None,
    model: str = None,
    provider: str = None,
    max_steps: int = None,
    close_browser_on_success: bool = True,
) -> JoinFamilyResult:
    """
    执行家庭组加入流程

    Args:
        inviter_account: 邀请人账号（普通 Pro）{email, password, secret_key, recovery_email, browser_profile_id}
        invitee_account: 被邀请人账号（待加入）{email, password, secret_key, recovery_email, browser_profile_id}
        inviter_browser_id: 邀请人的浏览器窗口 ID
        invitee_browser_id: 被邀请人的浏览器窗口 ID
        callback: 进度回调函数
        api_key: AI API Key（可选）
        model: AI 模型名称（可选）
        provider: AI 提供商（可选）
        max_steps: 最大步骤数（可选）
        close_browser_on_success: 成功后是否关闭浏览器窗口

    Returns:
        JoinFamilyResult: 加入结果
    """
    inviter_email = inviter_account.get("email", "")
    invitee_email = invitee_account.get("email", "")

    def log(msg: str):
        """日志输出"""
        print(f"[JoinFamily] {msg}")
        if callback:
            callback(msg)

    log(f"开始家庭组加入流程: {invitee_email} -> {inviter_email} 的家庭组")

    # 检查 AI Browser Agent 是否可用
    if not AI_BROWSER_AGENT_AVAILABLE:
        log("❌ AI Browser Agent 不可用")
        return JoinFamilyResult(
            success=False,
            message="AI Browser Agent 不可用",
            inviter_email=inviter_email,
            invitee_email=invitee_email,
            error_type="agent_unavailable",
        )

    # 获取 AI 配置
    if not provider:
        provider = ConfigManager.get_ai_default_provider()
    if not api_key:
        api_key = ConfigManager.get_ai_provider_api_key(provider)
    if not model:
        model = ConfigManager.get_ai_provider_model(provider)
    if not max_steps:
        max_steps = 20  # 家庭组流程可能需要更多步骤

    base_url = ConfigManager.get_ai_provider_base_url(provider)

    total_steps = 0

    try:
        # ==================== Step 1: 发送邀请 ====================
        log("=" * 50)
        log(f"Step 1: 在 {inviter_email} 窗口发送邀请...")
        log("=" * 50)

        invite_result = await _send_family_invite(
            browser_id=inviter_browser_id,
            inviter_account=inviter_account,
            invitee_email=invitee_email,
            api_key=api_key,
            base_url=base_url,
            model=model,
            provider=provider,
            max_steps=max_steps,
            log_func=log,
        )

        total_steps += invite_result.get("steps", 0)

        if not invite_result.get("success"):
            error_msg = invite_result.get("message", "发送邀请失败")
            log(f"❌ {error_msg}")
            return JoinFamilyResult(
                success=False,
                message=error_msg,
                inviter_email=inviter_email,
                invitee_email=invitee_email,
                error_type="invite_failed",
                total_steps=total_steps,
            )

        log("✅ 邀请发送成功，等待邮件送达...")

        # 等待邮件送达（通常需要几秒到几分钟）
        await asyncio.sleep(10)

        # ==================== Step 2: 接受邀请 ====================
        log("=" * 50)
        log(f"Step 2: 在 {invitee_email} 窗口接受邀请...")
        log("=" * 50)

        accept_result = await _accept_family_invite(
            browser_id=invitee_browser_id,
            invitee_account=invitee_account,
            inviter_email=inviter_email,
            api_key=api_key,
            base_url=base_url,
            model=model,
            provider=provider,
            max_steps=max_steps,
            log_func=log,
        )

        total_steps += accept_result.get("steps", 0)

        if not accept_result.get("success"):
            error_msg = accept_result.get("message", "接受邀请失败")
            log(f"❌ {error_msg}")
            return JoinFamilyResult(
                success=False,
                message=error_msg,
                inviter_email=inviter_email,
                invitee_email=invitee_email,
                error_type="accept_failed",
                total_steps=total_steps,
            )

        log("✅ 成功接受邀请!")

        # ==================== Step 3: 更新数据库 ====================
        log("更新数据库状态...")

        # 更新被邀请人状态为 family_yes（已通过家庭组获得 Pro）
        DBManager.update_pro_status(invitee_email, "family_yes")

        # 更新邀请人的家庭成员数量（+1）
        inviter_db = DBManager.get_account_by_email(inviter_email)
        if inviter_db:
            current_count = inviter_db.get("family_member_count", 0) or 1
            new_count = min(current_count + 1, 6)
            DBManager.update_family_member_count(inviter_email, new_count)
            log(f"邀请人 {inviter_email} 家庭成员数量: {current_count} -> {new_count}")

        # 关闭浏览器窗口
        if close_browser_on_success:
            try:
                closeBrowser(inviter_browser_id)
                log(f"已关闭邀请人浏览器窗口")
            except Exception as e:
                log(f"关闭邀请人窗口失败: {e}")

            try:
                closeBrowser(invitee_browser_id)
                log(f"已关闭被邀请人浏览器窗口")
            except Exception as e:
                log(f"关闭被邀请人窗口失败: {e}")

        log(f"✅ 家庭组加入完成! {invitee_email} 已加入 {inviter_email} 的家庭组")

        return JoinFamilyResult(
            success=True,
            message="成功加入家庭组",
            inviter_email=inviter_email,
            invitee_email=invitee_email,
            total_steps=total_steps,
        )

    except Exception as e:
        error_msg = str(e)
        log(f"❌ 异常: {error_msg}")
        return JoinFamilyResult(
            success=False,
            message=f"加入家庭组异常: {error_msg}",
            inviter_email=inviter_email,
            invitee_email=invitee_email,
            error_type="exception",
            total_steps=total_steps,
        )


async def _send_family_invite(
    browser_id: str,
    inviter_account: dict,
    invitee_email: str,
    api_key: str,
    base_url: str,
    model: str,
    provider: str,
    max_steps: int,
    log_func: Callable,
) -> dict:
    """
    在邀请人窗口发送家庭邀请

    Returns:
        dict: {success: bool, message: str, steps: int}
    """
    log = log_func
    inviter_email = inviter_account.get("email", "")
    inviter_secret = inviter_account.get("secret_key", "")

    try:
        # 打开浏览器
        result = openBrowser(browser_id)
        if not result.get("success"):
            return {"success": False, "message": result.get("msg", "打开浏览器失败"), "steps": 0}

        ws_endpoint = result.get("data", {}).get("ws", "")

        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(ws_endpoint)
            contexts = browser.contexts
            if not contexts:
                return {"success": False, "message": "没有浏览器上下文", "steps": 0}

            context = contexts[0]
            pages = context.pages
            page = pages[0] if pages else await context.new_page()

            # 导航到家庭管理页面
            log(f"[{inviter_email}] 导航到家庭管理页面...")
            await page.goto("https://myaccount.google.com/family", wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(2000)

            # 构建提示词
            prompt = SEND_INVITE_PROMPT.format(
                inviter_email=inviter_email,
                invitee_email=invitee_email,
            )

            # 创建 AI Agent
            agent = AIBrowserAgent(
                api_key=api_key,
                base_url=base_url,
                model=model,
                provider=provider,
            )

            agent.on_step(lambda step, action: log(f"[{inviter_email}][Agent] 步骤{step}: {action}"))

            # 构建 account 参数（AI Agent 使用 'secret' 字段名）
            agent_account = {
                "email": inviter_email,
                "password": inviter_account.get("password", ""),
                "secret": inviter_secret,
                "recovery_email": inviter_account.get("recovery_email", ""),
            }

            # 执行发送邀请任务
            task_result = await agent.execute_task(
                page=page,
                goal=prompt,
                start_url="https://myaccount.google.com/family",
                account=agent_account,
                max_steps=max_steps,
                navigate_first=False,
            )

            if task_result.success:
                return {"success": True, "message": "邀请发送成功", "steps": task_result.total_steps}
            else:
                return {"success": False, "message": task_result.message or "发送邀请失败", "steps": task_result.total_steps}

    except Exception as e:
        return {"success": False, "message": str(e), "steps": 0}


async def _accept_family_invite(
    browser_id: str,
    invitee_account: dict,
    inviter_email: str,
    api_key: str,
    base_url: str,
    model: str,
    provider: str,
    max_steps: int,
    log_func: Callable,
) -> dict:
    """
    在被邀请人窗口接受家庭邀请

    Returns:
        dict: {success: bool, message: str, steps: int}
    """
    log = log_func
    invitee_email = invitee_account.get("email", "")
    secret_key = invitee_account.get("secret_key", "")

    try:
        # 打开浏览器
        result = openBrowser(browser_id)
        if not result.get("success"):
            return {"success": False, "message": result.get("msg", "打开浏览器失败"), "steps": 0}

        ws_endpoint = result.get("data", {}).get("ws", "")

        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(ws_endpoint)
            contexts = browser.contexts
            if not contexts:
                return {"success": False, "message": "没有浏览器上下文", "steps": 0}

            context = contexts[0]
            pages = context.pages
            page = pages[0] if pages else await context.new_page()

            # 导航到 Gmail
            log(f"[{invitee_email}] 导航到 Gmail...")
            await page.goto("https://mail.google.com", wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(3000)

            # 构建 2FA 信息
            totp_info = ""
            totp_instructions = ""
            if secret_key:
                totp_info = f"- 当前 2FA 验证码: {{totp_code}} (使用密钥 {secret_key[:4]}... 生成)"
                totp_instructions = """- 如果看到需要输入验证码/Authenticator 的页面
- 在验证码输入框中输入 6 位数字验证码
- 验证码每 30 秒更新一次，请快速输入
- 点击"下一步"或按 Enter 确认"""
            else:
                totp_instructions = "- 如果需要 2FA 验证但没有密钥，报告需要人工干预 (need_verification)"

            # 构建提示词
            prompt = ACCEPT_INVITE_PROMPT.format(
                invitee_email=invitee_email,
                inviter_email=inviter_email,
                totp_info=totp_info,
                totp_instructions=totp_instructions,
            )

            # 创建 AI Agent
            agent = AIBrowserAgent(
                api_key=api_key,
                base_url=base_url,
                model=model,
                provider=provider,
            )

            agent.on_step(lambda step, action: log(f"[{invitee_email}][Agent] 步骤{step}: {action}"))

            # 构建 account 参数（AI Agent 使用 'secret' 字段名）
            agent_account = {
                "email": invitee_email,
                "password": invitee_account.get("password", ""),
                "secret": secret_key,
                "recovery_email": invitee_account.get("recovery_email", ""),
            }

            # 执行接受邀请任务
            task_result = await agent.execute_task(
                page=page,
                goal=prompt,
                start_url="https://mail.google.com",
                account=agent_account,
                max_steps=max_steps,
                navigate_first=False,
            )

            if task_result.success:
                return {"success": True, "message": "成功接受邀请", "steps": task_result.total_steps}
            else:
                return {"success": False, "message": task_result.message or "接受邀请失败", "steps": task_result.total_steps}

    except Exception as e:
        return {"success": False, "message": str(e), "steps": 0}


# ==================== 测试代码 ====================

if __name__ == "__main__":
    async def main():
        print("家庭组加入测试")
        print("=" * 50)

        # 测试账号（需要替换为真实账号）
        inviter_account = {
            "email": "pro_account@gmail.com",
            "password": "password",
            "secret_key": "",
        }

        invitee_account = {
            "email": "family_pro@gmail.com",
            "password": "password",
            "secret_key": "",
        }

        # 测试浏览器 ID（需要替换为真实 ID）
        inviter_browser_id = "12345"
        invitee_browser_id = "67890"

        result = await auto_join_family(
            inviter_account=inviter_account,
            invitee_account=invitee_account,
            inviter_browser_id=inviter_browser_id,
            invitee_browser_id=invitee_browser_id,
            callback=print,
        )

        print(f"\n结果: {result}")

    asyncio.run(main())
