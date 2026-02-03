# 批量解决 Antigravity 403 错误 - 实施方案 v2

> **创建时间**: 2025-02-03
> **状态**: 待实施
> **优先级**: 高

## 🎯 需求概述

| 项目 | 内容 |
|------|------|
| **问题** | Antigravity 平台测试连接返回 403，需要手机号验证 |
| **解决方案** | 通过 SMS-Bus 接码平台自动完成 Google 手机验证 |
| **触发条件** | Sub2API 返回 `code=403` 且 `reason=VALIDATION_REQUIRED` |
| **完成标准** | 验证成功，账户解锁，号码自动释放 |

---

## 📊 核心数据结构

### 403 响应格式
```json
{
  "error": {
    "code": 403,
    "details": [{
      "reason": "VALIDATION_REQUIRED",
      "metadata": {
        "validation_url": "https://accounts.google.com/signin/continue?..."
      }
    }]
  }
}
```

**提取路径**: `error.details[0].metadata.validation_url`

---

## 🏗️ 模块设计

### 1. SMS-Bus 客户端 (`services/sms_bus_client.py`) ✅ 已创建

| 方法 | 说明 |
|------|------|
| `get_balance()` | 查询余额 |
| `list_countries()` | 获取国家列表 |
| `list_projects()` | 获取服务列表 |
| `get_cheapest_prices(project_id, country_ids, limit)` | 获取最便宜的选项 ⭐ |
| `get_number(country_id, project_id, prefer_cheapest)` | 获取手机号 |
| `wait_for_sms(request_id, timeout, interval)` | 轮询等待验证码 |
| `cancel_request(request_id)` | 释放号码 |

---

### 2. 403 解锁自动化 (`automation/auto_unlock_403.py`) 📝 待创建

```python
@dataclass
class UnlockResult:
    success: bool
    message: str
    email: str
    phone_used: str = ""
    attempts: int = 0              # 尝试次数
    error_type: Optional[str] = None

async def auto_unlock_403(
    browser_id: str,
    account: dict,
    validation_url: str,
    sms_client: SMSBusClient,
    country_id: int = None,        # None = 自动选最便宜
    project_id: int = None,        # None = Google
    max_retries: int = 2,          # 最大重试次数
    callback: Callable = None,
    api_key: str = None,
    model: str = None,
    provider: str = None,
) -> UnlockResult
```

**执行流程**:
```
┌─────────────────────────────────────────────────────────────────┐
│  循环（最多 max_retries + 1 次）                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. 获取手机号                                                   │
│     └─► SMS-Bus: get_number(prefer_cheapest=True)               │
│                                                                 │
│  2. 浏览器打开验证页面                                            │
│     └─► page.goto(validation_url)                               │
│                                                                 │
│  3. AI Agent 操作                                                │
│     └─► 点击 "Verify your phone number"                         │
│     └─► 填入手机号                                               │
│     └─► 点击发送验证码                                           │
│                                                                 │
│  4. 等待验证码                                                   │
│     └─► SMS-Bus: wait_for_sms(timeout=120s)                     │
│         ├─► 收到验证码 → 继续                                    │
│         └─► 超时 → 释放号码 → 重试                               │
│                                                                 │
│  5. AI Agent 填入验证码                                          │
│     └─► 填入 6 位验证码                                          │
│     └─► 等待验证结果                                             │
│                                                                 │
│  6. 结果处理                                                     │
│     ├─► 成功 → 释放号码 → 返回成功                               │
│     └─► 失败 → 释放号码 → 重试或返回失败                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### 3. Sub2API 客户端更新 (`services/sub2api_client.py`) 📝 待修改

新增方法：
```python
async def wake_and_check_403(self, account_id: int) -> Sub2APIResponse:
    """
    唤醒账户并检测 403 状态

    Returns:
        success=True: 正常
        success=False + data.needs_unlock=True: 需要验证
            data.validation_url = 验证链接
    """

@staticmethod
def extract_validation_url(error_response: dict) -> Optional[str]:
    """从 403 响应提取验证链接"""
```

---

### 4. 批量处理器更新 (`automation/batch_account_processor.py`) 📝 待修改

新增方法：
```python
async def batch_unlock_403(
    self,
    accounts: List[Dict],
    browser_ids: List[str],
    sms_token: str = None,
    country_id: int = None,
    project_id: int = None,
    max_retries: int = 2,
    api_key: str = None,
    model: str = None,
    provider: str = None,
) -> BatchResult:
    """
    批量解锁 403 账户

    对每个账户:
    1. 调用 Sub2API wake 检测 403
    2. 如果需要解锁，调用 auto_unlock_403
    3. 成功 → 关闭窗口
    4. 失败 → 保留窗口
    """
```

---

### 5. 数据库更新 (`services/database.py`) 📝 待修改

```sql
-- accounts 表新增字段
ALTER TABLE accounts ADD COLUMN unlock_status TEXT DEFAULT 'none';
-- 状态值: none / needs_unlock / unlocked / unlock_failed
```

新增方法：
```python
def update_unlock_status(email: str, status: str) -> None
def get_accounts_by_unlock_status(status: str) -> List[dict]
```

---

### 6. 账户管理 GUI 更新 (`gui/account_manager_gui.py`) 📝 待修改

在现有界面中添加：
```
┌─────────────────────────────────────────────────────────────────┐
│  账户管理                                                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [现有功能...]                                                   │
│                                                                 │
│  ════════════════════════════════════════════════════════════   │
│                                                                 │
│  🔓 403 解锁设置                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ SMS-Bus Token: [________________________] [保存]          │  │
│  │                                                           │  │
│  │ 国家: [▼ 自动选择最便宜 ]  服务: [▼ Google ]              │  │
│  │                                                           │  │
│  │ [🔍 检测 403 账户]  [🔓 批量解锁]                          │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  需要解锁的账户 (3):                                             │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☑ user1@gmail.com    needs_unlock                        │  │
│  │ ☑ user2@gmail.com    needs_unlock                        │  │
│  │ ☐ user3@gmail.com    unlock_failed (重试)                │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

功能按钮：
| 按钮 | 功能 |
|------|------|
| 检测 403 账户 | 批量调用 wake 接口，识别需要解锁的账户 |
| 批量解锁 | 对选中账户执行解锁流程 |

---

### 7. 配置更新 (`core/config_manager.py`) 📝 待修改

```json
{
  "sms_bus": {
    "token": "",
    "default_country_id": null,
    "default_project_id": null,
    "sms_timeout": 120,
    "sms_poll_interval": 5,
    "max_retries": 2
  }
}
```

---

## 📁 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `services/sms_bus_client.py` | ✅ 已创建 | SMS-Bus API 客户端 |
| `automation/auto_unlock_403.py` | 📝 创建 | 403 解锁自动化脚本 |
| `services/sub2api_client.py` | 📝 修改 | 添加 wake_and_check_403、extract_validation_url |
| `automation/batch_account_processor.py` | 📝 修改 | 添加 batch_unlock_403 |
| `services/database.py` | 📝 修改 | 添加 unlock_status 字段和方法 |
| `gui/account_manager_gui.py` | 📝 修改 | 集成 403 解锁功能 |
| `core/config_manager.py` | 📝 修改 | 添加 sms_bus 配置项 |

---

## 🔄 号码释放策略

```
┌─────────────────────────────────────────────────────────────────┐
│                      号码释放决策                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  获取号码 → 发送验证码 → 等待接收                                 │
│                           │                                     │
│              ┌────────────┴────────────┐                        │
│              │                         │                        │
│              ▼                         ▼                        │
│         收到验证码               超时未收到                       │
│              │                         │                        │
│              ▼                         ▼                        │
│         填入验证                  释放号码 ✓                      │
│              │                         │                        │
│      ┌───────┴───────┐                 │                        │
│      │               │                 │                        │
│      ▼               ▼                 ▼                        │
│   验证成功       验证失败          重试 (换号)                    │
│      │               │                                          │
│      ▼               ▼                                          │
│  释放号码 ✓     释放号码 ✓                                        │
│      │               │                                          │
│      ▼               ▼                                          │
│   返回成功      重试或返回失败                                    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

总结: 无论成功还是失败，号码都会被释放
```

---

## 📊 状态流转

```
unlock_status 状态流转:

  none ──────────────────────────────────────┐
    │                                         │
    ▼                                         │
  needs_unlock ◄── (wake 检测到 403)          │
    │                                         │
    ▼                                         │
  unlocking ◄── (开始解锁)                    │
    │                                         │
    ├──► unlocked ─────► (可继续 OAuth) ──────┘
    │
    └──► unlock_failed ──► (已重试2次仍失败)
              │
              └──► (人工处理或再次批量重试)
```

---

## 🧪 AI Agent 提示词

### 发送验证码阶段
```python
UNLOCK_403_PROMPT = """
你是一个专业的浏览器自动化助手，需要完成 Google 账户手机验证。

## 账号信息
- 邮箱: {email}
- 验证手机号: {phone_number}

## 任务目标
完成手机号验证，解除账户 403 限制。

## 操作步骤

### 1. 选择验证方式
- 页面显示 "Verify your info to continue" 或 "Choose a way to verify"
- 点击 "Verify your phone number" 选项
- 不要选择 "Scan QR code"

### 2. 输入手机号
- 在输入框填入手机号: {phone_number}
- 格式已包含国家代码（如 +1...）
- 点击 "Send" 或 "Next" 发送验证码

### 3. 发送成功后
- 看到验证码输入页面时，报告 NEED_VERIFICATION
- 等待外部提供验证码

## 成功标准
- 验证码已发送，进入验证码输入页面

## 注意事项
- 如果提示手机号无效，报告 ERROR
- 如果需要选择国家代码，确保与手机号匹配
"""
```

### 输入验证码阶段
```python
ENTER_CODE_PROMPT = """
## 任务
输入验证码完成验证

## 验证码
{sms_code}

## 操作
1. 在验证码输入框填入: {sms_code}
2. 点击 "Verify" 或 "Next"
3. 等待验证结果

## 成功标准
- 页面显示验证成功
- 或跳转到正常页面

## 失败情况
- 如果提示验证码错误，报告 ERROR
"""
```

---

## ⏱️ 时间估算

| 模块 | 预计时间 |
|------|---------|
| `auto_unlock_403.py` | 30 分钟 |
| `sub2api_client.py` 修改 | 10 分钟 |
| `batch_account_processor.py` 修改 | 15 分钟 |
| `database.py` 修改 | 10 分钟 |
| `account_manager_gui.py` 修改 | 20 分钟 |
| `config_manager.py` 修改 | 5 分钟 |
| **总计** | **~90 分钟** |

---

## ✅ 确认事项

- [x] GUI 集成到账户管理界面
- [x] 失败后最多重试 2 次
- [x] 验证成功自动释放号码
- [x] 验证失败也释放号码（换号重试）
- [x] 不需要费用统计

---

## 📝 备注

- SMS-Bus API 文档: https://sms-bus.com/docs
- 优先获取最便宜的手机号
- 支持自定义国家和服务
