"""
Antigravity 403 解锁自动化

自动完成 Google 账户手机验证，解除 403 限制：
1. 从 SMS-Bus 获取手机号
2. AI Agent 操作浏览器发送验证码
3. 轮询等待验证码
4. AI Agent 输入验证码完成验证
5. 释放手机号

使用方法:
    from automation.auto_unlock_403 import auto_unlock_403
    from services.sms_bus_client import SMSBusClient

    async with SMSBusClient(token="xxx") as sms_client:
        result = await auto_unlock_403(
            browser_id="123",
            account={"email": "user@gmail.com", ...},
            validation_url="https://accounts.google.com/...",
            sms_client=sms_client,
        )
"""

import asyncio
from typing import Callable, Optional
from dataclasses import dataclass

from playwright.async_api import async_playwright, Page

from core.config_manager import ConfigManager
# 尝试导入 AI Browser Agent 模块
try:
    from core.ai_browser_agent import AIBrowserAgent
    AI_BROWSER_AGENT_AVAILABLE = True
except ImportError:
    AI_BROWSER_AGENT_AVAILABLE = False
    AIBrowserAgent = None

from services.database import DBManager
from services.ix_api import openBrowser
from services.sms_bus_client import SMSBusClient, PhoneNumber


@dataclass
class UnlockResult:
    """403 解锁结果"""
    success: bool
    message: str
    email: str
    phone_used: str = ""
    attempts: int = 0
    error_type: Optional[str] = None


# 发送验证码阶段的 AI 提示词
UNLOCK_403_PROMPT = """
你是一个专业的浏览器自动化助手，需要完成 Google 账户手机验证。

## 账号信息
- 邮箱: {email}
- 验证手机号: {phone_number}
- 手机号归属国家: {country_name}

## 任务目标
完成手机号验证，解除账户 403 限制。

## 操作步骤

### 1. 选择验证方式
- 如果页面显示多种验证方式选项（如 "Verify your phone number", "Scan QR code" 等）
- 点击 "Verify your phone number" 或 "Get a verification code" 选项

### 2. 选择接收方式
- 如果页面询问如何接收验证码（短信/电话）
- 选择 "Text message (SMS)" 短信方式
- 点击 "Next" 或 "Send"

### 3. 选择正确的国家并输入手机号（极其重要！）

**第一步：检查并选择正确的国家**
- 观察输入框左边的国旗/国家选择器
- 手机号归属国家是: {country_name}
- 如果当前显示的国家不是 {country_name}，按以下步骤切换：
  1. 点击国旗/国家选择器，打开国家下拉列表
  2. 下拉列表打开后，按下国家名称的首字母键（如 Canada 按 "C" 键，United States 按 "U" 键）
  3. 这会自动跳转到该字母开头的国家
  4. 如果有多个同字母开头的国家，继续按该字母键或用方向键定位
  5. 找到 {country_name} 后按 Enter 键或点击选择
- ⚠️ 不要尝试滚动下拉列表！使用首字母键盘导航更可靠！
- 特别注意：美国(United States)和加拿大(Canada)都是+1区号，必须选择正确的国家！

**第二步：输入手机号（不带区号）**
- 完整手机号是: {phone_number}
- 由于已经选择了正确的国家，只需输入不带区号的部分
- 例如: 如果手机号是 +12368701545，只输入 2368701545

然后点击 "Send" 或 "Next" 发送验证码

### 4. 发送成功后（极其重要！）
- 看到验证码输入页面（显示 "Enter code" 或 "Verification code" 输入框）时
- ⚠️ **立即报告 DONE**，不要报告 need_verification！
- 系统会自动从 SMS-Bus 获取验证码并调用下一阶段
- 你的任务只是发送验证码，不需要填写验证码

## 注意事项
- 使用元素 ID [N] 格式来定位元素
- 如果提示手机号无效或发送失败，报告 ERROR
- ⚠️ 绝对不要报告 need_verification！发送成功后直接报告 DONE
"""

# 输入验证码阶段的 AI 提示词
ENTER_CODE_PROMPT = """
## 任务
输入验证码完成手机验证

## 验证码
{sms_code}

## 操作步骤
1. 找到验证码输入框（通常标记为 "Enter code" 或 "Verification code"）
2. 使用 FILL 动作填入验证码: {sms_code}
3. 点击 "Verify" 或 "Next" 按钮
4. 等待验证结果

## 成功标准
- 页面显示 "Verification successful" 或类似成功消息
- 或跳转到正常页面（如 myaccount.google.com）
- 此时报告 DONE

## 失败情况
- 如果提示验证码错误或过期，报告 ERROR
- 如果页面要求重新发送验证码，报告 ERROR

## 注意事项
- 使用元素 ID [N] 格式来定位输入框和按钮
- 验证码是纯数字，直接填入即可
"""


async def auto_unlock_403(
    browser_id: str,
    account: dict,
    validation_url: str,
    sms_client: SMSBusClient,
    country_id: int = None,
    project_id: int = None,
    max_retries: int = None,  # None = 从配置读取
    callback: Callable[[str], None] = None,
    api_key: str = None,
    model: str = None,
    provider: str = None,
) -> UnlockResult:
    """
    执行 403 解锁自动化

    Args:
        browser_id: ixBrowser 窗口 ID
        account: 账号信息 {email, password, ...}
        validation_url: 403 验证链接
        sms_client: SMS-Bus 客户端
        country_id: 国家 ID（None = 自动选最便宜）
        project_id: 服务 ID（None = Google）
        max_retries: 最大重试次数（None = 从配置读取）
        callback: 进度回调函数
        api_key: AI API Key（可选）
        model: AI 模型名称（可选）
        provider: AI 提供商（可选）

    Returns:
        UnlockResult: 解锁结果
    """
    email = account.get("email", "")

    def log(msg: str):
        """日志输出"""
        print(f"[Unlock403] {email}: {msg}")
        if callback:
            callback(f"[{email}] {msg}")

    log("开始 403 解锁流程...")

    # 检查 AI Browser Agent 是否可用
    if not AI_BROWSER_AGENT_AVAILABLE:
        log("❌ AI Browser Agent 不可用")
        return UnlockResult(
            success=False,
            message="AI Browser Agent 不可用",
            email=email,
            error_type="agent_unavailable",
        )

    # 更新数据库状态
    DBManager.update_unlock_status(email, "unlocking")

    # 获取配置
    if country_id is None:
        country_id = ConfigManager.get_sms_bus_default_country_id()
    if project_id is None:
        project_id = ConfigManager.get_sms_bus_default_project_id()
    if max_retries is None:
        max_retries = ConfigManager.get_sms_bus_max_retries()

    sms_timeout = ConfigManager.get_sms_bus_timeout()
    sms_interval = ConfigManager.get_sms_bus_poll_interval()

    # 重试循环（max_retries 表示总尝试次数，不是额外重试次数）
    attempts = 0
    last_error = ""
    phone_used = ""

    for attempt in range(max_retries):
        attempts = attempt + 1
        log(f"=== 尝试 {attempts}/{max_retries} ===")

        phone: PhoneNumber = None

        try:
            # 步骤 1: 获取手机号
            log("获取手机号...")
            phone, error = await sms_client.get_number(
                country_id=country_id,
                project_id=project_id,
                prefer_cheapest=True,
            )

            if not phone:
                last_error = error or "无法获取手机号"
                log(f"❌ {last_error}")
                continue

            phone_used = phone.formatted_number
            log(f"✅ 获取到手机号: {phone_used} ({phone.country_name}, cost: ${phone.cost})")

            # 步骤 2: 打开浏览器并执行验证
            result = openBrowser(browser_id)
            if not result.get("success"):
                last_error = result.get("msg", "打开浏览器失败")
                log(f"❌ {last_error}")
                # 释放号码
                await sms_client.cancel_request(phone.request_id)
                continue

            ws_endpoint = result.get("data", {}).get("ws", "")

            async with async_playwright() as playwright:
                browser = await playwright.chromium.connect_over_cdp(ws_endpoint)
                contexts = browser.contexts
                if not contexts:
                    last_error = "没有找到浏览器上下文"
                    log(f"❌ {last_error}")
                    await sms_client.cancel_request(phone.request_id)
                    continue

                context = contexts[0]
                pages = context.pages
                page = pages[0] if pages else await context.new_page()

                # 导航到验证页面
                log("导航到验证页面...")
                await page.goto(validation_url, wait_until="networkidle", timeout=60000)

                # 获取 AI 配置
                if not provider:
                    provider = ConfigManager.get_ai_default_provider()
                if not api_key:
                    api_key = ConfigManager.get_ai_provider_api_key(provider)
                if not model:
                    model = ConfigManager.get_ai_provider_model(provider)

                base_url = ConfigManager.get_ai_provider_base_url(provider)

                # 创建 AI Agent
                agent = AIBrowserAgent(
                    api_key=api_key,
                    base_url=base_url,
                    model=model,
                    provider=provider,
                )

                agent.on_step(lambda step, action: log(f"[Agent] 步骤{step}: {action}"))

                # 步骤 3: AI Agent 发送验证码
                log("AI Agent 发送验证码...")
                send_prompt = UNLOCK_403_PROMPT.format(
                    email=email,
                    phone_number=phone_used,
                    country_name=phone.country_name or "United States",
                )

                send_result = await agent.execute_task(
                    page=page,
                    goal=send_prompt,
                    start_url=validation_url,
                    max_steps=15,
                    navigate_first=False,
                )

                if not send_result.success:
                    last_error = f"发送验证码失败: {send_result.message}"
                    log(f"❌ {last_error}")
                    await sms_client.cancel_request(phone.request_id)
                    continue

                log("✅ 验证码已发送，等待短信...")

                # 步骤 4: 等待验证码
                sms_code, error = await sms_client.wait_for_sms(
                    request_id=phone.request_id,
                    timeout=sms_timeout,
                    interval=sms_interval,
                    callback=lambda msg: log(msg),
                )

                if not sms_code:
                    last_error = error or "等待验证码超时"
                    log(f"❌ {last_error}")
                    # 释放号码并重试
                    await sms_client.cancel_request(phone.request_id)
                    continue

                log(f"✅ 收到验证码: {sms_code}")

                # 步骤 5: AI Agent 输入验证码
                log("AI Agent 输入验证码...")
                enter_prompt = ENTER_CODE_PROMPT.format(sms_code=sms_code)

                enter_result = await agent.execute_task(
                    page=page,
                    goal=enter_prompt,
                    start_url=page.url,  # 使用当前 URL
                    max_steps=10,
                    navigate_first=False,
                )

                # 步骤 6: 检查验证结果
                current_url = page.url
                verification_success = (
                    "myaccount.google.com" in current_url or
                    enter_result.success
                )

                # 释放号码
                log("释放手机号...")
                await sms_client.cancel_request(phone.request_id)

                if verification_success:
                    log("✅ 403 解锁成功")
                    DBManager.update_unlock_status(email, "unlocked")
                    return UnlockResult(
                        success=True,
                        message="403 解锁成功",
                        email=email,
                        phone_used=phone_used,
                        attempts=attempts,
                    )
                else:
                    last_error = f"验证失败: {enter_result.message}"
                    log(f"❌ {last_error}")
                    # 继续重试

        except Exception as e:
            last_error = str(e)
            log(f"❌ 异常: {last_error}")
            # 释放号码
            if phone:
                try:
                    await sms_client.cancel_request(phone.request_id)
                except Exception:
                    pass

    # 所有重试都失败
    log(f"❌ 解锁失败，已重试 {attempts} 次")
    DBManager.update_unlock_status(email, "unlock_failed")
    return UnlockResult(
        success=False,
        message=f"解锁失败: {last_error}",
        email=email,
        phone_used=phone_used,
        attempts=attempts,
        error_type="max_retries_exceeded",
    )


# ==================== 测试代码 ====================

if __name__ == "__main__":
    async def main():
        print("403 Unlock 测试")
        print("=" * 50)

        # 测试账号（需要替换为真实数据）
        test_account = {
            "email": "test@gmail.com",
            "password": "test_password",
        }

        # 测试验证链接
        test_validation_url = "https://accounts.google.com/signin/continue?..."

        # 测试浏览器 ID
        test_browser_id = "12345"

        async with SMSBusClient() as sms_client:
            result = await auto_unlock_403(
                browser_id=test_browser_id,
                account=test_account,
                validation_url=test_validation_url,
                sms_client=sms_client,
                callback=print,
            )

            print(f"\n结果: {result}")

    asyncio.run(main())
