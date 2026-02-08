"""
Stagehand Google Engine - 订阅操作

订阅 Google One 服务
"""

import logging
import time
from typing import Optional, TYPE_CHECKING

from ..types import SubscribeResult
from ..constants import GoogleURLs, Timeouts

if TYPE_CHECKING:
    from ..engine import StagehandGoogleEngine

logger = logging.getLogger(__name__)


class SubscribeOperation:
    """订阅操作"""

    def __init__(self, engine: "StagehandGoogleEngine"):
        self.engine = engine

    async def execute(
        self,
        plan: str = "student",
        timeout: float = Timeouts.OPERATION,
    ) -> SubscribeResult:
        """
        订阅 Google One

        Args:
            plan: 订阅计划 ("student", "regular", "trial")
            timeout: 超时时间

        Returns:
            SubscribeResult
        """
        start_time = time.time()
        logger.info(f"开始订阅操作，计划: {plan}")

        # 确定订阅 URL
        subscribe_urls = {
            "student": GoogleURLs.STUDENT_SUBSCRIBE,
            "regular": GoogleURLs.GOOGLE_ONE_PLANS,
            "trial": GoogleURLs.GOOGLE_ONE_PLANS,
        }
        target_url = subscribe_urls.get(plan, GoogleURLs.STUDENT_SUBSCRIBE)

        try:
            # 1. 导航到订阅页面
            nav_result = await self.engine.navigate(
                target_url,
                timeout=Timeouts.NAVIGATION,
            )

            if not nav_result.success:
                return SubscribeResult(
                    success=False,
                    message="导航到订阅页面失败",
                    error=nav_result.error_message,
                    plan=plan,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            await self.engine.wait(Timeouts.AFTER_NAVIGATION)

            # 2. 检查是否需要登录
            current_url = await self.engine.get_current_url()
            if "accounts.google.com" in current_url and "signin" in current_url:
                return SubscribeResult(
                    success=False,
                    message="需要先登录账号",
                    error="未登录",
                    plan=plan,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # 3. 检查当前订阅状态
            status_result = await self._check_subscription_status()

            if status_result.get("already_subscribed"):
                return SubscribeResult(
                    success=True,
                    message="已有订阅",
                    already_subscribed=True,
                    plan=plan,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            if status_result.get("ineligible"):
                return SubscribeResult(
                    success=False,
                    message="无资格订阅",
                    error="账号不符合订阅条件",
                    plan=plan,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # 4. 执行订阅流程
            subscribe_result = await self._perform_subscribe(plan)

            duration_ms = (time.time() - start_time) * 1000

            if subscribe_result.get("success"):
                return SubscribeResult(
                    success=True,
                    message="订阅成功",
                    plan=plan,
                    duration_ms=duration_ms,
                )
            else:
                return SubscribeResult(
                    success=False,
                    message=subscribe_result.get("message", "订阅失败"),
                    error=subscribe_result.get("error"),
                    plan=plan,
                    duration_ms=duration_ms,
                )

        except Exception as e:
            logger.error(f"订阅操作失败: {e}")
            return SubscribeResult(
                success=False,
                message=f"操作失败: {str(e)}",
                error=str(e),
                plan=plan,
                duration_ms=(time.time() - start_time) * 1000,
            )

    async def _check_subscription_status(self) -> dict:
        """检查订阅状态"""
        try:
            extract_result = await self.engine.extract(
                """
                检查当前页面的订阅状态：
                1. 是否已订阅 ("You have Google One", "已订阅", "Member")
                2. 是否无资格 ("Not eligible", "无资格", "Ineligible")
                3. 是否可以订阅 ("Get started", "Subscribe", "订阅")
                """
            )

            if not extract_result.success:
                return {}

            data = extract_result.data or {}
            result_text = str(data).lower()

            return {
                "already_subscribed": any(kw in result_text for kw in ["you have", "已订阅", "member", "active"]),
                "ineligible": any(kw in result_text for kw in ["not eligible", "无资格", "ineligible"]),
                "can_subscribe": any(kw in result_text for kw in ["get started", "subscribe", "订阅"]),
            }

        except Exception as e:
            logger.warning(f"检查订阅状态失败: {e}")
            return {}

    async def _perform_subscribe(self, plan: str) -> dict:
        """执行订阅流程"""
        try:
            # Step 1: 点击订阅按钮
            if plan == "student":
                await self.engine.act(
                    "点击 'Get student discount' 或 '获取学生优惠' 或 'Get started' 或 '开始' 按钮"
                )
            else:
                await self.engine.act(
                    "点击 'Subscribe' 或 '订阅' 或 'Get Google One' 或 '获取 Google One' 按钮"
                )
            await self.engine.wait(Timeouts.AFTER_CLICK * 2)

            # Step 2: 选择计划（如果有多个选项）
            if plan == "trial":
                await self.engine.act(
                    "点击 'Start free trial' 或 '开始免费试用' 按钮"
                )
            elif plan == "regular":
                await self.engine.act(
                    "点击 '100 GB' 或 '200 GB' 或 '2 TB' 计划选项"
                )
            await self.engine.wait(Timeouts.AFTER_CLICK)

            # Step 3: 处理支付/确认
            for _ in range(3):
                click_result = await self.engine.act(
                    "点击 'Subscribe' 或 '订阅' 或 'Buy' 或 '购买' 或 'Continue' 或 '继续' 或 'Confirm' 或 '确认' 按钮"
                )
                await self.engine.wait(2000)

                # 检查是否需要支付方式
                check_result = await self.engine.extract(
                    "检查是否需要添加支付方式"
                )
                if check_result.success and check_result.data:
                    result_text = str(check_result.data).lower()
                    if "payment" in result_text or "支付" in result_text or "card" in result_text:
                        return {
                            "success": False,
                            "message": "需要添加支付方式",
                            "error": "请使用 bind_card 方法添加支付卡",
                        }

            # Step 4: 验证订阅成功
            verify_result = await self._verify_subscription()

            return verify_result

        except Exception as e:
            logger.warning(f"订阅流程失败: {e}")
            return {"success": False, "message": str(e), "error": str(e)}

    async def _verify_subscription(self) -> dict:
        """验证订阅是否成功"""
        try:
            await self.engine.wait(2000)

            extract_result = await self.engine.extract(
                """
                检查是否订阅成功：
                1. "Welcome to Google One" / "欢迎使用 Google One"
                2. "Subscription active" / "订阅已激活"
                3. "Thank you" / "感谢"
                4. "Member since" / "会员自"

                也检查错误：
                5. "Payment failed" / "支付失败"
                6. "Error" / "错误"
                """
            )

            if not extract_result.success:
                return {"success": False, "message": "无法验证订阅结果"}

            data = extract_result.data or {}
            result_text = str(data).lower()

            if any(kw in result_text for kw in ["welcome", "欢迎", "active", "激活", "thank", "感谢", "member since"]):
                return {"success": True}

            if any(kw in result_text for kw in ["failed", "失败", "error", "错误"]):
                return {"success": False, "message": "订阅失败", "error": "支付或确认失败"}

            return {"success": False, "message": "无法确定订阅结果"}

        except Exception as e:
            logger.warning(f"验证失败: {e}")
            return {"success": False, "error": str(e)}
