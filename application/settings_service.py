"""设置页应用服务

Why:
- 将设置页配置编排从 GUI 层下沉到应用服务层。
- 保持现有功能不变的前提下，降低界面层复杂度，便于后续扩展与测试。
"""

from __future__ import annotations

from dataclasses import dataclass

from core.config_manager import ConfigManager


@dataclass
class SettingsSnapshot:
    """设置快照（用于 GUI <-> 配置层传递）"""

    sheerid_api_key: str
    ai_default_provider: str

    gemini_api_key: str
    gemini_base_url: str
    gemini_model: str

    anthropic_api_key: str
    anthropic_base_url: str
    anthropic_model: str

    ai_max_steps: int

    gmail_imap_email: str
    gmail_imap_password: str

    timeout_page_load: int
    timeout_status_check: int
    timeout_iframe_wait: int

    delay_after_login: int
    delay_after_offer: int
    delay_after_add_card: int
    delay_after_save: int

    proxy_max_windows_per_ip: int
    default_thread_count: int
    theme: str
    data_dir: str
    data_separator: str


class SettingsService:
    """设置页应用服务"""

    @staticmethod
    def resolve_provider_runtime_config(
        provider: str,
        api_key_input: str,
        base_url_input: str,
        model_input: str,
    ) -> tuple[str, str, str]:
        """解析提供商运行时配置（优先使用界面输入，回退到已保存配置）。"""
        provider_name = provider.strip().lower()
        api_key = api_key_input.strip() or ConfigManager.get_ai_provider_api_key(provider_name)
        base_url = base_url_input.strip() or ConfigManager.get_ai_provider_base_url(provider_name)
        model = model_input.strip() or ConfigManager.get_ai_provider_model(provider_name)
        return api_key, base_url, model

    @staticmethod
    def load_settings_snapshot() -> SettingsSnapshot:
        """加载设置快照"""
        ConfigManager.load()

        return SettingsSnapshot(
            sheerid_api_key=ConfigManager.get_api_key(),
            ai_default_provider=ConfigManager.get_ai_default_provider(),
            gemini_api_key=ConfigManager.get_ai_provider_api_key("gemini"),
            gemini_base_url=ConfigManager.get_ai_provider_base_url("gemini"),
            gemini_model=ConfigManager.get_ai_provider_model("gemini"),
            anthropic_api_key=ConfigManager.get_ai_provider_api_key("anthropic"),
            anthropic_base_url=ConfigManager.get_ai_provider_base_url("anthropic"),
            anthropic_model=ConfigManager.get_ai_provider_model("anthropic"),
            ai_max_steps=ConfigManager.get_ai_max_steps(),
            gmail_imap_email=ConfigManager.get("gmail_imap_email", ""),
            gmail_imap_password=ConfigManager.get_gmail_imap_password(),
            timeout_page_load=ConfigManager.get("timeouts.page_load", 30),
            timeout_status_check=ConfigManager.get("timeouts.status_check", 20),
            timeout_iframe_wait=ConfigManager.get("timeouts.iframe_wait", 15),
            delay_after_login=ConfigManager.get("delays.after_login", 3),
            delay_after_offer=ConfigManager.get("delays.after_offer", 8),
            delay_after_add_card=ConfigManager.get("delays.after_add_card", 10),
            delay_after_save=ConfigManager.get("delays.after_save", 18),
            proxy_max_windows_per_ip=ConfigManager.get("proxy.max_windows_per_ip", 3),
            default_thread_count=ConfigManager.get("default_thread_count", 3),
            theme=ConfigManager.get("theme", "auto"),
            data_dir=ConfigManager.get("data_dir", ""),
            data_separator=ConfigManager.get("data_separator", "----"),
        )

    @staticmethod
    def save_settings_snapshot(snapshot: SettingsSnapshot) -> None:
        """保存设置快照"""
        ConfigManager.set_api_key(snapshot.sheerid_api_key)

        ConfigManager.set_ai_default_provider(snapshot.ai_default_provider)

        # 保持兼容行为：输入为空时不覆盖已保存 API Key
        if snapshot.gemini_api_key:
            ConfigManager.set_ai_provider_api_key("gemini", snapshot.gemini_api_key)
        ConfigManager.set_ai_provider_base_url("gemini", snapshot.gemini_base_url)
        ConfigManager.set_ai_provider_model("gemini", snapshot.gemini_model)

        if snapshot.anthropic_api_key:
            ConfigManager.set_ai_provider_api_key("anthropic", snapshot.anthropic_api_key)
        ConfigManager.set_ai_provider_base_url("anthropic", snapshot.anthropic_base_url)
        ConfigManager.set_ai_provider_model("anthropic", snapshot.anthropic_model)

        ConfigManager.set_ai_max_steps(snapshot.ai_max_steps)

        ConfigManager.set("gmail_imap_email", snapshot.gmail_imap_email)
        ConfigManager.set_gmail_imap_password(snapshot.gmail_imap_password)

        ConfigManager.set("timeouts.page_load", snapshot.timeout_page_load)
        ConfigManager.set("timeouts.status_check", snapshot.timeout_status_check)
        ConfigManager.set("timeouts.iframe_wait", snapshot.timeout_iframe_wait)

        ConfigManager.set("delays.after_login", snapshot.delay_after_login)
        ConfigManager.set("delays.after_offer", snapshot.delay_after_offer)
        ConfigManager.set("delays.after_add_card", snapshot.delay_after_add_card)
        ConfigManager.set("delays.after_save", snapshot.delay_after_save)

        ConfigManager.set("proxy.max_windows_per_ip", snapshot.proxy_max_windows_per_ip)
        ConfigManager.set("default_thread_count", snapshot.default_thread_count)
        ConfigManager.set("theme", snapshot.theme)
        ConfigManager.set("data_separator", snapshot.data_separator)
        ConfigManager.save()

    @staticmethod
    def set_data_dir(path: str) -> None:
        """设置数据目录"""
        ConfigManager.set("data_dir", path)
