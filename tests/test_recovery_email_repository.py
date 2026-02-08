import sqlite3
import threading

from services.repositories import RecoveryEmailRepository


def _build_recovery_db_factory():
    db_uri = "file:recovery_repo_test?mode=memory&cache=shared"
    keeper = sqlite3.connect(db_uri, uri=True, check_same_thread=False)
    keeper.row_factory = sqlite3.Row

    def connection_factory():
        conn = sqlite3.connect(db_uri, uri=True, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    return connection_factory, keeper


def test_recovery_email_repository_pool_usage_and_binding():
    connection_factory, keeper = _build_recovery_db_factory()
    db_lock = threading.Lock()

    try:
        RecoveryEmailRepository.init_recovery_email_pool_tables(connection_factory, db_lock)

        assert RecoveryEmailRepository.add_recovery_email_to_pool(
            "helper@example.com",
            "imap-pass",
            "note1",
            connection_factory,
            db_lock,
        )

        pool = RecoveryEmailRepository.get_recovery_email_pool(connection_factory, db_lock)
        assert len(pool) == 1
        assert pool[0]["email"] == "helper@example.com"

        assert RecoveryEmailRepository.update_recovery_email_enabled(
            "helper@example.com",
            False,
            connection_factory,
            db_lock,
        )

        assert RecoveryEmailRepository.increment_recovery_email_usage(
            "helper@example.com",
            "2026-02-09",
            connection_factory,
            db_lock,
        )
        assert RecoveryEmailRepository.increment_recovery_email_usage(
            "helper@example.com",
            "2026-02-09",
            connection_factory,
            db_lock,
        )

        usage = RecoveryEmailRepository.get_recovery_email_daily_usage(
            "2026-02-09",
            connection_factory,
            db_lock,
        )
        assert usage["helper@example.com"] == 2

        assert RecoveryEmailRepository.set_recovery_email_usage_full(
            "helper@example.com",
            5,
            "2026-02-09",
            connection_factory,
            db_lock,
        )
        usage = RecoveryEmailRepository.get_recovery_email_daily_usage(
            "2026-02-09",
            connection_factory,
            db_lock,
        )
        assert usage["helper@example.com"] == 5

        assert RecoveryEmailRepository.set_account_recovery_binding(
            "user@example.com",
            "helper@example.com",
            "bound",
            connection_factory,
            db_lock,
        )

        binding = RecoveryEmailRepository.get_account_recovery_binding(
            "user@example.com",
            connection_factory,
            db_lock,
        )
        assert binding is not None
        assert binding["bound_recovery_email"] == "helper@example.com"

        all_bindings = RecoveryEmailRepository.get_all_account_recovery_bindings(
            connection_factory,
            db_lock,
        )
        assert "user@example.com" in all_bindings

        reset_count = RecoveryEmailRepository.reset_recovery_email_daily_usage(
            "2026-02-09",
            connection_factory,
            db_lock,
        )
        assert reset_count >= 1

        assert RecoveryEmailRepository.remove_recovery_email_from_pool(
            "helper@example.com",
            connection_factory,
            db_lock,
        )
        pool = RecoveryEmailRepository.get_recovery_email_pool(connection_factory, db_lock)
        assert pool == []
    finally:
        keeper.close()

