# 刷新家庭组信息（集成检测Pro）- 详细设计文档

> **创建日期**: 2026-02-XX
> **基于计划**: [PLAN_Refresh_Family_Info_With_Pro_Integration.md](./PLAN_Refresh_Family_Info_With_Pro_Integration.md)
> **实施方案**: 渐进式扩展（方案一）

---

## 1. 实施步骤总览

```
Phase 1: 数据库迁移
├── 1.1 accounts 表新增字段
├── 1.2 创建 account_refresh_tasks 任务主表
└── 1.3 创建 account_refresh_task_items 任务明细表

Phase 2: 数据层实现
├── 2.1 新增 AccountRefreshRepository
├── 2.2 更新 AccountRepository 新增字段方法
└── 2.3 DBManager 新增公开方法

Phase 3: 自动化层实现
├── 3.1 定义 AccountMembershipRefreshResult 结果类
├── 3.2 扩展 BatchAccountProcessor.batch_refresh_membership_info()
└── 3.3 实现家庭组详情检测逻辑

Phase 4: 应用层适配
├── 4.1 AutomationEngineAdapter 新增 task_type
├── 4.2 AccountTaskOrchestrator 新增编排入口
└── 4.3 兼容现有 detect_pro 入口

Phase 5: GUI 层实现
├── 5.1 新增"刷新家庭组信息"按钮
├── 5.2 修改"检测 Pro"按钮逻辑
├── 5.3 扩展表格列展示
└── 5.4 统一进度与日志

Phase 6: 测试与验证
├── 6.1 单元测试
├── 6.2 集成测试
└── 6.3 人工验收
```

---

## 2. Phase 1: 数据库迁移

### 2.1 accounts 表新增字段

在 `services/database.py` 的 `init_db()` 方法中添加：

```python
# ==================== 家庭组信息刷新扩展字段 ====================

# pro_plan_name: Pro 计划名称（如 "Premium 2TB"）
try:
    cursor.execute("ALTER TABLE accounts ADD COLUMN pro_plan_name TEXT DEFAULT ''")
except sqlite3.OperationalError:
    pass

# family_role: 家庭组角色（manager/member/none/unknown）
try:
    cursor.execute("ALTER TABLE accounts ADD COLUMN family_role TEXT DEFAULT 'unknown'")
except sqlite3.OperationalError:
    pass

# family_manager_email: 家庭组管理员邮箱
try:
    cursor.execute("ALTER TABLE accounts ADD COLUMN family_manager_email TEXT DEFAULT ''")
except sqlite3.OperationalError:
    pass

# has_family_group: 是否有家庭组（yes/no/unknown）
try:
    cursor.execute("ALTER TABLE accounts ADD COLUMN has_family_group TEXT DEFAULT 'unknown'")
except sqlite3.OperationalError:
    pass

# account_country: 账户所属国家
try:
    cursor.execute("ALTER TABLE accounts ADD COLUMN account_country TEXT DEFAULT ''")
except sqlite3.OperationalError:
    pass

# family_slots_left: 剩余家庭组位置（-1 表示不适用）
try:
    cursor.execute("ALTER TABLE accounts ADD COLUMN family_slots_left INTEGER DEFAULT -1")
except sqlite3.OperationalError:
    pass

# family_info_refreshed_at: 家庭组信息最后刷新时间
try:
    cursor.execute("ALTER TABLE accounts ADD COLUMN family_info_refreshed_at TIMESTAMP")
except sqlite3.OperationalError:
    pass

# family_info_refresh_error: 家庭组信息刷新错误
try:
    cursor.execute("ALTER TABLE accounts ADD COLUMN family_info_refresh_error TEXT")
except sqlite3.OperationalError:
    pass
```

### 2.2 创建任务主表 account_refresh_tasks

```python
# 创建账号刷新任务主表
cursor.execute('''
    CREATE TABLE IF NOT EXISTS account_refresh_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_type TEXT NOT NULL DEFAULT 'family_info_refresh',
        task_mode TEXT NOT NULL DEFAULT 'full',
        status TEXT NOT NULL DEFAULT 'pending',
        scope_type TEXT DEFAULT 'selected',
        total_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        progress_current INTEGER DEFAULT 0,
        progress_percent REAL DEFAULT 0.0,
        started_at TIMESTAMP,
        finished_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_by TEXT DEFAULT 'gui',
        note TEXT
    )
''')
```

### 2.3 创建任务明细表 account_refresh_task_items

```python
# 创建账号刷新任务明细表
cursor.execute('''
    CREATE TABLE IF NOT EXISTS account_refresh_task_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        error_message TEXT,
        is_pro TEXT,
        pro_plan_name TEXT,
        family_role TEXT,
        family_manager_email TEXT,
        has_family_group TEXT,
        family_member_count INTEGER,
        family_slots_left INTEGER,
        account_country TEXT,
        started_at TIMESTAMP,
        finished_at TIMESTAMP,
        FOREIGN KEY (task_id) REFERENCES account_refresh_tasks(id) ON DELETE CASCADE
    )
''')
```

---

## 3. Phase 2: 数据层实现

### 3.1 新增 AccountRefreshRepository

创建文件 `services/repositories/account_refresh_repository.py`：

```python
"""账号刷新任务仓库"""

from __future__ import annotations
from datetime import datetime
from typing import Callable, List, Optional
import threading


class AccountRefreshRepository:
    """账号刷新任务数据访问层"""

    @staticmethod
    def create_refresh_task(
        task_mode: str,
        total_count: int,
        connection_factory: Callable,
        db_lock: threading.Lock,
    ) -> int:
        """创建刷新任务，返回任务ID"""
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()
            cursor.execute('''
                INSERT INTO account_refresh_tasks
                (task_type, task_mode, status, total_count, started_at)
                VALUES (?, ?, 'running', ?, ?)
            ''', ('family_info_refresh', task_mode, total_count, datetime.now()))
            task_id = cursor.lastrowid
            conn.commit()
            conn.close()
            return task_id

    @staticmethod
    def create_task_items(
        task_id: int,
        emails: List[str],
        connection_factory: Callable,
        db_lock: threading.Lock,
    ):
        """批量创建任务明细"""
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()
            for email in emails:
                cursor.execute('''
                    INSERT INTO account_refresh_task_items (task_id, email, status)
                    VALUES (?, ?, 'pending')
                ''', (task_id, email))
            conn.commit()
            conn.close()

    @staticmethod
    def update_task_item(
        task_id: int,
        email: str,
        status: str,
        result: dict,
        connection_factory: Callable,
        db_lock: threading.Lock,
    ):
        """更新单条任务明细"""
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()
            cursor.execute('''
                UPDATE account_refresh_task_items SET
                    status = ?,
                    error_message = ?,
                    is_pro = ?,
                    pro_plan_name = ?,
                    family_role = ?,
                    family_manager_email = ?,
                    has_family_group = ?,
                    family_member_count = ?,
                    family_slots_left = ?,
                    account_country = ?,
                    finished_at = ?
                WHERE task_id = ? AND email = ?
            ''', (
                status,
                result.get('error_message'),
                result.get('is_pro'),
                result.get('pro_plan_name'),
                result.get('family_role'),
                result.get('family_manager_email'),
                result.get('has_family_group'),
                result.get('family_member_count'),
                result.get('family_slots_left'),
                result.get('account_country'),
                datetime.now(),
                task_id,
                email,
            ))
            conn.commit()
            conn.close()

    @staticmethod
    def finish_task(
        task_id: int,
        status: str,
        success_count: int,
        failed_count: int,
        connection_factory: Callable,
        db_lock: threading.Lock,
    ):
        """完成任务"""
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()
            cursor.execute('''
                UPDATE account_refresh_tasks SET
                    status = ?,
                    success_count = ?,
                    failed_count = ?,
                    progress_current = total_count,
                    progress_percent = 100.0,
                    finished_at = ?
                WHERE id = ?
            ''', (status, success_count, failed_count, datetime.now(), task_id))
            conn.commit()
            conn.close()
```

### 3.2 更新 AccountRepository

在 `services/repositories/account_repository.py` 中新增：

```python
@staticmethod
def update_membership_info(
    email: str,
    is_pro: str,
    pro_plan_name: str,
    family_role: str,
    family_manager_email: str,
    has_family_group: str,
    family_member_count: int,
    family_slots_left: int,
    account_country: str,
    error_message: str | None,
    connection_factory: Callable,
    db_lock: threading.Lock,
):
    """更新账号会员信息"""
    with db_lock:
        conn = connection_factory()
        cursor = conn.cursor()
        cursor.execute('''
            UPDATE accounts SET
                is_pro = ?,
                pro_plan_name = ?,
                family_role = ?,
                family_manager_email = ?,
                has_family_group = ?,
                family_member_count = ?,
                family_slots_left = ?,
                account_country = ?,
                family_info_refresh_error = ?,
                family_info_refreshed_at = ?,
                updated_at = ?
            WHERE email = ?
        ''', (
            is_pro,
            pro_plan_name,
            family_role,
            family_manager_email,
            has_family_group,
            family_member_count,
            family_slots_left,
            account_country,
            error_message,
            datetime.now(),
            datetime.now(),
            email,
        ))
        conn.commit()
        conn.close()
```

---

## 4. Phase 3: 自动化层实现

### 4.1 定义结果类

在 `automation/batch_account_processor.py` 中新增：

```python
@dataclass
class AccountMembershipRefreshResult:
    """账号会员信息刷新结果"""
    email: str
    is_pro: str = "unknown"  # yes/no/family_yes/detection_failed
    membership_type: str = "unknown"  # regular/family/none/unknown
    pro_plan_name: str = ""
    family_role: str = "unknown"  # manager/member/none/unknown
    has_family_group: str = "unknown"  # yes/no/unknown
    family_manager_email: str = ""
    family_member_count: int = 0
    family_slots_left: int = -1
    account_country: str = ""
    error_message: str = ""
    success: bool = False

    def to_dict(self) -> dict:
        return asdict(self)
```

### 4.2 扩展 batch_refresh_membership_info

```python
async def batch_refresh_membership_info(
    self,
    accounts: List[Dict],
    browser_ids: List[str],
    mode: str = "full",  # "pro_only" | "full"
) -> BatchResult:
    """
    批量刷新会员信息

    Args:
        accounts: 账号列表
        browser_ids: 浏览器窗口 ID 列表
        mode:
            - "pro_only": 仅检测 Pro 状态（兼容现有逻辑）
            - "full": 完整刷新（Pro + 家庭组 + 国家）
    """
    if len(accounts) != len(browser_ids):
        raise ValueError("账号数量与浏览器窗口数量不匹配")

    result = BatchResult(total=len(accounts))
    result.start_time = datetime.now()
    self._stop_flag = False
    self._semaphore = asyncio.Semaphore(self.concurrency)

    mode_text = "完整刷新" if mode == "full" else "Pro 检测"
    self._log(f"开始批量{mode_text}，共 {len(accounts)} 个账号，并发数 {self.concurrency}")

    # 如果是 full 模式，创建任务记录
    task_id = None
    if mode == "full":
        task_id = DBManager.create_refresh_task(
            task_mode=mode,
            total_count=len(accounts),
        )
        emails = [a.get("email", "") for a in accounts]
        DBManager.create_refresh_task_items(task_id, emails)

    # 创建任务
    tasks = []
    for account, browser_id in zip(accounts, browser_ids):
        task = self._refresh_membership_with_semaphore(
            account=account,
            browser_id=browser_id,
            mode=mode,
            task_id=task_id,
            result=result,
        )
        tasks.append(task)

    # 并发执行
    await asyncio.gather(*tasks, return_exceptions=True)

    result.end_time = datetime.now()

    # 统计
    pro_count = sum(1 for r in result.results if r.get("status") == "success" and r.get("data", {}).get("is_pro") == "yes")
    family_pro_count = sum(1 for r in result.results if r.get("status") == "success" and r.get("data", {}).get("is_pro") == "family_yes")
    non_pro_count = sum(1 for r in result.results if r.get("status") == "success" and r.get("data", {}).get("is_pro") == "no")

    self._log(
        f"批量{mode_text}完成: Pro {pro_count}, Pro(家庭组) {family_pro_count}, 非Pro {non_pro_count}, "
        f"失败 {result.failed_count}, 耗时 {result.duration_seconds:.1f}s"
    )

    # 更新任务状态
    if task_id:
        DBManager.finish_refresh_task(
            task_id=task_id,
            status="completed" if not self._stop_flag else "stopped",
            success_count=result.success_count,
            failed_count=result.failed_count,
        )

    # 添加统计摘要
    result.results.append({
        "_summary": True,
        "pro_count": pro_count + family_pro_count,
        "pro_regular_count": pro_count,
        "pro_family_count": family_pro_count,
        "non_pro_count": non_pro_count,
    })

    return result
```

---

## 5. Phase 4: 应用层适配

### 5.1 AutomationEngineAdapter 新增 task_type

在 `application/automation_engine_adapter.py` 的 `run_account_worker_task` 中添加：

```python
if task_type == "refresh_membership_info":
    mode = kwargs.get("mode", "full")
    result = await processor.batch_refresh_membership_info(
        accounts=list(accounts),
        browser_ids=list(browser_ids),
        mode=mode,
    )
    return {"type": "refresh_membership_info", "result": result.to_dict()}

# 兼容现有 detect_pro，内部转发
if task_type == "detect_pro":
    result = await processor.batch_refresh_membership_info(
        accounts=list(accounts),
        browser_ids=list(browser_ids),
        mode="pro_only",
    )
    return {"type": "detect_pro", "result": result.to_dict()}
```

---

## 6. Phase 5: GUI 层实现

### 5.1 新增"刷新家庭组信息"按钮

在 `gui/account_manager_interface.py` 的 `_createToolbar` 方法中，在"检测 Pro"按钮后添加：

```python
# 刷新家庭组信息
self.btnRefreshFamilyInfo = PushButton(FIF.UPDATE, "刷新家庭组", self)
self.btnRefreshFamilyInfo.setToolTip("刷新选中账号的完整会员信息（Pro状态、家庭组、国家）")
self.btnRefreshFamilyInfo.clicked.connect(self.onRefreshFamilyInfo)
toolbar1Layout.addWidget(self.btnRefreshFamilyInfo)
```

### 5.2 实现刷新方法

```python
def onRefreshFamilyInfo(self):
    """刷新家庭组信息（full 模式）"""
    selected = self._getSelectedAccounts()
    if not selected:
        InfoBar.warning(
            title="提示",
            content="请先选择要刷新的账号",
            parent=self,
            position=InfoBarPosition.TOP,
        )
        return

    # 筛选已登录账号
    logged_in = [a for a in selected if a.get("login_status") == "logged"]
    if not logged_in:
        InfoBar.warning(
            title="提示",
            content="请选择已登录的账号",
            parent=self,
        )
        return

    browser_ids = [a.get("browser_profile_id", "") for a in logged_in]

    self._startWorkerTask(
        task_type="refresh_membership_info",
        accounts=logged_in,
        browser_ids=browser_ids,
        mode="full",
    )
```

---

## 7. 测试计划

### 7.1 单元测试

| 测试用例 | 描述 |
|----------|------|
| test_create_refresh_task | 创建任务主表记录 |
| test_create_task_items | 创建任务明细记录 |
| test_update_membership_info | 更新账号会员信息字段 |
| test_calculate_family_slots | 验证剩余位置计算逻辑 |

### 7.2 集成测试

| 测试场景 | 预期结果 |
|----------|---------|
| pro_only 模式回归 | 结果与现有 detect_pro 一致 |
| full 模式普通 Pro | 写入 family_role=manager, family_slots_left=5 |
| full 模式家庭组 Pro | 写入 family_role=member, family_manager_email |
| 用户停止任务 | 任务状态变为 stopped |

---

## 8. 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| 家庭组页面结构变化 | 使用 StagehandGoogleEngine AI 识别 |
| 国家提取失败 | 写入 `unknown`，不阻塞任务 |
| 任务中断数据不一致 | 明细表记录每条状态 |

---

*文档版本: v1.0*
