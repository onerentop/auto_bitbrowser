import sqlite3
import threading

from services.repositories import AccountRepository


def _build_account_status_db_factory():
    db_uri = "file:account_repo_status_test?mode=memory&cache=shared"
    keeper = sqlite3.connect(db_uri, uri=True, check_same_thread=False)
    keeper.row_factory = sqlite3.Row
    cursor = keeper.cursor()
    cursor.execute(
        """
        CREATE TABLE accounts (
            email TEXT PRIMARY KEY,
            browser_profile_id TEXT,
            sub2api_status TEXT,
            sub2api_account_id INTEGER,
            sub2api_session_id TEXT,
            login_status TEXT,
            last_login_at TEXT,
            last_error TEXT,
            is_pro TEXT,
            unlock_status TEXT,
            validation_url TEXT,
            family_member_count INTEGER,
            family_sharing_enabled TEXT,
            updated_at TEXT
        )
        """
    )
    cursor.executemany(
        """
        INSERT INTO accounts (
            email, browser_profile_id, sub2api_status, sub2api_account_id, sub2api_session_id,
            login_status, last_login_at, last_error, is_pro, unlock_status,
            validation_url, family_member_count, family_sharing_enabled, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        """,
        [
            ("a@example.com", "", "not_linked", None, None, "not_logged", None, None, "unknown", "none", None, 0, "unknown"),
            ("b@example.com", "b-101", "linked", 11, "s-11", "logged_in", None, None, "yes", "needs_unlock", "https://v/b", 3, "no"),
            ("c@example.com", "c-101", "oauth_failed", None, None, "logged_in", None, None, "family_yes", "unlock_failed", "https://v/c", 2, "yes"),
        ],
    )
    keeper.commit()

    def connection_factory():
        conn = sqlite3.connect(db_uri, uri=True, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    return connection_factory, keeper


def test_account_repository_status_flows():
    connection_factory, keeper = _build_account_status_db_factory()
    db_lock = threading.Lock()

    try:
        assert AccountRepository.bind_account_to_browser(
            "a@example.com",
            "a-100",
            connection_factory,
            db_lock,
        )
        assert AccountRepository.get_account_by_browser("a-100", connection_factory, db_lock)["email"] == "a@example.com"

        unbound = AccountRepository.get_unbound_accounts(connection_factory, db_lock)
        assert unbound == []

        assert AccountRepository.update_sub2api_status(
            "a@example.com",
            "linked",
            101,
            "session-101",
            connection_factory,
            db_lock,
        )
        linked = AccountRepository.get_accounts_by_sub2api_status("linked", connection_factory, db_lock)
        assert len(linked) >= 2

        assert AccountRepository.update_login_status(
            "a@example.com",
            "login_failed",
            "bad password",
            connection_factory,
            db_lock,
        )
        failed_accounts = AccountRepository.get_accounts_by_login_status("login_failed", connection_factory, db_lock)
        assert any(item["email"] == "a@example.com" for item in failed_accounts)

        assert AccountRepository.update_login_status(
            "a@example.com",
            "logged_in",
            None,
            connection_factory,
            db_lock,
        )
        assert AccountRepository.update_pro_status(
            "a@example.com",
            "yes",
            connection_factory,
            db_lock,
        )

        sub2_candidates = AccountRepository.get_accounts_for_sub2api(connection_factory, db_lock)
        assert all(item["login_status"] == "logged_in" for item in sub2_candidates)

        assert AccountRepository.update_unlock_status(
            "a@example.com",
            "needs_unlock",
            "https://v/a",
            connection_factory,
            db_lock,
        )
        unlock_accounts = AccountRepository.get_accounts_by_unlock_status(
            "needs_unlock",
            connection_factory,
            db_lock,
        )
        assert any(item["email"] == "a@example.com" for item in unlock_accounts)

        assert AccountRepository.update_family_member_count(
            "a@example.com",
            4,
            connection_factory,
            db_lock,
        )
        assert AccountRepository.update_family_sharing_enabled(
            "a@example.com",
            "no",
            connection_factory,
            db_lock,
        )

        pro_for_share = AccountRepository.get_pro_accounts_for_sharing(connection_factory, db_lock)
        assert any(item["email"] == "a@example.com" for item in pro_for_share)

        family_pro = AccountRepository.get_family_pro_accounts(connection_factory, db_lock)
        assert any(item["email"] == "c@example.com" for item in family_pro)
    finally:
        keeper.close()

