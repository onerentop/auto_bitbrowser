"""
一键全自动订阅 - StagehandGoogleEngine 版

整合三个步骤为一次完整操作：
1. 获取 SheerID 链接 (StagehandGoogleEngine)
2. 批量验证 SheerID (API)
3. 绑卡订阅 (StagehandGoogleEngine)

支持断点续传：记录失败步骤，下次从失败处继续
"""

import asyncio
import traceback
from enum import Enum
from typing import Optional, Callable, Tuple, List, Dict, Any
from dataclasses import dataclass

from services.database import DBManager
from services.ix_api import openBrowser, closeBrowser
from services.sheerid_verifier import SheerIDVerifier
from core.config_manager import ConfigManager
from core.stagehand_engine import StagehandGoogleEngine


class SubscribeStep(Enum):
    """订阅流程步骤"""
    GET_LINK = "get_link"           # 获取 SheerID 链接
    VERIFY_SHEERID = "verify_sheerid"   # 验证 SheerID
    BIND_CARD = "bind_card"         # 绑卡订阅
    COMPLETED = "completed"         # 已完成


@dataclass
class SubscribeResult:
    """订阅结果"""
    success: bool
    status: str         # 最终状态: subscribed, verified, link_ready, ineligible, error
    message: str
    failed_step: Optional[str] = None  # 失败的步骤
    error_detail: Optional[str] = None  # 详细错误信息


class AutoSubscriber:
    """
    自动订阅器 (StagehandGoogleEngine 版)

    整合 SheerID 链接获取 + 验证 + 绑卡订阅的完整流程
    支持断点续传
    """

    def __init__(
        self,
        sheerid_api_key: Optional[str] = None,
        ai_api_key: Optional[str] = None,
        ai_provider: Optional[str] = None,
        ai_base_url: Optional[str] = None,
        ai_model: Optional[str] = None,
        max_steps: int = 25,
        close_browser_after: bool = False,
    ):
        """
        初始化自动订阅器

        Args:
            sheerid_api_key: SheerID API 密钥（默认从配置读取）
            ai_api_key: AI API 密钥（默认从配置读取）
            ai_provider: LLM 提供商 (gemini, anthropic)，默认从配置读取
            ai_base_url: AI API Base URL（用于第三方服务）
            ai_model: 使用的模型（默认从配置读取）
            max_steps: AI Agent 最大步骤数（保留兼容）
            close_browser_after: 完成后是否关闭浏览器
        """
        self.sheerid_api_key = sheerid_api_key or ConfigManager.get_api_key()
        self.ai_api_key = ai_api_key or ConfigManager.get_ai_api_key()
        self.ai_provider = ai_provider or ConfigManager.get_ai_default_provider()
        self.ai_base_url = ai_base_url
        self.ai_model = ai_model
        self.max_steps = max_steps
        self.close_browser_after = close_browser_after

        # 回调函数
        self._on_progress: Optional[Callable[[str, str, str], None]] = None  # email, step, message
        self._on_log: Optional[Callable[[str], None]] = None

        # 停止标志
        self._stop_requested = False

    def on_progress(self, callback: Callable[[str, str, str], None]):
        """设置进度回调"""
        self._on_progress = callback

    def on_log(self, callback: Callable[[str], None]):
        """设置日志回调"""
        self._on_log = callback

    def stop(self):
        """请求停止"""
        self._stop_requested = True

    def _log(self, message: str):
        """输出日志"""
        print(message)
        if self._on_log:
            self._on_log(message)

    def _progress(self, email: str, step: str, message: str):
        """报告进度"""
        if self._on_progress:
            self._on_progress(email, step, message)

    def _determine_start_step(self, account: dict) -> SubscribeStep:
        """
        根据账号状态和失败步骤确定从哪一步开始

        断点续传逻辑：
        1. 如果有 last_failed_step，从该步骤重试
        2. 否则根据当前状态判断
        """
        status = account.get("status", "pending")
        last_failed_step = account.get("last_failed_step")

        # 如果有记录的失败步骤，从该步骤重试
        if last_failed_step:
            try:
                return SubscribeStep(last_failed_step)
            except ValueError:
                pass  # 无效的步骤值，继续根据状态判断

        # 根据状态确定起始步骤
        if status == "subscribed":
            return SubscribeStep.COMPLETED
        elif status == "verified":
            return SubscribeStep.BIND_CARD
        elif status == "link_ready":
            return SubscribeStep.VERIFY_SHEERID
        elif status == "ineligible":
            return SubscribeStep.COMPLETED  # 无资格，不处理
        else:
            # pending 或其他状态，从头开始
            return SubscribeStep.GET_LINK

    def _build_model_name(self) -> Optional[str]:
        """构建 Stagehand 模型名称"""
        if self.ai_model:
            if self.ai_provider:
                provider_map = {"gemini": "google", "anthropic": "anthropic"}
                stagehand_provider = provider_map.get(self.ai_provider, self.ai_provider)
                return f"{stagehand_provider}/{self.ai_model}"
            return self.ai_model
        return None

    async def process_account(
        self,
        browser_id: str,
        account: dict,
        card_info: Optional[dict] = None,
    ) -> SubscribeResult:
        """
        处理单个账号的完整订阅流程

        Args:
            browser_id: 浏览器窗口 ID
            account: 账号信息 {'email', 'password', 'secret', 'status', 'verification_link', ...}
            card_info: 卡片信息 {'number', 'exp_month', 'exp_year', 'cvv', 'name', 'zip_code'}

        Returns:
            SubscribeResult: 处理结果
        """
        email = account.get("email", "")

        # 确定从哪一步开始
        start_step = self._determine_start_step(account)

        if start_step == SubscribeStep.COMPLETED:
            status = account.get("status", "")
            if status == "subscribed":
                return SubscribeResult(True, "subscribed", "已订阅，无需处理")
            elif status == "ineligible":
                return SubscribeResult(False, "ineligible", "无资格，跳过")

        self._log(f"[{email}] 开始处理 (StagehandGoogleEngine)，起始步骤: {start_step.value}")

        # 清除之前的失败记录
        DBManager.upsert_account(email, last_failed_step="", last_error="")

        engine = None
        current_step = start_step

        try:
            # 连接到 ixBrowser 窗口
            self._progress(email, "连接浏览器", "正在连接浏览器...")
            engine = await StagehandGoogleEngine.connect_to_ixbrowser(
                browser_id=browser_id,
                model_name=self._build_model_name(),
                model_api_key=self.ai_api_key,
                close_browser_on_exit=self.close_browser_after,
            )

            # 执行流程
            verification_link = account.get("verification_link", "")

            # Step 1: 获取 SheerID 链接（如果需要）
            if current_step == SubscribeStep.GET_LINK:
                if self._stop_requested:
                    return SubscribeResult(False, "error", "用户请求停止", failed_step=current_step.value)

                self._progress(email, "获取链接", "正在获取 SheerID 链接...")
                result = await self._step_get_link(engine, account)

                if not result.success:
                    # 检查是否是特殊状态
                    if result.status in ("subscribed", "verified", "ineligible"):
                        DBManager.upsert_account(email, status=result.status)
                        if result.status == "verified":
                            current_step = SubscribeStep.BIND_CARD
                        else:
                            return result
                    else:
                        return self._handle_failure(email, current_step, result.message)
                else:
                    # 成功获取链接
                    verification_link = result.message
                    DBManager.upsert_account(email, link=verification_link, status="link_ready")
                    current_step = SubscribeStep.VERIFY_SHEERID

            # Step 2: 验证 SheerID（如果需要）
            if current_step == SubscribeStep.VERIFY_SHEERID:
                if self._stop_requested:
                    return SubscribeResult(False, "error", "用户请求停止", failed_step=current_step.value)

                if not verification_link:
                    verification_link = account.get("verification_link", "")

                if not verification_link:
                    return self._handle_failure(email, current_step, "没有 SheerID 验证链接")

                self._progress(email, "验证SheerID", "正在验证学生资格...")
                result = await self._step_verify_sheerid(
                    verification_link=verification_link,
                    email=email,
                    engine=engine,
                    account=account,
                )

                if not result.success:
                    if result.status == "ineligible":
                        DBManager.upsert_account(email, status="ineligible")
                        return result
                    return self._handle_failure(email, current_step, result.message)

                # 验证成功
                if result.status == "subscribed":
                    DBManager.upsert_account(email, status="subscribed")
                    return SubscribeResult(success=True, status="subscribed", message="账号已订阅")

                DBManager.upsert_account(email, status="verified")
                current_step = SubscribeStep.BIND_CARD

            # Step 3: 绑卡订阅（如果需要）
            if current_step == SubscribeStep.BIND_CARD:
                if self._stop_requested:
                    return SubscribeResult(False, "error", "用户请求停止", failed_step=current_step.value)

                if not card_info:
                    return self._handle_failure(email, current_step, "没有可用的卡片信息")

                self._progress(email, "绑卡订阅", "正在绑卡订阅...")
                result = await self._step_bind_card(engine, account, card_info)

                if not result.success:
                    return self._handle_failure(email, current_step, result.message)

                # 绑卡成功
                DBManager.upsert_account(email, status="subscribed")

                # 记录绑卡历史
                card_number = card_info.get("number", "")
                if card_number:
                    DBManager.add_bind_card_history(
                        email, card_number[-4:] if len(card_number) >= 4 else card_number
                    )

                return SubscribeResult(success=True, status="subscribed", message="订阅成功！")

            return SubscribeResult(success=False, status="error", message="未知流程状态")

        except Exception as e:
            traceback.print_exc()
            return self._handle_failure(email, current_step, f"处理异常: {str(e)}")

        finally:
            # 清理资源
            if engine:
                try:
                    await engine.stop(close_browser=self.close_browser_after)
                except Exception:
                    pass

            if self.close_browser_after:
                try:
                    closeBrowser(browser_id)
                except Exception:
                    pass

    def _handle_failure(
        self,
        email: str,
        step: SubscribeStep,
        error: str
    ) -> SubscribeResult:
        """处理失败，记录断点信息"""
        self._log(f"[{email}] ❌ 步骤 {step.value} 失败: {error}")

        # 保存失败信息到数据库（用于断点续传）
        DBManager.upsert_account(
            email,
            last_failed_step=step.value,
            last_error=error[:500] if error else None,
            status="error"
        )

        return SubscribeResult(
            success=False,
            status="error",
            message=error,
            failed_step=step.value,
            error_detail=error
        )

    async def _step_get_link(
        self,
        engine: StagehandGoogleEngine,
        account: dict
    ) -> SubscribeResult:
        """步骤1：获取 SheerID 验证链接"""
        email = account.get("email", "")

        try:
            result = await engine.get_sheerlink()

            if result.success:
                if result.sheerlink_url:
                    return SubscribeResult(
                        success=True,
                        status="link_ready",
                        message=result.sheerlink_url
                    )
                elif result.status == "subscribed":
                    return SubscribeResult(False, "subscribed", "已订阅")
                elif result.status == "verified":
                    return SubscribeResult(False, "verified", "已验证未绑卡")
                elif result.status == "ineligible":
                    return SubscribeResult(False, "ineligible", "无资格")

            return SubscribeResult(
                success=False,
                status="error",
                message=result.message or "获取链接失败"
            )

        except Exception as e:
            return SubscribeResult(
                success=False,
                status="error",
                message=f"获取链接异常: {str(e)}"
            )

    async def _step_verify_sheerid(
        self,
        verification_link: str,
        email: str,
        engine: StagehandGoogleEngine = None,
        account: dict = None,
    ) -> SubscribeResult:
        """步骤2：验证 SheerID"""
        if not self.sheerid_api_key:
            return SubscribeResult(
                success=False,
                status="error",
                message="未配置 SheerID API 密钥"
            )

        async def do_verify(link: str) -> tuple:
            """执行验证，返回 (success, status, message, result)"""
            try:
                import re
                match = re.search(r'verificationId=([a-zA-Z0-9]+)', link)
                if not match:
                    match = re.search(r'/verify/([a-zA-Z0-9]+)', link)

                if not match:
                    return False, "error", "无法从链接中提取 verificationId", None

                verification_id = match.group(1)
                self._log(f"[{email}] 验证 ID: {verification_id}")

                verifier = SheerIDVerifier(api_key=self.sheerid_api_key)

                def progress_callback(vid, msg):
                    self._log(f"[{email}] SheerID: {msg}")

                results = await asyncio.to_thread(
                    verifier.verify_batch,
                    [verification_id],
                    progress_callback
                )

                result = results.get(verification_id, {})
                status = result.get("currentStep", result.get("status", ""))

                if status == "success":
                    return True, "verified", "SheerID 验证成功", result
                else:
                    error_msg = result.get("message", "验证失败")
                    return False, "error", f"SheerID 验证失败: {error_msg}", result

            except Exception as e:
                return False, "error", f"SheerID 验证异常: {str(e)}", None

        try:
            # 首次验证
            success, status, message, result = await do_verify(verification_link)

            if success:
                return SubscribeResult(success=True, status=status, message=message)

            # 首次验证失败，尝试重新获取链接并重试
            self._log(f"[{email}] 首次验证失败: {message}，尝试重新获取链接...")

            if not engine or not account:
                self._log(f"[{email}] 缺少重试参数，跳过重试")
                return SubscribeResult(success=False, status=status, message=message)

            if self._stop_requested:
                return SubscribeResult(success=False, status="error", message="用户请求停止")

            # 重新获取链接
            self._progress(email, "重试获取链接", "验证失败，正在重新获取链接...")
            retry_result = await self._step_get_link(engine, account)

            if not retry_result.success:
                if retry_result.status == "verified":
                    self._log(f"[{email}] 重新获取链接时发现账号已验证")
                    return SubscribeResult(success=True, status="verified", message="账号已验证")
                elif retry_result.status == "subscribed":
                    self._log(f"[{email}] 重新获取链接时发现账号已订阅")
                    return SubscribeResult(success=True, status="subscribed", message="账号已订阅")
                elif retry_result.status == "ineligible":
                    return SubscribeResult(success=False, status="ineligible", message="账号无资格")
                self._log(f"[{email}] 重新获取链接失败: {retry_result.message}")
                return SubscribeResult(
                    success=False,
                    status="error",
                    message=f"{message} (重新获取链接也失败: {retry_result.message})"
                )

            # 获取到新链接
            new_link = retry_result.message
            self._log(f"[{email}] 获取到新链接，正在重试验证...")

            # 更新数据库中的链接
            DBManager.upsert_account(email, link=new_link, status="link_ready")

            if self._stop_requested:
                return SubscribeResult(success=False, status="error", message="用户请求停止")

            # 使用新链接重试验证
            self._progress(email, "重试验证", "已获取新链接，正在重试验证...")
            retry_success, retry_status, retry_message, _ = await do_verify(new_link)

            if retry_success:
                return SubscribeResult(success=True, status=retry_status, message=retry_message)
            else:
                return SubscribeResult(
                    success=False,
                    status=retry_status,
                    message=f"重试验证失败: {retry_message}"
                )

        except Exception as e:
            return SubscribeResult(
                success=False,
                status="error",
                message=f"SheerID 验证异常: {str(e)}"
            )

    async def _step_bind_card(
        self,
        engine: StagehandGoogleEngine,
        account: dict,
        card_info: dict
    ) -> SubscribeResult:
        """步骤3：绑卡订阅"""
        try:
            # 构建过期日期
            exp_month = card_info.get("exp_month", "")
            exp_year = card_info.get("exp_year", "")
            card_exp = f"{exp_month}/{exp_year}" if exp_month and exp_year else ""

            result = await engine.bind_card(
                card_number=card_info.get("number", ""),
                card_exp=card_exp,
                card_cvv=card_info.get("cvv", ""),
                card_name=card_info.get("name", "John Smith"),
                zip_code=card_info.get("zip_code", "10001"),
            )

            if result.success:
                return SubscribeResult(
                    success=True,
                    status="subscribed",
                    message="绑卡订阅成功"
                )
            else:
                return SubscribeResult(
                    success=False,
                    status="error",
                    message=result.message or "绑卡订阅失败"
                )

        except Exception as e:
            return SubscribeResult(
                success=False,
                status="error",
                message=f"绑卡订阅异常: {str(e)}"
            )


async def process_accounts_batch(
    accounts: List[Dict[str, Any]],
    cards: List[Dict[str, Any]],
    cards_per_account: int = 1,
    concurrent_count: int = 3,
    sheerid_api_key: Optional[str] = None,
    close_browser_after: bool = False,
    on_progress: Optional[Callable[[str, str, str], None]] = None,
    on_log: Optional[Callable[[str], None]] = None,
    on_complete: Optional[Callable[[str, SubscribeResult], None]] = None,
    stop_check: Optional[Callable[[], bool]] = None,
) -> Dict[str, SubscribeResult]:
    """
    批量处理账号订阅

    Args:
        accounts: 账号列表，每个账号需包含 browser_id
        cards: 卡片列表
        cards_per_account: 每张卡绑定几个账号
        concurrent_count: 并发数
        sheerid_api_key: SheerID API 密钥
        close_browser_after: 完成后是否关闭浏览器
        on_progress: 进度回调
        on_log: 日志回调
        on_complete: 单个账号完成回调
        stop_check: 停止检查回调，返回 True 表示应该停止

    Returns:
        {email: SubscribeResult} 字典
    """
    results = {}

    # 创建信号量控制并发
    semaphore = asyncio.Semaphore(concurrent_count)

    async def process_single(account: dict, card: Optional[dict]) -> Tuple[str, SubscribeResult]:
        async with semaphore:
            email = account.get("email", "")
            browser_id = account.get("browser_id", "")

            # 检查是否请求停止
            if stop_check and stop_check():
                result = SubscribeResult(
                    success=False,
                    status="error",
                    message="用户请求停止"
                )
                if on_complete:
                    on_complete(email, result)
                return email, result

            if not browser_id:
                result = SubscribeResult(
                    success=False,
                    status="error",
                    message="缺少 browser_id"
                )
                if on_complete:
                    on_complete(email, result)
                return email, result

            subscriber = AutoSubscriber(
                sheerid_api_key=sheerid_api_key,
                close_browser_after=close_browser_after,
            )

            # 传递停止检查到 subscriber
            if stop_check and stop_check():
                subscriber.stop()

            if on_progress:
                subscriber.on_progress(on_progress)
            if on_log:
                subscriber.on_log(on_log)

            result = await subscriber.process_account(
                browser_id=browser_id,
                account=account,
                card_info=card,
            )

            if on_complete:
                on_complete(email, result)

            return email, result

    # 准备任务列表
    usage_counts = DBManager.get_card_usage_counts()

    tasks = []
    for account in accounts:
        # 在本批次中查找下一张可用卡片
        current_card = None
        for index, card in enumerate(cards):
            card_number = card.get('number', '')
            card_suffix = card_number[-4:] if len(card_number) >= 4 else card_number

            current_usage = usage_counts.get(card_suffix, 0)

            if current_usage < cards_per_account:
                current_card = card
                usage_counts[card_suffix] = current_usage + 1
                if on_log:
                    on_log(f"[卡片分配] ****{card_suffix} (已使用 {current_usage + 1}/{cards_per_account})")
                break

        if current_card is None and cards:
            if on_log:
                on_log(f"⚠️ 所有卡片都已达到使用上限 ({cards_per_account})")

        tasks.append(process_single(account, current_card))

    # 并发执行
    completed = await asyncio.gather(*tasks, return_exceptions=True)

    for item in completed:
        if isinstance(item, Exception):
            continue
        email, result = item
        results[email] = result

    return results
