from application.settings_service import SettingsService


def test_load_settings_snapshot_shape():
    snapshot = SettingsService.load_settings_snapshot()
    assert hasattr(snapshot, "sheerid_api_key")
    assert hasattr(snapshot, "ai_default_provider")
    assert hasattr(snapshot, "data_separator")

