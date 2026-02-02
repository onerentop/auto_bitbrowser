"""
自动获取 Google One AI Student SheerID 验证链接 (AI Agent 版)

使用多 LLM 提供商 (Gemini/Anthropic) Vision AI Agent 自动检测账号状态并提取 SheerID 链接
支持状态检测: subscribed, verified, link_ready, ineligible
"""

import asyncio
import traceback
from typing import Optional, Tuple

from core.ai_browser_agent import AIBrowserAgent, TaskResult
from core.ai_browser_agent.types import AgentState
from services.database import DBManager

# 目标 URL - Google One 学生订阅页面
SHEERLINK_URL = "https://goo.gle/freepro"


async def auto_get_sheerlink_ai(
    browser_id: str,
    account_info: dict,
    close_after: bool = False,
    max_steps: int = 20,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    model: Optional[str] = None,
    provider: Optional[str] = None,
    save_to_file: bool = True,
) -> Tuple[bool, str, Optional[str], Optional[str]]:
    """
    获取 Google One AI Student SheerID 验证链接

    Args:
        browser_id: ixBrowser 窗口 ID
        account_info: 账号信息 {'email', 'password', 'secret'}
        close_after: 完成后是否关闭浏览器
        max_steps: 最大执行步骤数
        api_key: API Key（可选，默认从配置读取）
        base_url: API Base URL（可选，用于第三方服务）
        model: 使用的模型（可选，默认从配置读取）
        provider: LLM 提供商 (gemini, anthropic)，默认从配置读取
        save_to_file: 是否保存到对应状态文件

    Returns:
        (success: bool, message: str, status: Optional[str], link: Optional[str])
        - success: 是否成功
        - message: 结果消息
        - status: 账号状态 (subscribed/verified/link_ready/ineligible/error)
        - link: SheerID 验证链接（status=link_ready 时返回）

    Status Types:
        - subscribed: 已订阅/已绑卡
        - verified: 已验证未绑卡，可直接领取优惠
        - link_ready: 有资格待验证，返回 SheerID 链接
        - ineligible: 无资格，无法使用优惠
        - error: 检测失败

    Environment Variables:
        GEMINI_API_KEY: Gemini API 密钥
        ANTHROPIC_API_KEY: Anthropic API 密钥
    """
    email = account_info.get("email", "Unknown")
    print(f"\n{'='*50}")
    print(f"获取 SheerID 验证链接 (AI Agent)")
    print(f"账号: {email}")
    print(f"{'='*50}")

    # 导入 ixBrowser API
    try:
        from services.ix_api import openBrowser, closeBrowser
    except ImportError:
        return False, "无法导入 ix_api 模块", "error", None

    browser = None
    playwright = None
    extracted_status = None
    extracted_link = None

    try:
        from playwright.async_api import async_playwright

        # 1. 打开 ixBrowser 窗口
        print(f"打开浏览器窗口: {browser_id}")
        result = openBrowser(browser_id)

        if not result or "data" not in result:
            return False, "无法打开浏览器窗口", "error", None

        ws_endpoint = result["data"].get("ws", "")
        if not ws_endpoint:
            return False, "获取 WebSocket endpoint 失败", "error", None

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
            provider=provider,
        )

        task_result = await agent.execute_task(
            page=page,
            goal=f"检测 Google 账号 {email} 的学生资格状态并提取 SheerID 验证链接",
            start_url=SHEERLINK_URL,
            account=account_info,
            params={},
            task_type="get_sheerlink",
            max_steps=max_steps,
            navigate_first=True,
        )

        # 处理结果
        if task_result.success:
            action_type = task_result.data.get("action_type", "")

            # 检查是否是链接提取动作
            if action_type == "extract_link":
                extracted_link = task_result.data.get("extracted_link", "")
                extracted_status = task_result.data.get("result_status", "link_ready")
                print(f"\n🔗 提取到链接: {extracted_link[:50]}..." if extracted_link else "")
                print(f"📋 账号状态: {extracted_status}")
            else:
                # done 动作 - 直接从 data 中获取 result_status
                extracted_link = None
                extracted_status = task_result.data.get("result_status", "unknown")
                print(f"📋 账号状态: {extracted_status}")

            # 保存到对应状态文件
            if save_to_file:
                _save_result(
                    email=email,
                    password=account_info.get("password", ""),
                    secret=account_info.get("secret", ""),
                    status=extracted_status,
                    link=extracted_link,
                    total_steps=task_result.total_steps,
                )

            return True, f"检测成功 ({extracted_status})", extracted_status, extracted_link

        # 任务失败
        print(f"\n❌ 检测失败")
        print(f"原因: {task_result.message}")
        if task_result.error_details:
            print(f"详情: {task_result.error_details[:500]}")

        # 失败也保存到错误文件
        if save_to_file:
            _save_result(
                email=email,
                password=account_info.get("password", ""),
                secret=account_info.get("secret", ""),
                status="error",
                link=None,
                error_msg=task_result.message,
                total_steps=task_result.total_steps,
            )

        return False, task_result.message, "error", None

    except Exception as e:
        traceback.print_exc()
        return False, f"运行失败: {str(e)}", "error", None

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


def _save_result(
    email: str,
    password: str,
    secret: str,
    status: str,
    link: Optional[str] = None,
    error_msg: Optional[str] = None,
    total_steps: int = 0,
):
    """
    根据状态保存结果到对应文件和数据库

    Args:
        email: 邮箱
        password: 密码
        secret: 2FA 密钥
        status: 账号状态
        link: SheerID 链接（可选）
        error_msg: 错误信息（可选）
        total_steps: AI 执行的总步骤数
    """
    try:
        # 根据状态更新数据库
        status_mapping = {
            "subscribed": "subscribed",
            "verified": "verified",
            "link_ready": "link_ready",
            "ineligible": "ineligible",
            "error": "error",
        }
        db_status = status_mapping.get(status, "error")

        # 更新数据库 - 只更新必要字段，不覆盖 recovery_email
        # 注意：这里不传 recovery_email，保留数据库中原有的值
        DBManager.upsert_account(
            email=email,
            password=password,
            secret_key=secret,  # 只更新 secret_key
            # recovery_email 不传，保留原值
            link=link,
            status=db_status,
            message=error_msg or status,
            sheerid_steps=total_steps,
        )
        print(f"✅ 数据库已更新: {email} -> {db_status} (步骤: {total_steps})")

        # 注意：不再调用 AccountManager.move_to_xxx() 方法
        # 因为那些方法会解析 account_line 并可能覆盖 recovery_email
        # 数据库已经更新，文件导出由 DBManager.export_to_files() 统一处理
        DBManager.export_to_files()

        # 记录保存位置（仅用于日志）
        file_names = {
            "subscribed": "已绑卡号.txt",
            "verified": "已验证未绑卡.txt",
            "link_ready": "sheerIDlink.txt",
            "ineligible": "无资格号.txt",
            "error": "超时或其他错误.txt",
        }
        if status in file_names:
            print(f"📁 已保存到: {file_names[status]}")

    except Exception as e:
        print(f"❌ 保存结果失败: {e}")


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

        success, msg, status, link = await auto_get_sheerlink_ai(
            test_browser_id,
            test_account,
            close_after=False,
        )
        print(f"\nResult: success={success}, message={msg}")
        print(f"Status: {status}")
        if link:
            print(f"Link: {link}")

    asyncio.run(test())
