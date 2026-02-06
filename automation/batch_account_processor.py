"""
批量账号处理器

支持批量登录和批量 OAuth，使用 asyncio.Semaphore 控制并发。
"""

import asyncio
import os
import traceback
from typing import Callable, List, Optional, Dict, Any
from dataclasses import dataclass, field
from datetime import datetime

from core.config_manager import ConfigManager
from core.retry_helper import RetryHelper
from services.database import DBManager
from services.sub2api_client import Sub2APIClient
from services.ix_api import closeBrowser

# 尝试导入 CDP 服务
try:
    from core.ai_browser_agent import create_cdp_service, CDP_SERVICE_AVAILABLE
except ImportError:
    CDP_SERVICE_AVAILABLE = False
    create_cdp_service = None

# 尝试导入 Stagehand SDK
try:
    from stagehand import AsyncStagehand
    STAGEHAND_AVAILABLE = True
except ImportError:
    STAGEHAND_AVAILABLE = False
    AsyncStagehand = None
from services.proxy_smart_allocator import ProxySmartAllocator
from automation.auto_google_login import auto_google_login, LoginResult
from automation.auto_antigravity_oauth import auto_antigravity_oauth, OAuthResult
from automation.auto_unlock_403 import auto_unlock_403, UnlockResult
from services.sms_bus_client import SMSBusClient


@dataclass
class BatchResult:
    """批量处理结果"""
    total: int
    success_count: int = 0
    failed_count: int = 0
    skipped_count: int = 0
    results: List[Dict[str, Any]] = field(default_factory=list)
    start_time: Optional[datetime] = None
    end_time: Optional[datetime] = None

    @property
    def success_rate(self) -> float:
        """成功率"""
        processed = self.success_count + self.failed_count
        return self.success_count / processed if processed > 0 else 0

    @property
    def duration_seconds(self) -> float:
        """执行时长（秒）"""
        if self.start_time and self.end_time:
            return (self.end_time - self.start_time).total_seconds()
        return 0

    def add_success(self, email: str, data: Dict = None):
        """添加成功结果"""
        self.success_count += 1
        self.results.append({
            "email": email,
            "status": "success",
            "data": data or {},
        })

    def add_failed(self, email: str, error: str, error_type: str = None):
        """添加失败结果"""
        self.failed_count += 1
        self.results.append({
            "email": email,
            "status": "failed",
            "error": error,
            "error_type": error_type,
        })

    def add_skipped(self, email: str, reason: str):
        """添加跳过结果"""
        self.skipped_count += 1
        self.results.append({
            "email": email,
            "status": "skipped",
            "reason": reason,
        })

    def to_dict(self) -> Dict:
        """转换为字典"""
        return {
            "total": self.total,
            "success_count": self.success_count,
            "failed_count": self.failed_count,
            "skipped_count": self.skipped_count,
            "success_rate": f"{self.success_rate:.1%}",
            "duration_seconds": self.duration_seconds,
            "results": self.results,
        }


class BatchAccountProcessor:
    """
    批量账号处理器

    使用示例:
        processor = BatchAccountProcessor(concurrency=3)

        # 批量登录
        result = await processor.batch_login(accounts, browser_ids)

        # 批量 OAuth
        result = await processor.batch_oauth(accounts, browser_ids, sub2api_client)
    """

    def __init__(
        self,
        concurrency: int = None,
        retry_times: int = 2,
        callback: Callable[[str], None] = None,
    ):
        """
        初始化批量处理器

        Args:
            concurrency: 并发数，默认从配置读取
            retry_times: 重试次数
            callback: 进度回调函数
        """
        self.concurrency = concurrency or ConfigManager.get_login_concurrency()
        self.retry_helper = RetryHelper(max_retries=retry_times, base_delay=2.0)
        self.callback = callback
        self._semaphore: Optional[asyncio.Semaphore] = None
        self._stop_flag = False

    def _log(self, msg: str):
        """日志输出"""
        print(f"[BatchProcessor] {msg}")
        if self.callback:
            self.callback(msg)

    def stop(self):
        """停止处理"""
        self._stop_flag = True
        self._log("收到停止信号")

    async def batch_login(
        self,
        accounts: List[Dict],
        browser_ids: List[str],
        api_key: str = None,
        model: str = None,
        provider: str = None,
    ) -> BatchResult:
        """
        批量执行登录

        Args:
            accounts: 账号列表，每个账号是 {email, password, secret_key, recovery_email}
            browser_ids: 浏览器窗口 ID 列表（与账号一一对应）
            api_key: AI API Key
            model: AI 模型名称
            provider: AI 提供商

        Returns:
            BatchResult: 批量处理结果
        """
        if len(accounts) != len(browser_ids):
            raise ValueError("账号数量与浏览器窗口数量不匹配")

        result = BatchResult(total=len(accounts))
        result.start_time = datetime.now()
        self._stop_flag = False
        self._semaphore = asyncio.Semaphore(self.concurrency)

        self._log(f"开始批量登录，共 {len(accounts)} 个账号，并发数 {self.concurrency}")

        # 创建任务
        tasks = []
        for account, browser_id in zip(accounts, browser_ids):
            task = self._login_with_semaphore(
                account=account,
                browser_id=browser_id,
                result=result,
                api_key=api_key,
                model=model,
                provider=provider,
            )
            tasks.append(task)

        # 并发执行
        await asyncio.gather(*tasks, return_exceptions=True)

        result.end_time = datetime.now()
        self._log(
            f"批量登录完成: 成功 {result.success_count}, "
            f"失败 {result.failed_count}, "
            f"跳过 {result.skipped_count}, "
            f"耗时 {result.duration_seconds:.1f}s"
        )

        return result

    async def _login_with_semaphore(
        self,
        account: Dict,
        browser_id: str,
        result: BatchResult,
        api_key: str = None,
        model: str = None,
        provider: str = None,
    ):
        """带信号量控制的登录任务"""
        email = account.get("email", "unknown")

        if self._stop_flag:
            result.add_skipped(email, "用户停止")
            return

        async with self._semaphore:
            if self._stop_flag:
                result.add_skipped(email, "用户停止")
                return

            try:
                # 检查是否已登录
                db_account = DBManager.get_account_by_email(email)
                if db_account and db_account.get("login_status") == "logged_in":
                    result.add_skipped(email, "已登录")
                    self._log(f"[{email}] 已登录，跳过")
                    return

                self._log(f"[{email}] 开始登录...")

                # 执行登录
                login_result = await auto_google_login(
                    browser_id=browser_id,
                    account=account,
                    callback=self.callback,
                    api_key=api_key,
                    model=model,
                    provider=provider,
                )

                if login_result.success:
                    result.add_success(email, {
                        "browser_id": browser_id,
                        "total_steps": login_result.total_steps,
                    })
                    self._log(f"[{email}] ✅ 登录成功")
                else:
                    result.add_failed(email, login_result.message, login_result.error_type)
                    self._log(f"[{email}] ❌ 登录失败: {login_result.message}")

            except Exception as e:
                result.add_failed(email, str(e), "exception")
                self._log(f"[{email}] ❌ 异常: {e}")

    async def batch_oauth(
        self,
        accounts: List[Dict],
        browser_ids: List[str],
        sub2api_client: Sub2APIClient = None,
        api_key: str = None,
        model: str = None,
        provider: str = None,
        skip_login: bool = False,
        auto_bind_proxy: bool = True,
    ) -> BatchResult:
        """
        批量执行 OAuth

        Args:
            accounts: 账号列表
            browser_ids: 浏览器窗口 ID 列表
            sub2api_client: Sub2API 客户端（可选）
            api_key: AI API Key
            model: AI 模型名称
            provider: AI 提供商
            skip_login: 是否跳过登录检查
            auto_bind_proxy: 是否自动绑定代理（默认 True）

        Returns:
            BatchResult: 批量处理结果
        """
        if len(accounts) != len(browser_ids):
            raise ValueError("账号数量与浏览器窗口数量不匹配")

        result = BatchResult(total=len(accounts))
        result.start_time = datetime.now()
        self._stop_flag = False
        self._semaphore = asyncio.Semaphore(self.concurrency)

        self._log(f"开始批量 OAuth，共 {len(accounts)} 个账号，并发数 {self.concurrency}")

        # 创建或使用传入的客户端
        client_created = False
        if sub2api_client is None:
            sub2api_client = Sub2APIClient()
            await sub2api_client._ensure_session()
            client_created = True

        # 创建代理智能分配器（如果启用）
        proxy_allocator = None
        if auto_bind_proxy:
            proxy_allocator = ProxySmartAllocator(sub2api_client)
            self._log("代理智能分配器已启用")

        try:
            # 创建任务
            tasks = []
            for account, browser_id in zip(accounts, browser_ids):
                task = self._oauth_with_semaphore(
                    account=account,
                    browser_id=browser_id,
                    sub2api_client=sub2api_client,
                    result=result,
                    api_key=api_key,
                    model=model,
                    provider=provider,
                    skip_login=skip_login,
                    proxy_allocator=proxy_allocator,
                    auto_bind_proxy=auto_bind_proxy,
                )
                tasks.append(task)

            # 并发执行
            await asyncio.gather(*tasks, return_exceptions=True)

        finally:
            if client_created:
                await sub2api_client.close()

        result.end_time = datetime.now()
        self._log(
            f"批量 OAuth 完成: 成功 {result.success_count}, "
            f"失败 {result.failed_count}, "
            f"跳过 {result.skipped_count}, "
            f"耗时 {result.duration_seconds:.1f}s"
        )

        return result

    async def _oauth_with_semaphore(
        self,
        account: Dict,
        browser_id: str,
        sub2api_client: Sub2APIClient,
        result: BatchResult,
        api_key: str = None,
        model: str = None,
        provider: str = None,
        skip_login: bool = False,
        proxy_allocator: ProxySmartAllocator = None,
        auto_bind_proxy: bool = True,
    ):
        """带信号量控制的 OAuth 任务"""
        email = account.get("email", "unknown")

        if self._stop_flag:
            result.add_skipped(email, "用户停止")
            return

        async with self._semaphore:
            if self._stop_flag:
                result.add_skipped(email, "用户停止")
                return

            try:
                # 检查是否已关联
                db_account = DBManager.get_account_by_email(email)
                if db_account and db_account.get("sub2api_status") == "linked":
                    result.add_skipped(email, "已关联")
                    self._log(f"[{email}] 已关联 Sub2API，跳过")
                    return

                self._log(f"[{email}] 开始 OAuth...")

                # 执行 OAuth
                oauth_result = await auto_antigravity_oauth(
                    browser_id=browser_id,
                    account=account,
                    sub2api_client=sub2api_client,
                    callback=self.callback,
                    api_key=api_key,
                    model=model,
                    provider=provider,
                    skip_login_check=skip_login,
                    proxy_allocator=proxy_allocator,
                    auto_bind_proxy=auto_bind_proxy,
                )

                if oauth_result.success:
                    result.add_success(email, {
                        "browser_id": browser_id,
                        "sub2api_account_id": oauth_result.sub2api_account_id,
                        "total_steps": oauth_result.total_steps,
                    })
                    self._log(f"[{email}] ✅ OAuth 成功")
                    # 成功时关闭浏览器窗口
                    try:
                        closeBrowser(browser_id)
                        self._log(f"[{email}] 浏览器窗口已关闭")
                    except Exception as e:
                        self._log(f"[{email}] 关闭窗口失败: {e}")
                else:
                    result.add_failed(email, oauth_result.message, oauth_result.error_type)
                    self._log(f"[{email}] ❌ OAuth 失败: {oauth_result.message}")
                    # 失败时不关闭浏览器，方便调试

            except Exception as e:
                result.add_failed(email, str(e), "exception")
                self._log(f"[{email}] ❌ 异常: {e}")

    async def batch_login_and_oauth(
        self,
        accounts: List[Dict],
        browser_ids: List[str],
        sub2api_client: Sub2APIClient = None,
        api_key: str = None,
        model: str = None,
        provider: str = None,
        auto_bind_proxy: bool = True,
    ) -> Dict[str, BatchResult]:
        """
        批量执行登录 + OAuth（先登录后 OAuth）

        Args:
            accounts: 账号列表
            browser_ids: 浏览器窗口 ID 列表
            sub2api_client: Sub2API 客户端
            api_key: AI API Key
            model: AI 模型名称
            provider: AI 提供商
            auto_bind_proxy: 是否自动绑定代理（默认 True）

        Returns:
            Dict: {"login": BatchResult, "oauth": BatchResult}
        """
        self._log("=== 阶段 1: 批量登录 ===")

        # 先执行登录
        login_result = await self.batch_login(
            accounts=accounts,
            browser_ids=browser_ids,
            api_key=api_key,
            model=model,
            provider=provider,
        )

        if self._stop_flag:
            return {"login": login_result, "oauth": BatchResult(total=0)}

        # 筛选登录成功的账号
        logged_in_accounts = []
        logged_in_browser_ids = []

        for account, browser_id in zip(accounts, browser_ids):
            email = account.get("email", "")
            db_account = DBManager.get_account_by_email(email)
            if db_account and db_account.get("login_status") == "logged_in":
                logged_in_accounts.append(account)
                logged_in_browser_ids.append(browser_id)

        self._log(f"登录成功 {len(logged_in_accounts)} 个账号，继续 OAuth...")

        if not logged_in_accounts:
            return {"login": login_result, "oauth": BatchResult(total=0)}

        self._log("=== 阶段 2: 批量 OAuth ===")

        # 执行 OAuth（跳过登录检查，因为已经登录）
        oauth_result = await self.batch_oauth(
            accounts=logged_in_accounts,
            browser_ids=logged_in_browser_ids,
            sub2api_client=sub2api_client,
            api_key=api_key,
            model=model,
            provider=provider,
            skip_login=True,
            auto_bind_proxy=auto_bind_proxy,
        )

        return {"login": login_result, "oauth": oauth_result}

    async def batch_unlock_403(
        self,
        accounts: List[Dict],
        browser_ids: List[str],
        sms_token: str = None,
        country_id: int = None,
        project_id: int = None,
        max_retries: int = None,  # None = 从配置读取
        api_key: str = None,
        model: str = None,
        provider: str = None,
    ) -> BatchResult:
        """
        批量解锁 403 账户

        Args:
            accounts: 账号列表，每个账号需要包含 validation_url
            browser_ids: 浏览器窗口 ID 列表（与账号一一对应）
            sms_token: SMS-Bus API Token（可选，默认从配置读取）
            country_id: 国家 ID（None = 自动选最便宜）
            project_id: 服务 ID（None = Google）
            max_retries: 最大重试次数
            api_key: AI API Key
            model: AI 模型名称
            provider: AI 提供商

        Returns:
            BatchResult: 批量处理结果
        """
        if len(accounts) != len(browser_ids):
            raise ValueError("账号数量与浏览器窗口数量不匹配")

        result = BatchResult(total=len(accounts))
        result.start_time = datetime.now()
        self._stop_flag = False
        self._semaphore = asyncio.Semaphore(self.concurrency)

        self._log(f"开始批量 403 解锁，共 {len(accounts)} 个账号，并发数 {self.concurrency}")

        # 显示 SMS-Bus 配置
        self._log(f"SMS-Bus 配置: country_id={country_id}, project_id={project_id}, max_retries={max_retries}")

        # 创建 SMS-Bus 客户端
        if not sms_token:
            sms_token = ConfigManager.get_sms_bus_token()

        if not sms_token:
            self._log("❌ SMS-Bus Token 未配置")
            result.end_time = datetime.now()
            return result

        # 使用 Sub2APIClient 重新获取 validation_url
        async with Sub2APIClient() as sub2api_client, SMSBusClient(token=sms_token) as sms_client:
            # 创建任务
            tasks = []
            for account, browser_id in zip(accounts, browser_ids):
                task = self._unlock_with_semaphore(
                    account=account,
                    browser_id=browser_id,
                    sms_client=sms_client,
                    result=result,
                    country_id=country_id,
                    project_id=project_id,
                    max_retries=max_retries,
                    api_key=api_key,
                    model=model,
                    provider=provider,
                    sub2api_client=sub2api_client,  # 传递 Sub2API 客户端
                )
                tasks.append(task)

            # 并发执行
            await asyncio.gather(*tasks, return_exceptions=True)

        result.end_time = datetime.now()
        self._log(
            f"批量 403 解锁完成: 成功 {result.success_count}, "
            f"失败 {result.failed_count}, "
            f"跳过 {result.skipped_count}, "
            f"耗时 {result.duration_seconds:.1f}s"
        )

        return result

    async def _unlock_with_semaphore(
        self,
        account: Dict,
        browser_id: str,
        sms_client: SMSBusClient,
        result: BatchResult,
        country_id: int = None,
        project_id: int = None,
        max_retries: int = None,  # None = 从配置读取
        api_key: str = None,
        model: str = None,
        provider: str = None,
        sub2api_client: Sub2APIClient = None,
    ):
        """带信号量控制的解锁任务"""
        email = account.get("email", "unknown")
        validation_url = account.get("validation_url", "")

        if self._stop_flag:
            result.add_skipped(email, "用户停止")
            return

        async with self._semaphore:
            if self._stop_flag:
                result.add_skipped(email, "用户停止")
                return

            try:
                self._log(f"[{email}] 开始解锁...")

                # 重要：重新检测 403 获取最新的 validation_url
                # 因为旧的 validation_url 可能已过期或被访问过
                if sub2api_client:
                    self._log(f"[{email}] 重新检测 403 状态以获取新的验证链接...")

                    # 查找 Sub2API 账号 ID
                    account_id = await sub2api_client.check_account_exists(email)
                    if account_id:
                        # 测试连接获取最新的 validation_url
                        test_result = await sub2api_client.test_account_connection(account_id)
                        test_data = test_result.data or {}  # 防止 data 为 None

                        if not test_result.success and test_data.get("needs_unlock"):
                            new_validation_url = test_data.get("validation_url", "")
                            if new_validation_url:
                                self._log(f"[{email}] 获取到新的验证链接")
                                validation_url = new_validation_url
                                # 更新数据库中的 validation_url
                                DBManager.update_unlock_status(email, "needs_unlock", validation_url)
                            else:
                                self._log(f"[{email}] [!] 未获取到新的验证链接，使用数据库中的链接")
                        elif test_result.success:
                            # 账号已不再是 403 状态
                            self._log(f"[{email}] ✅ 账号已不再需要解锁（403 已解除）")
                            DBManager.update_unlock_status(email, "unlocked")
                            result.add_success(email, {"skipped": True, "reason": "已解锁"})
                            return
                        else:
                            # 其他失败情况
                            self._log(f"[{email}] [!] 检测返回异常: {test_result.error}，使用数据库中的链接")
                    else:
                        self._log(f"[{email}] [!] 未找到 Sub2API 账号，使用数据库中的验证链接")

                # 检查是否有验证链接
                if not validation_url:
                    result.add_skipped(email, "无验证链接")
                    self._log(f"[{email}] 无验证链接，跳过")
                    return

                # 执行解锁
                unlock_result = await auto_unlock_403(
                    browser_id=browser_id,
                    account=account,
                    validation_url=validation_url,
                    sms_client=sms_client,
                    country_id=country_id,
                    project_id=project_id,
                    max_retries=max_retries,
                    callback=self.callback,
                    api_key=api_key,
                    model=model,
                    provider=provider,
                )

                if unlock_result.success:
                    result.add_success(email, {
                        "browser_id": browser_id,
                        "phone_used": unlock_result.phone_used,
                        "attempts": unlock_result.attempts,
                    })
                    self._log(f"[{email}] ✅ 解锁成功")
                    # 成功时关闭浏览器窗口
                    try:
                        closeBrowser(browser_id)
                        self._log(f"[{email}] 浏览器窗口已关闭")
                    except Exception as e:
                        self._log(f"[{email}] 关闭窗口失败: {e}")
                else:
                    result.add_failed(email, unlock_result.message, unlock_result.error_type)
                    self._log(f"[{email}] ❌ 解锁失败: {unlock_result.message}")
                    # 失败时不关闭浏览器，方便调试

            except Exception as e:
                result.add_failed(email, str(e), "exception")
                self._log(f"[{email}] ❌ 异常: {e}")

    async def batch_detect_pro(
        self,
        accounts: List[Dict],
        browser_ids: List[str],
    ) -> BatchResult:
        """
        批量检测 Google One Pro 会员状态

        Args:
            accounts: 账号列表（需要已登录）
            browser_ids: 浏览器窗口 ID 列表（与账号一一对应）

        Returns:
            BatchResult: 批量处理结果，包含 pro_count, non_pro_count
        """
        if len(accounts) != len(browser_ids):
            raise ValueError("账号数量与浏览器窗口数量不匹配")

        result = BatchResult(total=len(accounts))
        result.start_time = datetime.now()
        self._stop_flag = False
        self._semaphore = asyncio.Semaphore(self.concurrency)

        self._log(f"开始批量检测 Pro 状态，共 {len(accounts)} 个账号，并发数 {self.concurrency}")

        # 创建任务
        tasks = []
        for account, browser_id in zip(accounts, browser_ids):
            task = self._detect_pro_with_semaphore(
                account=account,
                browser_id=browser_id,
                result=result,
            )
            tasks.append(task)

        # 并发执行
        await asyncio.gather(*tasks, return_exceptions=True)

        result.end_time = datetime.now()

        # 统计 Pro 和非 Pro 数量（Pro 包括普通 Pro 和家庭组 Pro）
        pro_count = sum(1 for r in result.results if r.get("status") == "success" and r.get("data", {}).get("is_pro") == "yes")
        family_pro_count = sum(1 for r in result.results if r.get("status") == "success" and r.get("data", {}).get("is_pro") == "family_yes")
        non_pro_count = sum(1 for r in result.results if r.get("status") == "success" and r.get("data", {}).get("is_pro") == "no")

        self._log(
            f"批量检测 Pro 完成: Pro {pro_count}, Pro(家庭组) {family_pro_count}, 非Pro {non_pro_count}, "
            f"失败 {result.failed_count}, "
            f"跳过 {result.skipped_count}, "
            f"耗时 {result.duration_seconds:.1f}s"
        )

        # 在结果中添加 Pro 统计
        result.results.append({
            "_summary": True,
            "pro_count": pro_count + family_pro_count,  # 总 Pro 数（用于兼容旧逻辑）
            "pro_regular_count": pro_count,
            "pro_family_count": family_pro_count,
            "non_pro_count": non_pro_count,
        })

        return result

    async def _detect_pro_with_semaphore(
        self,
        account: Dict,
        browser_id: str,
        result: BatchResult,
    ):
        """带信号量控制的 Pro 检测任务"""
        from playwright.async_api import async_playwright
        from services.ix_api import openBrowser

        email = account.get("email", "unknown")

        if self._stop_flag:
            result.add_skipped(email, "用户停止")
            return

        async with self._semaphore:
            if self._stop_flag:
                result.add_skipped(email, "用户停止")
                return

            try:
                self._log(f"[{email}] 开始检测 Pro 状态...")

                # 打开浏览器
                open_result = openBrowser(browser_id)
                if not open_result.get("success"):
                    error_msg = open_result.get("msg", "打开浏览器失败")
                    result.add_failed(email, error_msg, "browser_open_failed")
                    self._log(f"[{email}] ❌ 打开浏览器失败: {error_msg}")
                    return

                ws_endpoint = open_result.get("data", {}).get("ws", "")
                if not ws_endpoint:
                    result.add_failed(email, "无法获取 WebSocket 端点", "no_ws_endpoint")
                    self._log(f"[{email}] ❌ 无法获取 WebSocket 端点")
                    return

                # 连接浏览器并检测
                async with async_playwright() as playwright:
                    browser = await playwright.chromium.connect_over_cdp(ws_endpoint)
                    contexts = browser.contexts
                    if not contexts:
                        result.add_failed(email, "没有浏览器上下文", "no_context")
                        self._log(f"[{email}] ❌ 没有浏览器上下文")
                        return

                    context = contexts[0]
                    pages = context.pages
                    if pages:
                        page = pages[0]
                    else:
                        page = await context.new_page()

                    # 检测 Pro 状态
                    # 优先使用 Stagehand AI 检测，失败时回退到传统方法
                    pro_status = None

                    if STAGEHAND_AVAILABLE:
                        self._log(f"[{email}] 尝试使用 Stagehand AI 检测...")
                        pro_status = await self._check_pro_status_via_stagehand(page, email, ws_endpoint)

                    if pro_status is None:
                        # Stagehand 不可用或失败，使用传统检测方法
                        self._log(f"[{email}] 使用传统检测方法...")
                        pro_status = await self._check_google_one_pro_status(page, email)

                    if pro_status is not None:
                        # 更新数据库
                        DBManager.update_pro_status(email, pro_status)

                        # 根据状态生成显示文本
                        status_text_map = {
                            "yes": "Pro",
                            "family_yes": "Pro(家庭组)",
                            "no": "非Pro",
                        }
                        status_text = status_text_map.get(pro_status, pro_status)

                        result.add_success(email, {
                            "browser_id": browser_id,
                            "is_pro": pro_status,
                        })
                        self._log(f"[{email}] ✅ Pro 状态: {status_text}")
                    else:
                        # 检测失败时也要保存状态到数据库
                        DBManager.update_pro_status(email, "detection_failed")
                        result.add_failed(email, "检测失败", "detection_failed")
                        self._log(f"[{email}] ❌ 检测 Pro 状态失败")

                    # 检测完成后关闭浏览器
                    try:
                        closeBrowser(browser_id)
                        self._log(f"[{email}] 浏览器窗口已关闭")
                    except Exception as e:
                        self._log(f"[{email}] 关闭窗口失败: {e}")

            except Exception as e:
                result.add_failed(email, str(e), "exception")
                self._log(f"[{email}] ❌ 异常: {e}")

    async def _check_pro_status_via_cdp(self, page, email: str) -> str | None:
        """
        使用 CDP 检测 Pro 会员状态

        Args:
            page: Playwright Page 对象
            email: 账号邮箱（用于日志）

        Returns:
            "pro" = Pro 会员（需进一步检测家庭组状态）
            "no" = 非 Pro 会员
            None = 检测失败
        """
        # 检查 CDP 服务是否可用
        if not CDP_SERVICE_AVAILABLE or create_cdp_service is None:
            self._log(f"[{email}] CDP 服务不可用")
            return None

        try:
            cdp_service = await create_cdp_service(page)

            try:
                # 获取可访问性树中的所有元素
                ax_elements = await cdp_service.get_interactive_elements_via_ax()
                self._log(f"[{email}] CDP 发现 {len(ax_elements)} 个可交互元素")

                # 非会员标识（CDP 中查找）
                non_pro_keywords = [
                    "upgrade", "升级", "升級",
                    "get started", "开始使用",
                    "get google one", "获取 google one",
                    "choose a plan", "选择方案",
                    "get basic", "get premium",
                ]

                # Pro 会员标识（CDP 中查找）
                pro_keywords = [
                    "manage membership", "管理会员", "管理成员资格",
                    "cancel membership", "取消会员",
                    "your membership", "您的成员资格",
                    "member since", "成为会员",
                    "next payment", "下次付款",
                    "renews on", "续订",
                ]

                # ========== 第一步：先遍历所有元素检查非会员标识 ==========
                # 重要：必须先完成非会员检测，因为非会员页面也可能显示 "Premium" 等推广内容
                for elem in ax_elements:
                    elem_name = (elem.get("name") or "").lower()

                    for keyword in non_pro_keywords:
                        if keyword in elem_name:
                            self._log(f"[{email}] CDP 检测到非会员标识: {keyword} (元素: {elem.get('name', '')[:50]})")
                            return "no"

                # ========== 第二步：再遍历所有元素检查 Pro 会员标识 ==========
                for elem in ax_elements:
                    elem_name = (elem.get("name") or "").lower()

                    for keyword in pro_keywords:
                        if keyword in elem_name:
                            self._log(f"[{email}] CDP 检测到 Pro 标识: {keyword} (元素: {elem.get('name', '')[:50]})")
                            return "pro"

                return None  # 无法确定

            finally:
                await cdp_service.close()

        except Exception as e:
            self._log(f"[{email}] CDP 检测异常: {e}")
            return None

    async def _check_family_status(self, page, email: str) -> str:
        """
        检测家庭组状态（CDP 优先，Playwright 兜底）

        Args:
            page: Playwright Page 对象
            email: 账号邮箱（用于日志）

        Returns:
            "yes" = 普通 Pro 会员（管理员/独立订阅）
            "family_yes" = 家庭组 Pro 会员（被邀请）
        """
        try:
            self._log(f"[{email}] 检测家庭组状态...")

            # 导航到家庭组页面
            await page.goto("https://myaccount.google.com/family", wait_until="domcontentloaded", timeout=15000)
            await page.wait_for_timeout(2000)

            # ========== CDP 优先检测 ==========
            if CDP_SERVICE_AVAILABLE and create_cdp_service:
                try:
                    cdp_service = await create_cdp_service(page)

                    try:
                        ax_elements = await cdp_service.get_interactive_elements_via_ax()

                        # 家庭组成员标识（只有成员才有退出按钮）
                        member_keywords = [
                            "leave family", "退出家庭", "离开家庭",
                            "you're a member", "您已加入",
                        ]

                        # 管理员标识
                        manager_keywords = [
                            "manage family", "管理家庭",
                            "invite family", "邀请家庭",
                            "add family member", "添加家庭成员",
                            "delete family", "删除家庭",
                            "family manager", "家庭管理员",
                        ]

                        # ========== 第一步：先遍历所有元素检查成员标识 ==========
                        # 优先检测成员标识，因为成员身份比管理员更明确
                        for elem in ax_elements:
                            elem_name = (elem.get("name") or "").lower()
                            for keyword in member_keywords:
                                if keyword in elem_name:
                                    self._log(f"[{email}] CDP 检测到家庭组成员标识: {keyword}")
                                    return "family_yes"

                        # ========== 第二步：再遍历所有元素检查管理员标识 ==========
                        for elem in ax_elements:
                            elem_name = (elem.get("name") or "").lower()
                            for keyword in manager_keywords:
                                if keyword in elem_name:
                                    self._log(f"[{email}] CDP 检测到管理员标识: {keyword}")
                                    # 检测家庭成员数量
                                    member_count = await self._get_family_member_count(page, email)
                                    if member_count > 0:
                                        DBManager.update_family_member_count(email, member_count)
                                    return "yes"

                    finally:
                        await cdp_service.close()

                except Exception as e:
                    self._log(f"[{email}] CDP 家庭组检测异常: {e}，回退到 Playwright...")

            # ========== Playwright 兜底 ==========
            family_page_text = await page.inner_text("body")

            # 家庭组成员标识
            member_indicators = [
                "退出家庭群组", "Leave family group", "离开家庭群组",
                "Leave family", "您已加入家庭群组", "You're a member of",
                "家庭群组成员", "Family group member", "Family member",
            ]

            for indicator in member_indicators:
                if indicator.lower() in family_page_text.lower():
                    self._log(f"[{email}] 检测到家庭组成员标识: {indicator}")
                    return "family_yes"

            # 管理员/独立订阅标识
            manager_indicators = [
                "管理家庭群组", "Manage family group", "Manage family",
                "邀请家庭成员", "Invite family members", "Add family member",
                "添加家庭成员", "创建家庭群组", "Create family group",
                "Create a family", "删除家庭群组", "Delete family group",
                "您是家庭管理员", "You are the family manager", "Family manager",
            ]

            for indicator in manager_indicators:
                if indicator.lower() in family_page_text.lower():
                    self._log(f"[{email}] 检测到普通 Pro 标识: {indicator}")
                    # 检测家庭成员数量
                    member_count = await self._get_family_member_count(page, email)
                    if member_count > 0:
                        DBManager.update_family_member_count(email, member_count)
                    return "yes"

            # 默认为普通 Pro
            self._log(f"[{email}] 未检测到明确的家庭组状态，默认为普通 Pro")
            member_count = await self._get_family_member_count(page, email)
            if member_count > 0:
                DBManager.update_family_member_count(email, member_count)
            return "yes"

        except Exception as e:
            self._log(f"[{email}] 家庭组状态检测失败: {e}，默认为普通 Pro")
            return "yes"

    async def _check_google_one_pro_status(self, page, email: str) -> str | None:
        """
        检测 Google One Pro 会员状态（CDP 优先，Playwright 文本分析兜底）

        Args:
            page: Playwright Page 对象
            email: 账号邮箱（用于日志）

        Returns:
            "yes" = 普通 Pro 会员（自己订阅）
            "family_yes" = 家庭组 Pro 会员（被邀请）
            "no" = 非 Pro 会员
            None = 检测失败
        """
        try:
            self._log(f"[{email}] 正在检测 Google One 会员状态...")

            # 导航到 Google One 页面
            await page.goto("https://one.google.com/", wait_until="domcontentloaded", timeout=15000)
            await page.wait_for_timeout(2000)

            # ========== 阶段1: CDP 优先检测 ==========
            if CDP_SERVICE_AVAILABLE and create_cdp_service:
                self._log(f"[{email}] 阶段1: 使用 CDP 检测 Pro 状态...")
                cdp_result = await self._check_pro_status_via_cdp(page, email)
                if cdp_result is not None:
                    self._log(f"[{email}] CDP 检测成功: {cdp_result}")
                    # CDP 检测到 Pro/非Pro，继续检测家庭组状态
                    if cdp_result == "pro":
                        # 检测是普通 Pro 还是家庭组 Pro
                        return await self._check_family_status(page, email)
                    elif cdp_result == "no":
                        return "no"
                else:
                    self._log(f"[{email}] CDP 检测无结果，回退到 Playwright 文本分析...")

            # ========== 阶段2: Playwright 文本分析兜底 ==========
            self._log(f"[{email}] 阶段2: 使用 Playwright 文本分析...")

            # 检查页面内容
            page_text = await page.inner_text("body")

            # ========== 重要修复：改变检测顺序，先检测非会员标识 ==========
            # 原因：非会员页面也会显示 "Premium plan" 等作为套餐推广/选项
            # 因此需要先排除非会员情况，再检测 Pro 会员标识

            # 非会员标识 - 明确表示用户尚未订阅的关键词
            # 注意：这些标识在已订阅用户页面上通常不会出现
            non_pro_indicators = [
                # ===== 最重要：Upgrade 按钮（非会员页面左侧导航栏必有）=====
                "Upgrade",            # 英文 - 升级按钮（只有非会员才有）
                "升级",               # 中文简体
                "升級",               # 中文繁体
                "アップグレード",      # 日语
                "업그레이드",          # 韩语
                "Nâng cấp",           # 越南语
                "Tingkatkan",         # 印尼语/马来语
                "อัปเกรด",            # 泰语
                # ===== 其他非会员标识 =====
                "Get started",        # 页面显示"开始使用"按钮（家庭组创建页面）
                "开始使用",
                "Sign up now",        # 注册按钮
                "立即注册",
                "Get Google One",     # 获取 Google One
                "获取 Google One",
                "加入 Google One",
                "Get Basic",          # 获取基础套餐按钮
                "获取 Basic",
                "Get Premium",        # 获取高级套餐按钮
                "获取 Premium",
                "Get Google AI Pro",  # 获取 AI Pro 按钮
                "Choose a plan",      # 选择方案页面
                "选择方案",
                "Pick a plan",
                "Choose your plan",
                "You can create a Family Group",  # 家庭组创建提示（非会员）
                "可以创建家庭群组",
                "Get more out of Google",  # 非会员页面底部推广语
                "With a Google One membership",  # 非会员页面推广语
            ]

            # Pro 会员标识 - 明确表示用户已订阅的关键词
            # 注意：只使用已订阅用户页面上才会出现的标识
            pro_indicators = [
                "Manage membership",  # 管理会员（只有订阅者才有）
                "管理会员",
                "管理成员资格",
                "Cancel membership",  # 取消会员（只有订阅者才有）
                "取消会员",
                "取消成员资格",
                "Change membership plan",  # 更改会员计划
                "更改成员资格方案",
                "Your membership",    # 您的会员资格
                "您的成员资格",
                "您的会员",
                "Member since",       # 会员起始日期
                "成为会员的时间",
                "Next payment",       # 下次付款
                "下次付款",
                "Renews on",          # 续订时间
                "续订日期",
                "您当前的方案",       # 表示已订阅某个方案
                "Your current plan",  # 英文版
            ]

            page_text_lower = page_text.lower()

            # 第一步：先检查是否有明确的非会员标识
            for indicator in non_pro_indicators:
                if indicator.lower() in page_text_lower:
                    self._log(f"[{email}] 检测到非会员标识: {indicator}")
                    return "no"

            # 第二步：检查是否有 Pro 会员标识
            is_pro = False
            for indicator in pro_indicators:
                if indicator.lower() in page_text_lower:
                    self._log(f"[{email}] 检测到 Pro 标识: {indicator}")
                    is_pro = True
                    break

            # 如果没检测到任何明确标识，返回 None（无法确定）
            if not is_pro:
                self._log(f"[{email}] 未检测到明确的会员/非会员标识")
                return None

            # 是 Pro 会员，调用统一的家庭组状态检测方法
            self._log(f"[{email}] 检测到 Pro 会员，正在检测家庭组状态...")
            return await self._check_family_status(page, email)

        except Exception as e:
            self._log(f"[{email}] [!] 检测 Pro 状态失败: {e}")
            return None

    async def _check_pro_status_via_stagehand(
        self,
        page,
        email: str,
        ws_endpoint: str,
    ) -> str | None:
        """
        使用 Stagehand AI 检测 Pro 状态

        通过 Stagehand SDK 连接到现有的 ixBrowser 窗口，
        使用 AI 智能提取 Google One 订阅信息。

        Args:
            page: Playwright Page 对象（已连接到 ixBrowser）
            email: 账号邮箱（用于日志）
            ws_endpoint: ixBrowser 的 WebSocket 端点

        Returns:
            "yes" = 普通 Pro 会员（自己订阅）
            "family_yes" = 家庭组 Pro 会员（被邀请）
            "no" = 非 Pro 会员
            None = 检测失败
        """
        if not STAGEHAND_AVAILABLE:
            self._log(f"[{email}] Stagehand SDK 不可用，回退到传统方法")
            return None

        try:
            self._log(f"[{email}] [AI] 使用 Stagehand AI 检测 Pro 状态...")

            # 优先使用 Anthropic/Claude 配置
            # 如果 Anthropic 未配置，回退到 Gemini
            model_api_key = ConfigManager.get_ai_provider_api_key("anthropic")
            model_base_url = None
            stagehand_model = None

            if model_api_key:
                # 使用 Anthropic/Claude
                model_name = ConfigManager.get_ai_provider_model("anthropic")
                if not model_name:
                    model_name = "claude-sonnet-4-20250514"
                stagehand_model = f"anthropic/{model_name}"
                # 获取 base_url（支持第三方 API 代理）
                base_url = ConfigManager.get_ai_provider_base_url("anthropic")
                if base_url:
                    # 确保 base_url 以 /v1 结尾（OpenAI 兼容格式）
                    if not base_url.endswith("/v1"):
                        model_base_url = base_url.rstrip("/") + "/v1"
                    else:
                        model_base_url = base_url
                self._log(f"[{email}] 使用 Anthropic 模型: {stagehand_model}")
                if model_base_url:
                    self._log(f"[{email}] 使用第三方 API: {model_base_url}")
            else:
                # 回退到 Gemini
                model_api_key = ConfigManager.get_ai_provider_api_key("gemini")
                if not model_api_key:
                    model_api_key = os.environ.get("MODEL_API_KEY")

                if model_api_key:
                    model_name = ConfigManager.get_ai_provider_model("gemini")
                    if not model_name:
                        model_name = "gemini-2.0-flash"
                    stagehand_model = f"google/{model_name}"
                    # 获取 base_url
                    base_url = ConfigManager.get_ai_provider_base_url("gemini")
                    if base_url:
                        model_base_url = base_url
                    self._log(f"[{email}] 使用 Gemini 模型: {stagehand_model}")

            if not model_api_key or not stagehand_model:
                self._log(f"[{email}] [!] 未配置 AI API Key（Anthropic 或 Gemini），无法使用 Stagehand")
                return None

            # 构建 model_config（用于 extract 调用）
            model_config = {
                "model_name": stagehand_model,
                "api_key": model_api_key,
            }
            if model_base_url:
                model_config["base_url"] = model_base_url

            # 创建 Stagehand 客户端（使用本地模式）
            async with AsyncStagehand(
                server="local",
                model_api_key=model_api_key,
                local_ready_timeout_s=30.0,
            ) as client:
                # 启动 session，连接到现有浏览器
                self._log(f"[{email}] 启动 Stagehand session (连接到现有浏览器)...")
                session = await client.sessions.start(
                    model_name=stagehand_model,
                    browser={
                        "type": "local",
                        "cdp_url": ws_endpoint,
                    },
                )

                try:
                    # 同步 Stagehand 到当前 URL
                    await session.navigate(url="https://one.google.com/")

                    # 使用 AI 提取 Pro 状态
                    self._log(f"[{email}] 使用 AI 提取订阅信息...")
                    extract_response = await session.extract(
                        instruction="""
                        仔细分析当前 Google One 页面，判断用户的会员订阅状态。

                        **重要判断规则（按优先级顺序）：**

                        1. 首先检查是否有"Upgrade"或"升级"按钮：
                           - 如果页面左侧导航栏或页面上有"Upgrade"、"升级"按钮 → 说明是**非会员**
                           - 非会员页面通常显示套餐选择、价格信息

                        2. 如果没有"Upgrade"按钮，检查是否是会员：
                           - 查找"Your membership"、"您的会员资格"、"Member benefits"、"会员福利"
                           - 查找存储空间信息如"100 GB"、"2 TB"、"AI Premium"
                           - 查找"Manage membership"、"管理会员"

                        3. 如果是会员，判断是独立订阅还是家庭组成员：

                           **家庭组成员特征（is_family_member=true）：**
                           - 看到"Shared with you"、"与您共享"
                           - 看到"Family plan"、"家庭方案"但没有付款/账单信息
                           - 看到"Leave family"、"退出家庭"选项
                           - 没有看到"Next payment"、"下次付款"信息
                           - 页面显示是通过其他人的订阅获得的福利

                           **独立订阅者特征（is_family_member=false）：**
                           - 看到"Next payment"、"下次付款"信息
                           - 看到"Cancel membership"、"取消会员"
                           - 看到"Payment method"、"付款方式"
                           - 看到"Manage family"、"管理家庭"（说明是家庭管理员）

                        请返回：
                        - is_subscribed: 是否有 Google One 会员（true/false）
                        - is_family_member: 是否是家庭组成员（被邀请加入的，不是管理员）（true/false）
                        - plan_name: 套餐名称（如"2 TB", "AI Premium", "100 GB"等）
                        - confidence: 判断置信度（0-1）
                        """,
                        schema={
                            "type": "object",
                            "properties": {
                                "is_subscribed": {
                                    "type": "boolean",
                                    "description": "用户是否有 Google One 会员资格（不论是自己订阅还是家庭共享）。如果页面有 Upgrade 按钮则为 false，如果显示会员福利或存储空间则为 true"
                                },
                                "is_family_member": {
                                    "type": "boolean",
                                    "description": "如果是会员，是否是通过家庭组共享获得的（被别人邀请加入）。如果没有付款信息或看到 shared with you 则为 true"
                                },
                                "plan_name": {
                                    "type": "string",
                                    "description": "会员套餐名称，如 2 TB, AI Premium, 100 GB 等"
                                },
                                "confidence": {
                                    "type": "number",
                                    "description": "判断置信度 0-1"
                                },
                            },
                            "required": ["is_subscribed", "is_family_member", "confidence"],
                        },
                        options={
                            "model": model_config,
                        },
                        page=page,
                    )

                    # 解析结果
                    result_data = extract_response.data.result
                    self._log(f"[{email}] Stagehand 提取结果: {result_data}")

                    if result_data is None:
                        self._log(f"[{email}] [!] Stagehand 提取结果为空")
                        return None

                    is_subscribed = result_data.get("is_subscribed", False)
                    is_family_member = result_data.get("is_family_member", False)
                    plan_name = result_data.get("plan_name", "")
                    confidence = result_data.get("confidence", 0)

                    self._log(f"[{email}] AI 分析: 已订阅={is_subscribed}, 家庭成员={is_family_member}, 方案={plan_name}, 置信度={confidence}")

                    # 置信度检查
                    if confidence < 0.5:
                        self._log(f"[{email}] [!] AI 置信度较低 ({confidence})，建议人工确认")

                    # 返回结果
                    if not is_subscribed:
                        self._log(f"[{email}] [OK] Stagehand 检测: 非 Pro 会员")
                        return "no"

                    # 是 Pro 会员，需要二次确认家庭组状态
                    # 导航到会员设置页面进行精确判断
                    self._log(f"[{email}] 检测到 Pro 会员，正在检查是否为独立订阅...")
                    await session.navigate(url="https://one.google.com/settings")

                    # 在设置页面检查是否有独立订阅者特有的选项
                    settings_response = await session.extract(
                        instruction="""
                        分析当前 Google One 设置页面，判断用户是独立订阅者还是家庭组成员。

                        **关键判断规则：**

                        如果看到以下任一内容，说明是**独立订阅者**（自己付费）：
                        - "Share Google One with family" 开关
                        - "Change payment method" / "更改付款方式"
                        - "Cancel membership" / "取消会员"
                        - "Change membership plan" / "更改会员方案"
                        - "Manage family settings" / "管理家庭设置"

                        如果页面**没有**付款相关选项，或者显示：
                        - "Your membership is shared by..." / "您的会员由...共享"
                        - "Leave family" / "退出家庭"
                        - 只有基本的会员信息，没有付款/取消选项
                        说明是**家庭组成员**（通过别人的订阅获得）

                        请返回：
                        - has_payment_options: 页面是否有付款相关选项（Change payment method, Cancel membership等）
                        - has_share_family_toggle: 页面是否有 "Share Google One with family" 开关
                        - is_independent_subscriber: 是否是独立订阅者（自己付费的）
                        - confidence: 判断置信度
                        """,
                        schema={
                            "type": "object",
                            "properties": {
                                "has_payment_options": {
                                    "type": "boolean",
                                    "description": "页面是否有付款相关选项"
                                },
                                "has_share_family_toggle": {
                                    "type": "boolean",
                                    "description": "页面是否有 Share Google One with family 开关"
                                },
                                "is_independent_subscriber": {
                                    "type": "boolean",
                                    "description": "是否是独立订阅者（自己付费）"
                                },
                                "confidence": {
                                    "type": "number",
                                    "description": "判断置信度 0-1"
                                },
                            },
                            "required": ["has_payment_options", "has_share_family_toggle", "is_independent_subscriber", "confidence"],
                        },
                        options={
                            "model": model_config,
                        },
                    )

                    settings_data = settings_response.data.result
                    self._log(f"[{email}] 设置页面检测结果: {settings_data}")

                    if settings_data:
                        has_payment = settings_data.get("has_payment_options", False)
                        has_share_toggle = settings_data.get("has_share_family_toggle", False)
                        is_independent = settings_data.get("is_independent_subscriber", False)
                        settings_confidence = settings_data.get("confidence", 0)

                        self._log(f"[{email}] 设置分析: 付款选项={has_payment}, 家庭共享开关={has_share_toggle}, 独立订阅={is_independent}, 置信度={settings_confidence}")

                        # 如果有付款选项或家庭共享开关，说明是独立订阅者
                        if has_payment or has_share_toggle or is_independent:
                            self._log(f"[{email}] [OK] Stagehand 检测: 普通 Pro 会员 ({plan_name})")
                            return "yes"
                        else:
                            self._log(f"[{email}] [OK] Stagehand 检测: 家庭组 Pro 会员 ({plan_name})")
                            return "family_yes"

                    # 默认返回独立订阅
                    self._log(f"[{email}] [OK] Stagehand 检测: 普通 Pro 会员 ({plan_name})")
                    return "yes"

                finally:
                    # 确保 session 结束
                    try:
                        await session.end()
                    except Exception:
                        pass

        except Exception as e:
            self._log(f"[{email}] [!] Stagehand 检测失败: {e}")
            self._log(f"[{email}] 错误详情: {traceback.format_exc()}")
            return None

    async def _get_family_member_count(self, page, email: str) -> int:
        """
        获取家庭组成员数量

        Args:
            page: Playwright Page 对象（应已在家庭组页面）
            email: 账号邮箱（用于日志）

        Returns:
            int: 家庭成员数量 (1-6)，0 表示检测失败
        """
        try:
            self._log(f"[{email}] 正在检测家庭成员数量...")

            # 当前页面应该是 https://myaccount.google.com/family
            # 如果不是，先导航
            current_url = page.url
            if "myaccount.google.com/family" not in current_url:
                await page.goto("https://myaccount.google.com/family", wait_until="domcontentloaded", timeout=15000)
                await page.wait_for_timeout(2000)

            # 方法 1: 通过计数页面上的成员头像/卡片
            # 家庭成员通常显示为卡片或头像列表
            member_selectors = [
                "[data-member-email]",  # 成员邮箱属性
                "[role='listitem']",  # 列表项
                ".family-member",  # 家庭成员 class
                "[data-member]",  # 成员数据属性
            ]

            for selector in member_selectors:
                try:
                    members = await page.query_selector_all(selector)
                    if members and len(members) > 0:
                        count = len(members)
                        self._log(f"[{email}] 通过选择器 '{selector}' 检测到 {count} 个成员")
                        if 1 <= count <= 6:
                            return count
                except Exception:
                    continue

            # 方法 2: 从页面文本中提取数字
            # 例如: "3 位家庭成员" / "3 family members"
            import re
            page_text = await page.inner_text("body")

            # 中文模式: "X 位成员" / "X位家庭成员"
            cn_patterns = [
                r"(\d)\s*位\s*(?:家庭)?成员",
                r"家庭群组\s*\((\d)\)",
                r"(\d)\s*人",
            ]

            # 英文模式: "X members" / "X family members"
            en_patterns = [
                r"(\d)\s*(?:family\s+)?members?",
                r"Family\s+group\s*\((\d)\)",
            ]

            all_patterns = cn_patterns + en_patterns
            for pattern in all_patterns:
                match = re.search(pattern, page_text, re.IGNORECASE)
                if match:
                    count = int(match.group(1))
                    self._log(f"[{email}] 通过正则匹配检测到 {count} 个成员 (模式: {pattern})")
                    if 1 <= count <= 6:
                        return count

            # 方法 3: 默认返回 1（至少有管理员自己）
            self._log(f"[{email}] 无法精确检测成员数量，默认为 1（管理员自己）")
            return 1

        except Exception as e:
            self._log(f"[{email}] [!] 获取家庭成员数量失败: {e}")
            return 0


# ==================== 便捷函数 ====================

async def quick_batch_login(
    accounts: List[Dict],
    browser_ids: List[str],
    concurrency: int = 3,
    callback: Callable = None,
) -> BatchResult:
    """
    快速批量登录

    Args:
        accounts: 账号列表
        browser_ids: 浏览器窗口 ID 列表
        concurrency: 并发数
        callback: 回调函数

    Returns:
        BatchResult: 批量结果
    """
    processor = BatchAccountProcessor(concurrency=concurrency, callback=callback)
    return await processor.batch_login(accounts, browser_ids)


async def quick_batch_oauth(
    accounts: List[Dict],
    browser_ids: List[str],
    concurrency: int = 3,
    callback: Callable = None,
) -> BatchResult:
    """
    快速批量 OAuth

    Args:
        accounts: 账号列表
        browser_ids: 浏览器窗口 ID 列表
        concurrency: 并发数
        callback: 回调函数

    Returns:
        BatchResult: 批量结果
    """
    processor = BatchAccountProcessor(concurrency=concurrency, callback=callback)
    return await processor.batch_oauth(accounts, browser_ids)


# ==================== 测试代码 ====================

if __name__ == "__main__":
    async def main():
        print("BatchAccountProcessor 测试")
        print("=" * 50)

        processor = BatchAccountProcessor(concurrency=2, callback=print)

        # 模拟账号
        accounts = [
            {"email": "test1@gmail.com", "password": "pass1"},
            {"email": "test2@gmail.com", "password": "pass2"},
        ]
        browser_ids = ["111", "222"]

        print(f"账号数: {len(accounts)}")
        print(f"并发数: {processor.concurrency}")

    asyncio.run(main())
