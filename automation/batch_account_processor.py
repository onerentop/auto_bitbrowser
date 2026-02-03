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
