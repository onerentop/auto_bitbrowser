"""
自动踢出非本机登录设备 - StagehandGoogleEngine 版

使用 StagehandGoogleEngine 自动完成操作
1. 进入设备管理页面
2. 识别本机设备（"您的当前会话"）
3. 逐个踢出其他设备
"""

import asyncio
import traceback
from typing import Optional, Tuple

from core.stagehand_engine import StagehandGoogleEngine


async def auto_kick_devices(
    browser_id: str,
    account_info: dict,
    close_after: bool = False,
    max_steps: int = 50,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    model: Optional[str] = None,
    provider: Optional[str] = None,
) -> Tuple[bool, str, int]:
    """
    踢出非本机登录设备

    Args:
        browser_id: ixBrowser 窗口 ID
        account_info: 账号信息 {'email', 'password', 'secret'}
        close_after: 完成后是否关闭浏览器
        max_steps: 最大执行步骤数（保留兼容）
        api_key: API Key（可选，默认从配置读取）
        base_url: API Base URL（可选，用于第三方服务）
        model: 使用的模型（可选，默认从配置读取）
        provider: LLM 提供商（已废弃）

    Returns:
        (success: bool, message: str, kicked_count: int)
        - success: 是否成功
        - message: 结果消息
        - kicked_count: 踢出的设备数量
    """
    email = account_info.get("email", "Unknown")
    print(f"\n{'='*50}")
    print(f"踢出非本机登录设备 (StagehandGoogleEngine)")
    print(f"账号: {email}")
    print(f"{'='*50}")

    engine = None
    kicked_count = 0

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

        # 2. 执行踢出设备操作
        print("执行踢出设备操作...")
        result = await engine.kick_devices(
            keep_current=True,
        )

        # 3. 处理结果
        kicked_count = result.kicked_count or 0

        if result.success:
            print(f"\n✅ 踢出设备任务完成!")
            print(f"耗时: {result.duration_ms:.0f}ms")

            if kicked_count > 0:
                return True, f"成功踢出 {kicked_count} 个设备", kicked_count
            else:
                return True, "没有需要踢出的设备（仅本机登录）", 0

        # 任务失败
        print(f"\n❌ 踢出设备失败")
        print(f"原因: {result.message}")
        if result.error:
            print(f"详情: {result.error[:500]}")

        return False, result.message, kicked_count

    except Exception as e:
        traceback.print_exc()
        return False, f"运行失败: {str(e)}", kicked_count

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

        success, msg, count = await auto_kick_devices(
            test_browser_id,
            test_account,
            close_after=False,
        )
        print(f"\nResult: {success}, {msg}")
        print(f"Kicked devices: {count}")

    asyncio.run(test())
