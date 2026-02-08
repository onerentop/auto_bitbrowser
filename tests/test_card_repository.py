import sqlite3
import threading

from services.repositories import CardRepository


def _build_card_db_factory():
    db_uri = "file:card_repo_test?mode=memory&cache=shared"
    keeper = sqlite3.connect(db_uri, uri=True, check_same_thread=False)
    keeper.row_factory = sqlite3.Row
    cursor = keeper.cursor()

    cursor.execute(
        """
        CREATE TABLE cards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            number TEXT NOT NULL,
            exp_month TEXT,
            exp_year TEXT,
            cvv TEXT,
            name TEXT,
            zip_code TEXT
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE bind_card_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL,
            card_number TEXT NOT NULL,
            bound_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(email)
        )
        """
    )

    keeper.commit()

    def connection_factory():
        conn = sqlite3.connect(db_uri, uri=True, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    return connection_factory, keeper


def test_card_repository_crud_and_usage_selection():
    connection_factory, keeper = _build_card_db_factory()
    db_lock = threading.Lock()

    try:
        CardRepository.save_all_cards(
            [
                {"number": "4111111111111111", "exp_month": "01", "exp_year": "2030", "cvv": "123"},
                {"number": "5555555555554444", "exp_month": "02", "exp_year": "2031", "cvv": "456"},
            ],
            connection_factory,
            db_lock,
        )

        all_cards = CardRepository.get_all_cards(connection_factory, db_lock)
        assert len(all_cards) == 2

        CardRepository.add_card(
            {"number": "378282246310005", "exp_month": "03", "exp_year": "2032", "cvv": "789"},
            connection_factory,
            db_lock,
        )
        all_cards = CardRepository.get_all_cards(connection_factory, db_lock)
        assert len(all_cards) == 3

        first_id = all_cards[0]["id"]
        CardRepository.delete_card(first_id, connection_factory, db_lock)
        all_cards = CardRepository.get_all_cards(connection_factory, db_lock)
        assert len(all_cards) == 2

        conn = connection_factory()
        cur = conn.cursor()
        cur.executemany(
            "INSERT INTO bind_card_history (email, card_number) VALUES (?, ?)",
            [
                ("u1@example.com", "1111"),
                ("u2@example.com", "1111"),
                ("u3@example.com", "4444"),
            ],
        )
        conn.commit()
        conn.close()

        usage_counts = CardRepository.get_card_usage_counts(connection_factory, db_lock)
        assert usage_counts["1111"] == 2
        assert usage_counts["4444"] == 1

        cards_for_pick = [
            {"number": "4111111111111111"},
            {"number": "5555555555554444"},
        ]

        selected_card, selected_index = CardRepository.get_next_available_card(
            cards_for_pick,
            cards_per_account=2,
            usage_count_getter=lambda: usage_counts,
        )
        assert selected_index == 1
        assert selected_card["number"].endswith("4444")
    finally:
        keeper.close()

