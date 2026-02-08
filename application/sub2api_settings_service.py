"""Sub2API 设置应用服务。

Why:
- 将 Sub2API/SMS-Bus 配置读写从 GUI 层下沉到 application 层。
- 统一 token 状态展示与掩码逻辑，减少界面层重复代码。
"""

from __future__ import annotations

from dataclasses import dataclass

from core.config_manager import ConfigManager


@dataclass
class Sub2APISettingsSnapshot:
    """Sub2API 设置快照。"""

    enabled: bool
    base_url: str
    default_group: str
    login_concurrency: int
    login_timeout: int
    oauth_timeout: int

    sms_country_id: int
    sms_project_id: int
    sms_timeout: int
    sms_poll_interval: int
    sms_max_retries: int


class Sub2APISettingsService:
    """Sub2API 设置应用服务。"""

    @staticmethod
    def load_snapshot() -> Sub2APISettingsSnapshot:
        """加载 Sub2API 设置快照。"""
        return Sub2APISettingsSnapshot(
            enabled=ConfigManager.get_sub2api_enabled(),
            base_url=ConfigManager.get_sub2api_base_url(),
            default_group=ConfigManager.get_sub2api_default_group(),
            login_concurrency=ConfigManager.get_login_concurrency(),
            login_timeout=ConfigManager.get_login_timeout(),
            oauth_timeout=ConfigManager.get_oauth_timeout(),
            sms_country_id=ConfigManager.get_sms_bus_default_country_id() or 0,
            sms_project_id=ConfigManager.get_sms_bus_default_project_id() or 0,
            sms_timeout=ConfigManager.get_sms_bus_timeout(),
            sms_poll_interval=ConfigManager.get_sms_bus_poll_interval(),
            sms_max_retries=ConfigManager.get_sms_bus_max_retries(),
        )

    @staticmethod
    def save_snapshot(snapshot: Sub2APISettingsSnapshot) -> None:
        """保存 Sub2API 设置快照。"""
        ConfigManager.set_sub2api_enabled(snapshot.enabled)
        ConfigManager.set_sub2api_base_url(snapshot.base_url)
        ConfigManager.set_sub2api_default_group(snapshot.default_group)

        ConfigManager.set_login_concurrency(snapshot.login_concurrency)
        ConfigManager.set_login_timeout(snapshot.login_timeout)
        ConfigManager.set_oauth_timeout(snapshot.oauth_timeout)

        ConfigManager.set_sms_bus_default_country_id(
            snapshot.sms_country_id if snapshot.sms_country_id > 0 else None
        )
        ConfigManager.set_sms_bus_default_project_id(
            snapshot.sms_project_id if snapshot.sms_project_id > 0 else None
        )
        ConfigManager.set_sms_bus_timeout(snapshot.sms_timeout)
        ConfigManager.set_sms_bus_poll_interval(snapshot.sms_poll_interval)
        ConfigManager.set_sms_bus_max_retries(snapshot.sms_max_retries)

    @staticmethod
    def get_sub2api_token() -> str:
        """获取 Sub2API Token。"""
        ConfigManager.reload()
        return ConfigManager.get_sub2api_token() or ""

    @staticmethod
    def set_sub2api_token(token: str) -> bool:
        """保存 Sub2API Token。"""
        ConfigManager.set_sub2api_token(token)
        return bool(Sub2APISettingsService.get_sub2api_token())

    @staticmethod
    def clear_sub2api_token() -> None:
        """清除 Sub2API Token。"""
        ConfigManager.set_sub2api_token("")

    @staticmethod
    def get_sms_token() -> str:
        """获取 SMS-Bus Token。"""
        ConfigManager.reload()
        return ConfigManager.get_sms_bus_token() or ""

    @staticmethod
    def set_sms_token(token: str) -> bool:
        """保存 SMS-Bus Token。"""
        ConfigManager.set_sms_bus_token(token)
        return bool(Sub2APISettingsService.get_sms_token())

    @staticmethod
    def clear_sms_token() -> None:
        """清除 SMS-Bus Token。"""
        ConfigManager.set_sms_bus_token("")

    @staticmethod
    def mask_secret(secret: str) -> str:
        """掩码显示敏感凭证。"""
        if not secret:
            return ""
        if len(secret) <= 12:
            return "***"
        return f"{secret[:8]}...{secret[-4:]}"

