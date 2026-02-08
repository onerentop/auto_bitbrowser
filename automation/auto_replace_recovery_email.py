"""
自动替换 Google 辅助邮箱 (Recovery Email) - StagehandGoogleEngine 版

使用 StagehandGoogleEngine 自动完成操作
"""

import asyncio
import traceback
from typing import Optional, Tuple

from core.stagehand_engine import StagehandGoogleEngine


async def auto_replace_recovery_email(
    browser_id: str,
    account_info: dict,
    new_email: str,
    close_after: bool = False,
    max_steps: int = 25,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    model: Optional[str] = None,
    provider: Optional[str] = None,
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
        max_steps: 最大执行步骤数（保留兼容）
        api_key: API Key（可选，默认从配置读取）
        base_url: API Base URL（可选）
        model: 使用的模型（可选）
        provider: LLM 提供商（已废弃）
        email_imap_config: 邮箱 IMAP 配置（预留）
        pool_emails: 邮箱池列表（可选）

    Returns:
        (success: bool, message: str, error_type: Optional[str])
        - success: 是否成功
        - message: 结果消息
        - error_type: 错误类型 (仅失败时有值)
    """
    email = account_info.get("email", "Unknown")
    print(f"\n{'='*50}")
    print(f"替换辅助邮箱 (StagehandGoogleEngine)")
    print(f"账号: {email}")
    print(f"新辅助邮箱: {new_email}")
    if pool_emails:
        print(f"邮箱池: {len(pool_emails)} 个邮箱")
    print(f"{'='*50}")

    engine = None

    try:
        # 构建模型名称
        model_name = None
        if model:
            if provider:
                provider_map = {"gemini": "google", "anthropic": "anthropic"}
                stagehand_provider = provider_map.get(provider, provider)
                model_name = f"{stagehand_provider}/{model}"
            else:
                model_name = model

        # 1. 连接到 ixBrowser 窗口
        print(f"连接 ixBrowser 窗口: {browser_id}")
        engine = await StagehandGoogleEngine.connect_to_ixbrowser(
            browser_id=browser_id,
            model_name=model_name,
            model_api_key=api_key,
            close_browser_on_exit=close_after,
        )

        # 2. 执行替换辅助邮箱操作
        print("执行替换辅助邮箱操作...")
        result = await engine.replace_recovery_email(new_email=new_email)

        # 3. 处理结果
        if result.success:
            print(f"\n✅ 辅助邮箱替换成功!")
            print(f"耗时: {result.duration_ms:.0f}ms")
            return True, "辅助邮箱替换成功", None

        # 任务失败
        print(f"\n❌ 辅助邮箱替换失败")
        print(f"原因: {result.message}")
        if result.error:
            print(f"详情: {result.error[:500]}")

        return False, result.message, result.error

    except Exception as e:
        traceback.print_exc()
        return False, f"运行失败: {str(e)}", "exception"

    finally:
        # 清理资源
        if engine:
            try:
                await engine.stop(close_browser=close_after)
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
        test_new_email = "backup@example.com"

        success, msg, error_type = await auto_replace_recovery_email(
            test_browser_id,
            test_account,
            test_new_email,
            close_after=False,
        )
        print(f"\nResult: {success}, {msg}, error_type={error_type}")

    asyncio.run(test())
