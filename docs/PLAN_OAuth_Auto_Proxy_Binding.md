# 实施计划：批量 OAuth 自动代理绑定

> **创建日期**: 2026-02-03
> **状态**: 待审批

## 需求描述

在批量 OAuth 过程中，自动完成以下操作：
1. 查询 Sub2API 的 IP 代理列表
2. 选择**关联账号数最少**的代理
3. 将 Sub2API 账号绑定到该代理
4. 更新 Sub2API 账号的备注为代理名称
5. 同步更新 ixBrowser 对应窗口的代理配置

---

## 架构分析

### 涉及的系统
1. **Sub2API 服务** (`D:\workspace\projects\sub2api`)
   - 代理管理 API
   - 账号更新 API
2. **ixBrowser 本地服务**
   - 窗口代理配置更新
3. **本项目** (`auto_bitbrowser2`)
   - Sub2API 客户端
   - 批量 OAuth 流程

### 需要调用的 API

#### Sub2API 端点
| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/v1/admin/proxies/all?with_count=true` | GET | 获取所有代理及其账号数 |
| `/api/v1/admin/accounts/:id` | PUT | 更新账号 (proxy_id, notes) |

#### ixBrowser SDK
| 函数 | 用途 |
|------|------|
| `update_profile_proxy()` | 更新窗口代理配置 |
| `update_profile(note=...)` | 更新窗口备注 |

---

## 实施步骤

### 阶段 1：扩展 Sub2API 客户端

**文件**: `services/sub2api_client.py`

新增方法：

```python
async def get_all_proxies_with_count(self) -> Sub2APIResponse:
    """
    获取所有代理及其关联账号数

    GET /api/v1/admin/proxies/all?with_count=true

    Returns:
        Sub2APIResponse 包含代理列表:
        [
            {
                "id": 1,
                "name": "US Proxy 1",
                "protocol": "http",
                "host": "proxy.example.com",
                "port": 8080,
                "username": "user",
                "password": "pass",
                "account_count": 5,
                "status": "active"
            }
        ]
    """

async def update_account(
    self,
    account_id: int,
    proxy_id: int = None,
    notes: str = None
) -> Sub2APIResponse:
    """
    更新账号信息 (代理绑定、备注)

    PUT /api/v1/admin/accounts/:id

    Args:
        account_id: Sub2API 账号 ID
        proxy_id: 要绑定的代理 ID
        notes: 账号备注
    """
```

### 阶段 2：创建代理智能分配服务

**新文件**: `services/proxy_smart_allocator.py`

```python
@dataclass
class ProxyInfo:
    """Sub2API 代理信息"""
    id: int
    name: str
    protocol: str  # http/https/socks5
    host: str
    port: int
    username: str
    password: str
    account_count: int
    status: str

class ProxySmartAllocator:
    """
    代理智能分配器

    功能:
    1. 从 Sub2API 获取代理列表
    2. 选择账号数最少的代理
    3. 绑定账号到代理
    4. 同步更新 ixBrowser 窗口代理
    """

    async def get_least_used_proxy(self) -> ProxyInfo:
        """获取关联账号数最少的代理"""

    async def bind_account_to_proxy(
        self,
        sub2api_account_id: int,
        proxy: ProxyInfo,
        browser_profile_id: str,
    ) -> bool:
        """
        将账号绑定到代理

        操作:
        1. 调用 Sub2API 更新账号 proxy_id
        2. 调用 Sub2API 更新账号 notes 为代理名称
        3. 调用 ixBrowser 更新窗口代理配置
        """
```

### 阶段 3：集成到 OAuth 流程

**文件**: `automation/auto_antigravity_oauth.py`

在 OAuth 完成后添加代理绑定逻辑：

```python
# OAuth 成功后
if oauth_result.success:
    # 1. 获取最少使用的代理
    allocator = ProxySmartAllocator(sub2api_client)
    proxy = await allocator.get_least_used_proxy()

    if proxy:
        # 2. 绑定代理到 Sub2API 账号
        # 3. 同步更新 ixBrowser 窗口代理
        await allocator.bind_account_to_proxy(
            sub2api_account_id=oauth_result.sub2api_account_id,
            proxy=proxy,
            browser_profile_id=browser_id,
        )
```

### 阶段 4：批量处理器集成

**文件**: `automation/batch_account_processor.py`

修改 `batch_oauth` 和 `_oauth_with_semaphore` 方法：

```python
async def batch_oauth(
    self,
    accounts: List[Dict],
    browser_ids: List[str],
    sub2api_client: Sub2APIClient = None,
    auto_bind_proxy: bool = True,  # 新增参数
    ...
) -> BatchResult:
```

### 阶段 5：GUI 配置选项

**文件**: `gui/account_manager_gui.py`

在工具栏添加配置选项：

```python
# 自动绑定代理复选框
self.chk_auto_bind_proxy = QCheckBox("自动绑定代理")
self.chk_auto_bind_proxy.setChecked(True)
self.chk_auto_bind_proxy.setToolTip("OAuth 成功后自动绑定到使用量最少的代理")
```

---

## 数据流示意图

```
[OAuth 成功]
     ↓
[调用 Sub2API: GET /proxies/all?with_count=true]
     ↓
[选择 account_count 最小的 proxy]
     ↓
[调用 Sub2API: PUT /accounts/:id]
  - proxy_id = 选中的代理 ID
  - notes = 代理名称
     ↓
[调用 ixBrowser SDK: update_profile_proxy()]
  - profile_id = browser_id
  - proxy_type = protocol
  - proxy_ip = host
  - proxy_port = port
  - proxy_user = username
  - proxy_password = password
     ↓
[完成]
```

---

## 文件修改清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `services/sub2api_client.py` | 修改 | 新增 2 个 API 方法 |
| `services/proxy_smart_allocator.py` | 新增 | 代理智能分配服务 |
| `automation/auto_antigravity_oauth.py` | 修改 | 集成代理绑定逻辑 |
| `automation/batch_account_processor.py` | 修改 | 添加 auto_bind_proxy 参数 |
| `gui/account_manager_gui.py` | 修改 | 添加配置开关 |

---

## 配置项

| 配置名 | 默认值 | 说明 |
|--------|--------|------|
| `oauth_auto_bind_proxy` | `true` | OAuth 成功后自动绑定代理 |

---

## 错误处理

1. **获取代理列表失败**: 记录日志，跳过代理绑定，不影响 OAuth 成功状态
2. **无可用代理**: 记录警告，跳过代理绑定
3. **代理绑定失败**: 记录错误，不影响 OAuth 成功状态
4. **ixBrowser 代理更新失败**: 记录错误，Sub2API 绑定仍然生效

---

## 日志输出示例

```
[OAuth] user@gmail.com: OAuth 成功，账号 ID: 12345
[ProxyBind] 获取代理列表成功，共 5 个代理
[ProxyBind] 选择代理: US Proxy 1 (账号数: 2/10)
[ProxyBind] 更新 Sub2API 账号代理绑定成功
[ProxyBind] 更新 ixBrowser 窗口代理成功
[OAuth] user@gmail.com: ✅ OAuth + 代理绑定完成
```

---

## 测试计划

1. **单元测试**
   - Sub2API 代理列表 API 调用
   - 最少使用代理选择算法
   - 账号更新 API 调用

2. **集成测试**
   - 完整 OAuth + 代理绑定流程
   - 多账号批量 OAuth 代理分配

3. **边界测试**
   - 无可用代理
   - 所有代理已满
   - API 连接失败

---

## 预估工时

| 阶段 | 预估时间 |
|------|----------|
| 阶段 1: Sub2API 客户端扩展 | 15 分钟 |
| 阶段 2: 代理智能分配服务 | 30 分钟 |
| 阶段 3: OAuth 流程集成 | 20 分钟 |
| 阶段 4: 批量处理器集成 | 15 分钟 |
| 阶段 5: GUI 配置选项 | 10 分钟 |
| 测试验证 | 15 分钟 |
| **总计** | **约 1.5 小时** |

---

## 待确认问题

1. **代理选择策略**: 仅按账号数排序，还是需要考虑其他因素（如延迟、国家等）？
2. **ixBrowser 备注同步**: 是否需要同时更新 ixBrowser 窗口的备注？
3. **并发安全**: 批量 OAuth 时多个账号同时选择代理，是否需要锁机制避免同一代理被过度分配？

---

**请审批后开始实施。**
