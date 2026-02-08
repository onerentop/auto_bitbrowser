from application.sheerid_service import SheerIDService


def test_load_accounts_by_statuses_empty():
    assert SheerIDService.load_accounts_by_statuses([]) == []

