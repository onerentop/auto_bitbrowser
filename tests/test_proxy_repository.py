import sqlite3
import threading

from services.repositories import ProxyRepository


def _build_proxy_db_factory():
    db_uri = "file:proxy_repo_test?mode=memory&cache=shared"
    keeper = sqlite3.connect(db_uri, uri=True, check_same_thread=False)
    keeper.row_factory = sqlite3.Row
    cursor = keeper.cursor()

    cursor.execute(
        """
        CREATE TABLE proxies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            proxy_type TEXT DEFAULT 'socks5',
            username TEXT,
            password TEXT,
            host TEXT NOT NULL,
            port TEXT NOT NULL
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE proxy_window_bindings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            proxy_id INTEGER NOT NULL,
            browser_id TEXT NOT NULL,
            email TEXT,
            bound_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(browser_id)
        )
        """
    )

    keeper.commit()

    def connection_factory():
        conn = sqlite3.connect(db_uri, uri=True, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    return connection_factory, keeper


def test_proxy_repository_save_bind_stats_and_unbind():
    connection_factory, keeper = _build_proxy_db_factory()
    db_lock = threading.Lock()

    try:
        ProxyRepository.save_all_proxies(
            [
                {"proxy_type": "socks5", "host": "1.1.1.1", "port": "1000", "username": "u1", "password": "p1"},
                {"proxy_type": "http", "host": "2.2.2.2", "port": "2000", "username": "u2", "password": "p2"},
            ],
            connection_factory,
            db_lock,
        )

        proxies = ProxyRepository.get_all_proxies(connection_factory, db_lock)
        assert len(proxies) == 2
        first_proxy_id = proxies[0]["id"]

        assert ProxyRepository.bind_proxy_to_window(
            first_proxy_id,
            "browser-1",
            "a@example.com",
            connection_factory,
            db_lock,
        )
        assert ProxyRepository.bind_proxy_to_window(
            first_proxy_id,
            "browser-2",
            "b@example.com",
            connection_factory,
            db_lock,
        )

        binding_count = ProxyRepository.get_proxy_binding_count(first_proxy_id, connection_factory, db_lock)
        assert binding_count == 2

        bindings = ProxyRepository.get_proxy_bindings(first_proxy_id, connection_factory, db_lock)
        assert len(bindings) == 2

        stats = ProxyRepository.get_all_proxy_usage_stats(2, connection_factory, db_lock)
        first_stat = next(item for item in stats if item["proxy_id"] == first_proxy_id)
        assert first_stat["used_count"] == 2
        assert first_stat["is_full"] is True

        assert ProxyRepository.unbind_proxy_from_window("browser-2", connection_factory, db_lock) is True
        binding_count = ProxyRepository.get_proxy_binding_count(first_proxy_id, connection_factory, db_lock)
        assert binding_count == 1

        available_proxy = ProxyRepository.get_next_available_proxy(2, connection_factory, db_lock)
        assert available_proxy is not None
    finally:
        keeper.close()


def test_proxy_repository_delete_and_incremental_replace():
    connection_factory, keeper = _build_proxy_db_factory()
    db_lock = threading.Lock()

    try:
        ProxyRepository.add_proxy(
            {"proxy_type": "socks5", "host": "3.3.3.3", "port": "3000", "username": "u3", "password": "p3"},
            connection_factory,
            db_lock,
        )
        proxies = ProxyRepository.get_all_proxies(connection_factory, db_lock)
        assert len(proxies) == 1
        proxy_id = proxies[0]["id"]

        ProxyRepository.delete_proxy(proxy_id, connection_factory, db_lock)
        proxies = ProxyRepository.get_all_proxies(connection_factory, db_lock)
        assert proxies == []

        ProxyRepository.save_all_proxies(
            [
                {"proxy_type": "socks5", "host": "4.4.4.4", "port": "4000"},
                {"proxy_type": "socks5", "host": "5.5.5.5", "port": "5000"},
            ],
            connection_factory,
            db_lock,
        )

        ProxyRepository.save_all_proxies(
            [
                {"proxy_type": "http", "host": "5.5.5.5", "port": "5000", "username": "updated", "password": "updated"},
            ],
            connection_factory,
            db_lock,
        )

        proxies = ProxyRepository.get_all_proxies(connection_factory, db_lock)
        assert len(proxies) == 1
        assert proxies[0]["host"] == "5.5.5.5"
        assert proxies[0]["proxy_type"] == "http"
    finally:
        keeper.close()

