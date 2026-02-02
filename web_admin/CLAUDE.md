# web_admin Module

> [Root](../CLAUDE.md) > **web_admin**

## Overview

Web Admin module provides an HTTP-based account management interface running on port 8080.

## Module Structure

```
web_admin/
├── server.py          # HTTP server main program
├── templates/
│   └── index.html     # Main page template
└── static/
    ├── css/           # Style files
    └── js/            # JavaScript files
```

## Entry Point

- **server.py**: `run_server(port=8080)` - Start HTTP service

## Core Components

### AccountHandler (server.py)

Inherits from `http.server.SimpleHTTPRequestHandler`, handles HTTP requests.

**Endpoints**:
| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Return main page (index.html) |
| GET | `/static/*` | Static resource service |
| GET | `/api/accounts` | Get all accounts (JSON) |
| POST | `/api/export` | Export selected accounts |

### Export API

**POST /api/export**

```json
// Request
{
  "emails": ["a@example.com", "b@example.com"],
  "fields": ["email", "password", "recovery_email"]
}

// Response: text/plain attachment
email----password----recovery_email
```

## Usage

### Start Server

```python
from web_admin.server import run_server

# Start in main thread
run_server(port=8080)

# Or in background thread
import threading
threading.Thread(target=run_server, daemon=True).start()
```

### Access Interface

Open browser and navigate to: `http://localhost:8080`

## Dependencies

- **Internal**: `services/database.py` - Uses `DBManager.get_all_accounts()` for data
- **Port 8080**: Default port, may conflict with other services

## Integration

Web Admin is typically started automatically as a background thread when the main GUI launches:

```python
# In main GUI startup logic
import threading
from web_admin.server import run_server

threading.Thread(target=run_server, daemon=True).start()
```

## Development Notes

1. Server uses `socketserver.TCPServer.allow_reuse_address = True` for quick restart
2. Logging is silenced (`log_message` returns empty) to avoid interfering with main GUI console
3. Uses `DBManager.init_db()` to ensure database is initialized

## Features

- **Account List View**: Display all accounts with status
- **Field Selection**: Choose which fields to export
- **Batch Export**: Export multiple accounts at once
- **Status Filtering**: Filter accounts by status

---

*Updated: 2026-02-02*
