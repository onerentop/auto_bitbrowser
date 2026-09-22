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

# 尝试导入 CDP 服务
try:
    from core.ai_browser_agent import create_cdp_service, CDP_SERVICE_AVAILABLE
except ImportError:
    CDP_SERVICE_AVAILABLE = False
    create_cdp_service = None

# 导入共享的 Pro 状态检测器
from automation.pro_status_detector import check_pro_status_via_stagehand, check_pro_status_with_engine

# 检查 StagehandGoogleEngine 是否可用
try:
    from core.stagehand_engine import StagehandGoogleEngine
    from core.stagehand_engine.constants import GoogleURLs
    STAGEHAND_ENGINE_AVAILABLE = True
except ImportError:
    STAGEHAND_ENGINE_AVAILABLE = False
    StagehandGoogleEngine = None
    GoogleURLs = None

from services.proxy_smart_allocator import ProxySmartAllocator
from automation.auto_google_login import auto_google_login, LoginResult
from automation.auto_antigravity_oauth import auto_antigravity_oauth, OAuthResult
from automation.auto_unlock_403 import auto_unlock_403, UnlockResult
from services.sms_bus_client import SMSBusClient

# 检查 BrowserUseEngine 是否可用
try:
    from core.browseruse_engine import BrowserUseEngine
    BROWSERUSE_ENGINE_AVAILABLE = True
except ImportError:
    BROWSERUSE_ENGINE_AVAILABLE = False
    BrowserUseEngine = None

# Pydantic 模型用于 AI 结构化提取
try:
    from pydantic import BaseModel, Field
    PYDANTIC_AVAILABLE = True
except ImportError:
    PYDANTIC_AVAILABLE = False
    BaseModel = object
    Field = lambda *args, **kwargs: None


# ==================== AI 提取数据模型 ====================

if PYDANTIC_AVAILABLE:
    class FamilyInfoExtractModel(BaseModel):
        """家庭组信息提取模型"""
        has_family_group: str = Field(
            default="unknown",
            description="是否有家庭组。可选值: yes（有）, no（无）, unknown（无法确定）"
        )
        family_role: str = Field(
            default="unknown",
            description="用户在家庭组中的角色。可选值: manager（管理员/创建者）, member（成员/被邀请者）, none（无家庭组）, unknown（无法确定）"
        )
        family_member_count: int = Field(
            default=0,
            description="家庭组成员数量（包括管理员自己），范围 1-6。如果无法确定返回 0"
        )
        family_manager_email: str = Field(
            default="",
            description="家庭组管理员的邮箱地址。如果当前用户是成员，这里应该是管理员的邮箱；如果是管理员则为空"
        )

    class AccountCountryExtractModel(BaseModel):
        """账户国家提取模型"""
        account_country: str = Field(
            default="unknown",
            description="账户所在国家的英文名称（如 'United States', 'China', 'Japan'）。如果无法确定返回 'unknown'"
        )
else:
    FamilyInfoExtractModel = None
    AccountCountryExtractModel = None


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


@dataclass
class AccountMembershipRefreshResult:
    """账号会员信息刷新结果"""
    email: str
    is_pro: str = "unknown"  # yes/no/family_yes/detection_failed
    membership_type: str = "unknown"  # regular/family/none/unknown
    pro_plan_name: str = ""
    family_role: str = "unknown"  # manager/member/none/unknown
    has_family_group: str = "unknown"  # yes/no/unknown
    family_manager_email: str = ""
    family_member_count: int = 0
    family_slots_left: int = -1
    account_country: str = ""
    error_message: str = ""
    success: bool = False

    def to_dict(self) -> Dict:
        """转换为字典"""
        return {
            "email": self.email,
            "is_pro": self.is_pro,
            "membership_type": self.membership_type,
            "pro_plan_name": self.pro_plan_name,
            "family_role": self.family_role,
            "has_family_group": self.has_family_group,
            "family_manager_email": self.family_manager_email,
            "family_member_count": self.family_member_count,
            "family_slots_left": self.family_slots_left,
            "account_country": self.account_country,
            "error_message": self.error_message,
            "success": self.success,
        }

    @classmethod
    def from_pro_status(cls, email: str, is_pro: str) -> "AccountMembershipRefreshResult":
        """从 Pro 状态创建结果对象"""
        result = cls(email=email)
        result.is_pro = is_pro

        # 根据 is_pro 推断 membership_type
        if is_pro == "yes":
            result.membership_type = "regular"
            result.family_role = "manager"  # 普通 Pro 默认是管理员
        elif is_pro == "family_yes":
            result.membership_type = "family"
            result.family_role = "member"  # 家庭组 Pro 默认是成员
        elif is_pro == "no":
            result.membership_type = "none"
            result.family_role = "none"
        else:
            result.membership_type = "unknown"
            result.family_role = "unknown"

        result.success = is_pro in ("yes", "no", "family_yes")
        return result

    def calculate_family_slots(self):
        """计算剩余家庭组位置"""
        if self.is_pro == "yes" and self.family_role == "manager":
            # 普通 Pro 管理员：最多 6 人，减去当前成员数
            self.family_slots_left = max(0, 6 - max(self.family_member_count, 1))
        elif self.is_pro == "family_yes":
            # 家庭组 Pro：不适用
            self.family_slots_left = -1
        else:
            self.family_slots_left = -1


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
        max_retries: int = None,
    ) -> BatchResult:
        """
        批量执行登录

        Args:
            accounts: 账号列表，每个账号是 {email, password, secret_key, recovery_email}
            browser_ids: 浏览器窗口 ID 列表（与账号一一对应）
            api_key: AI API Key
            model: AI 模型名称
            provider: AI 提供商
            max_retries: 登录最大重试次数（可选，默认从配置读取）

        Returns:
            BatchResult: 批量处理结果
        """
        if len(accounts) != len(browser_ids):
            raise ValueError("账号数量与浏览器窗口数量不匹配")

        result = BatchResult(total=len(accounts))
        result.start_time = datetime.now()
        self._stop_flag = False
        self._semaphore = asyncio.Semaphore(self.concurrency)

        # 获取重试配置
        retries = max_retries or ConfigManager.get_login_max_retries()

        self._log(f"开始批量登录，共 {len(accounts)} 个账号，并发数 {self.concurrency}，最大尝试 {retries} 次")

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
                max_retries=max_retries,
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
        max_retries: int = None,
    ):
        """带信号量控制的登录任务（支持多次重试）"""
        email = account.get("email", "unknown")

        if self._stop_flag:
            result.add_skipped(email, "用户停止")
            return

        async with self._semaphore:
            if self._stop_flag:
                result.add_skipped(email, "用户停止")
                return

            try:
                # 获取重试配置
                retries = max_retries or ConfigManager.get_login_max_retries()
                retry_delay = ConfigManager.get_login_retry_delay()

                self._log(f"[{email}] 开始登录（最多尝试 {retries} 次）...")

                # 执行登录（带重试）
                login_result = None
                last_error = None

                for attempt in range(1, retries + 1):
                    if self._stop_flag:
                        result.add_skipped(email, "用户停止")
                        return

                    if attempt > 1:
                        self._log(f"[{email}] 第 {attempt}/{retries} 次尝试...")
                        await asyncio.sleep(retry_delay)

                    try:
                        login_result = await auto_google_login(
                            browser_id=browser_id,
                            account=account,
                            callback=self.callback,
                            api_key=api_key,
                            model=model,
                            provider=provider,
                        )

                        if login_result.success:
                            # 登录成功
                            result.add_success(email, {
                                "browser_id": browser_id,
                                "total_steps": login_result.total_steps,
                                "attempts": attempt,
                            })
                            self._log(f"[{email}] ✅ 登录成功（第 {attempt} 次尝试）")
                            return

                        # 登录失败，记录错误
                        last_error = login_result.message
                        self._log(f"[{email}] 第 {attempt} 次尝试失败: {login_result.message}")

                        # 某些错误类型不需要重试
                        non_retryable_errors = [
                            "stagehand_unavailable",
                            "no_api_key",
                            "browser_open_failed",
                        ]
                        if login_result.error_type in non_retryable_errors:
                            self._log(f"[{email}] 错误类型 {login_result.error_type} 不可重试")
                            break

                    except Exception as e:
                        last_error = str(e)
                        self._log(f"[{email}] 第 {attempt} 次尝试异常: {e}")

                # 所有尝试都失败
                if login_result:
                    result.add_failed(email, login_result.message, login_result.error_type)
                    self._log(f"[{email}] ❌ 登录失败（已尝试 {retries} 次）: {login_result.message}")
                else:
                    result.add_failed(email, last_error or "未知错误", "exception")
                    self._log(f"[{email}] ❌ 登录失败（已尝试 {retries} 次）: {last_error}")

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
        max_retries: int = None,
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
            max_retries: 登录最大重试次数（可选，默认从配置读取）

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
            max_retries=max_retries,
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

                    # 检测 Pro 状态（使用 Stagehand AI）
                    self._log(f"[{email}] 使用 Stagehand AI 检测...")
                    pro_status = await check_pro_status_via_stagehand(
                        page=page,
                        email=email,
                        ws_endpoint=ws_endpoint,
                        log=lambda msg: self._log(f"[{email}] {msg}"),
                    )

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
            await page.goto(GoogleURLs.FAMILY_ACCOUNT, wait_until="domcontentloaded", timeout=15000)
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
            await page.goto(GoogleURLs.GOOGLE_ONE, wait_until="domcontentloaded", timeout=15000)
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
            if "myaccount.google.com/family" not in current_url and "families.google.com" not in current_url:
                family_url = GoogleURLs.FAMILY_ACCOUNT if GoogleURLs else "https://families.google.com/families"
                await page.goto(family_url, wait_until="domcontentloaded", timeout=15000)
                await page.wait_for_timeout(2000)

            # 方法 1: 通过计数页面上的成员头像/卡片
            # 家庭成员通常显示为卡片或头像列表
            member_selectors = [
                "[data-member-email]",  # 成员邮箱属性
                "[role='listitem']",  # 列表项
                ".family-member",  # 家庭成员 class
                "[data-member]",  # 成员数据属性
                "div[data-email]",  # 带邮箱的 div
                "img[alt*='profile']",  # 用户头像
                "[class*='member']",  # 包含 member 的 class
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
                r"(\d)\s*位\s*家庭群组成员",
                r"家庭成员\s*[:：]?\s*(\d)",
            ]

            # 英文模式: "X members" / "X family members"
            en_patterns = [
                r"(\d)\s*(?:family\s+)?members?",
                r"Family\s+group\s*\((\d)\)",
                r"(\d)\s+people",
                r"Family\s+members?\s*[:：]?\s*(\d)",
            ]

            all_patterns = cn_patterns + en_patterns
            for pattern in all_patterns:
                match = re.search(pattern, page_text, re.IGNORECASE)
                if match:
                    count = int(match.group(1))
                    self._log(f"[{email}] 通过正则匹配检测到 {count} 个成员 (模式: {pattern})")
                    if 1 <= count <= 6:
                        return count

            # 方法 3: 计算页面中邮箱地址的数量（通常每个成员都有邮箱显示）
            email_pattern = r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'
            emails_found = re.findall(email_pattern, page_text)
            unique_emails = set(emails_found)
            # 过滤掉明显不是用户邮箱的（如支持邮箱等）
            user_emails = [e for e in unique_emails if 'support' not in e.lower() and 'help' not in e.lower()]
            if 1 <= len(user_emails) <= 6:
                self._log(f"[{email}] 通过邮箱计数检测到 {len(user_emails)} 个成员")
                return len(user_emails)

            # 方法 4: 输出页面文本用于调试（仅前500字符）
            self._log(f"[{email}] 页面文本前500字: {page_text[:500].replace(chr(10), ' ')}")

            # 方法 5: 默认返回 1（至少有管理员自己）
            self._log(f"[{email}] 无法精确检测成员数量，默认为 1（管理员自己）")
            return 1

        except Exception as e:
            self._log(f"[{email}] [!] 获取家庭成员数量失败: {e}")
            return 0

    async def batch_refresh_membership_info(
        self,
        accounts: List[Dict],
        browser_ids: List[str],
        mode: str = "full",
    ) -> BatchResult:
        """
        批量刷新会员信息

        Args:
            accounts: 账号列表（需要已登录）
            browser_ids: 浏览器窗口 ID 列表（与账号一一对应）
            mode: 刷新模式
                - "pro_only": 仅检测 Pro 状态（兼容现有逻辑）
                - "full": 完整刷新（Pro + 家庭组详情 + 国家）

        Returns:
            BatchResult: 批量处理结果
        """
        if len(accounts) != len(browser_ids):
            raise ValueError("账号数量与浏览器窗口数量不匹配")

        result = BatchResult(total=len(accounts))
        result.start_time = datetime.now()
        self._stop_flag = False
        self._semaphore = asyncio.Semaphore(self.concurrency)

        mode_text = "完整刷新" if mode == "full" else "Pro 检测"
        self._log(f"开始批量{mode_text}，共 {len(accounts)} 个账号，并发数 {self.concurrency}")

        # 如果是 full 模式，创建任务记录
        task_id = None
        if mode == "full":
            try:
                task_id = DBManager.create_refresh_task(
                    task_mode=mode,
                    total_count=len(accounts),
                )
                emails = [a.get("email", "") for a in accounts]
                DBManager.create_refresh_task_items(task_id, emails)
                self._log(f"创建刷新任务 #{task_id}")
            except Exception as e:
                self._log(f"创建任务记录失败: {e}")
                task_id = None

        # 创建任务
        tasks = []
        for account, browser_id in zip(accounts, browser_ids):
            task = self._refresh_membership_with_semaphore(
                account=account,
                browser_id=browser_id,
                mode=mode,
                task_id=task_id,
                result=result,
            )
            tasks.append(task)

        # 并发执行
        await asyncio.gather(*tasks, return_exceptions=True)

        result.end_time = datetime.now()

        # 统计
        pro_count = sum(
            1 for r in result.results
            if r.get("status") == "success" and r.get("data", {}).get("is_pro") == "yes"
        )
        family_pro_count = sum(
            1 for r in result.results
            if r.get("status") == "success" and r.get("data", {}).get("is_pro") == "family_yes"
        )
        non_pro_count = sum(
            1 for r in result.results
            if r.get("status") == "success" and r.get("data", {}).get("is_pro") == "no"
        )

        self._log(
            f"批量{mode_text}完成: Pro {pro_count}, Pro(家庭组) {family_pro_count}, 非Pro {non_pro_count}, "
            f"失败 {result.failed_count}, 耗时 {result.duration_seconds:.1f}s"
        )

        # 更新任务状态
        if task_id:
            try:
                DBManager.finish_refresh_task(
                    task_id=task_id,
                    status="completed" if not self._stop_flag else "stopped",
                    success_count=result.success_count,
                    failed_count=result.failed_count,
                )
            except Exception as e:
                self._log(f"更新任务状态失败: {e}")

        # 添加统计摘要
        result.results.append({
            "_summary": True,
            "pro_count": pro_count + family_pro_count,
            "pro_regular_count": pro_count,
            "pro_family_count": family_pro_count,
            "non_pro_count": non_pro_count,
        })

        return result

    async def _refresh_membership_with_semaphore(
        self,
        account: Dict,
        browser_id: str,
        mode: str,
        task_id: int | None,
        result: BatchResult,
    ):
        """带信号量控制的会员信息刷新任务"""
        from services.ix_api import openBrowser

        email = account.get("email", "unknown")

        if self._stop_flag:
            result.add_skipped(email, "用户停止")
            return

        async with self._semaphore:
            if self._stop_flag:
                result.add_skipped(email, "用户停止")
                return

            # 标记任务明细开始
            if task_id:
                try:
                    DBManager.update_refresh_task_item_started(task_id, email)
                except Exception:
                    pass

            try:
                self._log(f"[{email}] 开始刷新会员信息 (mode={mode})...")

                # 打开浏览器
                open_result = openBrowser(browser_id)
                if not open_result.get("success"):
                    error_msg = open_result.get("msg", "打开浏览器失败")
                    result.add_failed(email, error_msg, "browser_open_failed")
                    self._log(f"[{email}] ❌ 打开浏览器失败: {error_msg}")
                    self._update_task_item_failed(task_id, email, error_msg)
                    return

                ws_endpoint = open_result.get("data", {}).get("ws", "")
                if not ws_endpoint:
                    result.add_failed(email, "无法获取 WebSocket 端点", "no_ws_endpoint")
                    self._log(f"[{email}] ❌ 无法获取 WebSocket 端点")
                    self._update_task_item_failed(task_id, email, "无法获取 WebSocket 端点")
                    return

                # ========== 统一引擎管理：Step 1/2/3 共用同一个 BrowserUseEngine ==========
                # 关键修复：避免 Step 1 创建/销毁引擎后 SOCKS 代理失效
                # 原因：engine.stop() 调用 browser.close() 断开 CDP 连接，
                # 可能破坏浏览器的网络栈状态，导致后续 CDP 重连后 SOCKS 代理不可用

                if mode == "full":
                    if not BROWSERUSE_ENGINE_AVAILABLE or not BrowserUseEngine:
                        raise RuntimeError("BrowserUseEngine 不可用，无法进行 full 模式检测")

                    # 创建引擎实例并连接 CDP（全程共用）
                    self._log(f"[{email}] 创建 BrowserUseEngine（全程共用）...")
                    engine = BrowserUseEngine()
                    try:
                        await engine.connect_cdp(ws_endpoint)
                        # Step 1: 检测 Pro 状态（使用共用引擎）
                        self._log(f"[{email}] Step 1: 检测 Pro 状态...")
                        pro_status = await check_pro_status_with_engine(
                            engine=engine,
                            email=email,
                            log=lambda msg: self._log(f"[{email}] {msg}"),
                        )

                        # 创建结果对象
                        refresh_result = AccountMembershipRefreshResult.from_pro_status(
                            email=email,
                            is_pro=pro_status if pro_status else "detection_failed",
                        )

                        if pro_status is None:
                            # 检测失败
                            DBManager.update_pro_status(email, "detection_failed")
                            result.add_failed(email, "检测失败", "detection_failed")
                            self._log(f"[{email}] ❌ 检测 Pro 状态失败")
                            self._update_task_item_failed(task_id, email, "检测失败")
                        else:
                            # 检测成功
                            status_text_map = {
                                "yes": "Pro",
                                "family_yes": "Pro(家庭组)",
                                "no": "非Pro",
                            }
                            status_text = status_text_map.get(pro_status, pro_status)
                            self._log(f"[{email}] ✅ Pro 状态: {status_text}")

                            # Step 2: 检测家庭组详情（Pro 账号 + "no" 账号的反向验证）
                            if pro_status in ("yes", "family_yes"):
                                self._log(f"[{email}] Step 2: 检测家庭组详情 (BrowserUseEngine)...")
                                await self._detect_family_details_via_browseruse(engine, email, refresh_result)

                                # ========== 关键协调：根据家庭组检测结果修正 is_pro ==========
                                if refresh_result.is_pro == "yes" and refresh_result.family_role == "member":
                                    self._log(f"[{email}] ⚠️ 状态修正: is_pro 从 'yes' 修正为 'family_yes'（检测到家庭成员角色）")
                                    refresh_result.is_pro = "family_yes"
                                    refresh_result.membership_type = "family"

                            elif pro_status == "no":
                                # ========== 反向验证 ==========
                                self._log(f"[{email}] Step 2 (反向验证): 检查是否实际为家庭组成员...")
                                await self._detect_family_details_via_browseruse(engine, email, refresh_result)

                                if refresh_result.has_family_group == "yes" and refresh_result.family_role == "member":
                                    self._log(f"[{email}] ⚠️ 反向验证修正: is_pro 从 'no' 修正为 'family_yes'")
                                    refresh_result.is_pro = "family_yes"
                                    refresh_result.membership_type = "family"
                                    pro_status = "family_yes"
                                elif refresh_result.has_family_group == "yes" and refresh_result.family_role == "manager":
                                    self._log(f"[{email}] ⚠️ 反向验证修正: is_pro 从 'no' 修正为 'yes'")
                                    refresh_result.is_pro = "yes"
                                    refresh_result.membership_type = "regular"
                                    pro_status = "yes"
                                else:
                                    self._log(f"[{email}] 反向验证: 确认为非 Pro")

                            # Step 3: 提取账户国家（所有账号）
                            self._log(f"[{email}] Step 3: 提取账户国家 (BrowserUseEngine)...")
                            await self._extract_account_country_via_browseruse(engine, email, refresh_result)

                            # 计算剩余位置
                            refresh_result.calculate_family_slots()

                            # Step 4: 写入数据库
                            DBManager.update_membership_info(
                                email=email,
                                is_pro=refresh_result.is_pro,
                                pro_plan_name=refresh_result.pro_plan_name,
                                family_role=refresh_result.family_role,
                                family_manager_email=refresh_result.family_manager_email,
                                has_family_group=refresh_result.has_family_group,
                                family_member_count=refresh_result.family_member_count,
                                family_slots_left=refresh_result.family_slots_left,
                                account_country=refresh_result.account_country,
                                error_message=None,
                            )

                            result.add_success(email, refresh_result.to_dict())

                            # 更新任务明细
                            if task_id:
                                try:
                                    DBManager.update_refresh_task_item(
                                        task_id=task_id,
                                        email=email,
                                        status="success",
                                        result=refresh_result.to_dict(),
                                    )
                                except Exception:
                                    pass

                    finally:
                        await engine.stop(close_browser=False)

                else:
                    # pro_only 模式：使用独立引擎（向后兼容）
                    self._log(f"[{email}] Step 1: 检测 Pro 状态...")
                    pro_status = await check_pro_status_via_stagehand(
                        page=None,
                        email=email,
                        ws_endpoint=ws_endpoint,
                        log=lambda msg: self._log(f"[{email}] {msg}"),
                    )

                    refresh_result = AccountMembershipRefreshResult.from_pro_status(
                        email=email,
                        is_pro=pro_status if pro_status else "detection_failed",
                    )

                    if pro_status is None:
                        DBManager.update_pro_status(email, "detection_failed")
                        result.add_failed(email, "检测失败", "detection_failed")
                        self._log(f"[{email}] ❌ 检测 Pro 状态失败")
                        self._update_task_item_failed(task_id, email, "检测失败")
                    else:
                        status_text_map = {
                            "yes": "Pro",
                            "family_yes": "Pro(家庭组)",
                            "no": "非Pro",
                        }
                        status_text = status_text_map.get(pro_status, pro_status)
                        self._log(f"[{email}] ✅ Pro 状态: {status_text}")

                        # pro_only 模式：仅更新 is_pro 字段
                        DBManager.update_pro_status(email, refresh_result.is_pro)
                        result.add_success(email, refresh_result.to_dict())

                # 检测完成后关闭浏览器
                try:
                    closeBrowser(browser_id)
                    self._log(f"[{email}] 浏览器窗口已关闭")
                except Exception as e:
                    self._log(f"[{email}] 关闭窗口失败: {e}")

            except Exception as e:
                result.add_failed(email, str(e), "exception")
                self._log(f"[{email}] ❌ 异常: {e}")
                self._update_task_item_failed(task_id, email, str(e))
                # 尝试关闭浏览器
                try:
                    closeBrowser(browser_id)
                except Exception:
                    pass

    def _update_task_item_failed(self, task_id: int | None, email: str, error_message: str):
        """更新任务明细为失败状态"""
        if task_id:
            try:
                DBManager.update_refresh_task_item(
                    task_id=task_id,
                    email=email,
                    status="failed",
                    result={"error_message": error_message},
                )
            except Exception:
                pass

    async def _detect_family_details_via_browseruse(
        self,
        engine: "BrowserUseEngine",
        email: str,
        refresh_result: "AccountMembershipRefreshResult",
    ):
        """
        检测家庭组详情 - 页面文本优先方案（Plan B）

        策略：
        1. 导航到 myaccount.google.com/family/details（唯一可靠 URL）
        2. 先用 Playwright inner_text 提取页面文本
        3. 用正则从页面文本提取：角色、管理员名、成员数、邮箱
        4. AI 仅在管理员邮箱缺失时使用（可能需要点击成员头像）
        5. 导航失败不级联影响后续步骤

        已知页面文本示例（myaccount.google.com/family/details）：
        ```
        Your Family Group details
        View and manage your Family Group options. Learn more
        Dyg Gonzales  gonzalesdyg126@gmail.com  Member
        By leaving Bruna's Family Group, you'll lose access to ...  Leave Family Group
        ```
        """
        import re

        try:
            # 重要修复：如果已经是 family_yes（家庭组成员），角色一定是 member
            # 这个逻辑放在最前面，确保即使后续失败也能设置正确的角色
            if refresh_result.is_pro == "family_yes":
                refresh_result.family_role = "member"
                self._log(f"[{email}] 账号是 family_yes，角色固定为 member")

            # ========== Step 1: 导航到家庭组页面 ==========
            # 注意：只使用 myaccount.google.com，因为 families.google.com 被 SOCKS 代理阻断
            family_url = "https://myaccount.google.com/family/details"
            self._log(f"[{email}] 导航到家庭组页面: {family_url}")
            nav_result = await engine.navigate(family_url, timeout=15000)

            if not nav_result.success:
                self._log(f"[{email}] 导航家庭组页面失败: {nav_result.error}")
                return

            # 等待页面加载
            await asyncio.sleep(3)

            # 检查是否导航到了错误页面（如 chrome-error://）
            page = engine._page
            if not page:
                self._log(f"[{email}] Page 对象不可用")
                return

            actual_url = page.url
            self._log(f"[{email}] 家庭组页面实际 URL: {actual_url}")

            if "chrome-error" in actual_url or "about:blank" in actual_url:
                self._log(f"[{email}] 页面加载失败（错误页面），跳过家庭组检测")
                return

            # ========== Step 2: 从页面文本提取信息（主要方法） ==========
            self._log(f"[{email}] 从页面文本提取家庭组信息...")
            try:
                page_text = await page.inner_text("body")
            except Exception as e:
                self._log(f"[{email}] 获取页面文本失败: {e}")
                return

            page_text_lower = page_text.lower()
            self._log(f"[{email}] 页面文本 (前500字): {page_text[:500].replace(chr(10), ' ')}")

            # ---------- 2a: 判断是否有家庭组 ----------
            # 有家庭组的标识
            has_family_indicators = [
                "your family group",       # 英文
                "family group details",    # 英文
                "家庭群组详细信息",          # 中文简体
                "你的家庭群组",              # 中文简体
                "您的家庭群组",              # 中文简体
                "family manager",          # 英文
                "家庭管理员",                # 中文简体
                "家庭群组管理員",            # 中文繁体
                "leave family",            # 英文（退出家庭组）
                "退出家庭群组",              # 中文
                "离开家庭群组",              # 中文
            ]
            # 无家庭组的标识
            no_family_indicators = [
                "create a family group",   # 英文
                "创建家庭群组",              # 中文
                "you can create",          # 英文
                "start a family group",    # 英文
                "no family group",         # 英文
            ]

            has_family = False
            no_family = False
            for indicator in has_family_indicators:
                if indicator.lower() in page_text_lower:
                    has_family = True
                    self._log(f"[{email}] 检测到家庭组标识: '{indicator}'")
                    break
            for indicator in no_family_indicators:
                if indicator.lower() in page_text_lower:
                    no_family = True
                    self._log(f"[{email}] 检测到无家庭组标识: '{indicator}'")
                    break

            if no_family and not has_family:
                refresh_result.has_family_group = "no"
                refresh_result.family_role = "none"
                self._log(f"[{email}] 页面文本确认：无家庭组")
                return
            elif has_family:
                refresh_result.has_family_group = "yes"
            else:
                self._log(f"[{email}] 无法从页面文本判断家庭组状态")
                refresh_result.has_family_group = "unknown"

            # ---------- 2b: 检测用户角色（Member vs Family manager） ----------
            # 关键逻辑：
            # - 如果页面文本包含 "Leave Family" / "退出家庭" → 当前用户是 member
            # - 如果页面文本包含 "X's Family Group" → X 是管理员，当前用户是 member
            # - 如果当前用户邮箱旁边标注 "Family manager" → 当前用户是 manager
            # - 如果当前用户邮箱旁边标注 "Member" → 当前用户是 member

            detected_role = None

            # 方法1: 查找 "Leave Family Group" 按钮（只有 member 才能看到）
            leave_patterns = [
                r"leave\s+famil",           # "Leave Family Group" / "Leave Family"
                r"退出家庭群组",
                r"离开家庭群组",
                r"退出家庭",
            ]
            for pattern in leave_patterns:
                if re.search(pattern, page_text, re.IGNORECASE):
                    detected_role = "member"
                    self._log(f"[{email}] 页面文本检测到 'Leave Family' → 角色=member")
                    break

            # 方法2: 查找 "X's Family Group"（X 是管理员名字）
            if not detected_role:
                # 匹配 "Bruna's Family Group" / "xxx 的家庭群组"
                manager_name_patterns = [
                    r"(?:leaving|leave)\s+(\w+(?:\s+\w+)?)'s\s+family",  # "leaving Bruna's Family"
                    r"(\w+(?:\s+\w+)?)'s\s+family\s+group",               # "Bruna's Family Group"
                    r"(\S+)\s*的家庭群组",                                  # "xxx 的家庭群组"
                ]
                for pattern in manager_name_patterns:
                    match = re.search(pattern, page_text, re.IGNORECASE)
                    if match:
                        manager_name = match.group(1).strip()
                        detected_role = "member"
                        self._log(f"[{email}] 页面文本检测到管理员名: '{manager_name}' → 角色=member")
                        break

            # 方法3: 查找当前用户邮箱附近的角色标注
            if not detected_role:
                # 提取当前用户邮箱前后的文本上下文
                email_lower = email.lower()
                email_pos = page_text_lower.find(email_lower)
                if email_pos >= 0:
                    # 取邮箱前后 200 个字符
                    context_start = max(0, email_pos - 200)
                    context_end = min(len(page_text), email_pos + len(email) + 200)
                    email_context = page_text[context_start:context_end].lower()

                    if "member" in email_context and "family manager" not in email_context:
                        detected_role = "member"
                        self._log(f"[{email}] 邮箱上下文检测到 'Member' → 角色=member")
                    elif "family manager" in email_context or "家庭管理员" in email_context:
                        detected_role = "manager"
                        self._log(f"[{email}] 邮箱上下文检测到 'Family manager' → 角色=manager")

            # 方法4: 查找 "Delete Family Group" 按钮（只有 manager 才能看到）
            if not detected_role:
                manager_only_patterns = [
                    r"delete\s+family\s+group",  # 只有管理员才有删除按钮
                    r"删除家庭群组",
                    r"invite\s+family\s+member",  # 只有管理员才能邀请
                    r"邀请家庭成员",
                    r"add\s+family\s+member",     # 添加成员
                    r"添加家庭成员",
                ]
                for pattern in manager_only_patterns:
                    if re.search(pattern, page_text, re.IGNORECASE):
                        detected_role = "manager"
                        self._log(f"[{email}] 页面文本检测到管理员专属按钮 → 角色=manager")
                        break

            # 应用检测到的角色（如果 is_pro 不是 family_yes，才使用页面文本检测结果）
            if detected_role:
                if refresh_result.is_pro == "family_yes":
                    # family_yes 的角色已固定为 member，不覆盖
                    self._log(f"[{email}] family_yes 角色固定为 member，忽略页面文本检测到的: {detected_role}")
                else:
                    refresh_result.family_role = detected_role
                    self._log(f"[{email}] 页面文本最终角色: {detected_role}")

            # ---------- 2c: 提取成员数量 ----------
            # 方法1: 正则匹配 "X members" / "X 位成员"
            count_patterns = [
                r'(\d+)\s*(?:family\s+)?members?',
                r'(\d+)\s*位\s*(?:家庭)?成员',
                r'(\d+)\s*人',
                r'家庭群组\s*\((\d+)\)',
            ]
            for pattern in count_patterns:
                match = re.search(pattern, page_text, re.IGNORECASE)
                if match:
                    count = int(match.group(1))
                    if 1 <= count <= 6:
                        refresh_result.family_member_count = count
                        self._log(f"[{email}] 页面文本提取成员数: {count}")
                        break

            # 方法2: 统计页面上的邮箱地址数量
            if refresh_result.family_member_count == 0:
                emails_found = re.findall(r'[\w.+-]+@[\w-]+\.\w+', page_text)
                unique_emails = set(
                    e for e in emails_found
                    if 'support' not in e.lower()
                    and 'help' not in e.lower()
                    and 'noreply' not in e.lower()
                    and not e.lower().endswith('@google.com')
                )
                if len(unique_emails) >= 1:
                    # 注意：页面可能只显示当前用户的邮箱
                    # 如果检测到 has_family_group=yes 且角色=member，至少有 2 人
                    count = len(unique_emails)
                    if refresh_result.has_family_group == "yes" and count == 1:
                        count = 2  # 至少有管理员 + 当前用户
                    if 1 <= count <= 6:
                        refresh_result.family_member_count = count
                        self._log(f"[{email}] 通过邮箱计数提取成员数: {count} (页面邮箱: {unique_emails})")

            # 方法3: 默认值
            if refresh_result.family_member_count == 0 and refresh_result.has_family_group == "yes":
                refresh_result.family_member_count = 2  # 至少有管理员 + 当前用户
                self._log(f"[{email}] 默认成员数: 2")

            # ---------- 2d: 提取管理员邮箱（从页面文本） ----------
            if not refresh_result.family_manager_email:
                # 从页面文本中查找邮箱
                emails_found = re.findall(r'[\w.+-]+@[\w-]+\.\w+', page_text)
                # 过滤：排除当前用户邮箱和系统邮箱
                candidate_emails = [
                    e for e in emails_found
                    if e.lower() != email.lower()
                    and 'support' not in e.lower()
                    and 'help' not in e.lower()
                    and 'noreply' not in e.lower()
                    and not e.lower().endswith('@google.com')
                ]
                if candidate_emails:
                    refresh_result.family_manager_email = candidate_emails[0]
                    self._log(f"[{email}] 页面文本提取管理员邮箱: {candidate_emails[0]}")

            # ========== Step 3: AI 补充提取（仅在管理员邮箱缺失时） ==========
            if not refresh_result.family_manager_email and refresh_result.has_family_group == "yes":
                self._log(f"[{email}] 管理员邮箱仍为空，使用 AI 尝试提取...")
                try:
                    extract_result = await engine.extract(
                        instruction="""Look at this Google Family page. I need the family manager's EMAIL ADDRESS.

The family manager is the person who created/manages this family group.
Their email should be visible on this page as text, OR you may need to click on their name/profile to reveal it.

IMPORTANT: Look for email addresses in format like name@gmail.com
- Check near each person's name
- If emails are hidden, try clicking on the family manager's name or profile picture

Return ONLY a JSON object:
{"family_manager_email": "email@gmail.com"}

If truly not found after clicking, return: {"family_manager_email": ""}""",
                        timeout=30000,
                        max_steps=6,
                    )

                    if extract_result.success and extract_result.data:
                        data = extract_result.data
                        self._log(f"[{email}] AI 管理员邮箱提取结果: {data}")

                        # 处理 {'content': '...'} 包装格式
                        if isinstance(data, dict) and "content" in data and len(data) == 1:
                            content_str = data.get("content", "")
                            # 从文本中提取邮箱
                            email_match = re.search(r'[\w.+-]+@[\w-]+\.[\w.]+', content_str)
                            if email_match:
                                found_email = email_match.group(0)
                                if found_email.lower() != email.lower():
                                    data = {"family_manager_email": found_email}
                            # 尝试提取 JSON
                            import json as _json
                            json_match = re.search(r'\{[^{}]*"family_manager_email"[^{}]*\}', content_str)
                            if json_match:
                                try:
                                    data = _json.loads(json_match.group())
                                except _json.JSONDecodeError:
                                    pass

                        if isinstance(data, dict):
                            mgr_email = data.get("family_manager_email", "")
                            if mgr_email and "@" in mgr_email and mgr_email.lower() != email.lower():
                                refresh_result.family_manager_email = mgr_email
                                self._log(f"[{email}] ✅ AI 提取管理员邮箱成功: {mgr_email}")
                            else:
                                self._log(f"[{email}] AI 未找到管理员邮箱")
                    else:
                        self._log(f"[{email}] AI 提取失败: {extract_result.error}")

                except Exception as e:
                    self._log(f"[{email}] AI 提取管理员邮箱异常: {e}")

            self._log(f"[{email}] 家庭组: has={refresh_result.has_family_group}, role={refresh_result.family_role}, count={refresh_result.family_member_count}, manager_email={refresh_result.family_manager_email}")

        except Exception as e:
            self._log(f"[{email}] 家庭组检测失败: {e}")

    async def _extract_account_country_via_browseruse(
        self,
        engine: "BrowserUseEngine",
        email: str,
        refresh_result: "AccountMembershipRefreshResult",
    ):
        """
        使用 BrowserUseEngine AI 提取账户国家
        """
        try:
            # ========== 导航错误恢复 ==========
            # 如果之前的步骤导致浏览器停留在 chrome-error 页面，需要先恢复
            try:
                page = engine._page
                if page:
                    current_url = page.url
                    if "chrome-error" in current_url or "about:blank" in current_url:
                        self._log(f"[{email}] 检测到错误页面 ({current_url})，尝试恢复...")
                        # 先导航到一个简单的 Google 页面恢复状态
                        recovery_result = await engine.navigate(
                            "https://myaccount.google.com",
                            timeout=15000,
                        )
                        if not recovery_result.success:
                            self._log(f"[{email}] 页面恢复失败，跳过国家提取")
                            refresh_result.account_country = "unknown"
                            return
                        await asyncio.sleep(2)
            except Exception as e:
                self._log(f"[{email}] 检查页面状态异常: {e}")

            # 导航到 Google 账号设置页面
            self._log(f"[{email}] BrowserUseEngine: 导航到账号设置页面...")
            nav_result = await engine.navigate(
                "https://myaccount.google.com/personal-info",
                timeout=15000,
            )
            if not nav_result.success:
                self._log(f"[{email}] 导航账号设置页面失败: {nav_result.error}")
                refresh_result.account_country = "unknown"
                return

            # 检查导航后是否又到了错误页面
            try:
                page = engine._page
                if page and ("chrome-error" in page.url or "about:blank" in page.url):
                    self._log(f"[{email}] 导航后仍在错误页面，跳过国家提取")
                    refresh_result.account_country = "unknown"
                    return
            except Exception:
                pass

            # 等待页面加载
            await asyncio.sleep(2)

            # 使用 AI 提取国家信息
            self._log(f"[{email}] BrowserUseEngine: 使用 AI 提取国家信息...")

            extract_instruction = """Analyze this Google Account personal info page and find the user's country/region.

Look for:
- "Country/Region" field and its value
- Location or address information
- Any country name displayed on the page

Return ONLY a valid JSON object with one key:
- account_country: The country name in English (e.g., "United States", "China", "Japan", "United Kingdom")
  - Return "unknown" if the country cannot be determined"""

            extract_result = await engine.extract(
                instruction=extract_instruction,
                schema=AccountCountryExtractModel if AccountCountryExtractModel else None,
                timeout=30000,
                max_steps=10,
            )

            if extract_result.success and extract_result.data:
                data = extract_result.data
                self._log(f"[{email}] AI 提取国家结果: {data}")

                # 处理 {'content': '...'} 包装格式
                if isinstance(data, dict) and "content" in data and len(data) == 1:
                    content_str = data.get("content", "")
                    import re
                    json_match = re.search(r'\{[^{}]*"account_country"[^{}]*\}', content_str, re.DOTALL)
                    if json_match:
                        try:
                            import json
                            data = json.loads(json_match.group())
                            self._log(f"[{email}] 从 content 中提取 JSON: {data}")
                        except json.JSONDecodeError:
                            pass
                    else:
                        # AI 返回自然语言，尝试从中提取国家名
                        country_patterns = [
                            r'(?:country|国家|地区|region)\s*(?:is|为|：|:)\s*([A-Z][a-zA-Z\s]+)',
                            r'(?:United States|United Kingdom|China|Japan|South Korea|Germany|France|Brazil|India|Canada|Australia|Mexico|Russia|Italy|Spain|Netherlands|Turkey|Indonesia|Thailand|Vietnam|Philippines|Malaysia|Singapore|Taiwan|Hong Kong)',
                        ]
                        for pattern in country_patterns:
                            match = re.search(pattern, content_str, re.IGNORECASE)
                            if match:
                                country_name = match.group(1).strip() if match.lastindex else match.group(0).strip()
                                data = {"account_country": country_name}
                                self._log(f"[{email}] 从自然语言中提取国家: {country_name}")
                                break

                if isinstance(data, dict):
                    country = data.get("account_country", "unknown")
                    if country and country != "unknown":
                        refresh_result.account_country = country
                        self._log(f"[{email}] 检测到国家: {country}")
                        return
                else:
                    self._log(f"[{email}] AI 返回非字典类型数据: {type(data)}")

            refresh_result.account_country = "unknown"
            self._log(f"[{email}] 未检测到国家，设为 unknown")

        except Exception as e:
            self._log(f"[{email}] BrowserUseEngine 国家提取失败: {e}")
            refresh_result.account_country = "unknown"


# ==================== 便捷函数 ====================

async def quick_batch_login(
    accounts: List[Dict],
    browser_ids: List[str],
    concurrency: int = 3,
    callback: Callable = None,
    max_retries: int = None,
) -> BatchResult:
    """
    快速批量登录

    Args:
        accounts: 账号列表
        browser_ids: 浏览器窗口 ID 列表
        concurrency: 并发数
        callback: 回调函数
        max_retries: 登录最大重试次数（可选，默认从配置读取）

    Returns:
        BatchResult: 批量结果
    """
    processor = BatchAccountProcessor(concurrency=concurrency, callback=callback)
    return await processor.batch_login(accounts, browser_ids, max_retries=max_retries)


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
