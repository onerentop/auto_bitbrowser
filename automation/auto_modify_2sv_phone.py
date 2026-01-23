"""
自动修改 Google 2-Step Verification 手机号

使用 Gemini Vision AI Agent 自动完成操作
"""

import asyncio
from typing import Optional, Tuple

from core.ai_browser_agent import AIBrowserAgent, TaskResult
from core.ai_browser_agent.agent import run_with_ixbrowser


# 目标 URL - 2-Step Verification 设置页面
TWO_STEP_PHONE_URL = "https://myaccount.google.com/signinoptions/two-step-verification"


async def auto_modify_2sv_phone(
    browser_id: str,
    account_info: dict,
    new_phone: str,
    close_after: bool = True,
    max_steps: int = 25,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    model: str = "gemini-2.5-flash",
) -> Tuple[bool, str]:
    """
    修改 Google 2-Step Verification 手机号

    Args:
        browser_id: ixBrowser 窗口 ID
        account_info: 账号信息 {'email', 'password', 'secret'}
        new_phone: 新手机号
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
    print(f"\n{'='*50}")
    print(f"修改 2SV 手机号")
    print(f"账号: {email}")
    print(f"新手机号: {new_phone}")
    print(f"{'='*50}")

    result: TaskResult = await run_with_ixbrowser(
        browser_id=browser_id,
        goal=f"将 Google 账号 {email} 的 2-Step Verification 手机号修改为 {new_phone}",
        start_url=TWO_STEP_PHONE_URL,
        account=account_info,
        params={"new_phone": new_phone},
        task_type="modify_2sv_phone",
        max_steps=max_steps,
        close_after=close_after,
        api_key=api_key,
        base_url=base_url,
        model=model,
    )

    if result.success:
        print(f"\n✅ 2SV 手机号修改成功!")
        print(f"总步骤数: {result.total_steps}")
    else:
        print(f"\n❌ 2SV 手机号修改失败")
        print(f"原因: {result.message}")
        if result.error_details:
            print(f"详情: {result.error_details[:500]}")

    return result.success, result.message


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
        test_phone = "+1234567890"

        success, msg = await auto_modify_2sv_phone(
            test_browser_id,
            test_account,
            test_phone,
            close_after=True,
        )
        print(f"\nResult: {success}, {msg}")

    asyncio.run(test())
