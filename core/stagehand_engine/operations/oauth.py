"""
Stagehand Google Engine - OAuth 授权操作

完成 OAuth 授权流程
"""

import logging
import time
from typing import Optional, TYPE_CHECKING

from ..types import OAuthResult
from ..constants import Timeouts, GoogleURLs

if TYPE_CHECKING:
    from ..engine import StagehandGoogleEngine

logger = logging.getLogger(__name__)


def _get_oauth_urls() -> dict:
    """
    获取预定义的 OAuth URL

    优先从 ConfigManager 读取配置，否则使用默认值。
    """
    try:
        from core.config_manager import ConfigManager
        # 尝试从配置读取
        antigravity_url = ConfigManager.get("oauth.antigravity_url", "")
        sub2api_url = ConfigManager.get("oauth.sub2api_url", "")
    except Exception:
        antigravity_url = ""
        sub2api_url = ""

    return {
        "antigravity": antigravity_url or GoogleURLs.ANTIGRAVITY_OAUTH,
        "sub2api": sub2api_url or "https://api.sub2api.com/oauth/google",
    }


# 兼容旧代码的静态引用
OAUTH_URLS = _get_oauth_urls()


class OAuthOperation:
    """OAuth 授权操作"""

    def __init__(self, engine: "StagehandGoogleEngine"):
        self.engine = engine

    async def execute(
        self,
        service: str,
        oauth_url: Optional[str] = None,
        timeout: float = Timeouts.OPERATION,
    ) -> OAuthResult:
        """
        完成 OAuth 授权

        Args:
            service: 服务名称 (如 "antigravity", "sub2api")
            oauth_url: OAuth 授权 URL (如果已知，否则使用预定义 URL)
            timeout: 超时时间

        Returns:
            OAuthResult
        """
        start_time = time.time()
        logger.info(f"开始 OAuth 授权: {service}")

        # 确定 OAuth URL
        target_url = oauth_url or OAUTH_URLS.get(service)
        if not target_url:
            return OAuthResult(
                success=False,
                message=f"未知的服务: {service}",
                error=f"请提供 oauth_url 参数",
                service=service,
                duration_ms=(time.time() - start_time) * 1000,
            )

        try:
            # 1. 导航到 OAuth URL
            nav_result = await self.engine.navigate(
                target_url,
                timeout=Timeouts.NAVIGATION,
            )

            if not nav_result.success:
                return OAuthResult(
                    success=False,
                    message="导航到 OAuth 页面失败",
                    error=nav_result.error_message,
                    service=service,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            await self.engine.wait(Timeouts.AFTER_NAVIGATION)

            # 2. 执行 OAuth 流程
            oauth_result = await self._perform_oauth()

            duration_ms = (time.time() - start_time) * 1000

            if oauth_result.get("success"):
                return OAuthResult(
                    success=True,
                    message="OAuth 授权成功",
                    service=service,
                    redirect_url=oauth_result.get("redirect_url"),
                    duration_ms=duration_ms,
                )
            else:
                return OAuthResult(
                    success=False,
                    message=oauth_result.get("message", "授权失败"),
                    error=oauth_result.get("error"),
                    service=service,
                    duration_ms=duration_ms,
                )

        except Exception as e:
            logger.error(f"OAuth 授权失败: {e}")
            return OAuthResult(
                success=False,
                message=f"操作失败: {str(e)}",
                error=str(e),
                service=service,
                duration_ms=(time.time() - start_time) * 1000,
            )

    async def _perform_oauth(self) -> dict:
        """执行 OAuth 授权流程"""
        try:
            # Step 1: 检查当前页面状态
            current_url = await self.engine.get_current_url()

            # 检查页面是否有效
            if not self._is_valid_url(current_url):
                logger.warning(f"OAuth 页面无效: {current_url}")
                return {"success": False, "message": f"页面 URL 无效: {current_url}"}

            # 检查是否已经在 Google 授权页面
            if "accounts.google.com" in current_url:
                return await self._handle_google_consent()

            # Step 2: 点击 Google 登录按钮（如果在第三方页面）
            click_result = await self.engine.act(
                "点击 'Sign in with Google' 或 '使用 Google 登录' 或 Google 图标按钮"
            )
            await self.engine.wait(3000)

            # Step 3: 处理 Google 授权页面
            current_url = await self.engine.get_current_url()

            # 检查页面是否有效
            if not self._is_valid_url(current_url):
                logger.warning(f"OAuth 跳转后页面无效: {current_url}")
                return {"success": False, "message": f"跳转后页面无效: {current_url}"}

            if "accounts.google.com" in current_url:
                return await self._handle_google_consent()

            # 可能需要选择账号
            await self._handle_account_chooser()

            # 再次检查是否进入授权页面
            current_url = await self.engine.get_current_url()
            if not self._is_valid_url(current_url):
                return {"success": False, "message": f"账号选择后页面无效: {current_url}"}

            if "accounts.google.com" in current_url:
                return await self._handle_google_consent()

            return {"success": False, "message": "未能进入 Google 授权页面"}

        except Exception as e:
            logger.warning(f"OAuth 流程失败: {e}")
            return {"success": False, "message": str(e), "error": str(e)}

    def _is_valid_url(self, url: str) -> bool:
        """检查 URL 是否有效（可以执行操作）"""
        if not url:
            return False
        invalid_patterns = ["about:blank", "about:srcdoc", "chrome://", "chrome-error://", "data:"]
        for pattern in invalid_patterns:
            if url.startswith(pattern):
                return False
        return True

    async def _handle_account_chooser(self) -> None:
        """处理账号选择器"""
        try:
            observe_result = await self.engine.observe(
                """
                检查是否有账号选择页面：
                1. "Choose an account" 或 "选择账号"
                2. 邮箱列表
                3. "Use another account" 或 "使用其他账号"
                """
            )

            if observe_result.success and observe_result.actions:
                # 点击第一个账号或 Use another account
                await self.engine.act(
                    "点击列表中的第一个账号"
                )
                await self.engine.wait(2000)

        except Exception as e:
            logger.debug(f"处理账号选择器时出错: {e}")

    async def _handle_google_consent(self) -> dict:
        """处理 Google 授权同意页面"""
        try:
            # 首先检查页面是否有效
            current_url = await self.engine.get_current_url()
            if not self._is_valid_url(current_url):
                logger.warning(f"Google consent 页面无效: {current_url}")
                return {"success": False, "message": f"授权页面无效: {current_url}"}

            # Step 1: 检查授权页面内容（跳过 extract 如果页面可能不稳定）
            # extract 可能失败，我们直接尝试点击操作
            logger.debug(f"处理 Google 授权页面: {current_url}")

            # Step 2: 点击允许/继续按钮
            for i in range(3):  # 可能有多步确认
                # 每次点击前检查页面有效性
                current_url = await self.engine.get_current_url()
                if not self._is_valid_url(current_url):
                    logger.warning(f"点击循环 {i+1}: 页面变为无效 - {current_url}")
                    return {"success": False, "message": f"授权过程中页面变为无效: {current_url}"}

                # 检查是否已离开 Google 页面（授权可能已完成）
                if "accounts.google.com" not in current_url:
                    # 已重定向到第三方服务
                    logger.info(f"OAuth 已重定向: {current_url}")
                    return {
                        "success": True,
                        "redirect_url": current_url,
                    }

                click_result = await self.engine.act(
                    "点击 'Allow' 或 '允许' 或 'Continue' 或 '继续' 或 'Confirm' 或 '确认' 按钮"
                )

                if not click_result.success:
                    logger.debug(f"点击循环 {i+1}: 点击失败 - {click_result.error}")

                await self.engine.wait(2000)

            # Step 3: 验证授权结果
            verify_result = await self._verify_oauth()

            return verify_result

        except Exception as e:
            logger.warning(f"处理授权页面失败: {e}")
            return {"success": False, "message": str(e), "error": str(e)}

    async def _verify_oauth(self) -> dict:
        """验证 OAuth 授权结果"""
        try:
            current_url = await self.engine.get_current_url()

            # 首先检查页面有效性
            if not self._is_valid_url(current_url):
                logger.warning(f"验证时页面无效: {current_url}")
                return {"success": False, "message": f"验证时页面无效: {current_url}"}

            # 如果已离开 Google 页面，可能授权成功
            if "accounts.google.com" not in current_url:
                logger.info(f"OAuth 验证: 已离开 Google 页面 -> {current_url}")
                return {"success": True, "redirect_url": current_url}

            # 尝试检查页面内容，但不依赖 extract 成功
            extract_result = await self.engine.extract(
                """
                检查页面状态：
                1. "Authorization successful" 或 "授权成功"
                2. "Error" 或 "错误"
                3. "Access denied" 或 "访问被拒绝"
                """
            )

            if not extract_result.success:
                # extract 失败不一定是授权失败，可能是页面状态问题
                logger.debug(f"验证 extract 失败: {extract_result.error}")
                return {"success": False, "message": f"无法验证授权结果: {extract_result.error}"}

            data = extract_result.data or {}
            result_text = str(data).lower()

            if any(kw in result_text for kw in ["successful", "成功"]):
                return {"success": True}

            if any(kw in result_text for kw in ["error", "错误", "denied", "拒绝"]):
                return {"success": False, "message": "授权被拒绝", "error": "访问被拒绝"}

            return {"success": False, "message": "无法确定授权结果"}

        except Exception as e:
            logger.warning(f"验证失败: {e}")
            return {"success": False, "error": str(e)}
