# services Module

> [Root](../CLAUDE.md) > **services**

## Overview

Service layer module. Contains database management, external API integrations, and data storage utilities.

## Module Structure

```
services/
├── __init__.py            # Module initialization
├── database.py            # SQLite database manager (DBManager)
├── ix_api.py              # ixBrowser low-level API wrapper
├── ix_window.py           # ixBrowser window management (high-level)
├── sheerid_verifier.py    # SheerID API client
├── account_manager.py     # Account status management
├── email_code_reader.py   # Email verification code reader
├── proxy_allocator.py     # Proxy allocation service
└── data_store.py          # Generic data storage
```

## Components

### DBManager (database.py)

Core SQLite database manager. Singleton pattern with thread-safe operations.

**Database Schema**:

```sql
-- Main accounts table
CREATE TABLE accounts (
    email TEXT PRIMARY KEY,
    password TEXT,
    recovery_email TEXT,
    secret_key TEXT,
    verification_link TEXT,
    status TEXT DEFAULT 'pending',
    message TEXT,
    sheerid_steps INTEGER DEFAULT 0,
    last_failed_step TEXT,
    last_error TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Payment cards
CREATE TABLE cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number TEXT NOT NULL,
    exp_month TEXT,
    exp_year TEXT,
    cvv TEXT,
    name TEXT DEFAULT 'John Smith',
    zip_code TEXT DEFAULT '10001',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Proxy configuration
CREATE TABLE proxies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proxy_type TEXT DEFAULT 'socks5',
    username TEXT,
    password TEXT,
    host TEXT NOT NULL,
    port TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Proxy-window bindings
CREATE TABLE proxy_window_bindings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proxy_id INTEGER NOT NULL,
    browser_id TEXT NOT NULL,
    email TEXT,
    bound_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (proxy_id) REFERENCES proxies(id) ON DELETE CASCADE,
    UNIQUE(browser_id)
);
```

**Key Methods**:
| Method | Description |
|--------|-------------|
| `init_db()` | Initialize database with auto-migration |
| `upsert_account(...)` | Insert or update account |
| `get_accounts_by_status(status)` | Query accounts by status |
| `get_all_accounts()` | Get all accounts |
| `get_account_by_email(email)` | Get single account |
| `export_to_files()` | Export to text files |
| `get_next_available_card(cards, limit)` | Card rotation logic |
| `get_next_available_proxy(max_per_ip)` | Proxy rotation logic |
| `get_comprehensive_account_data()` | Join all modification history tables |

### ix_api.py

Low-level ixBrowser API wrapper using `ixbrowser-local-api` SDK.

**Key Functions**:
| Function | Description |
|----------|-------------|
| `get_client()` | Get singleton IXBrowserClient |
| `openBrowser(profile_id)` | Open browser, return WebSocket endpoint |
| `closeBrowser(profile_id)` | Close browser |
| `createBrowser(name, proxy_config)` | Create new profile |
| `deleteBrowser(profile_id)` | Delete profile |
| `get_profile_list(page, limit)` | List profiles |
| `update_profile_proxy(...)` | Update proxy settings |

**Response Format**:
```python
# openBrowser returns:
{
    'success': True,
    'data': {
        'ws': 'ws://127.0.0.1:xxxxx/devtools/browser/...',
        'http': '127.0.0.1:port',
        'driver': 'path/to/chromedriver',
        'pid': 12345,
        'profile_id': 123
    }
}
```

### ix_window.py

High-level window management wrapper.

### sheerid_verifier.py

SheerID API client for batch student verification.

**Key Methods**:
| Method | Description |
|--------|-------------|
| `verify_batch(ids, callback)` | Batch verify (SSE streaming) |
| `_get_csrf_token()` | Get CSRF token for API calls |

### email_code_reader.py

Email verification code reader via IMAP.

**Key Classes**:
- `GmailCodeReader` - Read verification codes from Gmail

### proxy_allocator.py

Proxy allocation service with rotation logic.

## Usage Examples

```python
# Database operations
from services.database import DBManager

DBManager.init_db()
accounts = DBManager.get_accounts_by_status('link_ready')
DBManager.upsert_account('user@gmail.com', password='xxx', status='verified')

# ixBrowser operations
from services.ix_api import openBrowser, closeBrowser

result = openBrowser(12345)
if result['success']:
    ws_endpoint = result['data']['ws']
    # Use with Playwright: browser = await playwright.chromium.connect_over_cdp(ws_endpoint)

closeBrowser(12345)
```

## Thread Safety

- `database.py`: All methods use `threading.Lock` for thread safety
- `ix_api.py`: Uses singleton client, thread-safe for read operations
- `proxy_allocator.py`: Uses locks for allocation operations

## External Dependencies

| Service | Port | Description |
|---------|------|-------------|
| ixBrowser | 53200 | Local browser management |
| SheerID API | HTTPS | Student verification |
| Gmail IMAP | 993 | Email code reading |

---

*Generated: 2026-02-02*
