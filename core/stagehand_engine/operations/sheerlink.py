"""
Stagehand Google Engine - SheerID 链接获取操作

获取 Google One 学生验证 SheerID 链接
"""

import logging
import time
import re
from typing import Optional, TYPE_CHECKING

from pydantic import BaseModel, Field

from ..types import SheerlinkResult, OperationStatus
from ..constants import GoogleURLs, Timeouts

if TYPE_CHECKING:
    from ..engine import StagehandGoogleEngine

logger = logging.getLogger(__name__)


class StatusDetectionSchema(BaseModel):
    """状态检测 Schema"""
    is_subscribed: bool = Field(default=False, description="是否已订阅")
    is_verified: bool = Field(default=False, description="是否已验证未绑卡")
    is_eligible: bool = Field(default=False, description="是否有资格")
    is_ineligible: bool = Field(default=False, description="是否无资格")
    has_sheerid_link: bool = Field(default=False, description="是否有 SheerID 链接")
    detected_status: str = Field(default="unknown", description="检测到的状态")


class SheerlinkOperation:
    """获取 SheerID 链接操作"""

    def __init__(self, engine: "StagehandGoogleEngine"):
        self.engine = engine

    async def execute(
        self,
        navigate_if_needed: bool = True,
        timeout: float = Timeouts.OPERATION,
    ) -> SheerlinkResult:
        """
        获取 SheerID 验证链接

        Args:
            navigate_if_needed: 是否自动导航
            timeout: 超时时间

        Returns:
            SheerlinkResult
        """
        start_time = time.time()
        logger.info("开始获取 SheerID 链接操作")

        try:
            # 1. 导航到学生订阅页面
            if navigate_if_needed:
                nav_result = await self.engine.navigate(
                    GoogleURLs.SHEERLINK,
                    timeout=Timeouts.NAVIGATION,
                )

                if not nav_result.success:
                    return SheerlinkResult(
                        success=False,
                        message="导航到学生订阅页面失败",
                        error=nav_result.error_message,
                        duration_ms=(time.time() - start_time) * 1000,
                    )

                await self.engine.wait(Timeouts.AFTER_NAVIGATION)

            # 2. 检查是否需要登录
            current_url = await self.engine.get_current_url()
            if "accounts.google.com" in current_url and "signin" in current_url:
                return SheerlinkResult(
                    success=False,
                    message="需要先登录账号",
                    error="未登录",
                    op_status=OperationStatus.UNKNOWN,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # 3. 检测账号状态
            status_result = await self._detect_status()
            account_status = status_result.get("status", "unknown")

            # 4. 根据状态返回结果
            if account_status == "subscribed":
                return SheerlinkResult(
                    success=True,
                    message="账号已订阅",
                    op_status=OperationStatus.SUBSCRIBED,
                    verification_status="subscribed",
                    duration_ms=(time.time() - start_time) * 1000,
                )

            if account_status == "verified":
                return SheerlinkResult(
                    success=True,
                    message="账号已验证，可直接领取优惠",
                    op_status=OperationStatus.VERIFIED,
                    verification_status="verified",
                    duration_ms=(time.time() - start_time) * 1000,
                )

            if account_status == "ineligible":
                return SheerlinkResult(
                    success=False,
                    message="账号无资格",
                    op_status=OperationStatus.INELIGIBLE,
                    verification_status="ineligible",
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # 5. 尝试获取 SheerID 链接
            link_result = await self._extract_sheerlink()

            if link_result.get("success") and link_result.get("link"):
                return SheerlinkResult(
                    success=True,
                    message="成功获取 SheerID 链接",
                    op_status=OperationStatus.LINK_READY,
                    verification_status="link_ready",
                    sheerlink_url=link_result["link"],
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # 6. 如果没有直接找到链接，尝试点击按钮触发
            trigger_result = await self._trigger_sheerlink()

            if trigger_result.get("success") and trigger_result.get("link"):
                return SheerlinkResult(
                    success=True,
                    message="成功获取 SheerID 链接",
                    op_status=OperationStatus.LINK_READY,
                    verification_status="link_ready",
                    sheerlink_url=trigger_result["link"],
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # 无法获取链接
            return SheerlinkResult(
                success=False,
                message="无法获取 SheerID 链接",
                error=trigger_result.get("error", "未知错误"),
                op_status=OperationStatus.ERROR,
                duration_ms=(time.time() - start_time) * 1000,
                verification_status="error",
            )

        except Exception as e:
            logger.error(f"获取 SheerID 链接失败: {e}")
            return SheerlinkResult(
                success=False,
                message=f"操作失败: {str(e)}",
                error=str(e),
                op_status=OperationStatus.ERROR,
                verification_status="error",
                duration_ms=(time.time() - start_time) * 1000,
            )

    async def _detect_status(self) -> dict:
        """检测账号状态"""
        try:
            extract_result = await self.engine.extract(
                """
                分析当前 Google One 页面，判断账号状态：

                1. 已订阅标识：
                   - "You have Google One" / "您已拥有 Google One"
                   - "2 TB" / "100 GB" / "200 GB" 存储空间显示
                   - "Member benefits" / "会员权益"

                2. 已验证未绑卡标识：
                   - "Verified" / "已验证"
                   - "Claim your offer" / "领取优惠"
                   - 可以直接绑卡的状态

                3. 有资格待验证标识：
                   - "Verify your student status" / "验证学生身份"
                   - "SheerID" 相关内容
                   - "Get started" / "开始验证" 按钮

                4. 无资格标识：
                   - "Not eligible" / "无资格"
                   - "Ineligible" / "不符合条件"
                   - "This offer is not available" / "该优惠不可用"

                返回检测到的状态。
                """
            )

            if not extract_result.success:
                return {"status": "unknown"}

            data = extract_result.data or {}
            result_text = str(data).lower()

            # 判断状态优先级：subscribed > verified > ineligible > eligible
            if any(kw in result_text for kw in ["you have", "您已拥有", "member benefits", "会员权益", "2 tb", "100 gb"]):
                return {"status": "subscribed"}

            if any(kw in result_text for kw in ["verified", "已验证", "claim your offer", "领取优惠"]):
                return {"status": "verified"}

            if any(kw in result_text for kw in ["not eligible", "无资格", "ineligible", "不符合", "not available"]):
                return {"status": "ineligible"}

            if any(kw in result_text for kw in ["verify", "验证", "sheerid", "get started", "开始"]):
                return {"status": "eligible"}

            return {"status": "unknown"}

        except Exception as e:
            logger.warning(f"检测状态失败: {e}")
            return {"status": "unknown"}

    async def _extract_sheerlink(self) -> dict:
        """尝试从页面提取 SheerID 链接"""
        try:
            # 观察页面上的链接
            observe_result = await self.engine.observe(
                "找到页面上所有包含 'sheerid' 或 'student' 或 'verify' 的链接或按钮"
            )

            if observe_result.success and observe_result.actions:
                for action in observe_result.actions:
                    if isinstance(action, dict):
                        desc = action.get("description", "").lower()
                        # 检查是否包含 SheerID 相关链接
                        if "sheerid" in desc or ("student" in desc and "verify" in desc):
                            # 提取链接
                            extract_result = await self.engine.extract(
                                "提取页面上完整的 SheerID 验证链接 URL"
                            )
                            if extract_result.success and extract_result.data:
                                link = self._find_sheerid_url(str(extract_result.data))
                                if link:
                                    return {"success": True, "link": link}

            return {"success": False}

        except Exception as e:
            logger.warning(f"提取链接失败: {e}")
            return {"success": False, "error": str(e)}

    async def _trigger_sheerlink(self) -> dict:
        """点击按钮触发 SheerID 链接"""
        try:
            # Step 1: 点击验证按钮
            click_result = await self.engine.act(
                "点击 'Verify your student status' 或 '验证学生身份' 或 'Get started' 或 '开始' 按钮"
            )

            await self.engine.wait(Timeouts.AFTER_CLICK * 2)

            # Step 2: 检查是否跳转到 SheerID 页面
            current_url = await self.engine.get_current_url()
            if "sheerid" in current_url.lower():
                return {"success": True, "link": current_url}

            # Step 3: 检查页面上是否有 iframe 或新的链接
            extract_result = await self.engine.extract(
                """
                查找页面上的 SheerID 链接或 iframe：
                1. URL 中包含 "sheerid.com" 或 "sheerid" 的链接
                2. iframe src 属性包含 sheerid 的内容
                3. 任何可以点击进入学生验证的链接
                """
            )

            if extract_result.success and extract_result.data:
                link = self._find_sheerid_url(str(extract_result.data))
                if link:
                    return {"success": True, "link": link}

            # Step 4: 继续点击可能的链接
            click_result2 = await self.engine.act(
                "点击任何包含 'SheerID' 或 'student verification' 的链接或按钮"
            )

            await self.engine.wait(Timeouts.AFTER_CLICK * 2)

            # 再次检查 URL
            current_url = await self.engine.get_current_url()
            if "sheerid" in current_url.lower():
                return {"success": True, "link": current_url}

            return {"success": False, "error": "无法触发 SheerID 链接"}

        except Exception as e:
            logger.warning(f"触发链接失败: {e}")
            return {"success": False, "error": str(e)}

    def _find_sheerid_url(self, text: str) -> Optional[str]:
        """从文本中提取 SheerID URL"""
        # 尝试匹配 SheerID URL 模式
        patterns = [
            r'https?://[^\s<>"]*sheerid[^\s<>"]*',
            r'https?://offers\.sheerid\.com[^\s<>"]*',
            r'https?://[^\s<>"]*student[^\s<>"]*verify[^\s<>"]*',
        ]

        for pattern in patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                url = match.group(0)
                # 清理 URL
                url = url.rstrip('.,;:)\'"]')
                return url

        return None
