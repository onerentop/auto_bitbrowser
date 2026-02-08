import sqlite3
import threading

from services.repositories import HistoryRepository


def _build_history_db_factory():
    db_uri = "file:history_repo_test?mode=memory&cache=shared"
    keeper = sqlite3.connect(db_uri, uri=True, check_same_thread=False)
    keeper.row_factory = sqlite3.Row

    def connection_factory():
        conn = sqlite3.connect(db_uri, uri=True, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    return connection_factory, keeper


def test_history_repository_all_history_flows():
    connection_factory, keeper = _build_history_db_factory()
    db_lock = threading.Lock()

    try:
        HistoryRepository.init_phone_modification_table(connection_factory, db_lock)
        HistoryRepository.add_phone_modification("u1@example.com", "123456", connection_factory, db_lock)
        phone_history = HistoryRepository.get_phone_modification_history(connection_factory, db_lock)
        assert phone_history["u1@example.com"]["new_phone"] == "123456"
        assert HistoryRepository.clear_phone_modification_history(connection_factory, db_lock) >= 1

        HistoryRepository.init_email_modification_table(connection_factory, db_lock)
        HistoryRepository.add_email_modification(
            "u1@example.com",
            "recovery@example.com",
            connection_factory,
            db_lock,
        )
        email_history = HistoryRepository.get_email_modification_history(connection_factory, db_lock)
        assert email_history["u1@example.com"]["new_recovery_email"] == "recovery@example.com"
        assert HistoryRepository.clear_email_modification_history(connection_factory, db_lock) >= 1

        HistoryRepository.init_2sv_phone_modification_table(connection_factory, db_lock)
        HistoryRepository.add_2sv_phone_modification("u1@example.com", "8888", connection_factory, db_lock)
        sv2_history = HistoryRepository.get_2sv_phone_modification_history(connection_factory, db_lock)
        assert sv2_history["u1@example.com"]["new_phone"] == "8888"
        assert HistoryRepository.clear_2sv_phone_modification_history(connection_factory, db_lock) >= 1

        HistoryRepository.init_authenticator_modification_table(connection_factory, db_lock)
        HistoryRepository.add_authenticator_modification(
            "u1@example.com",
            "SECRET-KEY-123",
            connection_factory,
            db_lock,
        )
        auth_history = HistoryRepository.get_authenticator_modification_history(connection_factory, db_lock)
        assert auth_history["u1@example.com"]["new_secret"] == "SECRET-KEY-123"
        assert HistoryRepository.clear_authenticator_modification_history(connection_factory, db_lock) >= 1

        HistoryRepository.init_sheerid_verification_table(connection_factory, db_lock)
        HistoryRepository.add_sheerid_verification(
            "u1@example.com",
            "verify-001",
            "approved",
            "ok",
            connection_factory,
            db_lock,
        )
        sheerid_history = HistoryRepository.get_sheerid_verification_history(connection_factory, db_lock)
        assert sheerid_history["u1@example.com"]["verification_id"] == "verify-001"
        assert sheerid_history["u1@example.com"]["verification_result"] == "approved"
        assert HistoryRepository.clear_sheerid_verification_history(connection_factory, db_lock) >= 1

        HistoryRepository.init_bind_card_history_table(connection_factory, db_lock)
        HistoryRepository.add_bind_card_history("u1@example.com", "1234", connection_factory, db_lock)
        bind_history = HistoryRepository.get_bind_card_history(connection_factory, db_lock)
        assert bind_history["u1@example.com"]["card_number"] == "1234"
        assert HistoryRepository.clear_bind_card_history(connection_factory, db_lock) >= 1
    finally:
        keeper.close()

