from types import SimpleNamespace

from application.account_task_orchestrator import AccountTaskOrchestrator


def test_create_result_templates():
    batch_results = AccountTaskOrchestrator.create_batch_join_results(3)
    assert batch_results["total"] == 3
    assert batch_results["success_count"] == 0
    assert batch_results["failed_count"] == 0

    sharing_results = AccountTaskOrchestrator.create_enable_family_sharing_results(2)
    assert sharing_results["total"] == 2
    assert sharing_results["already_enabled_count"] == 0
    assert sharing_results["family_created_count"] == 0


def test_execute_batch_join_family_stop_short_circuit(monkeypatch):
    def fake_auto_join_family(**kwargs):
        return SimpleNamespace(success=True, message="")

    monkeypatch.setattr(
        "automation.auto_join_family.auto_join_family",
        fake_auto_join_family,
    )
    monkeypatch.setattr(
        "automation.auto_join_family._is_family_full_error",
        lambda _: False,
    )

    logs = []
    progress = []
    assignments = [
        ({"email": "a", "browser_profile_id": "a1"}, {"email": "pro1", "browser_profile_id": "p1"}),
        ({"email": "b", "browser_profile_id": "b1"}, {"email": "pro1", "browser_profile_id": "p1"}),
    ]

    results = AccountTaskOrchestrator.execute_batch_join_family(
        assignments=assignments,
        should_stop=lambda: True,
        log_callback=logs.append,
        progress_callback=progress.append,
    )

    assert results["success_count"] == 0
    assert results["failed_count"] == 0
    assert any("用户停止任务" in item for item in logs)
    assert progress == []


def test_execute_enable_family_sharing_stop_short_circuit(monkeypatch):
    def fake_enable_family_sharing(**kwargs):
        return SimpleNamespace(success=True, was_already_enabled=False, family_created=False, message="")

    monkeypatch.setattr(
        "automation.auto_enable_family_sharing.auto_enable_family_sharing",
        fake_enable_family_sharing,
    )

    logs = []
    progress = []
    accounts = [{"email": "a"}, {"email": "b"}]
    browser_ids = ["1", "2"]

    results = AccountTaskOrchestrator.execute_enable_family_sharing(
        accounts=accounts,
        browser_ids=browser_ids,
        should_stop=lambda: True,
        log_callback=logs.append,
        progress_callback=progress.append,
    )

    assert results["success_count"] == 0
    assert results["failed_count"] == 0
    assert any("用户停止任务" in item for item in logs)
    assert progress == []


def test_execute_batch_bind_success_and_failure():
    logs = []
    progress = []
    bound = {}

    def bind_account(email: str, browser_id: str):
        if email == "bad@example.com":
            raise RuntimeError("bind failed")
        bound[email] = browser_id

    matched_pairs = [
        ("ok1@example.com", "b1"),
        ("bad@example.com", "b2"),
        ("ok2@example.com", "b3"),
    ]

    results = AccountTaskOrchestrator.execute_batch_bind(
        matched_pairs=matched_pairs,
        should_stop=lambda: False,
        bind_account_callback=bind_account,
        log_callback=logs.append,
        progress_callback=progress.append,
    )

    assert results["total"] == 3
    assert results["success_count"] == 2
    assert results["failed_count"] == 1
    assert len(results["failed_list"]) == 1
    assert bound == {"ok1@example.com": "b1", "ok2@example.com": "b3"}
    assert progress == [1, 2, 3]
    assert any("绑定失败" in item for item in logs)


def test_execute_batch_delete_with_windows_and_failure():
    logs = []
    progress = []
    deleted_accounts = []
    closed_windows = []
    deleted_windows = []

    accounts = [
        {"email": "ok1@example.com"},
        {"email": "bad@example.com"},
        {"email": "ok2@example.com"},
    ]
    browser_ids = ["w1", "w2", "w3"]

    def delete_account(email: str):
        if email == "bad@example.com":
            raise RuntimeError("delete failed")
        deleted_accounts.append(email)

    def close_browser(browser_id: str):
        closed_windows.append(browser_id)

    def delete_browser(browser_id: str):
        deleted_windows.append(browser_id)
        return {"success": browser_id in ("w1", "w3")}

    results = AccountTaskOrchestrator.execute_batch_delete(
        accounts=accounts,
        browser_ids=browser_ids,
        with_windows=True,
        should_stop=lambda: False,
        delete_account_callback=delete_account,
        close_browser_callback=close_browser,
        delete_browser_callback=delete_browser,
        log_callback=logs.append,
        progress_callback=progress.append,
    )

    assert results["total"] == 3
    assert results["deleted_accounts"] == 2
    assert results["deleted_windows"] == 2
    assert results["failed_count"] == 1
    assert len(results["failed_list"]) == 1
    assert deleted_accounts == ["ok1@example.com", "ok2@example.com"]
    assert closed_windows == ["w1", "w2", "w3"]
    assert deleted_windows == ["w1", "w2", "w3"]
    assert progress == [1, 2, 3]
    assert any("删除 bad@example.com 失败" in item for item in logs)
