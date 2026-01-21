"""
自动绑卡订阅 - AI Agent 版

使用 Gemini Vision AI Agent 自动完成 Google One AI Student 绑卡订阅
替代传统的硬编码选择器方案，更稳定可维护
"""

import asyncio
import traceback
from typing import Optional, Tuple

from core.ai_browser_agent import AIBrowserAgent, TaskResult
from account_manager import AccountManager

# 目标 URL - Google One AI Student 页面
BIND_CARD_URL = "https://one.google.com/ai-student?g1_landing_page=75&utm_source=antigravity&utm_campaign=argon_limit_reached"


async def auto_bind_card_ai(
    browser_id: str,
    account_info: dict,
    card_info: dict,
    close_after: bool = False,
    max_steps: int = 40,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    model: str = "gemini-2.5-flash",
) -> Tuple[bool, str]:
    """
    使用 AI Agent 完成绑卡订阅

    Args:
        browser_id: ixBrowser 窗口 ID
        account_info: 账号信息 {'email', 'password', 'secret'}
        card_info: 卡片信息 {'number', 'exp_month', 'exp_year', 'cvv', 'name', 'zip_code'}
        close_after: 完成后是否关闭浏览器
        max_steps: 最大执行步骤数
        api_key: API Key（可选，默认从环境变量 GEMINI_API_KEY 读取）
        base_url: API Base URL（可选，默认使用 Gemini OpenAI 兼容 API）
        model: 使用的模型（默认 gemini-2.5-flash）

    Returns:
        (success: bool, message: str)

    Environment Variables:
        GEMINI_API_KEY: Gemini API 密钥
    """
    email = account_info.get("email", "Unknown")
    card_number = card_info.get('number', '')
    card_masked = f"**** **** **** {card_number[-4:]}" if len(card_number) >= 4 else "****"

    print(f"\n{'='*50}")
    print(f"AI Agent 绑卡订阅")
    print(f"账号: {email}")
    print(f"卡片: {card_masked}")
    print(f"{'='*50}")

    # 导入 ixBrowser API
    try:
        from ix_api import openBrowser, closeBrowser
    except ImportError:
        return False, "无法导入 ix_api 模块"

    browser = None
    playwright = None

    try:
        from playwright.async_api import async_playwright

        # 1. 打开 ixBrowser 窗口
        print(f"打开浏览器窗口: {browser_id}")
        result = openBrowser(browser_id)

        if not result or "data" not in result:
            return False, "无法打开浏览器窗口"

        ws_endpoint = result["data"].get("ws", "")
        if not ws_endpoint:
            return False, "获取 WebSocket endpoint 失败"

        # 2. 连接 Playwright
        playwright = await async_playwright().start()
        browser = await playwright.chromium.connect_over_cdp(ws_endpoint)

        # 获取页面
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        page = context.pages[0] if context.pages else await context.new_page()

        # 3. 构建任务参数
        params = {
            "card_number": card_info.get("number", ""),
            "card_exp_month": card_info.get("exp_month", ""),
            "card_exp_year": card_info.get("exp_year", ""),
            "card_cvv": card_info.get("cvv", ""),
            "card_name": card_info.get("name", "John Smith"),
            "card_zip_code": card_info.get("zip_code", "10001"),
        }

        # 4. 创建并运行 Agent
        agent = AIBrowserAgent(
            api_key=api_key,
            base_url=base_url,
            model=model,
        )

        task_result = await agent.execute_task(
            page=page,
            goal=f"为 Google 账号 {email} 完成绑卡订阅",
            start_url=BIND_CARD_URL,
            account=account_info,
            params=params,
            task_type="bind_card",
            max_steps=max_steps,
            navigate_first=True,
        )

        # 5. 处理结果
        if task_result.success:
            print(f"\n✅ 绑卡订阅成功!")
            print(f"总步骤数: {task_result.total_steps}")

            # 更新账号状态为已订阅
            try:
                acc_line = email
                if account_info.get("password"):
                    acc_line += f"----{account_info.get('password')}"
                if account_info.get("backup"):
                    acc_line += f"----{account_info.get('backup')}"
                if account_info.get("secret"):
                    acc_line += f"----{account_info.get('secret')}"

                AccountManager.move_to_subscribed(acc_line)
                print(f"✅ 账号状态已更新为 subscribed")
            except Exception as e:
                print(f"⚠️ 更新账号状态失败（不影响绑卡结果）: {e}")

            return True, "绑卡订阅成功"

        # 任务失败
        print(f"\n❌ 绑卡订阅失败")
        print(f"原因: {task_result.message}")
        if task_result.error_details:
            print(f"详情: {task_result.error_details[:500]}")

        return False, task_result.message

    except Exception as e:
        traceback.print_exc()
        return False, f"运行失败: {str(e)}"

    finally:
        # 清理资源
        if close_after:
            try:
                if browser:
                    await browser.close()
            except Exception:
                pass

            try:
                if playwright:
                    await playwright.stop()
            except Exception:
                pass

            try:
                closeBrowser(browser_id)
                print("浏览器已关闭")
            except Exception:
                pass


# 测试入口
if __name__ == "__main__":
    async def test():
        # 测试用参数
        test_browser_id = "test_id"
        test_account = {
            "email": "test@gmail.com",
            "password": "test_password",
            "secret": "test_secret",
        }
        test_card = {
            "number": "5481087170529907",
            "exp_month": "01",
            "exp_year": "32",
            "cvv": "536",
            "name": "John Smith",
            "zip_code": "10001",
        }

        success, msg = await auto_bind_card_ai(
            test_browser_id,
            test_account,
            test_card,
            close_after=False,
        )
        print(f"\nResult: {success}, {msg}")

    asyncio.run(test())
