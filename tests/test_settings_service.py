from application.settings_service import SettingsService


def test_load_settings_snapshot_shape():
    snapshot = SettingsService.load_settings_snapshot()
    assert hasattr(snapshot, "sheerid_api_key")
    assert hasattr(snapshot, "ai_default_provider")
    assert hasattr(snapshot, "data_separator")


def test_resolve_provider_runtime_config_shape():
    api_key, base_url, model = SettingsService.resolve_provider_runtime_config(
        provider="gemini",
        api_key_input="",
        base_url_input="",
        model_input="",
    )
    assert isinstance(api_key, str)
    assert isinstance(base_url, str)
    assert isinstance(model, str)
