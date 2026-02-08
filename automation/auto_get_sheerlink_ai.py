"""
自动获取 Google One AI Student SheerID 验证链接 - StagehandGoogleEngine 版

使用 StagehandGoogleEngine 自动检测账号状态并提取 SheerID 链接
支持状态检测: subscribed, verified, link_ready, ineligible
"""

import asyncio
import traceback
from typing import Optional, Tuple

from core.stagehand_engine import StagehandGoogleEngine
from services.database import DBManager


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
        max_steps: 最大执行步骤数（保留兼容）
        api_key: API Key（可选，默认从配置读取）
        base_url: API Base URL（可选，用于第三方服务）
        model: 使用的模型（可选，默认从配置读取）
        provider: LLM 提供商（已废弃）
        save_to_file: 是否保存到对应状态文件

    Returns:
        (success: bool, message: str, status: Optional[str], link: Optional[str])
        - success: 是否成功
        - message: 结果消息
        - status: 账号状态 (subscribed/verified/link_ready/ineligible/error)
        - link: SheerID 验证链接（status=link_ready 时返回）
    """
    email = account_info.get("email", "Unknown")
    print(f"\n{'='*50}")
    print(f"获取 SheerID 验证链接 (StagehandGoogleEngine)")
    print(f"账号: {email}")
    print(f"{'='*50}")

    engine = None
    extracted_status = None
    extracted_link = None

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

        # 2. 执行获取 SheerID 链接操作
        print("检测账号状态并获取 SheerID 链接...")
        result = await engine.get_sheerlink(
            navigate_if_needed=True,
        )

        # 3. 处理结果
        if result.success:
            extracted_status = result.status or "unknown"
            extracted_link = result.sheerlink

            print(f"\n🔗 提取到链接: {extracted_link[:50]}..." if extracted_link else "")
            print(f"📋 账号状态: {extracted_status}")

            # 保存到对应状态文件
            if save_to_file:
                _save_result(
                    email=email,
                    password=account_info.get("password", ""),
                    secret=account_info.get("secret", ""),
                    status=extracted_status,
                    link=extracted_link,
                    duration_ms=result.duration_ms,
                )

            return True, f"检测成功 ({extracted_status})", extracted_status, extracted_link

        # 任务失败
        print(f"\n❌ 检测失败")
        print(f"原因: {result.message}")
        if result.error:
            print(f"详情: {result.error[:500]}")

        # 失败也保存到错误文件
        if save_to_file:
            _save_result(
                email=email,
                password=account_info.get("password", ""),
                secret=account_info.get("secret", ""),
                status="error",
                link=None,
                error_msg=result.message,
                duration_ms=result.duration_ms,
            )

        return False, result.message, "error", None

    except Exception as e:
        traceback.print_exc()
        return False, f"运行失败: {str(e)}", "error", None

    finally:
        # 清理资源
        if engine:
            try:
                await engine.stop(close_browser=close_after)
            except Exception:
                pass


def _save_result(
    email: str,
    password: str,
    secret: str,
    status: str,
    link: Optional[str] = None,
    error_msg: Optional[str] = None,
    duration_ms: float = 0,
):
    """
    根据状态保存结果到对应文件和数据库
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
        DBManager.upsert_account(
            email=email,
            password=password,
            secret_key=secret,
            link=link,
            status=db_status,
            message=error_msg or status,
            sheerid_steps=int(duration_ms / 1000) if duration_ms else 0,
        )
        print(f"✅ 数据库已更新: {email} -> {db_status}")

        # 统一导出
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
