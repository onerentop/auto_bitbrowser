from application.account_manager_service import AccountManagerService


def test_check_task_conflicts_priority_and_wait_action():
    ok, message = AccountManagerService.check_task_conflicts(
        worker_running=True,
        wait_action="删除",
    )
    assert ok is False
    assert "已有任务在执行中" in message
    assert "删除" in message


def test_prepare_detect_pro_candidates_filters_by_login_and_browser():
    accounts = [
        {"email": "a@example.com", "login_status": "logged_in"},
        {"email": "b@example.com", "login_status": "not_logged"},
        {"email": "c@example.com", "login_status": "logged_in"},
    ]
    browser_ids = ["101", "102", ""]

    valid_accounts, valid_browser_ids, skipped_not_logged, skipped_no_browser = (
        AccountManagerService.prepare_detect_pro_candidates(accounts, browser_ids)
    )

    assert [account["email"] for account in valid_accounts] == ["a@example.com"]
    assert valid_browser_ids == ["101"]
    assert skipped_not_logged == ["b@example.com"]
    assert skipped_no_browser == ["c@example.com"]


def test_filter_linked_accounts_for_detect403_only_keeps_linked():
    accounts = [
        {"email": "a@example.com", "sub2api_status": "linked"},
        {"email": "b@example.com", "sub2api_status": "not_linked"},
        {"email": "c@example.com", "sub2api_status": "linked"},
    ]

    linked = AccountManagerService.filter_linked_accounts_for_detect403(accounts)
    assert [account["email"] for account in linked] == ["a@example.com", "c@example.com"]


def test_collect_unlock_targets_and_split_accounts_with_browser():
    selected_accounts = [
        {"email": "a@example.com", "unlock_status": "needs_unlock"},
        {"email": "b@example.com", "unlock_status": "normal"},
        {"email": "c@example.com", "unlock_status": "unlock_failed"},
    ]
    selected_browser_ids = ["101", "102", "-"]

    accounts_to_unlock, browser_ids = AccountManagerService.collect_unlock_targets_from_selected(
        selected_accounts,
        selected_browser_ids,
    )

    assert [account["email"] for account in accounts_to_unlock] == ["a@example.com", "c@example.com"]
    assert browser_ids == ["101", "-"]

    with_browser, valid_browser_ids, no_browser = AccountManagerService.split_accounts_with_browser(
        accounts_to_unlock,
        browser_ids,
    )

    assert [account["email"] for account in with_browser] == ["a@example.com"]
    assert valid_browser_ids == ["101"]
    assert no_browser == ["c@example.com"]


def test_prepare_enable_family_sharing_candidates():
    accounts = [
        {"email": "a@example.com", "is_pro": "yes", "login_status": "logged_in"},
        {"email": "b@example.com", "is_pro": "family_yes", "login_status": "logged_in"},
        {"email": "c@example.com", "is_pro": "yes", "login_status": "not_logged"},
        {"email": "d@example.com", "is_pro": "yes", "login_status": "logged_in"},
    ]
    browser_ids = ["101", "102", "103", ""]

    (
        valid_accounts,
        valid_browser_ids,
        skipped_not_pro,
        skipped_not_logged,
        skipped_no_browser,
    ) = AccountManagerService.prepare_enable_family_sharing_candidates(accounts, browser_ids)

    assert [account["email"] for account in valid_accounts] == ["a@example.com"]
    assert valid_browser_ids == ["101"]
    assert skipped_not_pro == ["b@example.com"]
    assert skipped_not_logged == ["c@example.com"]
    assert skipped_no_browser == ["d@example.com"]

