"""
自动绑卡订阅 - StagehandGoogleEngine 版

使用 StagehandGoogleEngine 自动完成 Google One AI Student 绑卡订阅
统一使用 Stagehand AI 驱动浏览器自动化
"""

import asyncio
import traceback
from typing import Optional, Tuple

from core.stagehand_engine import StagehandGoogleEngine
from services.database import DBManager


async def auto_bind_card_ai(
    browser_id: str,
    account_info: dict,
    card_info: dict,
    close_after: bool = False,
    max_steps: int = 40,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    model: Optional[str] = None,
    provider: Optional[str] = None,
) -> Tuple[bool, str]:
    """
    使用 StagehandGoogleEngine 完成绑卡订阅

    Args:
        browser_id: ixBrowser 窗口 ID
        account_info: 账号信息 {'email', 'password', 'secret'}
        card_info: 卡片信息 {'number', 'exp_month', 'exp_year', 'cvv', 'name', 'zip_code'}
        close_after: 完成后是否关闭浏览器
        max_steps: 最大执行步骤数（保留兼容，实际由 engine 控制）
        api_key: API Key（可选，默认从配置读取）
        base_url: API Base URL（可选，用于第三方服务）
        model: 使用的模型（可选，默认从配置读取）
        provider: LLM 提供商（已废弃，由 ConfigManager 统一管理）

    Returns:
        (success: bool, message: str)
    """
    email = account_info.get("email", "Unknown")
    card_number = card_info.get('number', '')
    card_masked = f"**** **** **** {card_number[-4:]}" if len(card_number) >= 4 else "****"

    print(f"\n{'='*50}")
    print(f"StagehandGoogleEngine 绑卡订阅")
    print(f"账号: {email}")
    print(f"卡片: {card_masked}")
    print(f"{'='*50}")

    engine = None

    try:
        # 构建模型名称（如果指定了 model 参数）
        model_name = None
        if model:
            # 转换为 Stagehand 格式: "provider/model"
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

        # 2. 构建卡片有效期
        exp_month = card_info.get("exp_month", "")
        exp_year = card_info.get("exp_year", "")
        card_exp = f"{exp_month}/{exp_year}" if exp_month and exp_year else ""

        # 3. 执行绑卡操作
        print("执行绑卡订阅操作...")
        result = await engine.bind_card(
            card_number=card_info.get("number", ""),
            card_exp=card_exp,
            card_cvv=card_info.get("cvv", ""),
            card_name=card_info.get("name", "John Smith"),
            zip_code=card_info.get("zip_code", "10001"),
        )

        # 4. 处理结果
        if result.success:
            print(f"\n✅ 绑卡订阅成功!")
            print(f"耗时: {result.duration_ms:.0f}ms")

            # 更新账号状态为已订阅
            try:
                DBManager.upsert_account(
                    email=email,
                    status="subscribed",
                    message="绑卡订阅成功",
                )
                # 记录绑卡历史
                if card_number:
                    masked_card = card_number[-4:] if len(card_number) >= 4 else card_number
                    DBManager.add_bind_card_history(email, masked_card)

                DBManager.export_to_files()
                print(f"✅ 账号状态已更新为 subscribed")
            except Exception as e:
                print(f"⚠️ 更新账号状态失败（不影响绑卡结果）: {e}")

            return True, "绑卡订阅成功"

        # 任务失败
        print(f"\n❌ 绑卡订阅失败")
        print(f"原因: {result.message}")
        if result.error:
            print(f"详情: {result.error[:500]}")

        return False, result.message

    except Exception as e:
        traceback.print_exc()
        return False, f"运行失败: {str(e)}"

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
