# Google 账号管理系统 - Sub2API 集成实施计划

> **创建日期**: 2026-02-02
> **状态**: 待批准
> **版本**: v2.0 (精简版 - 去除已有功能)

## 一、项目现有功能（无需重复开发）

经审查，以下功能**已在项目中实现**，本次集成**无需重复开发**：

| 已有功能 | 实现位置 | 说明 |
|----------|----------|------|
| ✅ 账户批量导入 | `gui/config_ui.py` → `AccountBatchImportDialog` | 支持格式解析、实时预览、智能去重 |
| ✅ 批量创建窗口 | `gui/main_window.py` + `services/ix_window.py` | 自动读取账号、后台并发创建 |
| ✅ 代理分配与绑定 | `services/proxy_allocator.py` | 顺序分配策略、配额管理、使用统计 |
| ✅ 代理-窗口绑定表 | `services/database.py` → `proxy_window_bindings` | 已有完整的绑定关系管理 |
| ✅ 导入去重逻辑 | `DBManager.upsert_account()` | 已存在账号只更新，不覆盖状态 |

---

## 二、本次需要新增的功能

### 2.1 核心目标

| 功能 | 说明 |
|------|------|
| 🆕 **一键登录** | AI Agent 自动完成 Google 登录 |
| 🆕 **Sub2API 集成** | 一键添加 Antigravity 平台账号 |
| 🆕 **OAuth 自动化** | 自动完成 Antigravity OAuth 授权流程 |
| 🆕 **账号-窗口绑定** | 记录账号与浏览器窗口的对应关系 |
| 🆕 **登录状态管理** | 跟踪账号登录状态 |

### 2.2 业务规则

| 规则 | 说明 |
|------|------|
| **去重检查** | 已关联 Sub2API 的账号不重复添加 |
| **登录验证** | 登录失败的账号不添加到 Sub2API |

---

## 三、实施阶段（精简版）

### 阶段 1: 数据库扩展 (services/database.py)

**新增字段到 accounts 表：**

| 字段名 | 类型 | 说明 |
|--------|------|------|
| `sub2api_account_id` | INTEGER | Sub2API 返回的账号 ID |
| `sub2api_status` | TEXT | 关联状态: not_linked / linking / linked / failed |
| `sub2api_session_id` | TEXT | OAuth 会话 ID（临时） |
| `login_status` | TEXT | 登录状态: not_logged / logged_in / login_failed |
| `last_login_at` | TIMESTAMP | 最后登录时间 |
| `browser_profile_id` | TEXT | 绑定的 ixBrowser 窗口 ID |

**新增方法：**
```python
# 账号-窗口绑定（区别于代理-窗口绑定）
def bind_account_to_browser(email: str, browser_profile_id: str) -> bool
def get_account_by_browser(browser_profile_id: str) -> dict
def get_unbound_accounts() -> list

# Sub2API 状态管理
def update_sub2api_status(email: str, status: str, account_id: int = None) -> bool
def get_accounts_by_sub2api_status(status: str) -> list

# 登录状态管理
def update_login_status(email: str, status: str) -> bool
```

### 阶段 2: 配置管理扩展 (core/config_manager.py)

**新增配置项：**
```json
{
  "sub2api": {
    "enabled": true,
    "base_url": "https://sub2api.topren.top",
    "admin_token": "",
    "default_group": "claude_share"
  },
  "account_manager": {
    "login_concurrency": 3,
    "login_timeout": 120,
    "oauth_timeout": 180
  }
}
```

### 阶段 3: Sub2API HTTP 客户端

**新建文件**: `services/sub2api_client.py`

```python
class Sub2APIClient:
    """Sub2API HTTP 客户端"""

    # Public Endpoints
    async def start_antigravity_oauth(self) -> dict
    async def complete_antigravity_oauth(session_id, state, code) -> dict
    async def wake_antigravity_account(account_id) -> dict

    # Admin Endpoints (需要 token)
    async def check_account_exists(email: str) -> Optional[int]
    async def list_accounts(platform="antigravity") -> list
    async def get_account(account_id) -> dict
```

### 阶段 4: 自动化脚本

#### 4.1 一键登录: `automation/auto_google_login.py`

```python
async def auto_google_login(
    browser_id: str,
    account: dict,  # {email, password, secret_key, recovery_email}
    callback: Callable = None,
) -> TaskResult:
    """
    Google 账号一键登录

    功能:
    - 打开浏览器窗口
    - 导航到 Google 登录页
    - AI Agent 自动填写账号密码
    - 处理 2FA 验证
    - 验证登录成功
    """
```

#### 4.2 Antigravity OAuth: `automation/auto_antigravity_oauth.py`

```python
async def auto_antigravity_oauth(
    browser_id: str,
    account: dict,
    sub2api_client: Sub2APIClient,
    callback: Callable = None,
) -> TaskResult:
    """
    Antigravity OAuth 自动化

    流程:
    1. 检查是否已关联（去重）
    2. 调用 start_antigravity_oauth 获取 auth_url
    3. AI Agent 完成登录授权
    4. 监听并提取 code
    5. 调用 complete_antigravity_oauth
    6. 更新本地数据库
    """
```

#### 4.3 批量处理器: `automation/batch_account_processor.py`

```python
class BatchAccountProcessor:
    """批量账号处理器"""

    async def batch_login(accounts, browser_ids) -> BatchResult
    async def batch_oauth(accounts, browser_ids, sub2api_client) -> BatchResult
```

### 阶段 5: GUI 界面

#### 5.1 账号管理界面: `gui/account_manager_gui.py`

```
┌─────────────────────────────────────────────────────────────────┐
│  Google 账号管理                                          [_][□][X]│
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ [批量登录] [批量OAuth] [刷新状态] │ 并发: [3 ▼]            │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ ┌───────────────────────────────────────────────────────────────┐│
│ │ □ │ 邮箱          │ 登录状态 │ 窗口ID  │ Sub2API │ 操作      ││
│ ├───┼───────────────┼──────────┼─────────┼─────────┼───────────┤│
│ │ □ │ user1@gm.com  │ 已登录   │ 12345   │ 已关联  │ [OAuth]   ││
│ │ □ │ user2@gm.com  │ 未登录   │ 12346   │ 未关联  │ [登录]    ││
│ └───────────────────────────────────────────────────────────────┘│
│                                                                  │
│ [日志输出区域]                                                   │
│ 状态栏: 总计 X 个 | 已登录 X | 已关联 X                          │
└─────────────────────────────────────────────────────────────────┘
```

**功能列表：**

| 功能 | 说明 |
|------|------|
| 批量登录 | 选中账号批量一键登录 |
| 批量 OAuth | 选中账号批量执行 Antigravity OAuth |
| 刷新状态 | 检测账号当前登录状态 |
| 筛选器 | 按登录状态、Sub2API 状态筛选 |
| 右键菜单 | 单个操作：登录、OAuth、重试 |

#### 5.2 配置界面扩展: `gui/config_ui.py`

**新增 Tab: Sub2API 设置**

```
┌─────────────────────────────────────────────────────┐
│ Sub2API 设置                                        │
├─────────────────────────────────────────────────────┤
│ 服务地址: [https://sub2api.topren.top        ]     │
│ 管理员 Token: [********************************] 👁  │
│ [测试连接]                                          │
│ ─────────────────────────────────────────────────── │
│ 账号管理设置                                        │
│ 登录并发数: [3  ▼]                                  │
│ 登录超时(秒): [120    ]                             │
│ OAuth 超时(秒): [180    ]                           │
└─────────────────────────────────────────────────────┘
```

---

## 四、文件变更清单（精简版）

### 4.1 新增文件

| 文件路径 | 说明 |
|----------|------|
| `services/sub2api_client.py` | Sub2API HTTP 客户端 |
| `automation/auto_google_login.py` | 一键登录自动化脚本 |
| `automation/auto_antigravity_oauth.py` | OAuth 自动化脚本 |
| `automation/batch_account_processor.py` | 批量处理器 |
| `gui/account_manager_gui.py` | 账号管理 GUI |

### 4.2 修改文件

| 文件路径 | 修改内容 |
|----------|----------|
| `services/database.py` | +6 字段, +6 方法 |
| `core/config_manager.py` | +Sub2API 配置项 |
| `gui/config_ui.py` | +Sub2API 设置 Tab |
| `gui/main_window.py` | +账号管理菜单入口 |

---

## 五、业务流程

### 5.1 一键登录流程

```
┌─────────────────────────────────────────────────────────────────┐
│                        一键登录流程                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. 选择账号                                                     │
│     └─→ 检查是否已绑定窗口                                       │
│     └─→ 未绑定 → 选择/创建窗口并绑定                             │
│                                                                  │
│  2. 打开浏览器窗口                                               │
│     └─→ 调用 ixBrowser API openBrowser()                        │
│                                                                  │
│  3. AI Agent 执行登录                                            │
│     └─→ 导航到 accounts.google.com                               │
│     └─→ 填写邮箱、密码                                           │
│     └─→ 处理 2FA（如有）                                         │
│                                                                  │
│  4. 验证登录成功                                                 │
│     └─→ 检测页面状态                                             │
│     └─→ 更新 login_status = 'logged_in'                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 Sub2API OAuth 流程

```
┌─────────────────────────────────────────────────────────────────┐
│                  账号添加到 Sub2API 流程                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. 前置检查                                                     │
│     └─→ sub2api_account_id 已存在？ → 跳过，提示"已关联"         │
│     └─→ 调用 Sub2API 检查邮箱是否已存在                          │
│                                                                  │
│  2. 执行登录（如未登录）                                         │
│     └─→ 登录失败？ → 终止，标记 login_status = 'login_failed'   │
│                                                                  │
│  3. 启动 OAuth 流程                                              │
│     └─→ POST /public/antigravity/oauth/start                    │
│     └─→ 获取 {auth_url, session_id, state}                      │
│                                                                  │
│  4. AI Agent 完成授权                                            │
│     └─→ 打开 auth_url                                           │
│     └─→ 自动完成授权流程                                         │
│     └─→ 监听 URL，提取 code 参数                                 │
│                                                                  │
│  5. 完成 OAuth                                                   │
│     └─→ POST /public/antigravity/oauth/complete                 │
│     └─→ 保存 sub2api_account_id                                 │
│     └─→ 更新 sub2api_status = 'linked'                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 5.3 状态定义

**登录状态 (login_status)**:

| 状态 | 说明 |
|------|------|
| `not_logged` | 未登录（默认） |
| `logging_in` | 登录中 |
| `logged_in` | 已登录 |
| `login_failed` | 登录失败 |

**Sub2API 状态 (sub2api_status)**:

| 状态 | 说明 |
|------|------|
| `not_linked` | 未关联（默认） |
| `linking` | OAuth 进行中 |
| `linked` | 已成功关联 |
| `oauth_failed` | OAuth 失败 |

---

## 六、实施时间线（精简版）

| 阶段 | 内容 | 预估时间 | 优先级 |
|------|------|----------|--------|
| 阶段 1 | 数据库扩展 | 1 小时 | P0 |
| 阶段 2 | 配置管理扩展 | 0.5 小时 | P0 |
| 阶段 3 | Sub2API 客户端 | 1.5 小时 | P0 |
| 阶段 4 | 自动化脚本 | 3 小时 | P0 |
| 阶段 5 | GUI 界面 | 2.5 小时 | P1 |
| 测试调试 | - | 1.5 小时 | P0 |

**总计**: 约 10 小时

---

## 七、风险与注意事项

### 7.1 技术风险

| 风险 | 缓解措施 |
|------|----------|
| Google 登录页面变化 | 定期更新 AI Agent 提示词 |
| OAuth 回调 URL 捕获 | 监听页面 URL 变化 |
| 并发登录被风控 | 控制并发数，添加随机延迟 |

### 7.2 安全注意

1. Sub2API admin_token 加密存储
2. 日志中不打印完整密码和 token

---

## 八、审批

**本方案已去除项目中已有的功能：**
- ~~账户批量导入~~ (已有)
- ~~批量创建窗口~~ (已有)
- ~~代理分配与绑定~~ (已有)
- ~~导入去重逻辑~~ (已有)

**保留需要新增的功能：**
- 🆕 一键登录
- 🆕 Sub2API 集成
- 🆕 OAuth 自动化
- 🆕 账号-窗口绑定
- 🆕 登录状态管理
- 🆕 账号管理 GUI

---

**等待批准后开始实施。**
