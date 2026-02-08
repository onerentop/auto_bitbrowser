"""
Stagehand Google Engine - 修改身份验证器操作

修改 Google Authenticator 并提取新的 TOTP 密钥
"""

import logging
import time
import re
from typing import Optional, TYPE_CHECKING

from ..types import ModifyAuthenticatorResult
from ..constants import GoogleURLs, Timeouts

if TYPE_CHECKING:
    from ..engine import StagehandGoogleEngine

logger = logging.getLogger(__name__)


class ModifyAuthenticatorOperation:
    """修改身份验证器操作"""

    def __init__(self, engine: "StagehandGoogleEngine"):
        self.engine = engine

    async def execute(
        self,
        timeout: float = Timeouts.OPERATION,
    ) -> ModifyAuthenticatorResult:
        """
        修改 Google Authenticator 并提取新密钥

        Args:
            timeout: 超时时间

        Returns:
            ModifyAuthenticatorResult (包含新的 TOTP 密钥)
        """
        start_time = time.time()
        logger.info("开始修改身份验证器操作")

        try:
            # 1. 导航到身份验证器设置页面
            nav_result = await self.engine.navigate(
                GoogleURLs.AUTHENTICATOR,
                timeout=Timeouts.NAVIGATION,
            )

            if not nav_result.success:
                return ModifyAuthenticatorResult(
                    success=False,
                    message="导航到身份验证器设置页面失败",
                    error=nav_result.error_message,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            await self.engine.wait(Timeouts.AFTER_NAVIGATION)

            # 2. 检查是否需要登录
            current_url = await self.engine.get_current_url()
            if "accounts.google.com" in current_url and "signin" in current_url:
                return ModifyAuthenticatorResult(
                    success=False,
                    message="需要先登录账号",
                    error="未登录",
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # 3. 执行修改流程
            modify_result = await self._perform_modify()

            duration_ms = (time.time() - start_time) * 1000

            if modify_result.get("success"):
                new_secret = modify_result.get("new_secret")
                return ModifyAuthenticatorResult(
                    success=True,
                    message="身份验证器修改成功",
                    secret_key=new_secret,
                    duration_ms=duration_ms,
                )
            else:
                return ModifyAuthenticatorResult(
                    success=False,
                    message=modify_result.get("message", "修改失败"),
                    error=modify_result.get("error"),
                    duration_ms=duration_ms,
                )

        except Exception as e:
            logger.error(f"修改身份验证器失败: {e}")
            return ModifyAuthenticatorResult(
                success=False,
                message=f"操作失败: {str(e)}",
                error=str(e),
                duration_ms=(time.time() - start_time) * 1000,
            )

    async def _perform_modify(self) -> dict:
        """执行修改流程"""
        try:
            # Step 1: 检查当前状态并开始设置
            await self.engine.act(
                "点击 'Set up authenticator' 或 '设置身份验证器' 或 'Add authenticator' 或 'Change app' 按钮"
            )
            await self.engine.wait(Timeouts.AFTER_CLICK * 2)

            # Step 2: 如果有"不使用扫码"选项，点击它以显示密钥
            await self.engine.act(
                "点击 \"Can't scan it?\" 或 '无法扫描？' 或 'Enter a setup key' 或 '输入设置密钥' 链接"
            )
            await self.engine.wait(Timeouts.AFTER_CLICK * 2)

            # Step 3: 提取密钥
            new_secret = await self._extract_secret()

            if not new_secret:
                return {
                    "success": False,
                    "message": "无法提取密钥",
                    "error": "未找到 TOTP 密钥",
                }

            logger.info(f"成功提取密钥: {new_secret[:8]}...")

            # Step 4: 生成验证码并完成设置
            try:
                import pyotp
                totp = pyotp.TOTP(new_secret)
                verification_code = totp.now()

                # 输入验证码
                await self.engine.act(
                    f"在验证码输入框中输入: {verification_code}"
                )
                await self.engine.wait(Timeouts.AFTER_INPUT)

                # 点击验证按钮
                await self.engine.act(
                    "点击 'Verify' 或 '验证' 或 'Next' 或 '下一步' 或 'Done' 或 '完成' 按钮"
                )
                await self.engine.wait(3000)

            except ImportError:
                logger.warning("pyotp 未安装，无法自动验证")
                return {
                    "success": False,
                    "message": "需要手动完成验证",
                    "new_secret": new_secret,
                    "error": "pyotp 未安装",
                }

            # Step 5: 验证设置成功
            verify_result = await self._verify_setup()

            if verify_result.get("success"):
                return {"success": True, "new_secret": new_secret}
            else:
                return {
                    "success": False,
                    "message": verify_result.get("message", "验证失败"),
                    "new_secret": new_secret,
                    "error": verify_result.get("error"),
                }

        except Exception as e:
            logger.warning(f"修改流程失败: {e}")
            return {"success": False, "message": str(e), "error": str(e)}

    async def _extract_secret(self) -> Optional[str]:
        """提取 TOTP 密钥"""
        try:
            # 方法1: 使用 extract 提取
            extract_result = await self.engine.extract(
                """
                在页面上查找 TOTP 设置密钥：
                1. 通常是一串大写字母和数字的组合
                2. 可能标记为 "Setup key", "Secret key", "密钥"
                3. 格式类似于: ABCD EFGH IJKL MNOP 或 ABCDEFGHIJKLMNOP
                4. 通常是 16-32 个字符

                返回找到的密钥字符串（仅密钥，不含其他文本）。
                """
            )

            if extract_result.success and extract_result.data:
                secret = self._parse_secret(str(extract_result.data))
                if secret:
                    return secret

            # 方法2: 获取页面内容并解析
            page_content = await self.engine.get_page_content()
            secret = self._parse_secret(page_content)

            return secret

        except Exception as e:
            logger.warning(f"提取密钥失败: {e}")
            return None

    def _parse_secret(self, text: str) -> Optional[str]:
        """从文本中解析 TOTP 密钥"""
        # 移除空格
        text_clean = text.replace(" ", "").replace("-", "").upper()

        # 尝试匹配 Base32 格式的密钥 (16-32 个字符)
        patterns = [
            r'[A-Z2-7]{16,32}',  # 标准 Base32
            r'(?:key|secret|密钥)[:\s]*([A-Z2-7]{16,32})',  # 带标签的
        ]

        for pattern in patterns:
            matches = re.findall(pattern, text_clean, re.IGNORECASE)
            for match in matches:
                # 验证是否是有效的 Base32
                candidate = match.upper() if isinstance(match, str) else match[0].upper()
                if self._is_valid_base32(candidate):
                    return candidate

        return None

    def _is_valid_base32(self, s: str) -> bool:
        """验证是否是有效的 Base32 字符串"""
        if len(s) < 16 or len(s) > 32:
            return False

        # Base32 字符集: A-Z 和 2-7
        valid_chars = set("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
        return all(c in valid_chars for c in s.upper())

    async def _verify_setup(self) -> dict:
        """验证设置是否成功"""
        try:
            extract_result = await self.engine.extract(
                """
                检查页面是否显示身份验证器设置成功的标志：
                1. "Authenticator app added" 或 "已添加身份验证器"
                2. "Success" 或 "成功"
                3. "Done" 或 "完成"
                4. 显示已设置的验证器

                也检查错误信息：
                5. "Invalid code" 或 "验证码无效"
                6. "Error" 或 "错误"
                """
            )

            if not extract_result.success:
                return {"success": False, "message": "无法验证设置结果"}

            data = extract_result.data or {}
            result_text = str(data).lower()

            if any(kw in result_text for kw in ["added", "已添加", "success", "成功", "done", "完成"]):
                return {"success": True}

            if any(kw in result_text for kw in ["invalid", "无效", "error", "错误"]):
                return {"success": False, "message": "验证码验证失败", "error": "无效的验证码"}

            return {"success": False, "message": "无法确定设置结果"}

        except Exception as e:
            logger.warning(f"验证失败: {e}")
            return {"success": False, "error": str(e)}
