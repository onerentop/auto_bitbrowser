"""
Antigravity OAuth 自动化

使用 StagehandGoogleEngine 自动完成 Sub2API Antigravity 平台账号添加：
1. 前置检查（去重）
2. 启动 OAuth 流程
3. AI Agent 完成授权
4. 完成 OAuth 并保存状态
"""

import asyncio
from typing import Callable, Optional
from dataclasses import dataclass

from services.database import DBManager
from services.sub2api_client import Sub2APIClient

# 导入 StagehandGoogleEngine
try:
    from core.stagehand_engine import StagehandGoogleEngine
    from core.stagehand_engine.constants import GoogleURLs
    STAGEHAND_ENGINE_AVAILABLE = True
except ImportError:
    STAGEHAND_ENGINE_AVAILABLE = False
    StagehandGoogleEngine = None
    GoogleURLs = None


@dataclass
class OAuthResult:
    """OAuth 结果"""
    success: bool
    message: str
    email: str
    sub2api_account_id: Optional[int] = None
    sub2api_status: str = "not_linked"
    error_type: Optional[str] = None
    total_steps: int = 0


async def auto_antigravity_oauth(
    browser_id: str,
    account: dict,
    sub2api_client: Sub2APIClient = None,
    callback: Callable[[str], None] = None,
    api_key: str = None,  # 已废弃，从 ConfigManager 读取
    model: str = None,  # 已废弃
    provider: str = None,  # 已废弃
    max_steps: int = None,  # 已废弃
    skip_login_check: bool = False,
    proxy_allocator = None,
    auto_bind_proxy: bool = True,
) -> OAuthResult:
    """
    执行 Antigravity OAuth 自动化

    使用 StagehandGoogleEngine 执行 OAuth 授权。

    Args:
        browser_id: ixBrowser 窗口 ID
        account: 账号信息 {email, password, secret_key, recovery_email}
        sub2api_client: Sub2API 客户端（可选，会自动创建）
        callback: 进度回调函数
        api_key: 已废弃，AI 配置从 ConfigManager 读取
        model: 已废弃
        provider: 已废弃
        max_steps: 已废弃
        skip_login_check: 是否跳过登录检查
        proxy_allocator: 代理智能分配器（可选）
        auto_bind_proxy: 是否自动绑定代理（默认 True）

    Returns:
        OAuthResult: OAuth 结果
    """
    email = account.get("email", "")
    password = account.get("password", "")
    secret_key = account.get("secret_key", "")

    def log(msg: str):
        """日志输出"""
        print(f"[OAuth] {email}: {msg}")
        if callback:
            callback(f"[{email}] {msg}")

    log("开始 OAuth 流程...")

    # 检查 StagehandGoogleEngine 是否可用
    if not STAGEHAND_ENGINE_AVAILABLE:
        log("[X] StagehandGoogleEngine 不可用")
        return OAuthResult(
            success=False,
            message="StagehandGoogleEngine 不可用",
            email=email,
            error_type="stagehand_unavailable",
        )

    # ========== 前置检查：Sub2API 账号是否已存在 ==========
    if sub2api_client is None:
        sub2api_client = Sub2APIClient()

    try:
        existing_id = await sub2api_client.check_account_exists(email)
        if existing_id:
            log(f"账号已存在于 Sub2API (ID: {existing_id})")
            DBManager.update_sub2api_status(email, "linked", existing_id)
            return OAuthResult(
                success=True,
                message="账号已存在于 Sub2API",
                email=email,
                sub2api_account_id=existing_id,
                sub2api_status="linked",
            )
    except Exception as e:
        log(f"检查 Sub2API 账号失败: {e}")

    engine = None

    try:
        # 连接到 ixBrowser 窗口
        log("连接到 ixBrowser 窗口...")
        engine = await StagehandGoogleEngine.connect_to_ixbrowser(
            browser_id=browser_id,
            use_config=True,
            close_browser_on_exit=False,
        )

        log("StagehandGoogleEngine 已连接")

        # 如果需要登录检查
        if not skip_login_check:
            log("检查登录状态...")
            # 导航到 Google 账号页面检查登录状态
            await engine.navigate(GoogleURLs.ACCOUNT)
            await engine.wait(2000)

            current_url = await engine.get_current_url()
            if "accounts.google.com" in current_url and "signin" in current_url:
                log("未登录，执行登录...")
                login_result = await engine.login(
                    email=email,
                    password=password,
                    totp_secret=secret_key if secret_key else None,
                )
                if not login_result.success:
                    log(f"[X] 登录失败: {login_result.message}")
                    return OAuthResult(
                        success=False,
                        message=f"登录失败: {login_result.message}",
                        email=email,
                        error_type="login_failed",
                    )
                log("[OK] 登录成功")

        # 获取 OAuth URL
        oauth_response = await sub2api_client.start_antigravity_oauth()
        if not oauth_response.success:
            error_msg = oauth_response.error or "无法启动 OAuth 流程"
            log(f"[X] {error_msg}")
            return OAuthResult(
                success=False,
                message=error_msg,
                email=email,
                error_type="oauth_url_failed",
            )

        oauth_url = oauth_response.data.get("auth_url") if oauth_response.data else None
        if not oauth_url:
            log("[X] 无法获取 OAuth URL")
            return OAuthResult(
                success=False,
                message="无法获取 OAuth URL",
                email=email,
                error_type="oauth_url_failed",
            )

        log(f"OAuth URL: {oauth_url[:50]}...")

        # 执行 OAuth 授权
        log("执行 OAuth 授权...")
        oauth_result = await engine.oauth_authorize(
            service="antigravity",
            oauth_url=oauth_url,
        )

        if oauth_result.success:
            log("[OK] OAuth 授权成功")

            # 更新数据库状态
            account_id = oauth_result.account_id
            if account_id:
                DBManager.update_sub2api_status(email, "linked", int(account_id))

            return OAuthResult(
                success=True,
                message="OAuth 授权成功",
                email=email,
                sub2api_account_id=int(account_id) if account_id else None,
                sub2api_status="linked",
            )
        else:
            error_msg = oauth_result.error or oauth_result.message or "OAuth 授权失败"
            log(f"[X] {error_msg}")
            return OAuthResult(
                success=False,
                message=error_msg,
                email=email,
                error_type="oauth_failed",
            )

    except Exception as e:
        error_msg = str(e)
        log(f"[X] 异常: {error_msg}")
        return OAuthResult(
            success=False,
            message=f"OAuth 异常: {error_msg}",
            email=email,
            error_type="exception",
        )

    finally:
        # 确保清理资源（不关闭浏览器窗口）
        if engine and engine.is_initialized:
            try:
                await engine.stop(close_browser=False)
            except Exception:
                pass


async def batch_antigravity_oauth(
    accounts: list,
    browser_ids: list,
    callback: Callable[[str], None] = None,
    sub2api_client: Sub2APIClient = None,
    skip_login_check: bool = False,
) -> dict:
    """
    批量执行 Antigravity OAuth

    Args:
        accounts: 账号列表
        browser_ids: 浏览器 ID 列表
        callback: 进度回调函数
        sub2api_client: Sub2API 客户端
        skip_login_check: 是否跳过登录检查

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
        print(f"[BatchOAuth] {msg}")
        if callback:
            callback(msg)

    if sub2api_client is None:
        sub2api_client = Sub2APIClient()

    for i, (account, browser_id) in enumerate(zip(accounts, browser_ids)):
        email = account.get("email", "")
        log(f"[{i+1}/{len(accounts)}] 处理: {email}")

        result = await auto_antigravity_oauth(
            browser_id=browser_id,
            account=account,
            sub2api_client=sub2api_client,
            callback=callback,
            skip_login_check=skip_login_check,
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
        print("Antigravity OAuth 测试 (StagehandGoogleEngine)")
        print("=" * 50)

        # 测试账号（需要替换为真实账号）
        test_account = {
            "email": "test@gmail.com",
            "password": "test_password",
            "secret_key": "",
        }

        # 测试浏览器 ID（需要替换为真实 ID）
        test_browser_id = "12345"

        result = await auto_antigravity_oauth(
            browser_id=test_browser_id,
            account=test_account,
            callback=print,
        )

        print(f"\n结果: {result}")

    asyncio.run(main())
