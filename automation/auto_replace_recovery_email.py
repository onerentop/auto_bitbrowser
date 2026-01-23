"""
自动替换 Google 辅助邮箱 (Recovery Email)

使用 Gemini Vision AI Agent 自动完成操作
"""

import asyncio
from typing import Optional, Tuple

from core.ai_browser_agent import AIBrowserAgent, TaskResult
from core.ai_browser_agent.agent import run_with_ixbrowser


# 目标 URL - 辅助邮箱设置页面
RECOVERY_EMAIL_URL = "https://myaccount.google.com/signinoptions/rescueemail"


async def auto_replace_recovery_email(
    browser_id: str,
    account_info: dict,
    new_email: str,
    close_after: bool = False,
    max_steps: int = 25,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    model: str = "gemini-2.5-flash",
    email_imap_config: dict = None,
    pool_emails: list = None,
) -> Tuple[bool, str, Optional[str]]:
    """
    替换 Google 辅助邮箱

    Args:
        browser_id: ixBrowser 窗口 ID
        account_info: 账号信息 {'email', 'password', 'secret'}
        new_email: 新辅助邮箱
        close_after: 完成后是否关闭浏览器
        max_steps: 最大执行步骤数
        api_key: API Key（可选，默认从环境变量 GEMINI_API_KEY 读取）
        base_url: API Base URL（可选，默认使用 Gemini OpenAI 兼容 API）
        model: 使用的模型（默认 gemini-2.5-flash）
        email_imap_config: 邮箱 IMAP 配置 {'email': str, 'password': str}
                          用于自动读取邮箱验证码
        pool_emails: 邮箱池列表（可选），用于告诉 AI 如果当前邮箱在池中则无需修改

    Returns:
        (success: bool, message: str, error_type: Optional[str])
        - success: 是否成功
        - message: 结果消息
        - error_type: AI 识别的错误类型 (仅失败时有值)

    Environment Variables:
        GEMINI_API_KEY: Gemini API 密钥
    """
    email = account_info.get("email", "Unknown")
    print(f"\n{'='*50}")
    print(f"替换辅助邮箱 (Recovery Email)")
    print(f"账号: {email}")
    print(f"新辅助邮箱: {new_email}")
    if pool_emails:
        print(f"邮箱池: {len(pool_emails)} 个邮箱")
    print(f"{'='*50}")

    # 构建参数，包含邮箱池列表
    params = {"new_email": new_email}
    if pool_emails:
        # 将邮箱列表转为逗号分隔的字符串，方便 AI 阅读
        params["pool_emails"] = ", ".join(pool_emails)
    else:
        params["pool_emails"] = "(未提供邮箱池)"

    result: TaskResult = await run_with_ixbrowser(
        browser_id=browser_id,
        goal=f"将 Google 账号 {email} 的辅助邮箱修改为 {new_email}",
        start_url=RECOVERY_EMAIL_URL,
        account=account_info,
        params=params,
        task_type="replace_recovery_email",
        max_steps=max_steps,
        close_after=close_after,
        api_key=api_key,
        base_url=base_url,
        model=model,
        email_imap_config=email_imap_config,
    )

    if result.success:
        print(f"\n✅ 辅助邮箱替换成功!")
        print(f"总步骤数: {result.total_steps}")
    else:
        print(f"\n❌ 辅助邮箱替换失败")
        print(f"原因: {result.message}")
        if result.error_type:
            print(f"错误类型: {result.error_type}")
        if result.error_details:
            print(f"详情: {result.error_details[:500]}")

    return result.success, result.message, result.error_type


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
        test_new_email = "backup@example.com"

        success, msg, error_type = await auto_replace_recovery_email(
            test_browser_id,
            test_account,
            test_new_email,
            close_after=False,
        )
        print(f"\nResult: {success}, {msg}, error_type={error_type}")

    asyncio.run(test())
