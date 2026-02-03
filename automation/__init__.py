# 自动化模块
# 包含所有 AI Agent 自动化脚本

# Google 登录自动化
from automation.auto_google_login import (
    auto_google_login,
    LoginResult,
    check_login_status,
)

# Antigravity OAuth 自动化
from automation.auto_antigravity_oauth import (
    auto_antigravity_oauth,
    OAuthResult,
)

# 批量账号处理器
from automation.batch_account_processor import (
    BatchAccountProcessor,
    BatchResult,
    quick_batch_login,
    quick_batch_oauth,
)

__all__ = [
    # Google Login
    "auto_google_login",
    "LoginResult",
    "check_login_status",
    # OAuth
    "auto_antigravity_oauth",
    "OAuthResult",
    # Batch
    "BatchAccountProcessor",
    "BatchResult",
    "quick_batch_login",
    "quick_batch_oauth",
]
