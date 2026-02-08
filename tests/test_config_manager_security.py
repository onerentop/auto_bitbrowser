import json
from pathlib import Path

from core.config_manager import ConfigManager


def _reset_config_manager(config_file: Path):
    ConfigManager.CONFIG_FILE = str(config_file)
    ConfigManager._config = None


def test_set_api_key_encrypts_on_disk_and_decrypts_on_read(tmp_path):
    config_file = tmp_path / "config.json"
    _reset_config_manager(config_file)

    ConfigManager.load()
    ConfigManager.set_api_key("sheerid-plain-key")

    with config_file.open("r", encoding="utf-8") as file:
        raw = json.load(file)

    assert raw["sheerid_api_key"].startswith("ENC:")
    assert ConfigManager.get_api_key() == "sheerid-plain-key"
    assert ConfigManager.get("sheerid_api_key", "") == "sheerid-plain-key"


def test_plaintext_sensitive_fields_are_migrated_on_load(tmp_path):
    config_file = tmp_path / "config.json"
    legacy_config = {
        "sheerid_api_key": "plain-sheerid-key",
        "gmail_imap_password": "plain-gmail-password",
        "sub2api": {
            "password": "plain-sub2-password",
            "admin_token": "plain-sub2-token",
        },
        "sms_bus": {
            "token": "plain-sms-token",
        },
        "ai_agent": {
            "api_key": "plain-ai-key",
            "providers": {
                "gemini": {
                    "api_key": "plain-gemini-key",
                }
            },
        },
    }
    config_file.write_text(
        json.dumps(legacy_config, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    _reset_config_manager(config_file)
    ConfigManager.load()

    with config_file.open("r", encoding="utf-8") as file:
        migrated = json.load(file)

    assert migrated["sheerid_api_key"].startswith("ENC:")
    assert migrated["gmail_imap_password"].startswith("ENC:")
    assert migrated["sub2api"]["password"].startswith("ENC:")
    assert migrated["sub2api"]["admin_token"].startswith("ENC:")
    assert migrated["sms_bus"]["token"].startswith("ENC:")
    assert migrated["ai_agent"]["api_key"].startswith("ENC:")
    assert migrated["ai_agent"]["providers"]["gemini"]["api_key"].startswith("ENC:")

    assert ConfigManager.get_api_key() == "plain-sheerid-key"
    assert ConfigManager.get_gmail_imap_password() == "plain-gmail-password"
    assert ConfigManager.get_sub2api_password() == "plain-sub2-password"
    assert ConfigManager.get_sub2api_token() == "plain-sub2-token"
    assert ConfigManager.get_sms_bus_token() == "plain-sms-token"
    assert ConfigManager.get_ai_api_key() == "plain-gemini-key"


def test_generic_set_on_sensitive_key_is_auto_encrypted(tmp_path):
    config_file = tmp_path / "config.json"
    _reset_config_manager(config_file)

    ConfigManager.load()
    ConfigManager.set("ai_agent.providers.custom.api_key", "custom-plain-key")
    ConfigManager.set("gmail_imap_password", "gmail-plain")

    raw_provider_key = ConfigManager._config["ai_agent"]["providers"]["custom"]["api_key"]
    raw_gmail_password = ConfigManager._config["gmail_imap_password"]

    assert raw_provider_key.startswith("ENC:")
    assert raw_gmail_password.startswith("ENC:")
    assert ConfigManager.get("ai_agent.providers.custom.api_key", "") == "custom-plain-key"
    assert ConfigManager.get("gmail_imap_password", "") == "gmail-plain"
