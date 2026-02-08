from application.sub2api_settings_service import Sub2APISettingsService


def test_mask_secret():
    assert Sub2APISettingsService.mask_secret("") == ""
    assert Sub2APISettingsService.mask_secret("short") == "***"
    assert Sub2APISettingsService.mask_secret("1234567890123456") == "12345678...3456"

