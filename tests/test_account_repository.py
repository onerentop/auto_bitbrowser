import sqlite3
import threading

from services.repositories import AccountRepository


def _build_connection_factory_with_seed():
    """构建共享内存数据库连接工厂，并初始化测试数据。"""
    db_uri = "file:account_repo_test?mode=memory&cache=shared"
    keeper = sqlite3.connect(db_uri, uri=True, check_same_thread=False)
    keeper.row_factory = sqlite3.Row
    cursor = keeper.cursor()
    cursor.execute(
        """
        CREATE TABLE accounts (
            email TEXT PRIMARY KEY,
            unlock_status TEXT,
            validation_url TEXT,
            is_pro TEXT,
            family_member_count INTEGER,
            login_status TEXT,
            browser_profile_id TEXT
        )
        """
    )
    cursor.executemany(
        """
        INSERT INTO accounts (
            email, unlock_status, validation_url, is_pro,
            family_member_count, login_status, browser_profile_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        [
            ("a@example.com", "needs_unlock", "https://verify/a", "yes", 1, "logged_in", "101"),
            ("b@example.com", "unlock_failed", "https://verify/b", "yes", 5, "logged_in", "102"),
            ("c@example.com", "none", "", "yes", 6, "logged_in", "103"),
            ("d@example.com", "needs_unlock", "", "yes", 2, "logged_in", "104"),
            ("e@example.com", "none", None, "family_yes", 0, "logged_in", "105"),
            ("f@example.com", "none", None, "yes", 0, "not_logged", "106"),
            ("g@example.com", "none", None, "yes", 0, "logged_in", ""),
        ],
    )
    keeper.commit()

    def connection_factory():
        conn = sqlite3.connect(db_uri, uri=True, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    return connection_factory, keeper


def test_account_repository_basic_queries_and_delete():
    connection_factory, keeper = _build_connection_factory_with_seed()
    db_lock = threading.Lock()

    try:
        all_accounts = AccountRepository.get_all_accounts(connection_factory, db_lock)
        assert len(all_accounts) == 7

        account = AccountRepository.get_account_by_email("a@example.com", connection_factory, db_lock)
        assert account is not None
        assert account["email"] == "a@example.com"

        deleted = AccountRepository.delete_account("g@example.com", connection_factory, db_lock)
        assert deleted is True

        deleted_account = AccountRepository.get_account_by_email("g@example.com", connection_factory, db_lock)
        assert deleted_account is None
    finally:
        keeper.close()


def test_account_repository_unlock_and_available_pro_filters():
    connection_factory, keeper = _build_connection_factory_with_seed()
    db_lock = threading.Lock()

    try:
        unlock_accounts = AccountRepository.get_accounts_needing_unlock(connection_factory, db_lock)
        unlock_emails = [item["email"] for item in unlock_accounts]
        assert unlock_emails == ["a@example.com", "b@example.com"]

        available_pro_accounts = AccountRepository.get_available_pro_accounts(connection_factory, db_lock)
        available_pro_emails = [item["email"] for item in available_pro_accounts]
        assert available_pro_emails == ["a@example.com", "b@example.com"]
    finally:
        keeper.close()

