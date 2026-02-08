import sqlite3
import threading

from services.repositories import AccountIoRepository


def _build_connection_factory_with_seed():
    db_uri = "file:account_io_repo_test?mode=memory&cache=shared"
    keeper = sqlite3.connect(db_uri, uri=True, check_same_thread=False)
    keeper.row_factory = sqlite3.Row
    cursor = keeper.cursor()

    cursor.execute(
        """
        CREATE TABLE accounts (
            email TEXT PRIMARY KEY,
            password TEXT,
            recovery_email TEXT,
            secret_key TEXT,
            verification_link TEXT,
            status TEXT,
            message TEXT,
            updated_at TEXT
        )
        """
    )

    cursor.execute(
        """
        CREATE TABLE phone_modification_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT,
            new_phone TEXT,
            modified_at TEXT
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE email_modification_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT,
            new_recovery_email TEXT,
            modified_at TEXT
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE sv2_phone_modification_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT,
            new_phone TEXT,
            modified_at TEXT
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE authenticator_modification_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT,
            new_secret TEXT,
            modified_at TEXT
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE sheerid_verification_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT,
            verification_id TEXT,
            verification_result TEXT,
            message TEXT,
            verified_at TEXT
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE bind_card_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT,
            card_number TEXT,
            bound_at TEXT
        )
        """
    )

    cursor.execute(
        """
        INSERT INTO accounts (
            email, password, recovery_email, secret_key,
            verification_link, status, message, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "a@example.com",
            "pwd",
            "rec@example.com",
            "sec",
            "https://verify",
            "link_ready",
            "ok",
            "2026-02-10 00:00:00",
        ),
    )
    cursor.execute(
        "INSERT INTO phone_modification_history (email, new_phone, modified_at) VALUES (?, ?, ?)",
        ("a@example.com", "123", "2026-02-10 01:00:00"),
    )

    keeper.commit()

    def connection_factory():
        conn = sqlite3.connect(db_uri, uri=True, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    return connection_factory, keeper


def test_get_comprehensive_account_data():
    connection_factory, keeper = _build_connection_factory_with_seed()
    db_lock = threading.Lock()

    try:
        rows = AccountIoRepository.get_comprehensive_account_data(connection_factory, db_lock)
        assert len(rows) == 1
        row = rows[0]
        assert row["email"] == "a@example.com"
        assert row["phone_modified"] is True
        assert row["phone_new"] == "123"
        assert row["bind_card"] is False
    finally:
        keeper.close()

