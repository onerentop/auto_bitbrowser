# 架构改造执行计划（保存版）

> 更新时间：2026-02-11
> 状态：执行中（Phase 5）

## 1. 背景与目标

当前仓库分层方向正确（`gui/`、`automation/`、`core/`、`services/`），但存在边界不硬、超大文件聚合职责的问题。

本计划目标：

1. 先稳住现有业务可用性，不做一次性大重构。
2. 通过分阶段改造，逐步收敛耦合与维护成本。
3. 每个阶段都可验收、可回滚。

---

## 2. 分阶段路线

### Phase 1：边界收口与基线治理（进行中）

- [x] 增强敏感配置统一读写与迁移（`ConfigManager`）
- [x] GUI 敏感配置入口统一走安全接口
- [x] 增加最小安全回归测试
- [x] 新增开发测试依赖清单（`requirements-dev.txt`）
- [x] 修正文档中的错误启动命令
- [x] 引入应用服务层骨架并迁移 1 条 GUI -> 服务调用链

验收标准：

- 敏感配置不再出现明文旁路写入。
- 关键配置逻辑具备最小自动化回归。
- 新增功能优先下沉服务层，不继续向 GUI 堆叠业务逻辑。

### Phase 2：数据层拆分（进行中）

- 拆分 `services/database.py` 为仓储模块（账号/代理/卡片/历史）。
- 保留兼容 Facade，避免一次性改穿全项目。

执行进度（2026-02-09）：

- [x] 新增 `services/repositories/` 仓储层目录与导出入口
- [x] 新增 `AccountRepository`，承接账号核心查询/删除/可用 Pro 查询/待解锁查询
- [x] `DBManager` 对以上方法改为兼容委托（调用方无感）
- [x] 新增 `tests/test_account_repository.py`，覆盖仓储纯 SQL 过滤逻辑
- [x] 新增 `CardRepository` 与 `ProxyRepository`，下沉卡片/代理核心 CRUD 与统计 SQL
- [x] `DBManager` 对卡片/代理核心方法改为兼容委托（调用方无感）
- [x] 新增 `tests/test_card_repository.py` 与 `tests/test_proxy_repository.py`
- [x] 新增 `HistoryRepository`，下沉手机号/邮箱/2SV/验证器/SheerID/绑卡历史方法
- [x] 新增 `RecoveryEmailRepository`，下沉辅助邮箱池/每日用量/绑定关系方法
- [x] `DBManager` 对历史记录与恢复邮箱池核心方法改为兼容委托（调用方无感）
- [x] 新增 `tests/test_history_repository.py` 与 `tests/test_recovery_email_repository.py`
- [x] 扩展 `AccountRepository`，下沉 Sub2API / 登录状态 / 解锁状态 / 家庭组状态核心方法
- [x] `DBManager` 对以上方法改为兼容委托（调用方无感）
- [x] 新增 `tests/test_account_repository_status.py` 覆盖状态迁移核心分支
- [x] 拆分导入/导出与综合查询查询聚合逻辑（保留兼容 Facade）

验收标准：

- 新增数据访问全部走仓储层。
- `database.py` 职责显著收敛。

### Phase 3：GUI 瘦身（执行中）

- 将流程编排下沉至 `application/`。
- GUI 仅负责交互与展示。

验收标准：

- 关键 GUI 文件复杂度下降，业务分支从界面层移除。

执行进度（2026-02-10）：

- [x] Fluent 任务界面 `kickdevices/modify2sv/modifyauth/replaceemail/replacephone/sheerlink` 调用入口统一改为 `AutomationEngineAdapter`
- [x] Fluent 主界面已覆盖核心业务流程，旧版 `*_gui.py` 迁移完成

### Phase 4：自动化引擎统一（执行中）

- 统一自动化主入口与适配层，减少双轨维护负担。

验收标准：

- 批处理链路仅依赖统一适配接口。

执行进度（2026-02-10）：

- [x] 新增 `application/automation_engine_adapter.py` 统一承接 automation / sub2api 外部调用
- [x] `AccountTaskOrchestrator` 改造为优先依赖 `AutomationEngineAdapter`
- [x] 下线旧版 GUI 入口：`main.py` 移除 `--legacy` 启动路径，仅保留 Fluent 主入口
- [x] 移除旧版窗口文件：`main_window.py`、`account_manager_gui.py` 及历史 `*_gui.py` 功能窗口
- [x] 新增 `application/sub2api_settings_service.py`，下沉 Sub2API/SMS-Bus 设置读写与 Token 掩码逻辑
- [x] `gui/config_ui.py` 的 Sub2API/SMS-Bus 配置入口改为通过 `Sub2APISettingsService`
- [x] `gui/sheerid_interface.py` 改为通过 `SheerIDService` 读写 API Key，移除界面层直接依赖
- [x] `gui/setting_interface.py` 的提供商连接测试配置解析改为通过 `SettingsService`
- [x] `AutomationEngineAdapter` 收敛为 Fluent 在用入口，移除旧版 GUI 兼容入口

### Phase 5：测试与可观测性（持续）

- 建立单元/集成/冒烟分层。
- 统一日志字段与故障定位路径。

执行进度（2026-02-10）：

- [x] 扩展 `tests/test_account_task_orchestrator.py` 覆盖停止分支、异常兜底与适配层调用路径
- [x] 新增 `tests/test_account_io_repository.py` 覆盖综合查询仓储分支
- [x] 新增 `tests/test_sub2api_settings_service.py` 覆盖掩码规则核心分支
- [x] 新增 `tests/test_sheerid_service.py` 覆盖 SheerIDService 基础分支
- [x] 扩展 `tests/test_settings_service.py` 覆盖提供商运行时配置解析分支
- [x] 持续执行 compileall + python 烟测（pytest 环境缺失时的兜底验证）

---

## 3. 执行原则

1. **兼容优先**：先引入新层，再迁移调用，最后清理旧入口。
2. **小步提交**：每步变更可单独回滚。
3. **先验证后扩散**：先迁移一个典型链路，验证稳定后复制到其他模块。

---

## 4. 本轮执行项（已保存）

本轮执行聚焦：

1. 建立 `application/` 层骨架。
2. 迁移 `SheerIDInterface` 的账号加载与验证成功更新链路到应用服务。
3. 保持业务行为不变，仅调整调用边界。

### 执行进度（2026-02-09）

- [x] 新增 `application/sheerid_service.py`
- [x] `gui/sheerid_interface.py` 改为通过 `SheerIDService` 加载账号与写入验证结果
- [x] 新增 `application/settings_service.py`
- [x] `gui/setting_interface.py` 的 `_loadConfig/_saveConfig/_onSelectDataDir` 改为通过 `SettingsService`
- [x] `gui/config_ui.py` 的 `load_settings/save_settings` 改为通过 `SettingsService`
- [x] 新增 `application/account_manager_service.py`，迁移账号管理界面的选中账号解析与缺失窗口校验逻辑
- [x] 继续迁移账号管理界面的批量绑定窗口匹配与批量删除确认文案生成逻辑
- [x] 迁移账号管理界面的家庭组候选筛选、分配与预览文案生成逻辑
- [x] 迁移账号管理界面的任务冲突统一校验（普通任务/批量绑定/403检测/批删/家庭组任务）
- [x] 迁移账号管理界面的 Pro 检测与 403 检测前置筛选及提示文案构建
- [x] 迁移账号管理界面的批量 403 解锁目标筛选、窗口过滤与确认文案构建
- [x] 迁移账号管理界面的开启家庭共享候选筛选与确认文案构建
- [x] 新增 `application/account_task_orchestrator.py`，下沉批量加入家庭组与开启家庭共享执行编排
- [x] 继续下沉账号管理界面批量绑定/批量删除执行循环到 `AccountTaskOrchestrator`
- [x] 下沉账号管理界面批量 403 检测执行循环到 `AccountTaskOrchestrator`
- [x] GUI 停止逻辑接入批量绑定/批量删除可中断标记（保持交互行为不变）
- [x] GUI 停止逻辑接入批量 403 检测可中断标记（保持交互行为不变）
- [x] 下沉 `AccountWorkerThread` 的登录/OAuth/一键登录OAuth/解锁/Pro检测执行逻辑到 `AccountTaskOrchestrator`
- [x] 修复主批处理线程“停止任务”可中断能力（统一返回 stopped 结果）
- [x] 下沉单个“加入家庭组”执行逻辑到 `AccountTaskOrchestrator`
- [x] 新增 `tests/test_account_manager_service.py` 覆盖核心纯逻辑分支
- [x] 扩展 `tests/test_account_task_orchestrator.py` 覆盖批量绑定/批量删除执行器分支
- [x] 扩展 `tests/test_account_task_orchestrator.py` 覆盖 worker 停止分支与单个加入家庭组执行器分支
- [x] 完成编译与最小读写回归验证

### Phase 2 增量进度（2026-02-10）

- [x] 新增 `AccountIoRepository`，下沉账号导入/导出与综合查询聚合 SQL
- [x] `DBManager.import_from_files/export_to_files/get_comprehensive_account_data` 改为兼容委托
- [x] `AccountRepository` 新增 `upsert_account/get_accounts_by_status` 承接 `DBManager` 兼容门面
- [x] 新增 `tests/test_account_io_repository.py` 覆盖综合查询仓储核心分支

下一步建议：

1. 在 `application/` 抽出设置 DTO 与映射工具，进一步减少界面层字段拼装。
2. 继续收敛 GUI 文件规模（拆分 `account_manager_interface.py` 内部私有方法簇）。
3. 按需补齐 `automation_engine_adapter.py` 的单元测试覆盖（当前以编译+烟测兜底）。
