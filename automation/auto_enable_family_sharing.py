"""
自动开启家庭组共享

使用 StagehandGoogleEngine 为普通 Pro 账户开启家庭组共享功能：
1. 导航到 Google One 设置页面
2. 展开 "Manage family settings"
3. 开启 "Share Google One with family" 开关
4. 更新数据库状态
"""

import asyncio
from typing import Callable, Optional
from dataclasses import dataclass

from services.database import DBManager

# 导入 StagehandGoogleEngine
try:
    from core.stagehand_engine import StagehandGoogleEngine
    STAGEHAND_ENGINE_AVAILABLE = True
except ImportError:
    STAGEHAND_ENGINE_AVAILABLE = False
    StagehandGoogleEngine = None


@dataclass
class EnableFamilySharingResult:
    """开启家庭共享结果"""
    success: bool
    message: str
    email: str
    was_already_enabled: bool = False
    family_created: bool = False  # 是否创建了新的家庭组
    error_type: Optional[str] = None
    total_steps: int = 0


async def auto_enable_family_sharing(
    browser_id: str,
    account: dict,
    callback: Callable[[str], None] = None,
    api_key: str = None,  # 已废弃，从 ConfigManager 读取
    model: str = None,  # 已废弃
    provider: str = None,  # 已废弃
    max_steps: int = None,  # 已废弃
    close_browser_on_success: bool = False,
) -> EnableFamilySharingResult:
    """
    开启家庭组共享功能

    使用 StagehandGoogleEngine 执行开启家庭共享操作。

    Args:
        browser_id: ixBrowser 窗口 ID
        account: 账号信息 {email, password, secret_key}
        callback: 进度回调函数
        api_key: 已废弃，AI 配置从 ConfigManager 读取
        model: 已废弃
        provider: 已废弃
        max_steps: 已废弃
        close_browser_on_success: 成功后是否关闭浏览器窗口

    Returns:
        EnableFamilySharingResult: 操作结果
    """
    email = account.get("email", "")

    def log(msg: str):
        """日志输出"""
        print(f"[EnableFamilySharing] {email}: {msg}")
        if callback:
            callback(f"[{email}] {msg}")

    log("开始开启家庭组共享...")

    # 检查 StagehandGoogleEngine 是否可用
    if not STAGEHAND_ENGINE_AVAILABLE:
        log("[X] StagehandGoogleEngine 不可用")
        return EnableFamilySharingResult(
            success=False,
            message="StagehandGoogleEngine 不可用",
            email=email,
            error_type="stagehand_unavailable",
        )

    engine = None

    try:
        # 连接到 ixBrowser 窗口
        log("连接到 ixBrowser 窗口...")
        engine = await StagehandGoogleEngine.connect_to_ixbrowser(
            browser_id=browser_id,
            use_config=True,
            close_browser_on_exit=close_browser_on_success,
        )

        log("StagehandGoogleEngine 已连接")

        # 执行开启家庭共享操作
        log("执行开启家庭共享...")
        result = await engine.enable_family_sharing()

        if result.success:
            log("[OK] 家庭共享已开启")

            # 更新数据库
            DBManager.update_family_sharing_status(email, True)

            if result.family_created:
                DBManager.update_family_member_count(email, 1)
                log("已创建新的家庭组")

            return EnableFamilySharingResult(
                success=True,
                message="家庭共享已开启" if not result.was_already_enabled else "家庭共享已处于开启状态",
                email=email,
                was_already_enabled=result.was_already_enabled,
                family_created=result.family_created,
            )
        else:
            error_msg = result.error or result.message or "开启家庭共享失败"
            log(f"[X] {error_msg}")
            return EnableFamilySharingResult(
                success=False,
                message=error_msg,
                email=email,
                error_type="enable_sharing_failed",
            )

    except Exception as e:
        error_msg = str(e)
        log(f"[X] 异常: {error_msg}")
        return EnableFamilySharingResult(
            success=False,
            message=f"开启家庭共享异常: {error_msg}",
            email=email,
            error_type="exception",
        )

    finally:
        # 确保清理资源
        if engine and engine.is_initialized:
            try:
                await engine.stop(close_browser=close_browser_on_success)
            except Exception:
                pass


async def batch_enable_family_sharing(
    accounts: list,
    browser_ids: list,
    callback: Callable[[str], None] = None,
    close_browser_on_success: bool = False,
) -> dict:
    """
    批量开启家庭组共享

    Args:
        accounts: 账号列表
        browser_ids: 浏览器 ID 列表
        callback: 进度回调函数
        close_browser_on_success: 成功后是否关闭浏览器窗口

    Returns:
        dict: {total, success_count, failed_count, results}
    """
    results = {
        "total": len(accounts),
        "success_count": 0,
        "failed_count": 0,
        "results": [],
    }

    def log(msg: str):
        print(f"[BatchEnableSharing] {msg}")
        if callback:
            callback(msg)

    for i, (account, browser_id) in enumerate(zip(accounts, browser_ids)):
        email = account.get("email", "")
        log(f"[{i+1}/{len(accounts)}] 处理: {email}")

        result = await auto_enable_family_sharing(
            browser_id=browser_id,
            account=account,
            callback=callback,
            close_browser_on_success=close_browser_on_success,
        )

        results["results"].append(result)

        if result.success:
            results["success_count"] += 1
            log(f"[{email}] ✅ 成功")
        else:
            results["failed_count"] += 1
            log(f"[{email}] ❌ 失败: {result.message}")

    log(f"批量完成: 成功 {results['success_count']}, 失败 {results['failed_count']}")
    return results


# ==================== 测试代码 ====================

if __name__ == "__main__":
    async def main():
        print("开启家庭共享测试 (StagehandGoogleEngine)")
        print("=" * 50)

        # 测试账号（需要替换为真实账号）
        test_account = {
            "email": "pro_account@gmail.com",
            "password": "password",
            "secret_key": "",
        }

        # 测试浏览器 ID（需要替换为真实 ID）
        test_browser_id = "12345"

        result = await auto_enable_family_sharing(
            browser_id=test_browser_id,
            account=test_account,
            callback=print,
        )

        print(f"\n结果: {result}")

    asyncio.run(main())
