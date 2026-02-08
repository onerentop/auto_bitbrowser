"""
Antigravity 403 解锁自动化 - StagehandGoogleEngine 版

自动完成 Google 账户手机验证，解除 403 限制：
1. 从 SMS-Bus 获取手机号
2. StagehandGoogleEngine 操作浏览器发送验证码
3. 轮询等待验证码
4. StagehandGoogleEngine 输入验证码完成验证
5. 释放手机号

使用方法:
    from automation.auto_unlock_403 import auto_unlock_403
    from services.sms_bus_client import SMSBusClient

    async with SMSBusClient(token="xxx") as sms_client:
        result = await auto_unlock_403(
            browser_id="123",
            account={"email": "user@gmail.com", ...},
            validation_url="https://accounts.google.com/...",
            sms_client=sms_client,
        )
"""

import asyncio
import traceback
from typing import Callable, Optional
from dataclasses import dataclass

from core.config_manager import ConfigManager
from core.stagehand_engine import StagehandGoogleEngine

from services.database import DBManager
from services.sms_bus_client import SMSBusClient, PhoneNumber


@dataclass
class UnlockResult:
    """403 解锁结果"""
    success: bool
    message: str
    email: str
    phone_used: str = ""
    attempts: int = 0
    error_type: Optional[str] = None


async def auto_unlock_403(
    browser_id: str,
    account: dict,
    validation_url: str,
    sms_client: SMSBusClient,
    country_id: int = None,
    project_id: int = None,
    max_retries: int = None,  # None = 从配置读取
    callback: Callable[[str], None] = None,
    api_key: str = None,
    model: str = None,
    provider: str = None,
) -> UnlockResult:
    """
    执行 403 解锁自动化 (StagehandGoogleEngine 版)

    Args:
        browser_id: ixBrowser 窗口 ID
        account: 账号信息 {email, password, ...}
        validation_url: 403 验证链接
        sms_client: SMS-Bus 客户端
        country_id: 国家 ID（None = 自动选最便宜）
        project_id: 服务 ID（None = Google）
        max_retries: 最大重试次数（None = 从配置读取）
        callback: 进度回调函数
        api_key: API Key（可选，默认从配置读取）
        model: 使用的模型（可选）
        provider: LLM 提供商（已废弃）

    Returns:
        UnlockResult: 解锁结果
    """
    email = account.get("email", "")

    def log(msg: str):
        """日志输出"""
        print(f"[Unlock403] {email}: {msg}")
        if callback:
            callback(f"[{email}] {msg}")

    log("开始 403 解锁流程 (StagehandGoogleEngine)...")

    # 更新数据库状态
    DBManager.update_unlock_status(email, "unlocking")

    # 获取配置
    if country_id is None:
        country_id = ConfigManager.get_sms_bus_default_country_id()
    if project_id is None:
        project_id = ConfigManager.get_sms_bus_default_project_id()
    if max_retries is None:
        max_retries = ConfigManager.get_sms_bus_max_retries()

    sms_timeout = ConfigManager.get_sms_bus_timeout()
    sms_interval = ConfigManager.get_sms_bus_poll_interval()

    # 构建模型名称
    model_name = None
    if model:
        if provider:
            provider_map = {"gemini": "google", "anthropic": "anthropic"}
            stagehand_provider = provider_map.get(provider, provider)
            model_name = f"{stagehand_provider}/{model}"
        else:
            model_name = model

    # 重试循环
    attempts = 0
    last_error = ""
    phone_used = ""

    for attempt in range(max_retries):
        attempts = attempt + 1
        log(f"=== 尝试 {attempts}/{max_retries} ===")

        phone: PhoneNumber = None
        engine = None

        try:
            # 步骤 1: 获取手机号
            log("获取手机号...")
            phone, error = await sms_client.get_number(
                country_id=country_id,
                project_id=project_id,
                prefer_cheapest=True,
            )

            if not phone:
                last_error = error or "无法获取手机号"
                log(f"❌ {last_error}")
                continue

            phone_used = phone.formatted_number
            log(f"✅ 获取到手机号: {phone_used} ({phone.country_name}, cost: ${phone.cost})")

            # 步骤 2: 连接到 ixBrowser 窗口
            log("连接 ixBrowser 窗口...")
            engine = await StagehandGoogleEngine.connect_to_ixbrowser(
                browser_id=browser_id,
                model_name=model_name,
                model_api_key=api_key,
                close_browser_on_exit=False,
            )

            # 步骤 3: 使用 StagehandGoogleEngine 执行 unlock_403
            log("执行 403 解锁操作...")
            result = await engine.unlock_403(
                validation_url=validation_url,
                phone_number=phone_used,
                country_name=phone.country_name or "United States",
                sms_client=sms_client,
                request_id=phone.request_id,
                sms_timeout=sms_timeout,
                sms_interval=sms_interval,
            )

            # 步骤 4: 处理结果
            if result.success:
                log("✅ 403 解锁成功")
                DBManager.update_unlock_status(email, "unlocked")

                # 释放号码
                try:
                    await sms_client.cancel_request(phone.request_id)
                except Exception:
                    pass

                return UnlockResult(
                    success=True,
                    message="403 解锁成功",
                    email=email,
                    phone_used=phone_used,
                    attempts=attempts,
                )
            else:
                last_error = f"验证失败: {result.message}"
                log(f"❌ {last_error}")

                # 释放号码并继续重试
                try:
                    await sms_client.cancel_request(phone.request_id)
                except Exception:
                    pass
                continue

        except Exception as e:
            last_error = str(e)
            log(f"❌ 异常: {last_error}")
            traceback.print_exc()

            # 释放号码
            if phone:
                try:
                    await sms_client.cancel_request(phone.request_id)
                except Exception:
                    pass

        finally:
            # 清理 engine 资源
            if engine:
                try:
                    await engine.stop(close_browser=False)
                except Exception:
                    pass

    # 所有重试都失败
    log(f"❌ 解锁失败，已重试 {attempts} 次")
    DBManager.update_unlock_status(email, "unlock_failed")
    return UnlockResult(
        success=False,
        message=f"解锁失败: {last_error}",
        email=email,
        phone_used=phone_used,
        attempts=attempts,
        error_type="max_retries_exceeded",
    )


# ==================== 测试代码 ====================

if __name__ == "__main__":
    async def main():
        print("403 Unlock 测试 (StagehandGoogleEngine)")
        print("=" * 50)

        # 测试账号（需要替换为真实数据）
        test_account = {
            "email": "test@gmail.com",
            "password": "test_password",
        }

        # 测试验证链接
        test_validation_url = "https://accounts.google.com/signin/continue?..."

        # 测试浏览器 ID
        test_browser_id = "12345"

        async with SMSBusClient() as sms_client:
            result = await auto_unlock_403(
                browser_id=test_browser_id,
                account=test_account,
                validation_url=test_validation_url,
                sms_client=sms_client,
                callback=print,
            )

            print(f"\n结果: {result}")

    asyncio.run(main())
