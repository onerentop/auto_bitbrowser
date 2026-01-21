"""
自动踢出非本机登录设备

使用 Gemini Vision AI Agent 自动完成操作
1. 进入设备管理页面
2. 识别本机设备（"您的当前会话"）
3. 逐个踢出其他设备
"""

import asyncio
import traceback
from typing import Optional, Tuple

from core.ai_browser_agent import AIBrowserAgent, TaskResult

# 目标 URL - 设备管理页面
DEVICES_URL = "https://myaccount.google.com/device-activity"


async def auto_kick_devices(
    browser_id: str,
    account_info: dict,
    close_after: bool = False,
    max_steps: int = 50,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    model: str = "gemini-2.5-flash",
) -> Tuple[bool, str, int]:
    """
    踢出非本机登录设备

    Args:
        browser_id: ixBrowser 窗口 ID
        account_info: 账号信息 {'email', 'password', 'secret'}
        close_after: 完成后是否关闭浏览器
        max_steps: 最大执行步骤数
        api_key: API Key（可选，默认从环境变量 GEMINI_API_KEY 读取）
        base_url: API Base URL（可选，默认使用 Gemini OpenAI 兼容 API）
        model: 使用的模型（默认 gemini-2.5-flash）

    Returns:
        (success: bool, message: str, kicked_count: int)
        - success: 是否成功
        - message: 结果消息
        - kicked_count: 踢出的设备数量

    Environment Variables:
        GEMINI_API_KEY: Gemini API 密钥
    """
    email = account_info.get("email", "Unknown")
    print(f"\n{'='*50}")
    print(f"踢出非本机登录设备")
    print(f"账号: {email}")
    print(f"{'='*50}")

    # 导入 ixBrowser API
    try:
        from ix_api import openBrowser, closeBrowser
    except ImportError:
        return False, "无法导入 ix_api 模块", 0

    browser = None
    playwright = None
    kicked_count = 0

    try:
        from playwright.async_api import async_playwright

        # 1. 打开 ixBrowser 窗口
        print(f"打开浏览器窗口: {browser_id}")
        result = openBrowser(browser_id)

        if not result or "data" not in result:
            return False, "无法打开浏览器窗口", 0

        ws_endpoint = result["data"].get("ws", "")
        if not ws_endpoint:
            return False, "获取 WebSocket endpoint 失败", 0

        # 2. 连接 Playwright
        playwright = await async_playwright().start()
        browser = await playwright.chromium.connect_over_cdp(ws_endpoint)

        # 获取页面
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        page = context.pages[0] if context.pages else await context.new_page()

        # 3. 创建并运行 Agent
        agent = AIBrowserAgent(
            api_key=api_key,
            base_url=base_url,
            model=model,
        )

        # 执行踢出设备任务
        task_result = await agent.execute_task(
            page=page,
            goal=f"踢出 Google 账号 {email} 的所有非本机登录设备",
            start_url=DEVICES_URL,
            account=account_info,
            params={},
            task_type="kick_devices",
            max_steps=max_steps,
            navigate_first=True,
        )

        # 任务成功完成
        if task_result.success:
            print(f"\n✅ 踢出设备任务完成!")
            print(f"总步骤数: {task_result.total_steps}")

            # 从 data 中获取踢出数量
            kicked_count = task_result.data.get("kicked_count", 0)

            if kicked_count > 0:
                return True, f"成功踢出 {kicked_count} 个设备", kicked_count
            else:
                return True, "没有需要踢出的设备（仅本机登录）", 0

        # 任务失败
        print(f"\n❌ 踢出设备失败")
        print(f"原因: {task_result.message}")
        if task_result.error_details:
            print(f"详情: {task_result.error_details[:500]}")

        return False, task_result.message, kicked_count

    except Exception as e:
        traceback.print_exc()
        return False, f"运行失败: {str(e)}", kicked_count

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

        success, msg, count = await auto_kick_devices(
            test_browser_id,
            test_account,
            close_after=False,
        )
        print(f"\nResult: {success}, {msg}")
        print(f"Kicked devices: {count}")

    asyncio.run(test())
