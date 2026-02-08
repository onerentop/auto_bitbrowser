"""
Stagehand Google Engine - 绑卡订阅操作

为 Google 账号绑定支付卡并完成订阅
"""

import logging
import re
import time
from typing import Optional, TYPE_CHECKING

from pydantic import BaseModel, Field

from ..types import BindCardResult
from ..constants import GoogleURLs, Timeouts

if TYPE_CHECKING:
    from ..engine import StagehandGoogleEngine

logger = logging.getLogger(__name__)


class CardFormSchema(BaseModel):
    """卡片表单 Schema"""
    has_card_number_input: bool = Field(default=False, description="是否有卡号输入框")
    has_expiry_input: bool = Field(default=False, description="是否有有效期输入框")
    has_cvv_input: bool = Field(default=False, description="是否有 CVV 输入框")
    has_name_input: bool = Field(default=False, description="是否有姓名输入框")
    has_zip_input: bool = Field(default=False, description="是否有邮编输入框")
    has_submit_button: bool = Field(default=False, description="是否有提交按钮")


class BindCardOperation:
    """绑卡订阅操作"""

    def __init__(self, engine: "StagehandGoogleEngine"):
        self.engine = engine

    async def execute(
        self,
        card_number: str,
        card_exp: str,
        card_cvv: str,
        card_name: str,
        zip_code: Optional[str] = None,
        timeout: float = Timeouts.OPERATION,
    ) -> BindCardResult:
        """
        绑定支付卡并完成订阅

        Args:
            card_number: 卡号
            card_exp: 有效期 (MM/YY 格式)
            card_cvv: CVV 安全码
            card_name: 持卡人姓名
            zip_code: 邮编 (某些地区需要)
            timeout: 超时时间

        Returns:
            BindCardResult
        """
        start_time = time.time()
        logger.info("开始绑卡订阅操作")

        # 参数验证 - 卡号
        if not card_number or not card_number.strip():
            return BindCardResult(
                success=False,
                message="卡号不能为空",
                error="card_number is required",
                duration_ms=(time.time() - start_time) * 1000,
            )

        # 清理卡号（移除空格和连字符）
        card_number_clean = re.sub(r'[\s\-]', '', card_number.strip())

        # 验证卡号格式（13-19位数字）
        if not card_number_clean.isdigit():
            return BindCardResult(
                success=False,
                message="卡号格式错误：必须为数字",
                error="card_number must contain only digits",
                duration_ms=(time.time() - start_time) * 1000,
            )

        if not (13 <= len(card_number_clean) <= 19):
            return BindCardResult(
                success=False,
                message=f"卡号长度错误：当前 {len(card_number_clean)} 位，应为 13-19 位",
                error=f"card_number length {len(card_number_clean)} is invalid, expected 13-19",
                duration_ms=(time.time() - start_time) * 1000,
            )

        # 参数验证 - CVV
        if not card_cvv or not card_cvv.strip():
            return BindCardResult(
                success=False,
                message="CVV 不能为空",
                error="card_cvv is required",
                duration_ms=(time.time() - start_time) * 1000,
            )

        cvv_clean = card_cvv.strip()
        if not cvv_clean.isdigit() or not (3 <= len(cvv_clean) <= 4):
            return BindCardResult(
                success=False,
                message=f"CVV 格式错误：必须为 3-4 位数字",
                error=f"card_cvv must be 3-4 digits",
                duration_ms=(time.time() - start_time) * 1000,
            )

        # 解析并验证有效期
        if not card_exp or not card_exp.strip():
            return BindCardResult(
                success=False,
                message="卡片有效期不能为空",
                error="card_exp is required",
                duration_ms=(time.time() - start_time) * 1000,
            )

        exp_parts = card_exp.strip().split("/")
        if len(exp_parts) != 2:
            return BindCardResult(
                success=False,
                message="有效期格式错误：应为 MM/YY 格式",
                error="card_exp format invalid, expected MM/YY",
                duration_ms=(time.time() - start_time) * 1000,
            )

        exp_month = exp_parts[0].strip()
        exp_year = exp_parts[1].strip()

        # 验证月份 (01-12)
        if not exp_month.isdigit() or not (1 <= int(exp_month) <= 12):
            return BindCardResult(
                success=False,
                message="有效期月份错误：应为 01-12",
                error=f"card_exp month {exp_month} is invalid",
                duration_ms=(time.time() - start_time) * 1000,
            )

        # 验证年份 (2位或4位数字)
        if not exp_year.isdigit() or len(exp_year) not in (2, 4):
            return BindCardResult(
                success=False,
                message="有效期年份错误：应为 2 位或 4 位数字",
                error=f"card_exp year {exp_year} is invalid",
                duration_ms=(time.time() - start_time) * 1000,
            )

        # 使用清理后的卡号
        card_number = card_number_clean

        try:
            # 1. 导航到绑卡页面
            nav_result = await self.engine.navigate(
                GoogleURLs.BIND_CARD,
                timeout=Timeouts.NAVIGATION,
            )

            if not nav_result.success:
                return BindCardResult(
                    success=False,
                    message="导航到绑卡页面失败",
                    error=nav_result.error_message,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            await self.engine.wait(Timeouts.AFTER_NAVIGATION)

            # 2. 检查是否需要登录
            current_url = await self.engine.get_current_url()
            if "accounts.google.com" in current_url and "signin" in current_url:
                return BindCardResult(
                    success=False,
                    message="需要先登录账号",
                    error="未登录",
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # 3. 检测页面状态（是否已订阅、是否有优惠）
            page_status = await self._detect_page_status()

            if page_status.get("already_subscribed"):
                return BindCardResult(
                    success=True,
                    message="账号已订阅",
                    already_subscribed=True,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            if page_status.get("ineligible"):
                return BindCardResult(
                    success=False,
                    message="账号无资格",
                    error="无资格使用该优惠",
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # 4. 开始绑卡流程
            bind_result = await self._perform_bind_card(
                card_number=card_number,
                exp_month=exp_month,
                exp_year=exp_year,
                card_cvv=card_cvv,
                card_name=card_name,
                zip_code=zip_code,
            )

            duration_ms = (time.time() - start_time) * 1000

            if bind_result.get("success"):
                return BindCardResult(
                    success=True,
                    message="绑卡订阅成功",
                    card_masked=f"**** **** **** {card_number[-4:]}" if len(card_number) >= 4 else "****",
                    duration_ms=duration_ms,
                )
            else:
                return BindCardResult(
                    success=False,
                    message=bind_result.get("message", "绑卡失败"),
                    error=bind_result.get("error"),
                    duration_ms=duration_ms,
                )

        except Exception as e:
            logger.error(f"绑卡订阅操作失败: {e}")
            return BindCardResult(
                success=False,
                message=f"操作失败: {str(e)}",
                error=str(e),
                duration_ms=(time.time() - start_time) * 1000,
            )

    async def _detect_page_status(self) -> dict:
        """检测页面状态"""
        try:
            extract_result = await self.engine.extract(
                """
                分析当前 Google One 页面状态，判断：
                1. 是否显示 "Already subscribed" / "已订阅" / "You have Google One"
                2. 是否显示 "Ineligible" / "无资格" / "Not eligible"
                3. 是否显示 "Get student discount" / "领取学生优惠" 按钮
                4. 是否显示支付表单/卡片输入区域

                返回检测到的状态。
                """
            )

            if not extract_result.success:
                return {}

            data = extract_result.data or {}
            result_text = str(data).lower()

            return {
                "already_subscribed": any(kw in result_text for kw in ["subscribed", "已订阅", "you have"]),
                "ineligible": any(kw in result_text for kw in ["ineligible", "无资格", "not eligible"]),
                "has_offer": any(kw in result_text for kw in ["discount", "优惠", "get student"]),
                "has_payment_form": any(kw in result_text for kw in ["card", "payment", "支付", "卡"]),
            }

        except Exception as e:
            logger.warning(f"检测页面状态失败: {e}")
            return {}

    async def _perform_bind_card(
        self,
        card_number: str,
        exp_month: str,
        exp_year: str,
        card_cvv: str,
        card_name: str,
        zip_code: Optional[str],
    ) -> dict:
        """执行绑卡流程"""
        try:
            # Step 1: 点击领取优惠/开始按钮
            step1_result = await self.engine.act(
                "点击 'Get student discount' 或 '领取学生优惠' 或 'Start' 或 '开始' 按钮"
            )
            await self.engine.wait(Timeouts.AFTER_CLICK * 2)

            # Step 2: 查找并填写卡号
            card_result = await self.engine.act(
                f"找到卡号输入框，输入卡号: {card_number}"
            )
            if not card_result.success:
                # 尝试更通用的指令
                card_result = await self.engine.act(
                    f"在 'Card number' 或 '卡号' 输入框中输入: {card_number}"
                )
            await self.engine.wait(Timeouts.AFTER_INPUT)

            # Step 3: 填写有效期
            # 尝试组合格式
            exp_combined = f"{exp_month}/{exp_year}"
            exp_result = await self.engine.act(
                f"找到有效期输入框，输入: {exp_combined}"
            )
            if not exp_result.success:
                # 尝试分开输入
                await self.engine.act(f"在 'MM' 或 '月' 输入框中输入: {exp_month}")
                await self.engine.wait(Timeouts.AFTER_INPUT)
                await self.engine.act(f"在 'YY' 或 '年' 输入框中输入: {exp_year}")
            await self.engine.wait(Timeouts.AFTER_INPUT)

            # Step 4: 填写 CVV
            cvv_result = await self.engine.act(
                f"找到 CVV 或安全码输入框，输入: {card_cvv}"
            )
            await self.engine.wait(Timeouts.AFTER_INPUT)

            # Step 5: 填写持卡人姓名
            name_result = await self.engine.act(
                f"找到持卡人姓名或 'Name on card' 输入框，输入: {card_name}"
            )
            await self.engine.wait(Timeouts.AFTER_INPUT)

            # Step 6: 填写邮编（如果有）
            if zip_code:
                await self.engine.act(
                    f"如果有邮编或 'ZIP code' 输入框，输入: {zip_code}"
                )
                await self.engine.wait(Timeouts.AFTER_INPUT)

            # Step 7: 点击提交/确认按钮
            submit_result = await self.engine.act(
                "点击 'Subscribe' 或 '订阅' 或 'Buy' 或 '购买' 或 'Continue' 或 '继续' 按钮"
            )
            await self.engine.wait(Timeouts.AFTER_CLICK * 3)

            # Step 8: 处理可能的确认对话框
            await self.engine.act(
                "如果有确认对话框，点击确认或继续按钮"
            )
            await self.engine.wait(Timeouts.AFTER_CLICK * 2)

            # Step 9: 验证订阅成功
            verify_result = await self._verify_subscription()

            return verify_result

        except Exception as e:
            logger.warning(f"绑卡流程失败: {e}")
            return {"success": False, "message": str(e), "error": str(e)}

    async def _verify_subscription(self) -> dict:
        """验证订阅是否成功"""
        try:
            # 等待页面加载
            await self.engine.wait(2000)

            # 检查页面内容
            extract_result = await self.engine.extract(
                """
                检查当前页面是否显示订阅成功的标志：
                1. "Welcome to Google One" / "欢迎使用 Google One"
                2. "Subscription active" / "订阅已激活"
                3. "Thank you" / "感谢您的订阅"
                4. "Confirmation" / "确认"
                5. 显示会员权益或存储空间

                也检查是否有错误信息：
                6. "Payment failed" / "付款失败"
                7. "Card declined" / "卡被拒绝"
                8. "Error" / "错误"
                """
            )

            if not extract_result.success:
                return {"success": False, "message": "无法验证订阅状态"}

            data = extract_result.data or {}
            result_text = str(data).lower()

            # 检测成功标志
            success_keywords = ["welcome", "欢迎", "active", "激活", "thank", "感谢", "confirmation", "确认"]
            if any(kw in result_text for kw in success_keywords):
                return {"success": True, "message": "订阅成功"}

            # 检测失败标志
            error_keywords = ["failed", "失败", "declined", "拒绝", "error", "错误"]
            if any(kw in result_text for kw in error_keywords):
                return {"success": False, "message": "支付失败", "error": "卡片被拒绝或支付错误"}

            # 无法确定
            return {"success": False, "message": "无法确定订阅状态"}

        except Exception as e:
            logger.warning(f"验证订阅失败: {e}")
            return {"success": False, "message": str(e), "error": str(e)}
