"""
批量账号处理器

支持批量登录和批量 OAuth，使用 asyncio.Semaphore 控制并发。
"""

import asyncio
from typing import Callable, List, Optional, Dict, Any
from dataclasses import dataclass, field
from datetime import datetime

from core.config_manager import ConfigManager
from core.retry_helper import RetryHelper
from services.database import DBManager
from services.sub2api_client import Sub2APIClient
from services.ix_api import closeBrowser
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
                                self._log(f"[{email}] ⚠️ 未获取到新的验证链接，使用数据库中的链接")
                        elif test_result.success:
                            # 账号已不再是 403 状态
                            self._log(f"[{email}] ✅ 账号已不再需要解锁（403 已解除）")
                            DBManager.update_unlock_status(email, "unlocked")
                            result.add_success(email, {"skipped": True, "reason": "已解锁"})
                            return
                        else:
                            # 其他失败情况
                            self._log(f"[{email}] ⚠️ 检测返回异常: {test_result.error}，使用数据库中的链接")
                    else:
                        self._log(f"[{email}] ⚠️ 未找到 Sub2API 账号，使用数据库中的验证链接")

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
            f"批量检测 Pro 完成: Pro(普通) {pro_count}, Pro(家庭组) {family_pro_count}, 非Pro {non_pro_count}, "
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
                    pro_status = await self._check_google_one_pro_status(page, email)

                    if pro_status is not None:
                        # 更新数据库
                        DBManager.update_pro_status(email, pro_status)

                        # 根据状态生成显示文本
                        status_text_map = {
                            "yes": "Pro(普通)",
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

    async def _check_google_one_pro_status(self, page, email: str) -> str | None:
        """
        检测 Google One Pro 会员状态

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

            # 是 Pro 会员，进一步检测是普通 Pro 还是家庭组 Pro
            self._log(f"[{email}] 检测到 Pro 会员，正在检测家庭组状态...")

            try:
                # 导航到家庭组页面（新地址，原 one.google.com/family 已 404）
                await page.goto("https://myaccount.google.com/family", wait_until="domcontentloaded", timeout=15000)
                await page.wait_for_timeout(2000)

                family_page_text = await page.inner_text("body")

                # 输出页面文本用于调试（仅前500字符）
                self._log(f"[{email}] 家庭组页面内容: {family_page_text[:500]}...")

                # ========== 修复：颠倒检测顺序，先检测成员标识 ==========
                # 家庭组成员标识 - 成员能看到的页面元素
                # 根据 Google 帮助文档，成员可以"退出家庭群组"，而管理员不能
                member_indicators = [
                    "退出家庭群组",        # 最可靠 - 只有成员才有这个按钮
                    "Leave family group",
                    "离开家庭群组",
                    "Leave family",
                    "您已加入家庭群组",
                    "You're a member of",
                    "家庭群组成员",
                    "Family group member",
                    "Family member",       # 新增：英文页面可能的标识
                ]

                # 先检查是否是家庭成员（优先级最高，避免被管理员标识误判）
                for indicator in member_indicators:
                    if indicator.lower() in family_page_text.lower():
                        self._log(f"[{email}] 检测到家庭组成员标识: {indicator}")
                        return "family_yes"

                # 普通 Pro (管理员/独立订阅) 标识
                # 根据 Google 帮助文档：管理员可以"添加成员"、"删除家庭群组"、"邀请家庭成员"
                manager_indicators = [
                    "管理家庭群组",        # 管理员独有的操作按钮
                    "Manage family group",
                    "Manage family",
                    "邀请家庭成员",        # 管理员独有
                    "Invite family members",
                    "Add family member",
                    "添加家庭成员",
                    "创建家庭群组",        # 独立订阅者创建家庭
                    "Create family group",
                    "Create a family",
                    "删除家庭群组",        # 只有管理员可以删除
                    "Delete family group",
                    "您是家庭管理员",      # 精确匹配
                    "You are the family manager",
                    "Family manager",      # 管理员角色标识
                ]

                # 再检查是否是管理员
                for indicator in manager_indicators:
                    if indicator.lower() in family_page_text.lower():
                        self._log(f"[{email}] 检测到普通 Pro 标识: {indicator}")
                        # 检测家庭成员数量
                        member_count = await self._get_family_member_count(page, email)
                        if member_count > 0:
                            DBManager.update_family_member_count(email, member_count)
                        return "yes"

                # 如果都没检测到，默认为普通 Pro（可能家庭页面结构变化或独立订阅）
                self._log(f"[{email}] 未检测到明确的家庭组状态，默认为普通 Pro")
                # 仍尝试检测家庭成员数量
                member_count = await self._get_family_member_count(page, email)
                if member_count > 0:
                    DBManager.update_family_member_count(email, member_count)
                return "yes"

            except Exception as e:
                self._log(f"[{email}] ⚠️ 检测家庭组状态失败: {e}，默认为普通 Pro")
                return "yes"

        except Exception as e:
            self._log(f"[{email}] ⚠️ 检测 Pro 状态失败: {e}")
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
            self._log(f"[{email}] ⚠️ 获取家庭成员数量失败: {e}")
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
