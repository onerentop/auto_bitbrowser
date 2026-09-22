# Google账号管理：刷新家庭组信息（集成检测Pro）实施计划

## 1. 目标摘要

将现有“检测Pro”能力并入“刷新家庭组信息”任务，形成统一批量任务链。一次刷新后可获取：

- 是否为 Pro 会员
- 会员类型（普通 Pro / 家庭组 Pro）
- 是否创建/拥有家庭组
- 若加入家庭组，显示加入谁的家庭组（管理员邮箱）
- 若为普通 Pro，显示剩余家庭组位置数
- 账户所属国家
- 批量任务状态、进度、失败详情（持久化）

---

## 2. 已确认决策

- 刷新范围：仅选中账号
- 任务记录：数据库任务表
- 国家口径：Google 账号主页国家

---

## 3. 核心集成策略

### 3.1 统一任务链

- Step1：检测 Pro（复用现有 detect_pro 核心能力）
- Step2：检测家庭组信息（仅对 Pro 相关账号深入）
- Step3：提取账户所属国家
- Step4：回写账号字段 + 更新任务明细

### 3.2 兼容现有按钮

- 保留“检测Pro”按钮，但内部改为统一任务的 `pro_only` 模式
- 新增“刷新家庭组信息”按钮，执行统一任务的 `full` 模式

这样既不破坏旧入口，又避免维护两套重复流程。

### 3.3 统一结果结构

新增统一结果对象 `AccountMembershipRefreshResult`：

- `email`
- `is_pro`（`yes/no/family_yes/detection_failed`）
- `membership_type`（`regular/family/none/unknown`）
- `pro_plan_name`
- `family_role`（`manager/member/none/unknown`）
- `has_family_group`（`yes/no/unknown`）
- `family_manager_email`
- `family_member_count`
- `family_slots_left`
- `account_country`
- `error_message`

---

## 4. 数据模型设计

### 4.1 `accounts` 扩展字段

沿用现有：

- `is_pro`
- `family_member_count`
- `family_sharing_enabled`

新增：

- `pro_plan_name TEXT DEFAULT ''`
- `family_role TEXT DEFAULT 'unknown'`
- `family_manager_email TEXT DEFAULT ''`
- `has_family_group TEXT DEFAULT 'unknown'`
- `account_country TEXT DEFAULT ''`
- `family_slots_left INTEGER DEFAULT -1`
- `family_info_refreshed_at TIMESTAMP`
- `family_info_refresh_error TEXT`

### 4.2 任务主表 `account_refresh_tasks`

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `task_type TEXT`（固定 `family_info_refresh`）
- `task_mode TEXT`（`pro_only/full`）
- `status TEXT`（`pending/running/completed/failed/stopped`）
- `scope_type TEXT`（`selected`）
- `total_count INTEGER`
- `success_count INTEGER`
- `failed_count INTEGER`
- `progress_current INTEGER`
- `progress_percent REAL`
- `started_at TIMESTAMP`
- `finished_at TIMESTAMP`
- `created_by TEXT DEFAULT 'gui'`
- `note TEXT`

### 4.3 任务明细表 `account_refresh_task_items`

- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `task_id INTEGER`（FK -> `account_refresh_tasks.id`）
- `email TEXT`
- `status TEXT`（`pending/running/success/failed/skipped`）
- `error_message TEXT`
- `is_pro TEXT`
- `family_role TEXT`
- `family_manager_email TEXT`
- `has_family_group TEXT`
- `family_member_count INTEGER`
- `family_slots_left INTEGER`
- `account_country TEXT`
- `started_at TIMESTAMP`
- `finished_at TIMESTAMP`

---

## 5. 业务判定规则

- 是否 Pro：`is_pro in ('yes', 'family_yes')`
- 会员类型：
  - `is_pro='yes'` => 普通 Pro
  - `is_pro='family_yes'` => 家庭组 Pro
  - 其他 => 非 Pro/未知
- 是否创建/拥有家庭组：`family_role='manager' 且 has_family_group='yes'`
- 加入了谁的家庭组：优先 `family_manager_email`，为空时从成员列表推断 manager 邮箱
- 普通 Pro 剩余位置：`family_slots_left = max(0, 6 - max(family_member_count, 1))`
- 家庭组 Pro 剩余位置：`family_slots_left = -1`（不适用）
- 国家：按 Google 账号主页提取，失败写 `unknown`

---

## 6. 代码改造点

### 6.1 `automation/batch_account_processor.py`

- 新增/改造 `batch_refresh_membership_info(..., mode='pro_only'|'full')`
- 复用现有 `batch_detect_pro` 内核，不复制核心检测逻辑

### 6.2 `application/automation_engine_adapter.py`

- 新增 `task_type='refresh_membership_info'`
- 兼容 `task_type='detect_pro'`，内部转发到 `refresh_membership_info(mode='pro_only')`

### 6.3 `application/account_task_orchestrator.py`

- 新增统一编排入口 `execute_refresh_membership_worker_task(...)`
- 输出兼容统计字段：
  - `pro_regular_count`
  - `pro_family_count`
  - `non_pro_count`
  - `failed_count`
  - `full_refresh_success_count`（仅 full 模式）

### 6.4 `services/database.py` / `services/repositories/account_repository.py`

- 新增任务主表/明细表 CRUD
- 新增账号刷新字段更新方法 `update_account_membership_info(...)`

### 6.5 `gui/account_manager_interface.py`

- 保留“检测Pro”按钮，切到 `pro_only` 模式
- 新增“刷新家庭组信息”按钮，走 `full` 模式
- 统一进度条、日志、任务完成提示
- 增加字段展示：会员类型、家庭组状态、管理员、剩余位置、所属国家、刷新时间

---

## 7. 测试与验收

### 7.1 单元测试

- `AccountRepository`：新增字段与任务表 CRUD
- 规则测试：Pro 类型判定、剩余位置计算、管理员邮箱回填
- 进度测试：`total/success/failed/progress_percent` 一致性

### 7.2 集成测试

- `pro_only` 模式回归：结果与当前“检测Pro”能力一致
- `full` 模式：可写入家庭组详情、国家、错误信息
- 停止任务：状态收敛为 `stopped`

### 7.3 人工验收场景

- 普通 Pro（有家庭组）
- 家庭组 Pro（显示管理员）
- 非 Pro 账号
- 国家提取失败（unknown + 错误记录）

---

## 8. 实施顺序

1. 数据库迁移：`accounts` 扩展 + 任务双表创建
2. 抽取并复用现有 detect_pro 内核到统一刷新函数
3. 接入 orchestrator/adapter 统一任务入口
4. GUI：检测Pro改造为 `pro_only`，新增 `full` 刷新入口
5. 完成测试与回归验证

---

## 9. 默认假设

- 执行范围：仅选中账号
- 任务记录：数据库持久化
- 国家来源：Google账号主页
- 家庭组上限：6 人（与现有逻辑一致）
- 老“检测Pro”入口保留且行为兼容

