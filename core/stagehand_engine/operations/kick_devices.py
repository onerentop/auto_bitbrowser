"""
Stagehand Google Engine - 踢出设备操作

踢出 Google 账号的其他登录设备
"""

import logging
import time
from typing import Optional, List, TYPE_CHECKING

from pydantic import BaseModel, Field

from ..types import KickDevicesResult
from ..constants import GoogleURLs, Timeouts

if TYPE_CHECKING:
    from ..engine import StagehandGoogleEngine

logger = logging.getLogger(__name__)


class DeviceInfoSchema(BaseModel):
    """设备信息 Schema"""
    device_name: str = Field(description="设备名称")
    is_current: bool = Field(default=False, description="是否是当前设备")
    last_active: Optional[str] = Field(default=None, description="最后活动时间")
    location: Optional[str] = Field(default=None, description="位置")


class DeviceListSchema(BaseModel):
    """设备列表 Schema"""
    devices: List[DeviceInfoSchema] = Field(
        default_factory=list,
        description="设备列表"
    )
    total_count: int = Field(default=0, description="设备总数")
    current_device_name: Optional[str] = Field(
        default=None,
        description="当前设备名称"
    )


class KickDevicesOperation:
    """踢出设备操作"""

    def __init__(self, engine: "StagehandGoogleEngine"):
        self.engine = engine

    async def execute(
        self,
        keep_current: bool = True,
        timeout: float = Timeouts.OPERATION,
    ) -> KickDevicesResult:
        """
        踢出其他登录设备

        Args:
            keep_current: 是否保留当前设备
            timeout: 超时时间

        Returns:
            KickDevicesResult
        """
        start_time = time.time()
        logger.info("开始踢出设备操作")

        kicked_devices = []
        failed_devices = []

        try:
            # 1. 导航到设备管理页面
            nav_result = await self.engine.navigate(
                GoogleURLs.DEVICES,
                timeout=Timeouts.NAVIGATION,
            )

            if not nav_result.success:
                return KickDevicesResult(
                    success=False,
                    message="导航到设备页面失败",
                    error=nav_result.error_message,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            await self.engine.wait(Timeouts.AFTER_NAVIGATION)

            # 2. 检查是否需要登录
            current_url = await self.engine.get_current_url()
            if "accounts.google.com" in current_url and "signin" in current_url:
                return KickDevicesResult(
                    success=False,
                    message="需要先登录账号",
                    error="未登录",
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # 3. 获取设备列表
            devices_result = await self._get_device_list()
            if not devices_result:
                return KickDevicesResult(
                    success=True,
                    message="未找到其他设备",
                    devices_found=0,
                    devices_kicked=0,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            devices_found = len(devices_result)
            logger.info(f"发现 {devices_found} 个设备")

            # 4. 逐个踢出非当前设备
            # 当前设备标识关键词（多语言）
            current_device_keywords = [
                # 中文
                "(当前会话)", "当前会话", "当前设备", "此设备",
                # 英文
                "your current session", "current session", "this device",
                # 日文
                "現在のセッション", "このデバイス",
                # 韩文
                "현재 세션", "이 기기",
                # 越南语
                "phiên hiện tại", "thiết bị này",
            ]

            for device_name in devices_result:
                # 跳过空值
                if not device_name:
                    continue

                device_name_lower = device_name.lower() if device_name else ""

                # 检查是否是当前设备
                if keep_current:
                    is_current = any(kw.lower() in device_name_lower for kw in current_device_keywords)
                    if is_current:
                        logger.info(f"跳过当前设备: {device_name}")
                        continue

                success = await self._kick_single_device(device_name)
                if success:
                    kicked_devices.append(device_name)
                    logger.info(f"成功踢出: {device_name}")
                else:
                    failed_devices.append(device_name)
                    logger.warning(f"踢出失败: {device_name}")

                # 等待一下再处理下一个
                await self.engine.wait(1000)

            duration_ms = (time.time() - start_time) * 1000
            devices_kicked = len(kicked_devices)
            devices_failed = len(failed_devices)

            if devices_kicked > 0:
                message = f"成功踢出 {devices_kicked} 个设备"
                if devices_failed > 0:
                    message += f"，{devices_failed} 个失败"
            else:
                message = "没有需要踢出的设备"

            return KickDevicesResult(
                success=True,
                message=message,
                devices_found=devices_found,
                devices_kicked=devices_kicked,
                devices_failed=devices_failed,
                kicked_devices=kicked_devices,
                failed_devices=failed_devices,
                duration_ms=duration_ms,
            )

        except Exception as e:
            logger.error(f"踢出设备操作失败: {e}")
            return KickDevicesResult(
                success=False,
                message=f"操作失败: {str(e)}",
                error=str(e),
                devices_found=0,
                devices_kicked=len(kicked_devices),
                devices_failed=len(failed_devices),
                kicked_devices=kicked_devices,
                failed_devices=failed_devices,
                duration_ms=(time.time() - start_time) * 1000,
            )

    async def _get_device_list(self) -> List[str]:
        """获取设备列表"""
        try:
            # 使用 observe 观察设备列表
            observe_result = await self.engine.observe(
                "找到页面上所有显示的设备卡片或设备条目，包括设备名称"
            )

            if not observe_result.success:
                # 备选方案：使用 extract
                extract_result = await self.engine.extract(
                    """
                    提取页面上所有已登录设备的信息:
                    1. 每个设备的名称
                    2. 是否是当前设备（标记为"您的当前会话"或"Your current session"）
                    3. 设备总数
                    """,
                    schema=DeviceListSchema,
                )

                if extract_result.success and extract_result.data:
                    devices = extract_result.data.get("devices", [])
                    return [d.get("device_name", "") for d in devices if d.get("device_name")]

            # 从 observe 结果中提取设备名称
            if observe_result.actions:
                device_names = []
                for action in observe_result.actions:
                    if isinstance(action, dict):
                        description = action.get("description", "")
                        if description and "device" in description.lower():
                            device_names.append(description)
                return device_names

            return []

        except Exception as e:
            logger.warning(f"获取设备列表失败: {e}")
            return []

    async def _kick_single_device(self, device_name: str) -> bool:
        """踢出单个设备"""
        try:
            # 1. 点击设备
            click_result = await self.engine.act(
                f"点击名为 '{device_name}' 的设备卡片或设备条目"
            )

            if not click_result.success:
                # 尝试更通用的指令
                click_result = await self.engine.act(
                    "点击第一个非当前会话的设备"
                )

            await self.engine.wait(Timeouts.AFTER_CLICK)

            # 2. 点击退出登录
            signout_result = await self.engine.act(
                "点击'退出登录'或'Sign out'按钮"
            )

            if not signout_result.success:
                # 尝试其他可能的按钮文本
                signout_result = await self.engine.act(
                    "点击'移除'或'Remove'或'登出'按钮"
                )

            await self.engine.wait(Timeouts.AFTER_CLICK)

            # 3. 确认操作（如果有确认对话框）
            await self.engine.act(
                "如果有确认对话框，点击确认或确定按钮"
            )

            await self.engine.wait(Timeouts.AFTER_CLICK)

            return True

        except Exception as e:
            logger.warning(f"踢出设备 {device_name} 失败: {e}")
            return False
